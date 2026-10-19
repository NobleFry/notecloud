import { ErrorCode, TRASH_RETENTION_DAYS, type CreateInvitationInput, type UpdateWorkspaceInput } from '@notecloud/shared';

import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
import { slugify, slugWithSuffix } from '../../lib/slug.js';
import { generateOpaqueToken, hashToken } from '../../lib/tokens.js';

/** Prisma 唯一约束冲突。用鸭子类型判断，避免依赖具体版本的错误类导出 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

// ─────────────────────────────────────────────────────────────────
// 工作区
// ─────────────────────────────────────────────────────────────────

export async function listWorkspaces(userId: string) {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, workspace: { deletedAt: null } },
    include: { workspace: { include: { _count: { select: { members: true } } } } },
    orderBy: [{ workspace: { isPersonal: 'desc' } }, { joinedAt: 'asc' }],
  });

  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    icon: m.workspace.icon,
    color: m.workspace.color,
    isPersonal: m.workspace.isPersonal,
    role: m.role,
    memberCount: m.workspace._count.members,
    createdAt: m.workspace.createdAt,
  }));
}

export async function createWorkspace(userId: string, input: { name: string; icon?: string | null; color?: string | null }) {
  const base = slugify(input.name);

  // slug 只是展示字段（路由用 id），但仍是唯一索引，冲突就换个后缀重试
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const workspace = await prisma.workspace.create({
        data: {
          name: input.name,
          slug: slugWithSuffix(base, attempt),
          icon: input.icon ?? null,
          color: input.color ?? null,
          ownerId: userId,
          // 建工作区与成为 OWNER 必须原子
          members: { create: { userId, role: 'OWNER' } },
        },
        include: { _count: { select: { members: true } } },
      });

      await prisma.auditLog.create({
        data: { actorId: userId, action: 'workspace.created', targetType: 'workspace', targetId: workspace.id, workspaceId: workspace.id },
      });

      return { ...workspace, role: 'OWNER' as const, memberCount: workspace._count.members };
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }

  throw new AppError(ErrorCode.SLUG_TAKEN);
}

export async function updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput) {
  return prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.icon !== undefined ? { icon: input.icon ?? null } : {}),
      ...(input.color !== undefined ? { color: input.color ?? null } : {}),
    },
  });
}

/**
 * 软删除工作区。要求调用方传入 slug 作为二次确认 ——
 * 删工作区是重操作，误点一次的代价太大。
 */
export async function deleteWorkspace(workspaceId: string, actorId: string, confirm: string | undefined) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw AppError.notFound('工作区');

  if (workspace.isPersonal) throw AppError.forbidden('个人空间不能删除');
  if (confirm !== workspace.slug) {
    throw AppError.validation([{ path: 'confirm', message: `请传入工作区标识 "${workspace.slug}" 以确认删除` }]);
  }

  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { deletedAt: new Date() } });
    // 软删除即可，成员关系保留：万一要恢复，权限还在
    await tx.auditLog.create({
      data: { actorId, action: 'workspace.deleted', targetType: 'workspace', targetId: workspaceId, workspaceId },
    });
  });
}

/** 本人作为 OWNER 的、已软删除的工作区 */
export async function listDeletedWorkspaces(userId: string) {
  const rows = await prisma.workspace.findMany({
    where: { ownerId: userId, deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
    select: {
      id: true,
      name: true,
      slug: true,
      icon: true,
      color: true,
      isPersonal: true,
      createdAt: true,
      deletedAt: true,
    },
  });

  return rows.map((w) => ({
    ...w,
    /** 还剩几天可以恢复 */
    daysLeft: Math.max(
      0,
      Math.ceil(TRASH_RETENTION_DAYS - (Date.now() - (w.deletedAt?.getTime() ?? Date.now())) / 86_400_000),
    ),
  }));
}

export async function restoreWorkspace(workspaceId: string, userId: string) {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, ownerId: userId, deletedAt: { not: null } },
  });
  if (!workspace) throw AppError.notFound('已删除的工作区');

  // 超过保留期就不再允许恢复 —— 定时任务随时会物理删除
  if (workspace.deletedAt && workspace.deletedAt.getTime() < Date.now() - TRASH_RETENTION_DAYS * 86_400_000) {
    throw AppError.validation([{ path: 'id', message: `超过 ${TRASH_RETENTION_DAYS} 天的工作区已无法恢复` }]);
  }

  await prisma.workspace.update({ where: { id: workspaceId }, data: { deletedAt: null } });
  await prisma.auditLog.create({
    data: { actorId: userId, action: 'workspace.restored', targetType: 'workspace', targetId: workspaceId, workspaceId },
  });

  return { id: workspace.id, name: workspace.name, slug: workspace.slug };
}

/**
 * 转让所有权。
 * 不变量：任何时刻每个工作区恰好有一个 OWNER。
 * 因此"新 owner 升级"和"老 owner 降级"必须在同一事务里完成。
 */
export async function transferOwnership(
  workspaceId: string,
  actorMembershipId: string,
  actorId: string,
  input: { userId: string; selfRole: 'ADMIN' | 'MEMBER' },
) {
  if (input.userId === actorId) throw AppError.forbidden('不能把所有权转让给自己');

  await prisma.$transaction(async (tx) => {
    const target = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: input.userId } },
    });
    if (!target) throw AppError.notFound('成员');

    await tx.workspaceMember.update({ where: { id: target.id }, data: { role: 'OWNER' } });
    await tx.workspaceMember.update({ where: { id: actorMembershipId }, data: { role: input.selfRole } });

    // 冗余字段同步：ownerId 与成员表的 OWNER 角色必须一致
    await tx.workspace.update({ where: { id: workspaceId }, data: { ownerId: input.userId } });

    await tx.auditLog.create({
      data: {
        actorId,
        action: 'workspace.ownership_transferred',
        targetType: 'workspace',
        targetId: workspaceId,
        workspaceId,
        meta: { newOwnerId: input.userId, selfRole: input.selfRole },
      },
    });
  });
}

/** 主动退出。最后一个 OWNER 必须先把所有权转出去 */
export async function leaveWorkspace(workspaceId: string, membershipId: string, role: string, isPersonal: boolean) {
  if (isPersonal) throw AppError.forbidden('不能退出个人空间');

  if (role === 'OWNER') {
    const ownerCount = await prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
    if (ownerCount <= 1) throw AppError.lastOwner();
  }

  await prisma.workspaceMember.delete({ where: { id: membershipId } });
}

// ─────────────────────────────────────────────────────────────────
// 成员
// ─────────────────────────────────────────────────────────────────

export async function listMembers(
  workspaceId: string,
  params: { limit: number; cursor?: string; q?: string },
) {
  const rows = await prisma.workspaceMember.findMany({
    where: {
      workspaceId,
      ...(params.q
        ? {
            user: {
              OR: [
                { name: { contains: params.q } },
                { email: { contains: params.q } },
              ],
            },
          }
        : {}),
    },
    include: { user: true },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > params.limit;
  const items = (hasMore ? rows.slice(0, params.limit) : rows).map((m) => ({
    userId: m.userId,
    membershipId: m.id,
    role: m.role,
    joinedAt: m.joinedAt,
    user: {
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      avatarUrl: m.user.avatarUrl,
      status: m.user.status,
    },
  }));

  return { items, nextCursor: hasMore ? (items.at(-1)?.membershipId ?? null) : null, hasMore };
}

export async function updateMemberRole(
  workspaceId: string,
  actorId: string,
  targetUserId: string,
  role: 'ADMIN' | 'MEMBER' | 'GUEST',
) {
  if (targetUserId === actorId) {
    throw AppError.forbidden('不能修改自己的角色，如需让位请使用转让所有权');
  }

  const target = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
  });
  if (!target) throw AppError.notFound('成员');

  if (target.role === 'OWNER') throw AppError.forbidden('不能修改工作区所有者的角色');

  return prisma.workspaceMember.update({ where: { id: target.id }, data: { role } });
}

export async function removeMember(workspaceId: string, actorId: string, targetUserId: string) {
  if (targetUserId === actorId) {
    throw AppError.forbidden('不能移除自己，如需离开请使用退出工作区');
  }

  const target = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
  });
  if (!target) throw AppError.notFound('成员');

  // OWNER 永远不会被移除，因此"至少一个 OWNER"这条不变量自然成立
  if (target.role === 'OWNER') throw AppError.forbidden('不能移除工作区所有者，请先转让所有权');

  await prisma.$transaction(async (tx) => {
    await tx.workspaceMember.delete({ where: { id: target.id } });
    await tx.auditLog.create({
      data: { actorId, action: 'workspace.member_removed', targetType: 'user', targetId: targetUserId, workspaceId },
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// 邀请
// ─────────────────────────────────────────────────────────────────

export async function createInvitation(workspaceId: string, actorId: string, input: CreateInvitationInput) {
  const raw = generateOpaqueToken(24);

  const invitation = await prisma.invitation.create({
    data: {
      workspaceId,
      email: input.email ?? null,
      role: input.role,
      tokenHash: hashToken(raw),
      invitedById: actorId,
      maxUses: input.maxUses,
      expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
    },
  });

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    maxUses: invitation.maxUses,
    uses: invitation.uses,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    /** 明文 token 只在这里出现一次，之后库里只有 hash，取不回来 */
    token: raw,
    url: `${env.WEB_ORIGIN}/invite/${raw}`,
  };
}

export async function listInvitations(workspaceId: string) {
  const rows = await prisma.invitation.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { invitedBy: { select: { id: true, name: true } } },
  });

  return rows.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    status: i.status,
    maxUses: i.maxUses,
    uses: i.uses,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
    invitedBy: i.invitedBy,
    /** 是否还能用（前端可直接置灰） */
    usable: i.status === 'PENDING' && i.uses < i.maxUses && i.expiresAt.getTime() > Date.now(),
  }));
}

export async function revokeInvitation(workspaceId: string, invitationId: string, actorId: string) {
  const result = await prisma.invitation.updateMany({
    where: { id: invitationId, workspaceId, status: 'PENDING' },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  if (result.count === 0) throw AppError.notFound('邀请');
  void actorId;
}

/** 公开预览：拿到链接的人未登录时也能看到"被邀请加入哪个工作区" */
export async function previewInvitation(raw: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: {
      workspace: { select: { name: true, icon: true, slug: true, deletedAt: true } },
      invitedBy: { select: { name: true } },
    },
  });

  const usable =
    Boolean(invitation) &&
    invitation!.status === 'PENDING' &&
    invitation!.expiresAt.getTime() > Date.now() &&
    invitation!.uses < invitation!.maxUses &&
    !invitation!.workspace.deletedAt;

  return {
    valid: usable,
    workspaceName: invitation?.workspace.name ?? null,
    workspaceIcon: invitation?.workspace.icon ?? null,
    invitedByName: invitation?.invitedBy.name ?? null,
    role: invitation?.role ?? null,
    email: invitation?.email ?? null,
  };
}

/** 接受邀请。已是成员时幂等返回成功，不报错 */
export async function acceptInvitation(raw: string, userId: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { workspace: true },
  });

  if (!invitation) throw AppError.invitationInvalid();
  if (invitation.status !== 'PENDING') throw AppError.invitationInvalid();
  if (invitation.expiresAt.getTime() <= Date.now()) throw AppError.invitationInvalid();
  if (invitation.uses >= invitation.maxUses) throw AppError.invitationInvalid();
  if (invitation.workspace.deletedAt) throw AppError.invitationInvalid();

  const me = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (invitation.email && invitation.email !== me.email) {
    throw AppError.forbidden(`该邀请仅限 ${invitation.email} 使用`);
  }

  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
  });
  if (existing) {
    return { workspaceId: invitation.workspaceId, role: existing.role, alreadyMember: true };
  }

  const membership = await prisma.$transaction(async (tx) => {
    const created = await tx.workspaceMember.create({
      data: {
        workspaceId: invitation.workspaceId,
        userId,
        role: invitation.role,
        invitedById: invitation.invitedById,
      },
    });

    const nextUses = invitation.uses + 1;
    await tx.invitation.update({
      where: { id: invitation.id },
      data: {
        uses: nextUses,
        ...(nextUses >= invitation.maxUses ? { status: 'ACCEPTED' as const, acceptedAt: new Date() } : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: 'workspace.invitation_accepted',
        targetType: 'workspace',
        targetId: invitation.workspaceId,
        workspaceId: invitation.workspaceId,
      },
    });

    return created;
  });

  return { workspaceId: invitation.workspaceId, role: membership.role, alreadyMember: false };
}

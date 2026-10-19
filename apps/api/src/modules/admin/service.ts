import { randomBytes, randomInt } from 'node:crypto';

import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';

/**
 * 站点管理员用的用户管理。
 *
 * 这里的所有操作都跨工作区，所以**只允许** SiteRole=ADMIN 调用（见 routes 的 requireSiteAdmin）。
 */

export interface ListUsersParams {
  q?: string;
  limit: number;
  cursor?: string;
}

export async function listUsers(params: ListUsersParams) {
  const rows = await prisma.user.findMany({
    where: params.q
      ? {
          OR: [
            { email: { contains: params.q } },
            { name: { contains: params.q } },
          ],
        }
      : {},
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      _count: { select: { memberships: true, notesCreated: true, tasksCreated: true } },
    },
  });

  const hasMore = rows.length > params.limit;
  const items = (hasMore ? rows.slice(0, params.limit) : rows).map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    role: u.role,
    status: u.status,
    emailVerified: u.emailVerifiedAt !== null,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    counts: {
      workspaces: u._count.memberships,
      notes: u._count.notesCreated,
      tasks: u._count.tasksCreated,
    },
  }));

  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null, hasMore };
}

export async function updateUser(
  actorId: string,
  targetId: string,
  input: { status?: 'ACTIVE' | 'DISABLED'; role?: 'USER' | 'ADMIN' },
) {
  if (targetId === actorId) {
    throw AppError.forbidden('不能修改自己的账号状态或站点角色，请让另一位管理员操作');
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) throw AppError.notFound('用户');

  // 最后一个管理员不能被降级或停用，否则站点将无人可管
  if (target.role === 'ADMIN' && (input.role === 'USER' || input.status === 'DISABLED')) {
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
    if (adminCount <= 1) {
      throw AppError.forbidden('这是最后一个可用的站点管理员，不能降级或停用');
    }
  }

  const updated = await prisma.user.update({
    where: { id: targetId },
    data: {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
    },
  });

  // 停用账号时立刻踢掉所有会话，否则已登录的设备还能继续用
  if (input.status === 'DISABLED') {
    await prisma.session.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  await prisma.auditLog.create({
    data: {
      actorId,
      action: 'admin.user_updated',
      targetType: 'user',
      targetId,
      meta: { status: input.status, role: input.role },
    },
  });

  return { id: updated.id, role: updated.role, status: updated.status };
}

/**
 * 强制重置密码。
 *
 * 生成一次性临时密码返回给管理员（由管理员线下转交）。
 * 不依赖 SMTP —— 邮件体系还没接。
 * 重置后吊销该用户所有会话。
 */
export async function resetUserPassword(actorId: string, targetId: string) {
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) throw AppError.notFound('用户');

  if (targetId === actorId) {
    throw AppError.forbidden('请用「修改密码」功能修改自己的密码');
  }

  // 保证同时含字母和数字，满足密码策略
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let temp = 'Nc';
  for (const byte of randomBytes(10)) temp += alphabet[byte % alphabet.length];
  temp += String(randomInt(0, 10));

  await prisma.$transaction([
    prisma.user.update({ where: { id: targetId }, data: { passwordHash: await hashPassword(temp) } }),
    prisma.session.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: { actorId, action: 'admin.password_reset', targetType: 'user', targetId },
    }),
  ]);

  return { temporaryPassword: temp };
}

export async function overview() {
  const [users, activeUsers, workspaces, notes, tasks, attachments, sessions] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.workspace.count({ where: { deletedAt: null } }),
    prisma.note.count({ where: { deletedAt: null } }),
    prisma.task.count({ where: { deletedAt: null } }),
    prisma.attachment.aggregate({ where: { deletedAt: null }, _sum: { size: true }, _count: { _all: true } }),
    prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
  ]);

  return {
    users,
    activeUsers,
    workspaces,
    notes,
    tasks,
    attachments: { count: attachments._count._all, bytes: attachments._sum.size ?? 0 },
    activeSessions: sessions,
  };
}

import { randomBytes, randomUUID } from 'node:crypto';

import {
  ErrorCode,
  type LoginInput,
  type RegisterInput,
  type UpdateProfileInput,
} from '@notecloud/shared';
import type { FastifyReply } from 'fastify';

import { env, isProduction } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { slugify } from '../../lib/slug.js';
import { expiresAtFrom, generateOpaqueToken, hashToken, parseDuration } from '../../lib/tokens.js';

// ─────────────────────────────────────────────────────────────────
// Refresh Cookie
// ─────────────────────────────────────────────────────────────────

export const REFRESH_COOKIE = 'nc_rt';
/** 只让 cookie 出现在认证相关路由上，减少暴露面 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.floor(parseDuration(env.REFRESH_TOKEN_TTL) / 1000),
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

// ─────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────

interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

/** 建会话：明文令牌只返回给调用方（写进 cookie），库里只留 sha256 */
async function createSession(userId: string, familyId: string, meta: RequestMeta) {
  const token = generateOpaqueToken();

  const session = await prisma.session.create({
    data: {
      userId,
      familyId,
      tokenHash: hashToken(token),
      userAgent: meta.userAgent?.slice(0, 512),
      ip: meta.ip?.slice(0, 64),
      expiresAt: expiresAtFrom(env.REFRESH_TOKEN_TTL),
    },
  });

  return { token, session };
}

/** 查一个仍然可用的邀请 */
async function findUsableInvitation(rawToken: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { workspace: true },
  });

  if (!invitation) return null;
  if (invitation.status !== 'PENDING') return null;
  if (invitation.expiresAt.getTime() <= Date.now()) return null;
  if (invitation.uses >= invitation.maxUses) return null;
  if (invitation.workspace.deletedAt) return null;

  return invitation;
}

async function loadUserWithWorkspaces(userId: string) {
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
  }));
}

export function publicUser(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  role: string;
  emailVerifiedAt: Date | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    timezone: user.timezone,
    locale: user.locale,
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
  };
}

// ─────────────────────────────────────────────────────────────────
// 注册
// ─────────────────────────────────────────────────────────────────

export async function register(input: RegisterInput, meta: RequestMeta) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw AppError.emailTaken();

  const userCount = await prisma.user.count();
  const isFirstUser = userCount === 0;

  // 邀请先做只读校验，事务内再复核使用次数，避免并发超发
  const invitation = input.inviteToken ? await findUsableInvitation(input.inviteToken) : null;
  if (input.inviteToken && !invitation) throw AppError.invitationInvalid();

  if (!invitation && !isFirstUser && !env.ALLOW_PUBLIC_REGISTRATION) {
    throw AppError.registrationClosed();
  }

  if (invitation?.email && invitation.email !== input.email) {
    throw AppError.forbidden('该邀请仅限指定邮箱使用');
  }

  // 哈希放在事务外：argon2 是刻意设计成慢的，不该占着数据库连接
  const passwordHash = await hashPassword(input.password);
  const siteRole = isFirstUser && env.FIRST_USER_IS_ADMIN ? 'ADMIN' : 'USER';

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        role: siteRole,
        // 邀请制阶段不发验证邮件，直接视为已验证；开启邮箱验证后此处改为 null
        emailVerifiedAt: env.REQUIRE_EMAIL_VERIFICATION ? null : new Date(),
      },
    });

    // 每个人都有一个不可被加入、不可被删除的个人空间，保证永远有落脚点
    await tx.workspace.create({
      data: {
        name: `${input.name}的个人空间`,
        slug: `personal-${randomBytes(6).toString('hex')}`,
        isPersonal: true,
        ownerId: created.id,
        members: { create: { userId: created.id, role: 'OWNER' } },
      },
    });

    if (invitation) {
      // 幂等：已经是成员就不重复插入
      const alreadyJoined = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: created.id } },
      });

      if (!alreadyJoined) {
        await tx.workspaceMember.create({
          data: {
            workspaceId: invitation.workspaceId,
            userId: created.id,
            role: invitation.role,
            invitedById: invitation.invitedById,
          },
        });
      }

      const nextUses = invitation.uses + 1;
      await tx.invitation.update({
        where: { id: invitation.id },
        data: {
          uses: nextUses,
          ...(nextUses >= invitation.maxUses
            ? { status: 'ACCEPTED' as const, acceptedAt: new Date() }
            : {}),
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorId: created.id,
        action: isFirstUser ? 'site.first_admin_created' : 'auth.register',
        targetType: 'user',
        targetId: created.id,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 512),
      },
    });

    return created;
  });

  const familyId = randomUUID();
  const { token, session } = await createSession(user.id, familyId, meta);

  return {
    user: publicUser(user),
    refreshToken: token,
    sessionId: session.id,
    workspaces: await loadUserWithWorkspaces(user.id),
  };
}

// ─────────────────────────────────────────────────────────────────
// 登录
// ─────────────────────────────────────────────────────────────────

export async function login(input: LoginInput, meta: RequestMeta) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // 邮箱不存在与密码错误返回同一个错误码，避免账号枚举
  if (!user) {
    // 仍然跑一次哈希校验，抹平时间差（防时序攻击）
    await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$0000000000000000000000000000000000000000000', input.password);
    throw AppError.unauthorized();
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) throw AppError.unauthorized();

  if (user.status === 'DISABLED') throw new AppError(ErrorCode.ACCOUNT_DISABLED);

  const familyId = randomUUID();
  const { token, session } = await createSession(user.id, familyId, meta);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return {
    user: publicUser(user),
    refreshToken: token,
    sessionId: session.id,
    workspaces: await loadUserWithWorkspaces(user.id),
  };
}

// ─────────────────────────────────────────────────────────────────
// 刷新（轮转 + 重放检测）
// ─────────────────────────────────────────────────────────────────

export async function refresh(rawToken: string | undefined, meta: RequestMeta) {
  if (!rawToken) throw AppError.unauthorized('缺少刷新令牌');

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!session) throw AppError.unauthorized('登录状态无效，请重新登录');

  // 一个"已经被撤销"的令牌又被用了 —— 说明令牌泄漏，整族作废
  if (session.revokedAt) {
    await prisma.session.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new AppError(ErrorCode.REFRESH_REUSED);
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthorized('登录已过期，请重新登录');
  }

  if (session.user.status === 'DISABLED') throw new AppError(ErrorCode.ACCOUNT_DISABLED);

  const newToken = generateOpaqueToken();

  const created = await prisma.$transaction(async (tx) => {
    const next = await tx.session.create({
      data: {
        userId: session.userId,
        familyId: session.familyId, // 同族，便于回溯整条轮转链
        tokenHash: hashToken(newToken),
        userAgent: meta.userAgent?.slice(0, 512),
        ip: meta.ip?.slice(0, 64),
        expiresAt: expiresAtFrom(env.REFRESH_TOKEN_TTL),
      },
    });

    await tx.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), lastUsedAt: new Date(), replacedById: next.id },
    });

    return next;
  });

  return {
    user: publicUser(session.user),
    refreshToken: newToken,
    sessionId: created.id,
  };
}

// ─────────────────────────────────────────────────────────────────
// 登出 / 改密 / 资料
// ─────────────────────────────────────────────────────────────────

export async function logout(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function changePassword(
  userId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) throw AppError.unauthorized('当前密码不正确');

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    // 改密后，除当前设备外的所有会话全部作废
    await tx.session.updateMany({
      where: { userId, revokedAt: null, id: { not: currentSessionId } },
      data: { revokedAt: new Date() },
    });
    await tx.auditLog.create({
      data: { actorId: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId },
    });
  });
}

export async function updateProfile(userId: string, input: UpdateProfileInput) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl || null } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
    },
  });
  return publicUser(user);
}

export async function listSessions(userId: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  });

  return sessions.map((s) => ({
    id: s.id,
    userAgent: s.userAgent,
    ip: s.ip,
    lastUsedAt: s.lastUsedAt,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const result = await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw AppError.notFound('会话');
}

export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null, id: { not: keepSessionId } },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export { loadUserWithWorkspaces, slugify };

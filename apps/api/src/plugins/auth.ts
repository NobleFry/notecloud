import { ErrorCode, roleAtLeast, type WorkspaceRole } from '@notecloud/shared';
import type { FastifyRequest } from 'fastify';

import { prisma } from '../db/prisma.js';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';

/**
 * 鉴权中间件：解析 Bearer token → 校验会话仍然有效 → 挂载 request.auth。
 *
 * 为什么每个请求都查一次会话（而不是只信 JWT）？
 *   因为要支持"账号被停用"和"设备被踢下线"立刻生效。
 *   Access token 寿命只有 15 分钟，这一次查询换来的是可撤销性。
 */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw AppError.unauthorized('缺少访问令牌');
  }

  const payload = verifyAccessToken(header.slice('Bearer '.length));

  const session = await prisma.session.findFirst({
    where: { id: payload.sid, userId: payload.sub, revokedAt: null },
    include: { user: true },
  });

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthorized('会话已失效，请重新登录');
  }

  if (session.user.status === 'DISABLED') {
    throw new AppError(ErrorCode.ACCOUNT_DISABLED);
  }

  req.auth = {
    user: session.user,
    sessionId: session.id,
    siteRole: session.user.role,
  };
}

/** 站点管理员专用 */
export async function requireSiteAdmin(req: FastifyRequest): Promise<void> {
  await requireAuth(req);
  if (req.auth?.siteRole !== 'ADMIN') {
    throw AppError.forbidden('需要站点管理员权限');
  }
}

/**
 * 工作区权限守卫 —— 全项目**唯一**的越权检查入口。
 *
 * 纪律：workspaceId 必须来自路由参数并经此校验，
 *       业务查询一律带上 workspaceId 条件，绝不信任请求体里传来的 id。
 */
export async function requireWorkspace(
  req: FastifyRequest,
  workspaceId: string,
  requiredRole: WorkspaceRole = 'MEMBER',
): Promise<NonNullable<FastifyRequest['workspaceCtx']>> {
  if (!req.auth) throw AppError.unauthorized();

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId,
      userId: req.auth.user.id,
      workspace: { deletedAt: null },
    },
    include: { workspace: true },
  });

  if (!membership) throw AppError.notMember();

  const role = membership.role as WorkspaceRole;
  if (!roleAtLeast(role, requiredRole)) throw AppError.insufficientRole(requiredRole);

  const ctx = { workspace: membership.workspace, membership, role };
  req.workspaceCtx = ctx;
  return ctx;
}

/**
 * 生成一个「先鉴权 → 再校验工作区角色」的 preHandler。
 *
 * 注意必须先跑 requireAuth：requireWorkspace 依赖 req.auth，
 * 只挂本守卫而不鉴权会导致 req.auth 为空、误报 40100。
 */
export function workspaceGuard(minRole: WorkspaceRole = 'MEMBER') {
  return async (req: FastifyRequest): Promise<void> => {
    await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireWorkspace(req, id, minRole);
  };
}

/** 当前用户在工作区里是否有管理权限（OWNER / ADMIN） */
export function isWorkspaceAdmin(req: FastifyRequest): boolean {
  return req.workspaceCtx?.role === 'OWNER' || req.workspaceCtx?.role === 'ADMIN';
}

import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '@notecloud/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { parseDuration, signAccessToken } from '../../lib/tokens.js';
import { requireAuth } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import * as svc from './service.js';

function metaOf(req: FastifyRequest) {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

/** Access Token 有效期（秒），返回给前端用于提前刷新 */
const ACCESS_TTL_SECONDS = Math.floor(parseDuration('15m') / 1000);

function issueAccessToken(userId: string, sessionId: string, role: string) {
  return signAccessToken({ sub: userId, sid: sessionId, role });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── 注册 ───────────────────────────────────────────────────────
  app.post(
    '/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = registerSchema.parse(req.body);
      const result = await svc.register(input, metaOf(req));

      svc.setRefreshCookie(reply, result.refreshToken);

      return ok(req.id, {
        user: result.user,
        accessToken: issueAccessToken(result.user.id, result.sessionId, result.user.role),
        expiresIn: ACCESS_TTL_SECONDS,
        workspaces: result.workspaces,
      });
    },
  );

  // ── 登录 ───────────────────────────────────────────────────────
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = loginSchema.parse(req.body);
      const result = await svc.login(input, metaOf(req));

      svc.setRefreshCookie(reply, result.refreshToken);

      return ok(req.id, {
        user: result.user,
        accessToken: issueAccessToken(result.user.id, result.sessionId, result.user.role),
        expiresIn: ACCESS_TTL_SECONDS,
        workspaces: result.workspaces,
      });
    },
  );

  // ── 刷新（轮转 + 重放检测）───────────────────────────────────────
  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const raw = req.cookies[svc.REFRESH_COOKIE];
      const result = await svc.refresh(raw, metaOf(req));

      svc.setRefreshCookie(reply, result.refreshToken);

      return ok(req.id, {
        user: result.user,
        accessToken: issueAccessToken(result.user.id, result.sessionId, result.user.role),
        expiresIn: ACCESS_TTL_SECONDS,
      });
    },
  );

  // ── 登出 ───────────────────────────────────────────────────────
  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await svc.logout(req.auth!.sessionId);
    svc.clearRefreshCookie(reply);
    return ok(req.id, { loggedOut: true });
  });

  // ── 当前用户 + 其工作区 ─────────────────────────────────────────
  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    return ok(req.id, {
      user: svc.publicUser(auth.user),
      workspaces: await svc.loadUserWithWorkspaces(auth.user.id),
    });
  });

  app.patch('/auth/me', { preHandler: requireAuth }, async (req) => {
    const input = updateProfileSchema.parse(req.body);
    const user = await svc.updateProfile(req.auth!.user.id, input);
    return ok(req.id, { user });
  });

  // ── 修改密码 ───────────────────────────────────────────────────
  app.post('/auth/password/change', { preHandler: requireAuth }, async (req) => {
    const input = changePasswordSchema.parse(req.body);
    await svc.changePassword(
      req.auth!.user.id,
      req.auth!.sessionId,
      input.currentPassword,
      input.newPassword,
    );
    return ok(req.id, { changed: true, otherSessionsRevoked: true });
  });
}

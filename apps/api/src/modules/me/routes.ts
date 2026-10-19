import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import * as authSvc from '../auth/service.js';

/** 当前用户的会话（登录设备）管理 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/sessions', { preHandler: requireAuth }, async (req) => {
    const sessions = await authSvc.listSessions(req.auth!.user.id);
    return ok(req.id, {
      items: sessions.map((s) => ({ ...s, current: s.id === req.auth!.sessionId })),
    });
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/me/sessions/:sessionId',
    { preHandler: requireAuth },
    async (req) => {
      await authSvc.revokeSession(req.auth!.user.id, req.params.sessionId);
      return ok(req.id, { revoked: true });
    },
  );

  app.delete('/me/sessions', { preHandler: requireAuth }, async (req) => {
    const count = await authSvc.revokeOtherSessions(req.auth!.user.id, req.auth!.sessionId);
    return ok(req.id, { revokedCount: count });
  });
}

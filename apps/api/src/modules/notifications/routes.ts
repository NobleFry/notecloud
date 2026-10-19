import { notificationListQuerySchema } from '@notecloud/shared';
import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import * as svc from './service.js';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/notifications', { preHandler: requireAuth }, async (req) => {
    const query = notificationListQuerySchema.parse(req.query);
    return ok(req.id, await svc.listNotifications(req.auth!.user.id, query));
  });

  app.get('/me/notifications/unread-count', { preHandler: requireAuth }, async (req) => {
    return ok(req.id, { count: await svc.unreadCount(req.auth!.user.id) });
  });

  app.post<{ Params: { id: string } }>(
    '/me/notifications/:id/read',
    { preHandler: requireAuth },
    async (req) => {
      await svc.markRead(req.auth!.user.id, req.params.id);
      return ok(req.id, { read: true });
    },
  );

  app.post('/me/notifications/read-all', { preHandler: requireAuth }, async (req) => {
    return ok(req.id, { marked: await svc.markAllRead(req.auth!.user.id) });
  });
}

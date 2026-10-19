import { adminUserListQuerySchema, updateAdminUserSchema } from '@notecloud/shared';
import type { FastifyInstance } from 'fastify';

import { requireSiteAdmin } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import * as svc from './service.js';

type UserParams = { Params: { userId: string } };

/**
 * 站点管理后台。全部接口都要求 SiteRole=ADMIN（**站点级**，与工作区角色无关）。
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/overview', { preHandler: requireSiteAdmin }, async (req) => {
    return ok(req.id, await svc.overview());
  });

  app.get('/admin/users', { preHandler: requireSiteAdmin }, async (req) => {
    const query = adminUserListQuerySchema.parse(req.query);
    return ok(req.id, await svc.listUsers(query));
  });

  app.patch<UserParams>('/admin/users/:userId', { preHandler: requireSiteAdmin }, async (req) => {
    const input = updateAdminUserSchema.parse(req.body);
    return ok(req.id, {
      user: await svc.updateUser(req.auth!.user.id, req.params.userId, input),
    });
  });

  app.post<UserParams>(
    '/admin/users/:userId/reset-password',
    { preHandler: requireSiteAdmin },
    async (req) => {
      return ok(req.id, await svc.resetUserPassword(req.auth!.user.id, req.params.userId));
    },
  );
}

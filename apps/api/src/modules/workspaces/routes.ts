import {
  createInvitationSchema,
  createWorkspaceSchema,
  paginationSchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateWorkspaceSchema,
} from '@notecloud/shared';
import type { FastifyInstance } from 'fastify';

import { prisma } from '../../db/prisma.js';
import { requireAuth, workspaceGuard } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import * as svc from './service.js';

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // ── 工作区 ─────────────────────────────────────────────────────

  app.get('/workspaces', { preHandler: requireAuth }, async (req) => {
    return ok(req.id, { items: await svc.listWorkspaces(req.auth!.user.id) });
  });

  /** 已软删除的工作区（本人是 OWNER）。必须放在 /workspaces/:id 之前语义上更清晰 */
  app.get('/workspaces/deleted', { preHandler: requireAuth }, async (req) => {
    return ok(req.id, { items: await svc.listDeletedWorkspaces(req.auth!.user.id) });
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/restore', { preHandler: requireAuth }, async (req) => {
    return ok(req.id, { workspace: await svc.restoreWorkspace(req.params.id, req.auth!.user.id) });
  });

  app.post('/workspaces', { preHandler: requireAuth }, async (req) => {
    const input = createWorkspaceSchema.parse(req.body);
    return ok(req.id, { workspace: await svc.createWorkspace(req.auth!.user.id, input) });
  });

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const { workspace, role } = req.workspaceCtx!;
      const memberCount = await prisma.workspaceMember.count({ where: { workspaceId: workspace.id } });
      return ok(req.id, {
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          icon: workspace.icon,
          color: workspace.color,
          isPersonal: workspace.isPersonal,
          createdAt: workspace.createdAt,
        },
        role,
        memberCount,
      });
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/workspaces/:id',
    { preHandler: workspaceGuard('ADMIN') },
    async (req) => {
      const input = updateWorkspaceSchema.parse(req.body);
      const workspace = await svc.updateWorkspace(req.workspaceCtx!.workspace.id, input);
      return ok(req.id, { workspace });
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>(
    '/workspaces/:id',
    { preHandler: workspaceGuard('OWNER') },
    async (req) => {
      await svc.deleteWorkspace(req.workspaceCtx!.workspace.id, req.auth!.user.id, req.query.confirm);
      return ok(req.id, { deleted: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/transfer',
    { preHandler: workspaceGuard('OWNER') },
    async (req) => {
      const input = transferOwnershipSchema.parse(req.body);
      await svc.transferOwnership(
        req.workspaceCtx!.workspace.id,
        req.workspaceCtx!.membership.id,
        req.auth!.user.id,
        input,
      );
      return ok(req.id, { transferred: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/leave',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      // GUEST 也可能需要退出，所以这个接口的角色下限在后面单独判断
      await svc.leaveWorkspace(
        req.workspaceCtx!.workspace.id,
        req.workspaceCtx!.membership.id,
        req.workspaceCtx!.role,
        req.workspaceCtx!.workspace.isPersonal,
      );
      return ok(req.id, { left: true });
    },
  );

  // ── 成员 ───────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/members',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const params = paginationSchema.parse(req.query);
      const page = await svc.listMembers(req.workspaceCtx!.workspace.id, params);
      return ok(req.id, page);
    },
  );

  app.patch<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId',
    { preHandler: workspaceGuard('ADMIN') },
    async (req) => {
      const input = updateMemberRoleSchema.parse(req.body);
      await svc.updateMemberRole(req.workspaceCtx!.workspace.id, req.auth!.user.id, req.params.userId, input.role);
      return ok(req.id, { updated: true });
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId',
    { preHandler: workspaceGuard('ADMIN') },
    async (req) => {
      await svc.removeMember(req.workspaceCtx!.workspace.id, req.auth!.user.id, req.params.userId);
      return ok(req.id, { removed: true });
    },
  );

  // ── 邀请（管理）─────────────────────────────────────────────────
  // 注意：MEMBER 不能邀请成员（已确认的决策），下限是 ADMIN

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/invitations',
    { preHandler: workspaceGuard('ADMIN') },
    async (req) => {
      return ok(req.id, { items: await svc.listInvitations(req.workspaceCtx!.workspace.id) });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/invitations',
    { preHandler: workspaceGuard('ADMIN') },
    async (req) => {
      const input = createInvitationSchema.parse(req.body);
      const invitation = await svc.createInvitation(req.workspaceCtx!.workspace.id, req.auth!.user.id, input);
      return ok(req.id, { invitation });
    },
  );

  app.delete<{ Params: { id: string; invitationId: string } }>(
    '/workspaces/:id/invitations/:invitationId',
    { preHandler: workspaceGuard('ADMIN') },
    async (req) => {
      await svc.revokeInvitation(req.workspaceCtx!.workspace.id, req.params.invitationId, req.auth!.user.id);
      return ok(req.id, { revoked: true });
    },
  );
}

/** 邀请的公开预览与接受（不属于某个工作区的子路由） */
export async function invitationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { token: string } }>('/invitations/:token', async (req) => {
    return ok(req.id, await svc.previewInvitation(req.params.token));
  });

  app.post<{ Params: { token: string } }>(
    '/invitations/:token/accept',
    { preHandler: requireAuth },
    async (req) => {
      const result = await svc.acceptInvitation(req.params.token, req.auth!.user.id);
      return ok(req.id, result);
    },
  );
}

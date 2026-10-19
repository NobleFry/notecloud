import { createShareLinkSchema } from '@notecloud/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isWorkspaceAdmin, workspaceGuard } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import * as svc from './service.js';

type NoteParams = { Params: { id: string; noteId: string } };
type LinkParams = { Params: { id: string; linkId: string } };

function ws(req: FastifyRequest) {
  return req.workspaceCtx!.workspace.id;
}

export async function shareRoutes(app: FastifyInstance): Promise<void> {
  // ── 管理（需要登录 + 工作区成员）────────────────────────────

  app.post<NoteParams>(
    '/workspaces/:id/notes/:noteId/share',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = createShareLinkSchema.parse(req.body ?? {});
      const link = await svc.createShareLink(ws(req), req.auth!.user.id, req.params.noteId, input.expiresInDays);
      return ok(req.id, { link });
    },
  );

  app.get<NoteParams>(
    '/workspaces/:id/notes/:noteId/share',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      return ok(req.id, { items: await svc.listShareLinks(ws(req), req.params.noteId) });
    },
  );

  app.delete<LinkParams>(
    '/workspaces/:id/share-links/:linkId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await svc.revokeShareLink(ws(req), req.params.linkId, req.auth!.user.id, isWorkspaceAdmin(req));
      return ok(req.id, { revoked: true });
    },
  );

  // ── 公开读取（无需登录）──────────────────────────────────────
  app.get<{ Params: { token: string } }>('/share/:token', async (req) => {
    return ok(req.id, { note: await svc.getSharedNote(req.params.token) });
  });
}

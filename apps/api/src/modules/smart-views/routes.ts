import { createSmartViewSchema, updateSmartViewSchema, type SmartViewFilter } from '@notecloud/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
import { workspaceGuard } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';

type WsParams = { Params: { id: string } };
type ViewParams = { Params: { id: string; viewId: string } };

function ws(req: FastifyRequest) {
  return req.workspaceCtx!.workspace.id;
}

function dto(v: {
  id: string;
  name: string;
  icon: string | null;
  filter: unknown;
  isShared: boolean;
  ownerId: string | null;
  position: number;
  createdAt: Date;
}) {
  return {
    id: v.id,
    name: v.name,
    icon: v.icon,
    filter: v.filter as SmartViewFilter,
    isShared: v.isShared,
    position: v.position,
    // 私有视图只有自己能看到，所以也不需要隐藏 ownerId
    ownerId: v.ownerId,
    createdAt: v.createdAt,
  };
}

export async function smartViewRoutes(app: FastifyInstance): Promise<void> {
  app.get<WsParams>('/workspaces/:id/smart-views', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const rows = await prisma.smartView.findMany({
      where: {
        workspaceId: ws(req),
        // 共享的 + 自己的私有视图
        OR: [{ isShared: true }, { ownerId: req.auth!.user.id }],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    return ok(req.id, { items: rows.map(dto) });
  });

  app.post<WsParams>('/workspaces/:id/smart-views', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = createSmartViewSchema.parse(req.body);

    const count = await prisma.smartView.count({ where: { workspaceId: ws(req) } });
    if (count >= 30) {
      throw AppError.validation([{ path: 'name', message: '每个工作区最多 30 个智能视图' }]);
    }

    const view = await prisma.smartView.create({
      data: {
        workspaceId: ws(req),
        name: input.name,
        icon: input.icon ?? null,
        filter: input.filter,
        isShared: input.isShared,
        ownerId: input.isShared ? null : req.auth!.user.id,
        createdById: req.auth!.user.id,
        position: count,
      },
    });

    return ok(req.id, { view: dto(view) });
  });

  app.patch<ViewParams>('/workspaces/:id/smart-views/:viewId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = updateSmartViewSchema.parse(req.body);
    const existing = await findOwned(req, req.params.viewId);

    const view = await prisma.smartView.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.icon !== undefined ? { icon: input.icon ?? null } : {}),
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
        ...(input.isShared !== undefined
          ? { isShared: input.isShared, ownerId: input.isShared ? null : existing.ownerId ?? req.auth!.user.id }
          : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
      },
    });

    return ok(req.id, { view: dto(view) });
  });

  app.delete<ViewParams>('/workspaces/:id/smart-views/:viewId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    await findOwned(req, req.params.viewId);
    await prisma.smartView.delete({ where: { id: req.params.viewId } });
    return ok(req.id, { deleted: true });
  });
}

/** 只能改/删自己的私有视图；共享视图需要 ADMIN */
async function findOwned(req: FastifyRequest, viewId: string) {
  const view = await prisma.smartView.findFirst({
    where: { id: viewId, workspaceId: ws(req) },
  });
  if (!view) throw AppError.notFound('智能视图');

  const isMine = view.ownerId === req.auth!.user.id;
  const isAdmin = req.workspaceCtx!.role === 'OWNER' || req.workspaceCtx!.role === 'ADMIN';
  if (!isMine && !isAdmin) throw AppError.forbidden('只能修改自己创建的智能视图');

  return view;
}

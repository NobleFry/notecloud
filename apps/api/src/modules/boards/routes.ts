import {
  createBoardSchema,
  createColumnSchema,
  moveTaskSchema,
  reorderColumnsSchema,
  updateBoardSchema,
  updateColumnSchema,
} from '@notecloud/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { workspaceGuard } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import * as svc from './service.js';

type WsParams = { Params: { id: string } };
type BoardParams = { Params: { id: string; boardId: string } };
type ColumnParams = { Params: { id: string; columnId: string } };

function ws(req: FastifyRequest) {
  return req.workspaceCtx!.workspace.id;
}

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  // ── 看板 ──────────────────────────────────────────────────────

  app.get<WsParams>('/workspaces/:id/boards', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    return ok(req.id, { items: await svc.listBoards(ws(req)) });
  });

  /** 所有看板的列，扁平返回（选择器用） */
  app.get<WsParams>('/workspaces/:id/board-columns', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    return ok(req.id, { boards: await svc.listAllColumns(ws(req)) });
  });

  app.post<WsParams>('/workspaces/:id/boards', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = createBoardSchema.parse(req.body);
    return ok(req.id, { board: await svc.createBoard(ws(req), req.auth!.user.id, input) });
  });

  app.get<BoardParams>(
    '/workspaces/:id/boards/:boardId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      return ok(req.id, await svc.getBoard(ws(req), req.params.boardId));
    },
  );

  app.patch<BoardParams>(
    '/workspaces/:id/boards/:boardId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = updateBoardSchema.parse(req.body);
      return ok(req.id, { board: await svc.updateBoard(ws(req), req.params.boardId, input) });
    },
  );

  app.delete<BoardParams>(
    '/workspaces/:id/boards/:boardId',
    { preHandler: workspaceGuard('ADMIN') },
    async (req) => {
      await svc.deleteBoard(ws(req), req.params.boardId);
      return ok(req.id, { deleted: true });
    },
  );

  // ── 列 ────────────────────────────────────────────────────────

  app.post<BoardParams>(
    '/workspaces/:id/boards/:boardId/columns',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = createColumnSchema.parse(req.body);
      return ok(req.id, { column: await svc.createColumn(ws(req), req.params.boardId, input) });
    },
  );

  app.post<BoardParams>(
    '/workspaces/:id/boards/:boardId/columns/reorder',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = reorderColumnsSchema.parse(req.body);
      await svc.reorderColumns(ws(req), req.params.boardId, input.orderedIds);
      return ok(req.id, { reordered: true });
    },
  );

  app.patch<ColumnParams>(
    '/workspaces/:id/board-columns/:columnId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = updateColumnSchema.parse(req.body);
      return ok(req.id, { column: await svc.updateColumn(ws(req), req.params.columnId, input) });
    },
  );

  app.delete<ColumnParams>(
    '/workspaces/:id/board-columns/:columnId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await svc.deleteColumn(ws(req), req.params.columnId);
      return ok(req.id, { deleted: true });
    },
  );

  // ── 拖动卡片 ──────────────────────────────────────────────────

  app.post<BoardParams>(
    '/workspaces/:id/boards/:boardId/move',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = moveTaskSchema.parse(req.body);
      const result = await svc.moveTask(
        ws(req),
        req.params.boardId,
        input.taskId,
        input.columnId,
        input.orderedTaskIds,
        req.auth!.user.id,
      );
      return ok(req.id, result);
    },
  );
}

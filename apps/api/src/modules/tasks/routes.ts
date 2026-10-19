import {
  createCommentSchema,
  createTaskSchema,
  setTaskColumnSchema,
  taskListQuerySchema,
  toggleChecklistSchema,
  updateCommentSchema,
  updateTaskSchema,
} from '@notecloud/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isWorkspaceAdmin, workspaceGuard } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import { idempotencyGuard } from '../../plugins/idempotency.js';
import * as notifications from '../notifications/service.js';
import * as svc from './service.js';

type WsParams = { Params: { id: string } };
type TaskParams = { Params: { id: string; taskId: string } };
type ChecklistParams = { Params: { id: string; taskId: string; itemId: string } };
type CommentParams = { Params: { id: string; commentId: string } };

function ws(req: FastifyRequest) {
  return req.workspaceCtx!.workspace.id;
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  // ── 任务 ──────────────────────────────────────────────────────

  app.get<WsParams>('/workspaces/:id/tasks', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const query = taskListQuerySchema.parse(req.query);
    // 用用户自己的时区算"今天/本周" —— 库里的时间是 UTC，语义边界是本地时间
    const timeZone = req.auth!.user.timezone || 'Asia/Shanghai';

    if (query.q) {
      const limit = query.limit;
      const result = query.q.length < 2
        ? await svc.listTasks(ws(req), req.auth!.user.id, timeZone, query)
        : await svc.searchTasks(ws(req), query.q, limit);
      return ok(req.id, result);
    }

    return ok(req.id, await svc.listTasks(ws(req), req.auth!.user.id, timeZone, query));
  });

  app.post<WsParams>('/workspaces/:id/tasks', { preHandler: [workspaceGuard('MEMBER'), idempotencyGuard] }, async (req) => {
    const input = createTaskSchema.parse(req.body);
    const task = await svc.createTask(ws(req), req.auth!.user, input);
    return ok(req.id, { task });
  });

  app.get<TaskParams>('/workspaces/:id/tasks/:taskId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    return ok(req.id, { task: await svc.getTask(ws(req), req.params.taskId) });
  });

  app.patch<TaskParams>('/workspaces/:id/tasks/:taskId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = updateTaskSchema.parse(req.body);
    const task = await svc.updateTask(ws(req), req.params.taskId, input, {
      id: req.auth!.user.id,
      name: req.auth!.user.name,
    });
    return ok(req.id, { task });
  });

  app.patch<ChecklistParams>(
    '/workspaces/:id/tasks/:taskId/checklist/:itemId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = toggleChecklistSchema.parse(req.body);
      const task = await svc.toggleChecklist(ws(req), req.params.taskId, req.params.itemId, input.done);
      return ok(req.id, { task });
    },
  );

  /** 放进看板某列 / 从看板移出 */
  app.put<TaskParams>(
    '/workspaces/:id/tasks/:taskId/column',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = setTaskColumnSchema.parse(req.body);
      const task = await svc.setTaskColumn(ws(req), req.params.taskId, input.columnId, {
        id: req.auth!.user.id,
      });
      return ok(req.id, { task });
    },
  );

  // ── 回收站 ────────────────────────────────────────────────────

  app.delete<TaskParams>('/workspaces/:id/tasks/:taskId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    await svc.trashTask(ws(req), req.params.taskId);
    return ok(req.id, { trashed: true });
  });

  app.post<TaskParams>(
    '/workspaces/:id/tasks/:taskId/restore',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await svc.restoreTask(ws(req), req.params.taskId);
      return ok(req.id, { restored: true });
    },
  );

  app.delete<TaskParams>(
    '/workspaces/:id/tasks/:taskId/purge',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await svc.purgeTask(ws(req), req.params.taskId, req.auth!.user.id, isWorkspaceAdmin(req));
      return ok(req.id, { purged: true });
    },
  );

  // ── 关注者（协作人）──────────────────────────────────────────

  app.get<TaskParams>(
    '/workspaces/:id/tasks/:taskId/watchers',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      return ok(req.id, await notifications.listWatchers(req.params.taskId, req.auth!.user.id));
    },
  );

  app.post<TaskParams>(
    '/workspaces/:id/tasks/:taskId/watch',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await notifications.watchTask(req.params.taskId, req.auth!.user.id);
      return ok(req.id, { watching: true });
    },
  );

  app.delete<TaskParams>(
    '/workspaces/:id/tasks/:taskId/watch',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await notifications.unwatchTask(req.params.taskId, req.auth!.user.id);
      return ok(req.id, { watching: false });
    },
  );

  // ── 评论 ──────────────────────────────────────────────────────

  app.get<TaskParams>(
    '/workspaces/:id/tasks/:taskId/comments',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      return ok(req.id, { items: await svc.listComments(ws(req), req.params.taskId) });
    },
  );

  app.post<TaskParams>(
    '/workspaces/:id/tasks/:taskId/comments',
    { preHandler: [workspaceGuard('MEMBER'), idempotencyGuard] },
    async (req) => {
      const input = createCommentSchema.parse(req.body);
      const comment = await svc.createComment(
        ws(req),
        req.params.taskId,
        { id: req.auth!.user.id, name: req.auth!.user.name },
        input.body,
        input.mentions,
      );
      return ok(req.id, { comment });
    },
  );

  app.patch<CommentParams>(
    '/workspaces/:id/comments/:commentId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = updateCommentSchema.parse(req.body);
      const comment = await svc.updateComment(ws(req), req.params.commentId, req.auth!.user.id, input.body);
      return ok(req.id, { comment });
    },
  );

  app.delete<CommentParams>(
    '/workspaces/:id/comments/:commentId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await svc.deleteComment(ws(req), req.params.commentId, req.auth!.user.id, isWorkspaceAdmin(req));
      return ok(req.id, { deleted: true });
    },
  );
}

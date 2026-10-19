import {
  createNoteSchema,
  createNotebookSchema,
  createTagSchema,
  noteListQuerySchema,
  reorderNotebooksSchema,
  searchNotesQuerySchema,
  setNoteNotebooksSchema,
  setNoteTagsSchema,
  updateNoteSchema,
  updateNotebookSchema,
  updateTagSchema,
} from '@notecloud/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isWorkspaceAdmin, workspaceGuard } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import { idempotencyGuard } from '../../plugins/idempotency.js';
import * as svc from './service.js';

type WorkspaceParams = { Params: { id: string } };
type NotebookParams = { Params: { id: string; notebookId: string } };
type TagParams = { Params: { id: string; tagId: string } };
type NoteParams = { Params: { id: string; noteId: string } };

function ws(req: FastifyRequest) {
  return req.workspaceCtx!.workspace.id;
}

/**
 * 笔记模块：笔记本 / 标签 / 笔记。
 * 全部挂在工作区下，权限下限 MEMBER（GUEST 在 M5 再做资源级授权）。
 */
export async function notesRoutes(app: FastifyInstance): Promise<void> {
  // ── 笔记本 ─────────────────────────────────────────────────────

  app.get<WorkspaceParams>('/workspaces/:id/notebooks', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    return ok(req.id, { items: await svc.listNotebooks(ws(req)) });
  });

  app.post<WorkspaceParams>('/workspaces/:id/notebooks', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = createNotebookSchema.parse(req.body);
    const notebook = await svc.createNotebook(ws(req), req.auth!.user.id, input);
    return ok(req.id, { notebook });
  });

  // 注意：必须放在 /:notebookId 之前没必要（方法不同），但路径要唯一
  app.post<WorkspaceParams>(
    '/workspaces/:id/notebooks/reorder',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = reorderNotebooksSchema.parse(req.body);
      return ok(req.id, await svc.reorderNotebooks(ws(req), req.auth!.user.id, input.parentId, input.orderedIds));
    },
  );

  app.patch<NotebookParams>(
    '/workspaces/:id/notebooks/:notebookId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = updateNotebookSchema.parse(req.body);
      const notebook = await svc.updateNotebook(ws(req), req.params.notebookId, input);
      return ok(req.id, { notebook });
    },
  );

  app.delete<NotebookParams>(
    '/workspaces/:id/notebooks/:notebookId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const result = await svc.deleteNotebook(
        ws(req),
        req.params.notebookId,
        req.auth!.user.id,
        isWorkspaceAdmin(req),
      );
      return ok(req.id, result);
    },
  );

  // ── 标签 ───────────────────────────────────────────────────────

  app.get<WorkspaceParams>('/workspaces/:id/tags', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    return ok(req.id, { items: await svc.listTags(ws(req)) });
  });

  app.post<WorkspaceParams>('/workspaces/:id/tags', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = createTagSchema.parse(req.body);
    return ok(req.id, { tag: await svc.createTag(ws(req), input) });
  });

  app.patch<TagParams>('/workspaces/:id/tags/:tagId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = updateTagSchema.parse(req.body);
    return ok(req.id, { tag: await svc.updateTag(ws(req), req.params.tagId, input) });
  });

  app.delete<TagParams>('/workspaces/:id/tags/:tagId', { preHandler: workspaceGuard('ADMIN') }, async (req) => {
    await svc.deleteTag(ws(req), req.params.tagId);
    return ok(req.id, { deleted: true });
  });

  // ── 笔记 ───────────────────────────────────────────────────────

  app.get<WorkspaceParams>('/workspaces/:id/notes', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const query = noteListQuerySchema.parse(req.query);
    return ok(req.id, await svc.listNotes(ws(req), req.auth!.user.id, query));
  });

  /** 全文检索（ngram）。与列表接口分开，便于前端做"搜索模式"切换 */
  app.get<WorkspaceParams>(
    '/workspaces/:id/notes/search',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const query = searchNotesQuerySchema.parse(req.query);
      const result = await svc.searchNotes(ws(req), req.auth!.user.id, {
        ...query,
        view: 'all',
        limit: query.limit,
      });
      return ok(req.id, result);
    },
  );

  app.post<WorkspaceParams>(
    '/workspaces/:id/notes',
    { preHandler: [workspaceGuard('MEMBER'), idempotencyGuard] },
    async (req) => {
      const input = createNoteSchema.parse(req.body);
      const note = await svc.createNote(ws(req), req.auth!.user.id, input);
      return ok(req.id, { note });
    },
  );

  app.get<NoteParams>('/workspaces/:id/notes/:noteId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const note = await svc.getNote(ws(req), req.auth!.user.id, req.params.noteId, true);
    return ok(req.id, { note });
  });

  app.patch<NoteParams>('/workspaces/:id/notes/:noteId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = updateNoteSchema.parse(req.body);
    const note = await svc.updateNote(ws(req), req.auth!.user.id, req.params.noteId, input);
    return ok(req.id, { note });
  });

  app.put<NoteParams>(
    '/workspaces/:id/notes/:noteId/notebooks',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const input = setNoteNotebooksSchema.parse(req.body);
      await svc.setNoteNotebooks(ws(req), req.params.noteId, input.notebookIds);
      return ok(req.id, { updated: true });
    },
  );

  app.put<NoteParams>('/workspaces/:id/notes/:noteId/tags', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const input = setNoteTagsSchema.parse(req.body);
    await svc.setNoteTags(ws(req), req.params.noteId, input.tagIds);
    return ok(req.id, { updated: true });
  });

  // ── 回收站 ─────────────────────────────────────────────────────

  app.delete<NoteParams>('/workspaces/:id/notes/:noteId', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    await svc.trashNote(ws(req), req.auth!.user.id, req.params.noteId);
    return ok(req.id, { trashed: true });
  });

  app.post<NoteParams>(
    '/workspaces/:id/notes/:noteId/restore',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await svc.restoreNote(ws(req), req.auth!.user.id, req.params.noteId);
      return ok(req.id, { restored: true });
    },
  );

  app.delete<NoteParams>(
    '/workspaces/:id/notes/:noteId/purge',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      await svc.purgeNote(ws(req), req.auth!.user.id, req.params.noteId, isWorkspaceAdmin(req));
      return ok(req.id, { purged: true });
    },
  );

  app.delete<WorkspaceParams>(
    '/workspaces/:id/trash',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      return ok(req.id, await svc.emptyTrash(ws(req), req.auth!.user.id, isWorkspaceAdmin(req)));
    },
  );
}

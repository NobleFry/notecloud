import type { NoteView, ResourceVisibility } from '@notecloud/shared';

import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './client';

// ─────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────

export interface NotebookDto {
  id: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  depth: number;
  noteCount: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface TagDto {
  id: string;
  name: string;
  color: string | null;
  noteCount: number;
  taskCount: number;
  createdAt: string;
}

export interface NoteListItem {
  id: string;
  title: string;
  excerpt: string | null;
  visibility: ResourceVisibility;
  isPinned: boolean;
  isStarred: boolean;
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  createdBy: { id: string; name: string; avatarUrl: string | null };
  updatedBy: { id: string; name: string; avatarUrl: string | null } | null;
  notebookIds: string[];
  tags: { id: string; name: string; color: string | null }[];
}

export interface NoteDetail extends NoteListItem {
  content: string;
}

export interface NoteListParams {
  view?: NoteView;
  notebookId?: string | null;
  tagId?: string | null;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

// ─────────────────────────────────────────────────────────────────
// 笔记本
// ─────────────────────────────────────────────────────────────────

export function listNotebooks(workspaceId: string) {
  return apiGet<{ items: NotebookDto[] }>(`/workspaces/${workspaceId}/notebooks`);
}

export function createNotebook(
  workspaceId: string,
  payload: { name: string; parentId?: string | null; icon?: string | null; color?: string | null },
) {
  return apiPost<{ notebook: NotebookDto }>(`/workspaces/${workspaceId}/notebooks`, payload);
}

export function updateNotebook(
  workspaceId: string,
  notebookId: string,
  payload: { name?: string; icon?: string | null; color?: string | null },
) {
  return apiPatch<{ notebook: NotebookDto }>(`/workspaces/${workspaceId}/notebooks/${notebookId}`, payload);
}

export function deleteNotebook(workspaceId: string, notebookId: string) {
  return apiDelete<{ deletedCount: number }>(`/workspaces/${workspaceId}/notebooks/${notebookId}`);
}

export function reorderNotebooks(
  workspaceId: string,
  payload: { parentId: string | null; orderedIds: string[] },
) {
  return apiPost<{ reordered: number }>(`/workspaces/${workspaceId}/notebooks/reorder`, payload);
}

// ─────────────────────────────────────────────────────────────────
// 标签
// ─────────────────────────────────────────────────────────────────

export function listTags(workspaceId: string) {
  return apiGet<{ items: TagDto[] }>(`/workspaces/${workspaceId}/tags`);
}

export function createTag(workspaceId: string, payload: { name: string; color?: string | null }) {
  return apiPost<{ tag: TagDto }>(`/workspaces/${workspaceId}/tags`, payload);
}

export function updateTag(workspaceId: string, tagId: string, payload: { name?: string; color?: string | null }) {
  return apiPatch<{ tag: TagDto }>(`/workspaces/${workspaceId}/tags/${tagId}`, payload);
}

export function deleteTag(workspaceId: string, tagId: string) {
  return apiDelete<{ deleted: boolean }>(`/workspaces/${workspaceId}/tags/${tagId}`);
}

// ─────────────────────────────────────────────────────────────────
// 笔记
// ─────────────────────────────────────────────────────────────────

export function listNotes(workspaceId: string, params: NoteListParams = {}) {
  const query: Record<string, string> = {};
  if (params.view) query.view = params.view;
  if (params.notebookId) query.notebookId = params.notebookId;
  if (params.tagId) query.tagId = params.tagId;
  if (params.q) query.q = params.q;
  if (params.limit) query.limit = String(params.limit);
  if (params.cursor) query.cursor = params.cursor;

  return apiGet<{ items: NoteListItem[]; nextCursor: string | null; hasMore: boolean }>(
    `/workspaces/${workspaceId}/notes`,
    { params: query },
  );
}

export function searchNotes(workspaceId: string, q: string) {
  return apiGet<{ items: NoteListItem[]; hasMore: boolean }>(`/workspaces/${workspaceId}/notes/search`, {
    params: { q },
  });
}

export function getNote(workspaceId: string, noteId: string) {
  return apiGet<{ note: NoteDetail }>(`/workspaces/${workspaceId}/notes/${noteId}`);
}

export function createNote(
  workspaceId: string,
  payload: {
    title?: string;
    content?: string;
    notebookIds?: string[];
    tagIds?: string[];
    visibility?: ResourceVisibility;
  },
) {
  return apiPost<{ note: NoteDetail }>(`/workspaces/${workspaceId}/notes`, payload);
}

export function updateNote(
  workspaceId: string,
  noteId: string,
  payload: {
    version: number;
    title?: string;
    content?: string;
    visibility?: ResourceVisibility;
    isPinned?: boolean;
    isStarred?: boolean;
    archived?: boolean;
  },
) {
  return apiPatch<{ note: NoteDetail }>(`/workspaces/${workspaceId}/notes/${noteId}`, payload);
}

export function setNoteNotebooks(workspaceId: string, noteId: string, notebookIds: string[]) {
  return apiPut<{ updated: boolean }>(`/workspaces/${workspaceId}/notes/${noteId}/notebooks`, { notebookIds });
}

export function setNoteTags(workspaceId: string, noteId: string, tagIds: string[]) {
  return apiPut<{ updated: boolean }>(`/workspaces/${workspaceId}/notes/${noteId}/tags`, { tagIds });
}

export function trashNote(workspaceId: string, noteId: string) {
  return apiDelete<{ trashed: boolean }>(`/workspaces/${workspaceId}/notes/${noteId}`);
}

export function restoreNote(workspaceId: string, noteId: string) {
  return apiPost<{ restored: boolean }>(`/workspaces/${workspaceId}/notes/${noteId}/restore`);
}

export function purgeNote(workspaceId: string, noteId: string) {
  return apiDelete<{ purged: boolean }>(`/workspaces/${workspaceId}/notes/${noteId}/purge`);
}

export function emptyTrash(workspaceId: string) {
  return apiDelete<{ purged: number }>(`/workspaces/${workspaceId}/trash`);
}

import type { TaskPriority, TaskStatus, TaskView } from '@notecloud/shared';

import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  startAt: string | null;
  dueAt: string | null;
  isAllDay: boolean;
  completedAt: string | null;
  canceledAt: string | null;
  position: number;
  columnId: string | null;
  reminderAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  createdBy: { id: string; name: string; avatarUrl: string | null };
  checklist: Array<{ id: string; title: string; done: boolean; position: number }>;
  checklistDone: number;
  checklistTotal: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
}

export interface CommentDto {
  id: string;
  body: string;
  mentions: string[];
  author: { id: string; name: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface TaskListParams {
  view?: TaskView;
  tagId?: string | null;
  q?: string;
  /** 只看不在任何看板上的任务 */
  unassigned?: boolean;
  limit?: number;
}

export function listTasks(workspaceId: string, params: TaskListParams = {}) {
  const query: Record<string, string> = {};
  if (params.view) query.view = params.view;
  if (params.tagId) query.tagId = params.tagId;
  if (params.q) query.q = params.q;
  if (params.unassigned) query.unassigned = '1';
  if (params.limit) query.limit = String(params.limit);

  return apiGet<{ items: TaskDto[]; nextCursor: string | null; hasMore: boolean }>(
    `/workspaces/${workspaceId}/tasks`,
    { params: query },
  );
}

export function getTask(workspaceId: string, taskId: string) {
  return apiGet<{ task: TaskDto }>(`/workspaces/${workspaceId}/tasks/${taskId}`);
}

export function createTask(
  workspaceId: string,
  payload: {
    title: string;
    description?: string | null;
    status?: TaskStatus;
    priority?: TaskPriority;
    startAt?: string | null;
    dueAt?: string | null;
    isAllDay?: boolean;
    assigneeId?: string | null;
    tagIds?: string[];
    checklist?: Array<{ title: string }>;
    /** 直接建在某个看板列上 */
    columnId?: string | null;
    reminderAt?: string | null;
  },
) {
  return apiPost<{ task: TaskDto }>(`/workspaces/${workspaceId}/tasks`, payload);
}

export function updateTask(
  workspaceId: string,
  taskId: string,
  payload: {
    version: number;
    title?: string;
    description?: string | null;
    status?: TaskStatus;
    priority?: TaskPriority;
    startAt?: string | null;
    dueAt?: string | null;
    isAllDay?: boolean;
    assigneeId?: string | null;
    tagIds?: string[];
    checklist?: Array<{ id?: string; title: string; done: boolean }>;
    reminderAt?: string | null;
  },
) {
  return apiPatch<{ task: TaskDto }>(`/workspaces/${workspaceId}/tasks/${taskId}`, payload);
}

// ── 关注者 ────────────────────────────────────────────────────────

export interface WatcherDto {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export function listWatchers(workspaceId: string, taskId: string) {
  return apiGet<{ items: WatcherDto[]; watching: boolean }>(
    `/workspaces/${workspaceId}/tasks/${taskId}/watchers`,
  );
}

export function watchTask(workspaceId: string, taskId: string) {
  return apiPost<{ watching: boolean }>(`/workspaces/${workspaceId}/tasks/${taskId}/watch`);
}

export function unwatchTask(workspaceId: string, taskId: string) {
  return apiDelete<{ watching: boolean }>(`/workspaces/${workspaceId}/tasks/${taskId}/watch`);
}

export function toggleChecklist(workspaceId: string, taskId: string, itemId: string, done: boolean) {
  return apiPatch<{ task: TaskDto }>(`/workspaces/${workspaceId}/tasks/${taskId}/checklist/${itemId}`, {
    done,
  });
}

export function trashTask(workspaceId: string, taskId: string) {
  return apiDelete<{ trashed: boolean }>(`/workspaces/${workspaceId}/tasks/${taskId}`);
}

export function restoreTask(workspaceId: string, taskId: string) {
  return apiPost<{ restored: boolean }>(`/workspaces/${workspaceId}/tasks/${taskId}/restore`);
}

export function purgeTask(workspaceId: string, taskId: string) {
  return apiDelete<{ purged: boolean }>(`/workspaces/${workspaceId}/tasks/${taskId}/purge`);
}

export function listComments(workspaceId: string, taskId: string) {
  return apiGet<{ items: CommentDto[] }>(`/workspaces/${workspaceId}/tasks/${taskId}/comments`);
}

export function createComment(
  workspaceId: string,
  taskId: string,
  payload: { body: string; mentions?: string[] },
) {
  return apiPost<{ comment: CommentDto }>(
    `/workspaces/${workspaceId}/tasks/${taskId}/comments`,
    payload,
  );
}

export function deleteComment(workspaceId: string, commentId: string) {
  return apiDelete<{ deleted: boolean }>(`/workspaces/${workspaceId}/comments/${commentId}`);
}

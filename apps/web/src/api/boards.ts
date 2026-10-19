import type { TaskStatus } from '@notecloud/shared';

import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './client';
import { createTask } from './tasks';
import type { TaskDto } from './tasks';

export interface BoardSummary {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  columnCount: number;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardColumnDto {
  id: string;
  boardId: string;
  name: string;
  status: TaskStatus;
  position: number;
  color: string | null;
  wipLimit: number | null;
  tasks: TaskDto[];
}

export interface BoardDetail {
  board: {
    id: string;
    name: string;
    description: string | null;
    icon: string | null;
    color: string | null;
    createdAt: string;
    updatedAt: string;
  };
  columns: BoardColumnDto[];
}

export function listBoards(workspaceId: string) {
  return apiGet<{ items: BoardSummary[] }>(`/workspaces/${workspaceId}/boards`);
}

export function createBoard(
  workspaceId: string,
  payload: { name: string; description?: string | null; icon?: string | null; color?: string | null },
) {
  return apiPost<{ board: BoardSummary }>(`/workspaces/${workspaceId}/boards`, payload);
}

export function getBoard(workspaceId: string, boardId: string) {
  return apiGet<BoardDetail>(`/workspaces/${workspaceId}/boards/${boardId}`);
}

export function updateBoard(
  workspaceId: string,
  boardId: string,
  payload: { name?: string; description?: string | null; color?: string | null },
) {
  return apiPatch<{ board: BoardSummary }>(`/workspaces/${workspaceId}/boards/${boardId}`, payload);
}

export function deleteBoard(workspaceId: string, boardId: string) {
  return apiDelete<{ deleted: boolean }>(`/workspaces/${workspaceId}/boards/${boardId}`);
}

export function createColumn(
  workspaceId: string,
  boardId: string,
  payload: { name: string; status?: TaskStatus; color?: string | null; wipLimit?: number | null },
) {
  return apiPost<{ column: BoardColumnDto }>(`/workspaces/${workspaceId}/boards/${boardId}/columns`, payload);
}

export function updateColumn(
  workspaceId: string,
  columnId: string,
  payload: { name?: string; status?: TaskStatus; color?: string | null; wipLimit?: number | null },
) {
  return apiPatch<{ column: BoardColumnDto }>(`/workspaces/${workspaceId}/board-columns/${columnId}`, payload);
}

export function deleteColumn(workspaceId: string, columnId: string) {
  return apiDelete<{ deleted: boolean }>(`/workspaces/${workspaceId}/board-columns/${columnId}`);
}

export function reorderColumns(workspaceId: string, boardId: string, orderedIds: string[]) {
  return apiPost<{ reordered: boolean }>(`/workspaces/${workspaceId}/boards/${boardId}/columns/reorder`, {
    orderedIds,
  });
}

/** 拖动卡片：列 + 目标列的完整顺序 */
export function moveTask(
  workspaceId: string,
  boardId: string,
  payload: { taskId: string; columnId: string; orderedTaskIds: string[] },
) {
  return apiPost<BoardDetail>(`/workspaces/${workspaceId}/boards/${boardId}/move`, payload);
}

/** 在某一列新建卡片 —— 卡片就是任务，所以本质是带 columnId 建任务 */
export function createBoardCard(workspaceId: string, columnId: string, title: string) {
  return createTask(workspaceId, { title, columnId });
}

// ── 把已有任务放进看板 ──────────────────────────────────────────

export interface BoardColumnOption {
  id: string;
  name: string;
  status: TaskStatus;
  wipLimit: number | null;
}

export interface BoardColumnGroup {
  id: string;
  name: string;
  columns: BoardColumnOption[];
}

/** 所有看板的列（选择器用） */
export function listAllColumns(workspaceId: string) {
  return apiGet<{ boards: BoardColumnGroup[] }>(`/workspaces/${workspaceId}/board-columns`);
}

/** columnId = null 表示从看板移出 */
export function setTaskColumn(workspaceId: string, taskId: string, columnId: string | null) {
  return apiPut<{ task: TaskDto }>(`/workspaces/${workspaceId}/tasks/${taskId}/column`, { columnId });
}

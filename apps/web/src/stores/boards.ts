import { defineStore } from 'pinia';
import { computed, ref, toRaw } from 'vue';

import * as api from '@/api/boards';
import type { BoardColumnDto, BoardDetail } from '@/api/boards';

export const useBoardsStore = defineStore('boards', () => {
  const workspaceId = ref<string | null>(null);
  const boardId = ref<string | null>(null);

  const detail = ref<BoardDetail | null>(null);
  const loading = ref(false);
  const moving = ref(false);

  const columns = computed(() => detail.value?.columns ?? []);

  function reset(): void {
    workspaceId.value = null;
    boardId.value = null;
    detail.value = null;
  }

  async function load(wsId: string, bId: string): Promise<void> {
    workspaceId.value = wsId;
    boardId.value = bId;
    loading.value = true;
    try {
      detail.value = await api.getBoard(wsId, bId);
    } finally {
      loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    if (!workspaceId.value || !boardId.value) return;
    detail.value = await api.getBoard(workspaceId.value, boardId.value);
  }

  /** 拖动卡片：先乐观更新本地，失败再回滚重拉 */
  async function moveTask(taskId: string, toColumnId: string, orderedTaskIds: string[]): Promise<boolean> {
    if (!workspaceId.value || !boardId.value || !detail.value) return false;

    moving.value = true;
    let snapshot: BoardDetail | null = null;

    try {
      // ⚠️ detail.value 是 Vue 的响应式 Proxy，直接 structuredClone 会抛
      // DataCloneError（Proxy 不可结构化克隆）。必须先 toRaw 再克隆。
      snapshot = structuredClone(toRaw(detail.value));

      // 乐观更新：立刻把卡片从旧列移到新列，避免拖完等一个来回
      const fromColumn = detail.value.columns.find((c) => c.tasks.some((t) => t.id === taskId));
      const toColumn = detail.value.columns.find((c) => c.id === toColumnId);
      const task = fromColumn?.tasks.find((t) => t.id === taskId);

      if (fromColumn && toColumn && task) {
        fromColumn.tasks = fromColumn.tasks.filter((t) => t.id !== taskId);
        const nextTasks = toColumn.tasks.filter((t) => t.id !== taskId);
        const index = orderedTaskIds.indexOf(taskId);
        nextTasks.splice(index >= 0 ? index : nextTasks.length, 0, task);
        toColumn.tasks = nextTasks;
      }

      detail.value = await api.moveTask(workspaceId.value, boardId.value, {
        taskId,
        columnId: toColumnId,
        orderedTaskIds,
      });
      return true;
    } catch {
      // 任何异常都要回滚并让调用方弹提示，绝不静默失败
      if (snapshot) detail.value = snapshot;
      return false;
    } finally {
      moving.value = false;
    }
  }

  async function addCard(columnId: string, title: string): Promise<boolean> {
    if (!workspaceId.value || !boardId.value) return false;
    try {
      await api.createBoardCard(workspaceId.value, columnId, title);
      await refresh();
      return true;
    } catch {
      return false;
    }
  }

  async function createColumn(payload: {
    name: string;
    status?: BoardColumnDto['status'];
    wipLimit?: number | null;
    color?: string | null;
  }): Promise<boolean> {
    if (!workspaceId.value || !boardId.value) return false;
    try {
      await api.createColumn(workspaceId.value, boardId.value, payload);
      await refresh();
      return true;
    } catch {
      return false;
    }
  }

  async function updateColumn(columnId: string, payload: Parameters<typeof api.updateColumn>[2]): Promise<boolean> {
    if (!workspaceId.value) return false;
    try {
      await api.updateColumn(workspaceId.value, columnId, payload);
      await refresh();
      return true;
    } catch {
      return false;
    }
  }

  async function deleteColumn(columnId: string): Promise<boolean> {
    if (!workspaceId.value) return false;
    try {
      await api.deleteColumn(workspaceId.value, columnId);
      await refresh();
      return true;
    } catch {
      return false;
    }
  }

  return {
    workspaceId,
    boardId,
    detail,
    loading,
    moving,
    columns,
    reset,
    load,
    refresh,
    moveTask,
    addCard,
    createColumn,
    updateColumn,
    deleteColumn,
  };
});

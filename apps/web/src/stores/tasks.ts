import { ErrorCode, type TaskStatus, type TaskView } from '@notecloud/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import * as api from '@/api/tasks';
import type { CommentDto, TaskDto } from '@/api/tasks';
import type { TagDto } from '@/api/notes';
import * as notesApi from '@/api/notes';

interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskDto['priority'];
  startAt?: string | null;
  dueAt?: string | null;
  isAllDay?: boolean;
  assigneeId?: string | null;
  reminderAt?: string | null;
  tagIds?: string[];
  checklist?: Array<{ id?: string; title: string; done: boolean }>;
}

export const useTasksStore = defineStore('tasks', () => {
  const workspaceId = ref<string | null>(null);

  const tasks = ref<TaskDto[]>([]);
  const tags = ref<TagDto[]>([]);

  const view = ref<TaskView>('all');
  const tagId = ref<string | null>(null);
  const q = ref('');

  const loading = ref(false);
  const saving = ref(false);
  const conflict = ref<TaskDto | null>(null);

  const current = ref<TaskDto | null>(null);
  const comments = ref<CommentDto[]>([]);
  const commentsLoading = ref(false);

  const isTrashView = computed(() => view.value === 'trash');
  const isEmpty = computed(() => !loading.value && tasks.value.length === 0);

  function reset(): void {
    workspaceId.value = null;
    tasks.value = [];
    tags.value = [];
    current.value = null;
    comments.value = [];
    view.value = 'all';
    tagId.value = null;
    q.value = '';
    conflict.value = null;
  }

  async function init(wsId: string): Promise<void> {
    if (workspaceId.value !== wsId) reset();
    workspaceId.value = wsId;
    await Promise.all([loadTasks(), loadTags()]);
  }

  async function loadTags(): Promise<void> {
    if (!workspaceId.value) return;
    tags.value = (await notesApi.listTags(workspaceId.value)).items;
  }

  async function loadTasks(): Promise<void> {
    if (!workspaceId.value) return;
    loading.value = true;
    try {
      const page = await api.listTasks(workspaceId.value, {
        view: view.value,
        tagId: tagId.value,
        ...(q.value.trim() ? { q: q.value.trim() } : {}),
        limit: 100,
      });
      tasks.value = page.items;
    } finally {
      loading.value = false;
    }
  }

  function setView(next: TaskView): void {
    view.value = next;
    tagId.value = null;
    void loadTasks();
  }

  function selectTag(id: string | null): void {
    if (view.value === 'trash') view.value = 'all';
    tagId.value = id;
    void loadTasks();
  }

  function syncTask(task: TaskDto): void {
    const idx = tasks.value.findIndex((t) => t.id === task.id);
    if (idx >= 0) tasks.value[idx] = task;
  }

  async function openTask(id: string): Promise<void> {
    if (!workspaceId.value) return;
    conflict.value = null;
    current.value = (await api.getTask(workspaceId.value, id)).task;
    await loadComments(id);
  }

  async function createTask(payload: {
    title: string;
    dueAt?: string | null;
    priority?: TaskDto['priority'];
    status?: TaskStatus;
  }): Promise<TaskDto | null> {
    if (!workspaceId.value) return null;
    const created = await api.createTask(workspaceId.value, {
      title: payload.title,
      ...(payload.dueAt !== undefined ? { dueAt: payload.dueAt } : {}),
      ...(payload.priority ? { priority: payload.priority } : {}),
      ...(payload.status ? { status: payload.status } : {}),
      tagIds: tagId.value ? [tagId.value] : [],
    });
    await loadTasks();
    return created.task;
  }

  /** 保存（乐观锁）。409 时把服务端版本放进 conflict，交给 UI 决定 */
  async function save(patch: TaskPatch): Promise<'ok' | 'conflict' | 'error'> {
    if (!workspaceId.value || !current.value) return 'error';

    saving.value = true;
    try {
      const res = await api.updateTask(workspaceId.value, current.value.id, {
        version: current.value.version,
        ...patch,
      });
      current.value = res.task;
      syncTask(res.task);
      conflict.value = null;
      return 'ok';
    } catch (err) {
      const res = err as { code?: number; data?: { current?: TaskDto } };
      if (res.code === ErrorCode.VERSION_CONFLICT && res.data?.current) {
        conflict.value = res.data.current;
        return 'conflict';
      }
      return 'error';
    } finally {
      saving.value = false;
    }
  }

  function acceptRemote(): void {
    if (!conflict.value) return;
    current.value = conflict.value;
    conflict.value = null;
  }

  /** 列表里直接勾选完成/取消完成 */
  async function setStatus(task: TaskDto, status: TaskStatus): Promise<boolean> {
    if (!workspaceId.value) return false;
    try {
      const res = await api.updateTask(workspaceId.value, task.id, { version: task.version, status });
      if (current.value?.id === task.id) current.value = res.task;
      await loadTasks();
      return true;
    } catch {
      await loadTasks();
      return false;
    }
  }

  async function toggleChecklistItem(taskId: string, itemId: string, done: boolean): Promise<void> {
    if (!workspaceId.value) return;
    const res = await api.toggleChecklist(workspaceId.value, taskId, itemId, done);
    if (current.value?.id === taskId) current.value = res.task;
    syncTask(res.task);
  }

  async function trash(id: string): Promise<void> {
    if (!workspaceId.value) return;
    await api.trashTask(workspaceId.value, id);
    if (current.value?.id === id) current.value = null;
    await loadTasks();
  }

  async function restore(id: string): Promise<void> {
    if (!workspaceId.value) return;
    await api.restoreTask(workspaceId.value, id);
    await loadTasks();
  }

  async function purge(id: string): Promise<void> {
    if (!workspaceId.value) return;
    await api.purgeTask(workspaceId.value, id);
    await loadTasks();
  }

  async function loadComments(taskId: string): Promise<void> {
    if (!workspaceId.value) return;
    commentsLoading.value = true;
    try {
      comments.value = (await api.listComments(workspaceId.value, taskId)).items;
    } finally {
      commentsLoading.value = false;
    }
  }

  async function addComment(body: string, mentions: string[] = []): Promise<void> {
    if (!workspaceId.value || !current.value) return;
    await api.createComment(workspaceId.value, current.value.id, {
      body,
      ...(mentions.length ? { mentions } : {}),
    });
    await loadComments(current.value.id);
  }

  async function removeComment(commentId: string): Promise<void> {
    if (!workspaceId.value || !current.value) return;
    await api.deleteComment(workspaceId.value, commentId);
    await loadComments(current.value.id);
  }

  return {
    workspaceId,
    tasks,
    tags,
    view,
    tagId,
    q,
    loading,
    saving,
    conflict,
    current,
    comments,
    commentsLoading,
    isTrashView,
    isEmpty,
    init,
    reset,
    loadTasks,
    loadTags,
    setView,
    selectTag,
    openTask,
    createTask,
    save,
    acceptRemote,
    setStatus,
    toggleChecklistItem,
    trash,
    restore,
    purge,
    loadComments,
    addComment,
    removeComment,
  };
});

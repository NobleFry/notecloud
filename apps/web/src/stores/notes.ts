import { ErrorCode, type NoteView, type ResourceVisibility } from '@notecloud/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import * as api from '@/api/notes';
import type { NoteDetail, NoteListItem, NotebookDto, TagDto } from '@/api/notes';

interface SavePatch {
  title?: string;
  content?: string;
  visibility?: ResourceVisibility;
  isPinned?: boolean;
  isStarred?: boolean;
  archived?: boolean;
}

export const useNotesStore = defineStore('notes', () => {
  const workspaceId = ref<string | null>(null);

  const notebooks = ref<NotebookDto[]>([]);
  const tags = ref<TagDto[]>([]);

  const notes = ref<NoteListItem[]>([]);
  const current = ref<NoteDetail | null>(null);

  // ── 列表过滤状态 ──
  const view = ref<NoteView>('all');
  const notebookId = ref<string | null>(null);
  const tagId = ref<string | null>(null);
  const q = ref('');

  const loadingList = ref(false);
  const loadingNote = ref(false);
  const hasMore = ref(false);
  const cursor = ref<string | null>(null);

  // ── 保存状态 ──
  const saving = ref(false);
  const lastSavedAt = ref<Date | null>(null);
  /** 409 时服务端的最新版本，用于冲突提示 */
  const conflict = ref<NoteDetail | null>(null);

  const isTrashView = computed(() => view.value === 'trash');
  const isEmpty = computed(() => !loadingList.value && notes.value.length === 0);

  function reset(): void {
    workspaceId.value = null;
    notebooks.value = [];
    tags.value = [];
    notes.value = [];
    current.value = null;
    view.value = 'all';
    notebookId.value = null;
    tagId.value = null;
    q.value = '';
    cursor.value = null;
    hasMore.value = false;
    conflict.value = null;
    lastSavedAt.value = null;
  }

  async function init(wsId: string): Promise<void> {
    if (workspaceId.value !== wsId) reset();
    workspaceId.value = wsId;
    await Promise.all([loadNotebooks(), loadTags(), loadNotes(true)]);
  }

  async function loadNotebooks(): Promise<void> {
    if (!workspaceId.value) return;
    notebooks.value = (await api.listNotebooks(workspaceId.value)).items;
  }

  async function loadTags(): Promise<void> {
    if (!workspaceId.value) return;
    tags.value = (await api.listTags(workspaceId.value)).items;
  }

  async function loadNotes(resetList = true): Promise<void> {
    if (!workspaceId.value) return;
    loadingList.value = true;
    try {
      const page = await api.listNotes(workspaceId.value, {
        view: view.value,
        notebookId: notebookId.value,
        tagId: tagId.value,
        ...(q.value.trim() ? { q: q.value.trim() } : {}),
        limit: 30,
        ...(resetList ? {} : { cursor: cursor.value }),
      });

      notes.value = resetList ? page.items : [...notes.value, ...page.items];
      cursor.value = page.nextCursor;
      hasMore.value = page.hasMore;
    } finally {
      loadingList.value = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value) return;
    await loadNotes(false);
  }

  function setView(next: NoteView): void {
    view.value = next;
    notebookId.value = null;
    tagId.value = null;
    current.value = null;
    void loadNotes(true);
  }

  function selectNotebook(id: string | null): void {
    view.value = 'all';
    notebookId.value = id;
    tagId.value = null;
    current.value = null;
    void loadNotes(true);
  }

  function selectTag(id: string | null): void {
    view.value = 'all';
    tagId.value = id;
    notebookId.value = null;
    current.value = null;
    void loadNotes(true);
  }

  /** 应用一个保存的过滤器（智能视图） */
  function applyFilter(filter: { view?: NoteView; notebookId?: string; tagId?: string; q?: string }): void {
    view.value = filter.view ?? 'all';
    notebookId.value = filter.notebookId ?? null;
    tagId.value = filter.tagId ?? null;
    q.value = filter.q ?? '';
    current.value = null;
    void loadNotes(true);
  }

  async function openNote(id: string): Promise<void> {
    if (!workspaceId.value) return;
    loadingNote.value = true;
    conflict.value = null;
    try {
      current.value = (await api.getNote(workspaceId.value, id)).note;
      lastSavedAt.value = null;
    } finally {
      loadingNote.value = false;
    }
  }

  async function createNew(init?: {
    title?: string;
    content?: string;
    notebookIds?: string[];
    tagIds?: string[];
  }): Promise<NoteDetail | null> {
    if (!workspaceId.value) return null;
    const created = await api.createNote(workspaceId.value, {
      title: init?.title ?? '',
      content: init?.content ?? '',
      notebookIds: init?.notebookIds ?? (notebookId.value ? [notebookId.value] : []),
      tagIds: init?.tagIds ?? (tagId.value ? [tagId.value] : []),
    });
    current.value = created.note;
    lastSavedAt.value = null;
    await loadNotes(true);
    return created.note;
  }

  /** 把保存结果回填到列表，避免每次自动保存都重拉整个列表 */
  function syncListItem(note: NoteDetail): void {
    const idx = notes.value.findIndex((n) => n.id === note.id);
    if (idx >= 0) {
      notes.value[idx] = {
        ...notes.value[idx]!,
        title: note.title,
        excerpt: note.excerpt,
        version: note.version,
        updatedAt: note.updatedAt,
        isPinned: note.isPinned,
        isStarred: note.isStarred,
      };
    }
  }

  /**
   * 保存。带 version 做乐观锁。
   * 409 时不覆盖，把服务端版本放进 conflict 交给 UI 决定。
   */
  async function save(patch: SavePatch): Promise<'ok' | 'conflict' | 'error'> {
    if (!workspaceId.value || !current.value) return 'error';

    saving.value = true;
    try {
      const res = await api.updateNote(workspaceId.value, current.value.id, {
        version: current.value.version,
        ...patch,
      });
      current.value = res.note;
      syncListItem(res.note);
      lastSavedAt.value = new Date();
      conflict.value = null;
      return 'ok';
    } catch (err) {
      const res = err as { code?: number; data?: { current?: NoteDetail } };
      if (res.code === ErrorCode.VERSION_CONFLICT && res.data?.current) {
        conflict.value = res.data.current;
        return 'conflict';
      }
      return 'error';
    } finally {
      saving.value = false;
    }
  }

  /** 用服务端版本覆盖本地编辑 */
  function acceptRemote(): void {
    if (!conflict.value) return;
    current.value = conflict.value;
    conflict.value = null;
  }

  /** 用自己的内容覆盖服务端（以服务端最新版本号为基准重新提交） */
  async function overwriteRemote(patch: SavePatch): Promise<boolean> {
    if (!conflict.value || !current.value) return false;
    const base = conflict.value;
    conflict.value = null;
    current.value = { ...current.value, version: base.version };
    const result = await save(patch);
    return result === 'ok';
  }

  async function reloadCurrent(): Promise<void> {
    if (!workspaceId.value || !current.value) return;
    await openNote(current.value.id);
  }

  async function moveToTrash(id: string): Promise<void> {
    if (!workspaceId.value) return;
    await api.trashNote(workspaceId.value, id);
    if (current.value?.id === id) current.value = null;
    await loadNotes(true);
    await loadNotebooks();
  }

  async function restore(id: string): Promise<void> {
    if (!workspaceId.value) return;
    await api.restoreNote(workspaceId.value, id);
    await loadNotes(true);
  }

  async function purge(id: string): Promise<void> {
    if (!workspaceId.value) return;
    await api.purgeNote(workspaceId.value, id);
    await loadNotes(true);
  }

  async function emptyTrash(): Promise<number> {
    if (!workspaceId.value) return 0;
    const res = await api.emptyTrash(workspaceId.value);
    await loadNotes(true);
    return res.purged;
  }

  async function setNotebooksForCurrent(ids: string[]): Promise<void> {
    if (!workspaceId.value || !current.value) return;
    await api.setNoteNotebooks(workspaceId.value, current.value.id, ids);
    current.value = { ...current.value, notebookIds: ids };
    syncListItem(current.value);
    await loadNotebooks();
    await loadNotes(true);
  }

  async function setTagsForCurrent(ids: string[]): Promise<void> {
    if (!workspaceId.value || !current.value) return;
    await api.setNoteTags(workspaceId.value, current.value.id, ids);
    await reloadCurrent();
    await loadTags();
    await loadNotes(true);
  }

  return {
    workspaceId,
    notebooks,
    tags,
    notes,
    current,
    view,
    notebookId,
    tagId,
    q,
    loadingList,
    loadingNote,
    hasMore,
    saving,
    lastSavedAt,
    conflict,
    isTrashView,
    isEmpty,
    init,
    reset,
    loadNotebooks,
    loadTags,
    loadNotes,
    loadMore,
    setView,
    selectNotebook,
    selectTag,
    applyFilter,
    openNote,
    createNew,
    save,
    acceptRemote,
    overwriteRemote,
    reloadCurrent,
    moveToTrash,
    restore,
    purge,
    emptyTrash,
    setNotebooksForCurrent,
    setTagsForCurrent,
  };
});

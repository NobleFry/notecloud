<script setup lang="ts">
import { NButton, NDropdown, NEmpty, NInput, NModal, NTooltip, useMessage } from 'naive-ui';
import { computed, ref } from 'vue';

import type { NotebookDto } from '@/api/notes';
import * as api from '@/api/notes';
import { useNotesStore } from '@/stores/notes';
import { errorMessage } from '@/utils/error';

const store = useNotesStore();
const message = useMessage();

interface FlatNode {
  node: NotebookDto;
  depth: number;
}

/** 把树拍平成带缩进的列表 —— 比递归组件好渲染、好做拖拽 */
const flat = computed<FlatNode[]>(() => {
  const byParent = new Map<string | null, NotebookDto[]>();
  for (const n of store.notebooks) {
    const key = n.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  const out: FlatNode[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const node of byParent.get(parentId) ?? []) {
      out.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
});

function childrenOf(parentId: string | null): NotebookDto[] {
  return store.notebooks
    .filter((n) => (n.parentId ?? null) === parentId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

const totalCount = computed(() => store.notebooks.reduce((sum, n) => sum + n.noteCount, 0));

// ── 拖拽 ────────────────────────────────────────────────────────
const draggingId = ref<string | null>(null);
const dropTarget = ref<{ id: string; zone: 'before' | 'after' | 'inside' } | null>(null);
const rootDropActive = ref(false);

function resetDrag(): void {
  draggingId.value = null;
  dropTarget.value = null;
  rootDropActive.value = false;
}

function onDragStart(event: DragEvent, node: NotebookDto): void {
  draggingId.value = node.id;
  dropTarget.value = null;
  if (event.dataTransfer) {
    // Firefox 必须 setData，否则 drag 不会启动
    event.dataTransfer.setData('text/plain', node.id);
    event.dataTransfer.effectAllowed = 'move';
  }
}

function onDragOver(event: DragEvent, node: NotebookDto): void {
  if (!draggingId.value || draggingId.value === node.id) return;
  event.preventDefault();
  event.stopPropagation();
  rootDropActive.value = false;

  const el = event.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;

  dropTarget.value = {
    id: node.id,
    // 上下 30% 是同级插入，中间是成为子节点
    zone: ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'inside',
  };
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();

  const target = dropTarget.value;
  const draggedId = draggingId.value;
  resetDrag();
  if (!target || !draggedId) return;

  const dragged = store.notebooks.find((n) => n.id === draggedId);
  const node = store.notebooks.find((n) => n.id === target.id);
  if (!dragged || !node) return;

  let parentId: string | null;
  let index: number;

  if (target.zone === 'inside') {
    parentId = node.id;
    index = childrenOf(node.id).filter((n) => n.id !== draggedId).length;
  } else {
    parentId = node.parentId ?? null;
    const siblings = childrenOf(parentId).filter((n) => n.id !== draggedId);
    const at = siblings.findIndex((n) => n.id === node.id);
    index = target.zone === 'before' ? at : at + 1;
  }

  await commitMove(dragged, parentId, index);
}

function onRootDragOver(event: DragEvent): void {
  if (!draggingId.value) return;
  event.preventDefault();
  dropTarget.value = null;
  rootDropActive.value = true;
}

async function onRootDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  const draggedId = draggingId.value;
  resetDrag();
  if (!draggedId) return;

  const dragged = store.notebooks.find((n) => n.id === draggedId);
  if (!dragged) return;

  await commitMove(dragged, null, childrenOf(null).filter((n) => n.id !== draggedId).length);
}

/**
 * 提交移动。
 *
 * 两步：先重排目标父级（后端会做环路/深度校验，失败就整体不动），
 * 再重排源父级把留下的空位收紧。顺序不能反 —— 否则目标校验失败时
 * 源列表已经改了，会留下不一致的序号。
 */
async function commitMove(dragged: NotebookDto, parentId: string | null, index: number): Promise<void> {
  const ws = store.workspaceId;
  if (!ws) return;

  const oldParentId = dragged.parentId ?? null;
  const targetList = childrenOf(parentId).filter((n) => n.id !== dragged.id);
  const at = Math.max(0, Math.min(index, targetList.length));
  const ordered = [...targetList.slice(0, at), dragged, ...targetList.slice(at)];

  try {
    await api.reorderNotebooks(ws, { parentId, orderedIds: ordered.map((n) => n.id) });

    if (oldParentId !== parentId) {
      const sourceList = childrenOf(oldParentId).filter((n) => n.id !== dragged.id);
      await api.reorderNotebooks(ws, { parentId: oldParentId, orderedIds: sourceList.map((n) => n.id) });
    }

    await store.loadNotebooks();
  } catch (err) {
    message.error(errorMessage(err));
    // 失败就回到服务端真实状态，别让本地树和库里不一致
    await store.loadNotebooks();
  }
}

// ── 新建 / 重命名 ──────────────────────────────────────────────
const editor = ref<{
  open: boolean;
  mode: 'create' | 'rename';
  parentId: string | null;
  id: string | null;
  name: string;
}>({ open: false, mode: 'create', parentId: null, id: null, name: '' });

const submitting = ref(false);

function openCreate(parentId: string | null): void {
  editor.value = { open: true, mode: 'create', parentId, id: null, name: '' };
}

function openRename(node: NotebookDto): void {
  editor.value = { open: true, mode: 'rename', parentId: node.parentId, id: node.id, name: node.name };
}

async function submitEditor(): Promise<void> {
  const name = editor.value.name.trim();
  if (!name) {
    message.warning('请填写名称');
    return;
  }

  submitting.value = true;
  try {
    if (editor.value.mode === 'create') {
      await api.createNotebook(store.workspaceId!, { name, parentId: editor.value.parentId });
    } else if (editor.value.id) {
      await api.updateNotebook(store.workspaceId!, editor.value.id, { name });
    }
    await store.loadNotebooks();
    editor.value.open = false;
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    submitting.value = false;
  }
}

async function remove(node: NotebookDto): Promise<void> {
  try {
    const res = await api.deleteNotebook(store.workspaceId!, node.id);
    message.success(`已删除「${node.name}」（${res.deletedCount} 个），其中的笔记已移到收件箱`);
    if (store.notebookId === node.id) store.selectNotebook(null);
    await store.loadNotebooks();
  } catch (err) {
    message.error(errorMessage(err));
  }
}

function menuFor(node: NotebookDto) {
  return [
    { label: '新建子笔记本', key: 'create-child', disabled: node.depth >= 4 },
    { label: '重命名', key: 'rename' },
    { type: 'divider', key: 'd' },
    { label: '删除', key: 'delete' },
  ];
}

function onMenu(key: string, node: NotebookDto): void {
  if (key === 'create-child') openCreate(node.id);
  if (key === 'rename') openRename(node);
  if (key === 'delete') void remove(node);
}
</script>

<template>
  <div class="nc-tree">
    <div class="nc-tree__head">
      <span class="nc-tree__title">笔记本</span>
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button size="tiny" quaternary @click="openCreate(null)">＋</n-button>
        </template>
        新建根笔记本
      </n-tooltip>
    </div>

    <div class="nc-tree__list" @dragend="resetDrag">
      <!-- 收件箱：没有归属任何笔记本的笔记 -->
      <div
        class="nc-tree__row"
        :class="{ 'is-active': store.notebookId === 'none' }"
        @click="store.selectNotebook('none')"
      >
        <span class="nc-tree__icon">📥</span>
        <span class="nc-tree__name">收件箱</span>
      </div>

      <div
        v-for="item in flat"
        :key="item.node.id"
        class="nc-tree__row"
        :class="[
          { 'is-active': store.notebookId === item.node.id, 'is-dragging': draggingId === item.node.id },
          dropTarget?.id === item.node.id ? `is-drop-${dropTarget.zone}` : '',
        ]"
        :style="{ paddingLeft: `${8 + item.depth * 14}px` }"
        draggable="true"
        @click="store.selectNotebook(item.node.id)"
        @dragstart="onDragStart($event, item.node)"
        @dragover="onDragOver($event, item.node)"
        @drop="onDrop"
        @dragend="resetDrag"
      >
        <span class="nc-tree__icon">{{ item.node.icon || (item.depth > 0 ? '📄' : '📁') }}</span>
        <span class="nc-tree__name" :title="item.node.name">{{ item.node.name }}</span>
        <span v-if="item.node.noteCount > 0" class="nc-tree__count">{{ item.node.noteCount }}</span>

        <n-dropdown
          trigger="click"
          :options="menuFor(item.node)"
          @select="(key: string) => onMenu(key, item.node)"
        >
          <span class="nc-tree__more" @click.stop>⋯</span>
        </n-dropdown>
      </div>

      <!-- 拖到根目录 -->
      <div
        v-if="draggingId"
        class="nc-tree__rootdrop"
        :class="{ 'is-over': rootDropActive }"
        @dragover="onRootDragOver"
        @drop="onRootDrop"
      >
        拖到这里移到根目录
      </div>

      <n-empty
        v-if="flat.length === 0"
        size="small"
        description="还没有笔记本"
        style="margin: 16px 0"
      />
    </div>

    <div v-if="flat.length > 0" class="nc-tree__foot">
      共 {{ totalCount }} 条笔记已归类 · 可拖拽整理
    </div>

    <n-modal
      v-model:show="editor.open"
      preset="card"
      :title="editor.mode === 'create' ? '新建笔记本' : '重命名笔记本'"
      style="max-width: 380px"
    >
      <n-input
        v-model:value="editor.name"
        placeholder="例如：产品设计"
        :maxlength="64"
        @keyup.enter="submitEditor"
      />
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="editor.open = false">取消</n-button>
          <n-button type="primary" :loading="submitting" @click="submitEditor">确定</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.nc-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.nc-tree__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 6px;
  flex: 0 0 auto;
}

.nc-tree__title {
  font-size: 12px;
  font-weight: 600;
  color: #8a8f99;
  letter-spacing: 0.04em;
}

.nc-tree__list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 2px 6px;
}

.nc-tree__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #333;
  user-select: none;
  transition: background 0.12s ease;
}

.nc-tree__row:hover {
  background: #f4f6f8;
}

.nc-tree__row.is-active {
  background: #e8f3ee;
  color: #18a058;
  font-weight: 500;
}

.nc-tree__row.is-dragging {
  opacity: 0.45;
}

/* 拖拽指示：上下边缘插入 vs 中间成为子节点 */
.nc-tree__row.is-drop-before {
  box-shadow: inset 0 2px 0 #18a058;
}

.nc-tree__row.is-drop-after {
  box-shadow: inset 0 -2px 0 #18a058;
}

.nc-tree__row.is-drop-inside {
  background: #e8f3ee;
  outline: 1.5px dashed #18a058;
  outline-offset: -1.5px;
}

.nc-tree__icon {
  flex: 0 0 auto;
  font-size: 13px;
}

.nc-tree__name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-tree__count {
  flex: 0 0 auto;
  font-size: 11px;
  color: #9aa1ab;
}

.nc-tree__more {
  flex: 0 0 auto;
  padding: 0 4px;
  color: #b0b6bf;
  opacity: 0;
}

.nc-tree__row:hover .nc-tree__more {
  opacity: 1;
}

.nc-tree__rootdrop {
  margin: 8px 4px;
  padding: 10px;
  border: 1.5px dashed #d4d9df;
  border-radius: 8px;
  text-align: center;
  font-size: 12px;
  color: #9aa1ab;
}

.nc-tree__rootdrop.is-over {
  border-color: #18a058;
  color: #18a058;
  background: #eef8f2;
}

.nc-tree__foot {
  flex: 0 0 auto;
  padding: 8px 12px;
  font-size: 11px;
  color: #a0a6af;
  border-top: 1px solid #f2f3f5;
}
</style>

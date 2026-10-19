<script setup lang="ts">
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_COLOR,
  TASK_PRIORITY_LABEL,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  type TaskPriority,
  type TaskStatus,
} from '@notecloud/shared';
import {
  NAlert,
  NAvatar,
  NButton,
  NDatePicker,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import type { BoardColumnDto } from '@/api/boards';
import { setTaskColumn } from '@/api/boards';
import type { TaskDto } from '@/api/tasks';
import { listTasks } from '@/api/tasks';
import { useBoardsStore } from '@/stores/boards';
import { useRealtimeStore } from '@/stores/realtime';
import { useTasksStore } from '@/stores/tasks';
import { errorMessage } from '@/utils/error';

const route = useRoute();
const boards = useBoardsStore();
const tasks = useTasksStore();
const realtime = useRealtimeStore();
const message = useMessage();

const workspaceId = computed(() => String(route.params.id ?? ''));
const boardId = computed(() => String(route.params.boardId ?? ''));

let offRealtime: (() => void) | null = null;

onMounted(async () => {
  try {
    await boards.load(workspaceId.value, boardId.value);
    // 卡片详情复用任务 store（卡片就是任务）
    await tasks.init(workspaceId.value);

    // 别人移动了卡片 → 直接重拉这块看板（自己触发的会被服务端排除）
    offRealtime = realtime.subscribe('board.changed', (event) => {
      if (event.payload?.boardId === boardId.value) void boards.refresh();
    });
  } catch (err) {
    message.error(errorMessage(err));
  }
});

onBeforeUnmount(() => {
  offRealtime?.();
});

// ── 拖拽 ────────────────────────────────────────────────────────
const dragging = ref<string | null>(null);
const dropHint = ref<{ columnId: string; index: number } | null>(null);
/** 拖拽刚结束时浏览器还会补一个 click，用它把误触的"打开卡片"挡掉 */
let lastDragEndAt = 0;

function onDragStart(event: DragEvent, task: TaskDto): void {
  dragging.value = task.id;
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', task.id);
    event.dataTransfer.effectAllowed = 'move';
  }
}

function onDragEnd(): void {
  dragging.value = null;
  dropHint.value = null;
  lastDragEndAt = Date.now();
}

function idsWithoutDragged(columnId: string): string[] {
  const column = boards.columns.find((c) => c.id === columnId);
  return (column?.tasks ?? []).filter((t) => t.id !== dragging.value).map((t) => t.id);
}

function onCardDragOver(event: DragEvent, columnId: string, taskId: string): void {
  if (!dragging.value) return;
  event.preventDefault();
  event.stopPropagation();

  // 悬停在"被拖动的卡片自己"身上时不更新落点，
  // 否则它会被过滤掉、indexOf 返回 -1，落点每次都变成列首
  if (taskId === dragging.value) return;

  const ids = idsWithoutDragged(columnId);
  const index = ids.indexOf(taskId);
  const el = event.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;

  dropHint.value = { columnId, index: Math.max(0, index + (after ? 1 : 0)) };
}

function onColumnDragOver(event: DragEvent, columnId: string): void {
  if (!dragging.value) return;
  event.preventDefault();
  // 能走到这里说明光标不在任何卡片上（卡片上的 dragover 已经 stopPropagation），
  // 统一视为"放到这一列末尾"
  dropHint.value = { columnId, index: idsWithoutDragged(columnId).length };
}

async function onDrop(event: DragEvent, columnId: string): Promise<void> {
  event.preventDefault();

  const taskId = dragging.value;
  const hint = dropHint.value;
  dragging.value = null;
  dropHint.value = null;
  lastDragEndAt = Date.now();

  if (!taskId || !hint || hint.columnId !== columnId) return;

  const column = boards.columns.find((c) => c.id === columnId);
  const ids = (column?.tasks ?? []).filter((t) => t.id !== taskId).map((t) => t.id);
  const index = Math.max(0, Math.min(hint.index, ids.length));
  ids.splice(index, 0, taskId);

  const ok = await boards.moveTask(taskId, columnId, ids);
  if (!ok) message.error('移动失败：可能触发了 WIP 上限，或没有权限');
}

// ── 新建卡片 ────────────────────────────────────────────────────
const addingIn = ref<string | null>(null);
const newCardTitle = ref('');

function startAdd(columnId: string): void {
  addingIn.value = columnId;
  newCardTitle.value = '';
}

async function submitCard(columnId: string): Promise<void> {
  const title = newCardTitle.value.trim();
  if (!title) {
    addingIn.value = null;
    return;
  }

  const ok = await boards.addCard(columnId, title);
  if (ok) {
    newCardTitle.value = '';
  } else {
    message.error('添加失败');
  }
}

// ── 把已有待办加进看板 ──────────────────────────────────────────
const pickModal = ref({ open: false, columnId: '', columnName: '' });
const pickTasks = ref<TaskDto[]>([]);
const pickLoading = ref(false);
const pickQuery = ref('');
let pickTimer: number | null = null;

async function fetchPickTasks(): Promise<void> {
  pickLoading.value = true;
  try {
    const res = await listTasks(workspaceId.value, {
      view: 'all',
      unassigned: true,
      ...(pickQuery.value.trim() ? { q: pickQuery.value.trim() } : {}),
      limit: 50,
    });
    pickTasks.value = res.items;
  } catch {
    pickTasks.value = [];
  } finally {
    pickLoading.value = false;
  }
}

async function openPicker(column: BoardColumnDto): Promise<void> {
  pickModal.value = { open: true, columnId: column.id, columnName: column.name };
  pickQuery.value = '';
  await fetchPickTasks();
}

function onPickSearch(): void {
  if (pickTimer) window.clearTimeout(pickTimer);
  pickTimer = window.setTimeout(() => void fetchPickTasks(), 300);
}

async function addExisting(task: TaskDto): Promise<void> {
  try {
    await setTaskColumn(workspaceId.value, task.id, pickModal.value.columnId);
  } catch {
    message.error('添加失败：可能触发了 WIP 上限');
    return;
  }

  pickTasks.value = pickTasks.value.filter((t) => t.id !== task.id);
  await boards.refresh();
  message.success(`已添加「${task.title}」`);
}

// ── 列设置 ──────────────────────────────────────────────────────
const columnModal = ref<{
  open: boolean;
  mode: 'create' | 'edit';
  id: string | null;
  name: string;
  status: TaskStatus;
  wipLimit: number | null;
}>({ open: false, mode: 'create', id: null, name: '', status: 'TODO', wipLimit: null });

const columnSaving = ref(false);

function openCreateColumn(): void {
  columnModal.value = { open: true, mode: 'create', id: null, name: '', status: 'TODO', wipLimit: null };
}

function openEditColumn(column: BoardColumnDto): void {
  columnModal.value = {
    open: true,
    mode: 'edit',
    id: column.id,
    name: column.name,
    status: column.status,
    wipLimit: column.wipLimit,
  };
}

async function saveColumn(): Promise<void> {
  const name = columnModal.value.name.trim();
  if (!name) {
    message.warning('请填写列名');
    return;
  }

  columnSaving.value = true;
  try {
    const ok =
      columnModal.value.mode === 'create'
        ? await boards.createColumn({
            name,
            status: columnModal.value.status,
            wipLimit: columnModal.value.wipLimit,
          })
        : await boards.updateColumn(columnModal.value.id!, {
            name,
            status: columnModal.value.status,
            wipLimit: columnModal.value.wipLimit,
          });

    if (ok) {
      columnModal.value.open = false;
      message.success('已保存');
    } else {
      message.error('保存失败');
    }
  } finally {
    columnSaving.value = false;
  }
}

async function removeColumn(column: BoardColumnDto): Promise<void> {
  const ok = await boards.deleteColumn(column.id);
  if (ok) message.success(`已删除列「${column.name}」，其中的卡片已脱离看板`);
  else message.error('删除失败：看板至少要保留一列');
}

// ── 卡片详情（精简版，完整版在待办页）──────────────────────────
const cardOpen = ref(false);
const cardDraft = ref({
  title: '',
  description: '',
  priority: 'NONE' as TaskPriority,
  dueAt: null as number | null,
});
const cardSaving = ref(false);

const priorityOptions = TASK_PRIORITIES.map((p) => ({ label: TASK_PRIORITY_LABEL[p], value: p }));
const statusOptions = TASK_STATUSES.map((s) => ({ label: TASK_STATUS_LABEL[s], value: s }));

async function openCard(task: TaskDto): Promise<void> {
  // 拖拽刚结束时浏览器会补一个 click，别把它当成"打开卡片"
  if (dragging.value || Date.now() - lastDragEndAt < 250) return;

  await tasks.openTask(task.id);
  const t = tasks.current;
  if (!t) return;

  cardDraft.value = {
    title: t.title,
    description: t.description ?? '',
    priority: t.priority,
    dueAt: t.dueAt ? new Date(t.dueAt).getTime() : null,
  };
  cardOpen.value = true;
}

async function saveCard(): Promise<void> {
  cardSaving.value = true;
  try {
    const result = await tasks.save({
      title: cardDraft.value.title.trim() || '未命名任务',
      description: cardDraft.value.description || null,
      priority: cardDraft.value.priority,
      dueAt: cardDraft.value.dueAt ? new Date(cardDraft.value.dueAt).toISOString() : null,
    });

    if (result === 'ok') {
      await boards.refresh();
      cardOpen.value = false;
      message.success('已保存');
    } else if (result === 'conflict') {
      message.warning('这项任务已被他人修改，请刷新后重试');
      boards.refresh();
    } else {
      message.error('保存失败');
    }
  } finally {
    cardSaving.value = false;
  }
}

function isEmptyColumn(column: BoardColumnDto): boolean {
  return column.tasks.length === 0;
}

function isOverWip(column: BoardColumnDto): boolean {
  return Boolean(column.wipLimit && column.tasks.length > column.wipLimit);
}

function formatDue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function isOverdue(iso: string | null): boolean {
  return Boolean(iso) && new Date(iso!).getTime() < Date.now();
}
</script>

<template>
  <div class="nc-board">
    <header class="nc-board__head">
      <div style="display: flex; align-items: center; gap: 10px; min-width: 0">
        <RouterLink :to="{ name: 'boards', params: { id: workspaceId } }" class="nc-board__back">
          ← 所有看板
        </RouterLink>
        <strong class="nc-board__title">{{ boards.detail?.board.name ?? '看板' }}</strong>
        <span class="nc-muted">{{ boards.columns.length }} 列</span>
      </div>

      <n-button size="small" @click="openCreateColumn">＋ 添加列</n-button>
    </header>

    <n-spin v-if="boards.loading" style="display: block; margin: 80px auto" />

    <div v-else class="nc-board__columns">
      <section
        v-for="column in boards.columns"
        :key="column.id"
        class="nc-col"
        :class="{ 'is-drop-target': dropHint?.columnId === column.id }"
        @dragover="onColumnDragOver($event, column.id)"
        @drop="onDrop($event, column.id)"
      >
        <header class="nc-col__head">
          <span class="nc-col__dot" :style="{ background: column.color ?? '#c9ced6' }" />
          <span class="nc-col__name">{{ column.name }}</span>
          <span class="nc-col__count" :class="{ 'is-over': isOverWip(column) }">
            {{ column.tasks.length }}<template v-if="column.wipLimit">/{{ column.wipLimit }}</template>
          </span>
          <n-button size="tiny" quaternary @click="openEditColumn(column)">⋯</n-button>
        </header>

        <div class="nc-col__body">
          <div
            v-for="(task, index) in column.tasks"
            :key="task.id"
            class="nc-card"
            :class="{
              'is-dragging': dragging === task.id,
              'is-drop-before': dropHint?.columnId === column.id && dropHint?.index === index,
              'is-drop-after':
                dropHint?.columnId === column.id &&
                dropHint?.index === index + 1 &&
                index === column.tasks.length - 1,
            }"
            draggable="true"
            @dragstart="onDragStart($event, task)"
            @dragend="onDragEnd"
            @dragover="onCardDragOver($event, column.id, task.id)"
            @drop="onDrop($event, column.id)"
            @click="openCard(task)"
          >
            <div class="nc-card__title">{{ task.title }}</div>

            <div v-if="task.tags.length" class="nc-card__tags">
              <n-tag v-for="t in task.tags" :key="t.id" size="tiny" :bordered="false" :color="{ color: t.color ?? '#eef0f2', textColor: '#334' }">
                {{ t.name }}
              </n-tag>
            </div>

            <div class="nc-card__meta">
              <span v-if="task.priority !== 'NONE'" :style="{ color: TASK_PRIORITY_COLOR[task.priority] }">
                ● {{ TASK_PRIORITY_LABEL[task.priority] }}
              </span>
              <span v-if="task.dueAt" :class="{ 'is-overdue': isOverdue(task.dueAt) }">
                📅 {{ formatDue(task.dueAt) }}
              </span>
              <span v-if="task.checklistTotal > 0">☑ {{ task.checklistDone }}/{{ task.checklistTotal }}</span>
              <n-avatar
                v-if="task.assignee"
                round
                :size="18"
                :src="task.assignee.avatarUrl ?? undefined"
                style="margin-left: auto"
              >
                {{ task.assignee.name[0] }}
              </n-avatar>
            </div>
          </div>

          <div v-if="addingIn === column.id" class="nc-col__add">
            <n-input
              v-model:value="newCardTitle"
              size="small"
              placeholder="卡片标题，回车创建"
              autofocus
              @keyup.enter="submitCard(column.id)"
              @keyup.esc="addingIn = null"
            />
            <div style="display: flex; gap: 6px; margin-top: 6px">
              <n-button size="tiny" type="primary" @click="submitCard(column.id)">添加</n-button>
              <n-button size="tiny" quaternary @click="addingIn = null">取消</n-button>
            </div>
          </div>

          <button v-else class="nc-col__addbtn" @click="startAdd(column.id)">＋ 添加卡片</button>

          <button
            v-if="addingIn !== column.id"
            class="nc-col__addbtn"
            title="把「待办」里已有的任务加进来"
            @click="openPicker(column)"
          >
            从待办添加
          </button>

          <n-empty v-if="isEmptyColumn(column) && addingIn !== column.id" size="tiny" description="" style="margin: 8px 0" />
        </div>
      </section>

      <button class="nc-board__addcol" @click="openCreateColumn">＋ 添加列</button>
    </div>

    <!-- 列设置 -->
    <n-modal v-model:show="columnModal.open" preset="card" :title="columnModal.mode === 'create' ? '添加列' : '编辑列'" style="max-width: 420px">
      <div style="display: grid; gap: 12px">
        <div>
          <div class="nc-label">列名</div>
          <n-input v-model:value="columnModal.name" placeholder="例如：待评审" :maxlength="64" />
        </div>
        <div>
          <div class="nc-label">映射的任务状态</div>
          <n-select
            v-model:value="columnModal.status"
            :options="statusOptions"
          />
          <div class="nc-muted" style="margin-top: 4px">拖进这一列，任务状态会自动变成这个值</div>
        </div>
        <div>
          <div class="nc-label">WIP 上限（留空 = 不限）</div>
          <n-input-number v-model:value="columnModal.wipLimit" :min="1" :max="100" clearable style="width: 100%" />
        </div>
      </div>

      <template #footer>
        <div style="display: flex; justify-content: space-between; width: 100%">
          <n-button
            v-if="columnModal.mode === 'edit'"
            size="small"
            type="error"
            quaternary
            @click="
              columnModal.open = false;
              removeColumn(boards.columns.find((c) => c.id === columnModal.id)!);
            "
          >
            删除这一列
          </n-button>
          <span v-else />
          <div style="display: flex; gap: 8px">
            <n-button @click="columnModal.open = false">取消</n-button>
            <n-button type="primary" :loading="columnSaving" @click="saveColumn">保存</n-button>
          </div>
        </div>
      </template>
    </n-modal>

    <!-- 从待办添加 -->
    <n-modal
      v-model:show="pickModal.open"
      preset="card"
      :title="`添加到「${pickModal.columnName}」`"
      style="max-width: 520px"
    >
      <n-input
        v-model:value="pickQuery"
        placeholder="搜索任务标题"
        clearable
        style="margin-bottom: 10px"
        @update:value="onPickSearch"
      />

      <n-spin v-if="pickLoading" style="display: block; margin: 24px auto" />
      <n-empty
        v-else-if="pickTasks.length === 0"
        size="small"
        description="没有未在看板上的任务"
        style="margin: 24px 0"
      />

      <div v-else class="nc-picklist">
        <div v-for="item in pickTasks" :key="item.id" class="nc-pickitem" @click="addExisting(item)">
          <span class="nc-pickitem__title">{{ item.title }}</span>
          <span class="nc-muted">{{ TASK_PRIORITY_LABEL[item.priority] }}</span>
          <span class="nc-pickitem__add">＋</span>
        </div>
      </div>
    </n-modal>

    <!-- 卡片详情（精简） -->
    <n-drawer v-model:show="cardOpen" :width="440" placement="right">
      <n-drawer-content v-if="tasks.current" closable>
        <template #header>卡片</template>

        <n-alert
          v-if="boards.columns.some((c) => c.status === 'DONE') && tasks.current?.status === 'DONE'"
          type="success"
          :bordered="false"
          style="margin-bottom: 12px"
        >
          这张卡片当前在「已完成」列
        </n-alert>

        <div class="nc-label">标题</div>
        <n-input v-model:value="cardDraft.title" placeholder="卡片标题" style="margin-bottom: 12px" />

        <div class="nc-label">优先级</div>
        <n-select v-model:value="cardDraft.priority" :options="priorityOptions" style="margin-bottom: 12px" />

        <div class="nc-label">截止时间</div>
        <n-date-picker v-model:value="cardDraft.dueAt" type="datetime" clearable style="width: 100%; margin-bottom: 12px" />

        <div class="nc-label">描述</div>
        <n-input
          v-model:value="cardDraft.description"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 12 }"
          placeholder="补充说明"
        />

        <div v-if="tasks.current" class="nc-card__link">
          <RouterLink
            :to="{ name: 'tasks', params: { id: workspaceId }, query: { task: tasks.current.id } }"
          >
            在待办中打开（含子任务与评论）→
          </RouterLink>
        </div>

        <template #footer>
          <div style="display: flex; justify-content: flex-end; gap: 8px; width: 100%">
            <n-button @click="cardOpen = false">取消</n-button>
            <n-button type="primary" :loading="cardSaving" @click="saveCard">保存</n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.nc-board {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #f7f9fb;
}

.nc-board__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid #eef0f2;
  background: #fff;
  flex: 0 0 auto;
}

.nc-board__back {
  font-size: 12px;
  color: #8a8f99;
  text-decoration: none;
}

.nc-board__back:hover {
  color: #18a058;
}

.nc-board__title {
  font-size: 15px;
}

.nc-board__columns {
  display: flex;
  gap: 12px;
  padding: 14px 16px 20px;
  overflow-x: auto;
  flex: 1 1 auto;
  min-height: 0;
  align-items: flex-start;
}

.nc-col {
  flex: 0 0 288px;
  width: 288px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: #f0f3f6;
  border-radius: 10px;
  border: 1px solid transparent;
}

.nc-col.is-drop-target {
  border-color: #b9dcc9;
  background: #eef6f1;
}

.nc-col__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 10px 6px;
  flex: 0 0 auto;
}

.nc-col__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.nc-col__name {
  font-size: 13px;
  font-weight: 600;
  color: #3d4450;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-col__count {
  font-size: 11px;
  color: #9aa1ab;
  margin-right: auto;
}

.nc-col__count.is-over {
  color: #d03050;
  font-weight: 600;
}

.nc-col__body {
  overflow-y: auto;
  padding: 0 8px 10px;
  flex: 1 1 auto;
  min-height: 40px;
}

.nc-card {
  background: #fff;
  border-radius: 8px;
  padding: 9px 10px;
  margin-bottom: 8px;
  cursor: pointer;
  border: 1px solid #e8ebef;
  box-shadow: 0 1px 1px rgb(0 0 0 / 3%);
}

.nc-card:hover {
  border-color: #d7dde4;
}

.nc-card.is-dragging {
  opacity: 0.4;
}

.nc-card.is-drop-before {
  box-shadow: 0 -2px 0 #18a058;
}

.nc-card.is-drop-after {
  box-shadow: 0 2px 0 #18a058;
}

.nc-card__title {
  font-size: 13px;
  color: #1f2430;
  line-height: 1.45;
  word-break: break-word;
}

.nc-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.nc-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: #9aa1ab;
}

.nc-card__meta .is-overdue {
  color: #d03050;
}

.nc-col__addbtn {
  width: 100%;
  border: none;
  background: transparent;
  color: #8a8f99;
  font-size: 12px;
  text-align: left;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.nc-col__addbtn:hover {
  background: #e4e9ee;
  color: #18a058;
}

.nc-picklist {
  max-height: 380px;
  overflow-y: auto;
}

.nc-pickitem {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 6px;
  cursor: pointer;
  border-bottom: 1px solid #f7f8f9;
}

.nc-pickitem:hover {
  background: #f2f9f5;
}

.nc-pickitem__title {
  flex: 1 1 auto;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-pickitem__add {
  color: #18a058;
  font-size: 14px;
}

.nc-col__add {
  background: #fff;
  border-radius: 8px;
  padding: 8px;
}

.nc-board__addcol {
  flex: 0 0 200px;
  height: 44px;
  border: 1.5px dashed #cfd6dd;
  border-radius: 10px;
  background: transparent;
  color: #8a8f99;
  font-size: 13px;
  cursor: pointer;
}

.nc-board__addcol:hover {
  border-color: #18a058;
  color: #18a058;
}

.nc-label {
  font-size: 12px;
  color: #8a8f99;
  margin-bottom: 4px;
}

.nc-card__link {
  margin-top: 16px;
  font-size: 13px;
}
</style>

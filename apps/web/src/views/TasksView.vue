<script setup lang="ts">
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_COLOR,
  TASK_PRIORITY_LABEL,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  TASK_VIEWS,
  TASK_VIEW_LABEL,
  type TaskPriority,
  type TaskStatus,
  type TaskView,
} from '@notecloud/shared';
import {
  NAlert,
  NAvatar,
  NButton,
  NCheckbox,
  NDatePicker,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NEmpty,
  NInput,
  NPopconfirm,
  NSelect,
  NSpin,
  NTag,
  NDivider,
  useMessage,
} from 'naive-ui';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { apiGet } from '@/api/client';
import { listAllColumns, setTaskColumn } from '@/api/boards';
import type { BoardColumnGroup } from '@/api/boards';
import type { TaskDto } from '@/api/tasks';
import { listWatchers, unwatchTask, watchTask } from '@/api/tasks';
import { useTasksStore } from '@/stores/tasks';
import { useRealtimeStore } from '@/stores/realtime';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/error';
import { relativeTime } from '@/utils/time';

const route = useRoute();
const store = useTasksStore();
const realtime = useRealtimeStore();
const auth = useAuthStore();
const message = useMessage();

let offRealtime: (() => void) | null = null;

const workspaceId = computed(() => String(route.params.id ?? ''));

const VIEW_ICONS: Record<TaskView, string> = {
  all: '📋',
  today: '☀️',
  week: '🗓️',
  overdue: '⚠️',
  done: '✅',
  assigned: '👤',
  mine: '✍️',
  trash: '🗑️',
};

// ── 成员（用于负责人与 @提及）──────────────────────────────────
interface MemberRow {
  userId: string;
  user: { id: string; name: string; avatarUrl: string | null };
}
const members = ref<MemberRow[]>([]);

const memberOptions = computed(() =>
  members.value.map((m) => ({ label: m.user.name, value: m.userId })),
);

onMounted(async () => {
  try {
    await store.init(workspaceId.value);
    await loadBoardColumns();
    const page = await apiGet<{ items: MemberRow[] }>(`/workspaces/${workspaceId.value}/members`, {
      params: { limit: 100 },
    });
    members.value = page.items;

    // 从看板跳过来时（?task=<id>）直接打开那条任务的详情
    const taskId = typeof route.query.task === 'string' ? route.query.task : null;
    if (taskId) {
      await store.openTask(taskId);
      syncDraft();
      detailOpen.value = true;
    }

    offRealtime = realtime.subscribe('task.changed', () => {
      void store.loadTasks();
    });
  } catch (err) {
    message.error(errorMessage(err));
  }
});

onBeforeUnmount(() => {
  offRealtime?.();
});

watch(workspaceId, async (id) => {
  if (!id) return;
  await store.init(id);
});

// ── 快速添加 ────────────────────────────────────────────────────
const quickTitle = ref('');
const quickAdding = ref(false);

async function quickAdd(): Promise<void> {
  const title = quickTitle.value.trim();
  if (!title) return;

  quickAdding.value = true;
  try {
    await store.createTask({ title });
    quickTitle.value = '';
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    quickAdding.value = false;
  }
}

// ── 搜索 ────────────────────────────────────────────────────────
let searchTimer: number | null = null;
const search = ref('');
watch(search, (value) => {
  store.q = value;
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void store.loadTasks(), 350);
});

// ── 列表分组 ────────────────────────────────────────────────────
function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function groupOf(task: TaskDto): string {
  if (!task.dueAt) return 'nodate';
  const due = new Date(task.dueAt).getTime();
  const today = startOfToday();
  if (due < Date.now() && task.status !== 'DONE') return 'overdue';
  if (due < today + 86_400_000) return 'today';
  if (due < today + 7 * 86_400_000) return 'week';
  return 'later';
}

const GROUP_LABEL: Record<string, string> = {
  overdue: '已逾期',
  today: '今天',
  week: '未来 7 天',
  later: '以后',
  nodate: '没有日期',
};

const grouped = computed(() => {
  // 已完成 / 回收站不做日期分组，一个平铺列表更直观
  if (store.view === 'done' || store.view === 'trash') {
    return [{ key: 'flat', label: '', items: store.tasks }];
  }

  const buckets = new Map<string, TaskDto[]>();
  for (const task of store.tasks) {
    const key = groupOf(task);
    const list = buckets.get(key) ?? [];
    list.push(task);
    buckets.set(key, list);
  }

  return ['overdue', 'today', 'week', 'later', 'nodate']
    .filter((key) => (buckets.get(key)?.length ?? 0) > 0)
    .map((key) => ({ key, label: GROUP_LABEL[key]!, items: buckets.get(key)! }));
});

// ── 行内操作 ────────────────────────────────────────────────────
async function toggleDone(task: TaskDto): Promise<void> {
  const next: TaskStatus = task.status === 'DONE' ? 'TODO' : 'DONE';
  const ok = await store.setStatus(task, next);
  if (!ok) message.error('操作失败，请重试');
  if (ok && next === 'DONE') message.success('已完成');
}

function isOverdue(task: TaskDto): boolean {
  return Boolean(task.dueAt) && new Date(task.dueAt!).getTime() < Date.now() && task.status !== 'DONE';
}

function formatDue(task: TaskDto): string {
  if (!task.dueAt) return '';
  const date = new Date(task.dueAt);
  const today = startOfToday();
  const t = date.getTime();
  const time = task.isAllDay
    ? ''
    : ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  if (t < today) return `${date.getMonth() + 1}月${date.getDate()}日${time}`;
  if (t < today + 86_400_000) return `今天${time}`;
  if (t < today + 2 * 86_400_000) return `明天${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日${time}`;
}

// ── 详情抽屉 ────────────────────────────────────────────────────
const detailOpen = ref(false);
const draft = ref({
  title: '',
  description: '',
  status: 'TODO' as TaskStatus,
  priority: 'NONE' as TaskPriority,
  dueAt: null as number | null,
  reminderAt: null as number | null,
  assigneeId: null as string | null,
  tagIds: [] as string[],
});

// ── 看板列（把任务放进看板）──────────────────────────────────
const boardColumns = ref<BoardColumnGroup[]>([]);
const currentColumnId = ref<string | null>(null);

const columnOptions = computed(() =>
  boardColumns.value
    .filter((b) => b.columns.length > 0)
    .map((b) => ({
      type: 'group' as const,
      label: b.name,
      key: b.id,
      children: b.columns.map((c) => ({
        label: c.wipLimit ? `${c.name}（WIP ${c.wipLimit}）` : c.name,
        value: c.id,
      })),
    })),
);

async function loadBoardColumns(): Promise<void> {
  try {
    boardColumns.value = (await listAllColumns(workspaceId.value)).boards;
  } catch {
    boardColumns.value = [];
  }
}

async function changeColumn(value: string | null): Promise<void> {
  if (!store.current) return;
  try {
    const res = await setTaskColumn(workspaceId.value, store.current.id, value);
    store.current = res.task;
    currentColumnId.value = value;
    await store.loadTasks();
    message.success(value ? '已加入看板' : '已从看板移出');
  } catch (err) {
    message.error(errorMessage(err));
    currentColumnId.value = store.current.columnId ?? null;
  }
}

// ── 关注者（协作人）──────────────────────────────────────────
const watching = ref(false);

async function loadWatchers(taskId: string): Promise<void> {
  try {
    const res = await listWatchers(workspaceId.value, taskId);
    watching.value = res.watching;
  } catch {
    watching.value = false;
  }
}

async function toggleWatch(): Promise<void> {
  if (!store.current) return;
  try {
    if (watching.value) {
      await unwatchTask(workspaceId.value, store.current.id);
      watching.value = false;
      message.success('已取消关注');
    } else {
      await watchTask(workspaceId.value, store.current.id);
      watching.value = true;
      message.success('已关注，之后有新评论会通知你');
    }
  } catch (err) {
    message.error(errorMessage(err));
  }
}

const tagOptions = computed(() => store.tags.map((t) => ({ label: t.name, value: t.id })));
const conflictTask = computed(() => store.conflict);

// 在 script 里算好选项：在模板里对导入常量做下标访问会被 Vue 编译器当成 ref 处理
const statusOptions = TASK_STATUSES.map((s) => ({ label: TASK_STATUS_LABEL[s], value: s }));
const priorityOptions = TASK_PRIORITIES.map((p) => ({ label: TASK_PRIORITY_LABEL[p], value: p }));

async function openDetail(task: TaskDto): Promise<void> {
  await store.openTask(task.id);
  syncDraft();
  detailOpen.value = true;
  void loadWatchers(task.id);
}

function syncDraft(): void {
  const task = store.current;
  if (!task) return;
  draft.value = {
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt ? new Date(task.dueAt).getTime() : null,
    reminderAt: task.reminderAt ? new Date(task.reminderAt).getTime() : null,
    assigneeId: task.assignee?.id ?? null,
    tagIds: task.tags.map((t) => t.id),
  };
  currentColumnId.value = task.columnId ?? null;
}

async function saveDraft(): Promise<void> {
  const result = await store.save({
    title: draft.value.title.trim() || '未命名任务',
    description: draft.value.description || null,
    status: draft.value.status,
    priority: draft.value.priority,
    dueAt: draft.value.dueAt ? new Date(draft.value.dueAt).toISOString() : null,
    isAllDay: false,
    assigneeId: draft.value.assigneeId,
    reminderAt: draft.value.reminderAt ? new Date(draft.value.reminderAt).toISOString() : null,
    tagIds: draft.value.tagIds,
  });

  if (result === 'ok') {
    message.success('已保存');
    await store.loadTasks();
  } else if (result === 'error') {
    message.error('保存失败，请重试');
  }
}

async function useRemote(): Promise<void> {
  store.acceptRemote();
  syncDraft();
  message.success('已改用服务端版本');
}

// ── 回写：每次字段改动后自动保存（防抖）─────────────────────────
let saveTimer: number | null = null;
watch(
  draft,
  () => {
    if (!detailOpen.value || !store.current) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveDraft(), 800);
  },
  { deep: true },
);

// ── 子任务 ──────────────────────────────────────────────────────
const newChecklistTitle = ref('');

async function addChecklistItem(): Promise<void> {
  const title = newChecklistTitle.value.trim();
  const task = store.current;
  if (!title || !task) return;

  const result = await store.save({
    checklist: [
      ...task.checklist.map((c) => ({ id: c.id, title: c.title, done: c.done })),
      { title, done: false },
    ],
  });
  if (result === 'ok') {
    newChecklistTitle.value = '';
    message.success('已添加子任务');
  }
}

async function removeChecklistItem(itemId: string): Promise<void> {
  const task = store.current;
  if (!task) return;
  await store.save({
    checklist: task.checklist
      .filter((c) => c.id !== itemId)
      .map((c) => ({ id: c.id, title: c.title, done: c.done })),
  });
}

async function toggleItem(item: { id: string; done: boolean }): Promise<void> {
  const task = store.current;
  if (!task) return;
  await store.toggleChecklistItem(task.id, item.id, !item.done);
}

// ── 评论 ────────────────────────────────────────────────────────
const commentBody = ref('');
const pendingMentions = ref<string[]>([]);

const mentionOptions = computed(() =>
  members.value
    .filter((m) => m.user.id !== auth.user?.id)
    .map((m) => ({ label: m.user.name, key: m.userId })),
);

function insertMention(userId: string): void {
  const member = members.value.find((m) => m.userId === userId);
  if (!member) return;
  commentBody.value += `${commentBody.value && !commentBody.value.endsWith(' ') ? ' ' : ''}@${member.user.name} `;
  if (!pendingMentions.value.includes(userId)) pendingMentions.value.push(userId);
}

async function submitComment(): Promise<void> {
  const body = commentBody.value.trim();
  if (!body) return;
  try {
    await store.addComment(body, pendingMentions.value);
    commentBody.value = '';
    pendingMentions.value = [];
  } catch (err) {
    message.error(errorMessage(err));
  }
}

/** 把 @名字 拆出来高亮。按名字长度倒序匹配，避免 "张三" 先吃掉 "张三丰" */
function renderComment(body: string): Array<{ text: string; mention: boolean }> {
  const names = members.value
    .map((m) => m.user.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  if (names.length === 0) return [{ text: body, mention: false }];

  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(${escaped.join('|')})`, 'g');

  const parts: Array<{ text: string; mention: boolean }> = [];
  let last = 0;
  for (const match of body.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: body.slice(last, index), mention: false });
    parts.push({ text: match[0], mention: true });
    last = index + match[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts;
}

// ── 删除 / 恢复 ─────────────────────────────────────────────────
async function removeTask(task: TaskDto): Promise<void> {
  await store.trash(task.id);
  if (store.current?.id === task.id) {
    detailOpen.value = false;
    store.current = null;
  }
  message.success('已移入回收站');
}

async function restoreTask(id: string): Promise<void> {
  await store.restore(id);
  message.success('已恢复');
}

async function purgeTask(id: string): Promise<void> {
  await store.purge(id);
  message.success('已彻底删除');
}
</script>

<template>
  <div class="nc-tasks">
    <aside class="nc-tasks__side">
      <div class="nc-tasks__views">
        <div
          v-for="v in TASK_VIEWS"
          :key="v"
          class="nc-view"
          :class="{ 'is-active': store.view === v }"
          @click="store.setView(v)"
        >
          <span>{{ VIEW_ICONS[v] }}</span>
          <span>{{ TASK_VIEW_LABEL[v] }}</span>
        </div>
      </div>

      <n-divider style="margin: 4px 0" />

      <div class="nc-tasks__tags">
        <div class="nc-tasks__tagshead">
          <span>标签</span>
          <n-button v-if="store.tagId" size="tiny" quaternary @click="store.selectTag(null)">×</n-button>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 6px">
          <n-tag
            v-for="t in store.tags"
            :key="t.id"
            size="small"
            :bordered="false"
            checkable
            :checked="store.tagId === t.id"
            @update:checked="(checked: boolean) => store.selectTag(checked ? t.id : null)"
          >
            #{{ t.name }}
            <span v-if="t.taskCount" style="opacity: 0.6; margin-left: 3px">{{ t.taskCount }}</span>
          </n-tag>
          <span v-if="store.tags.length === 0" class="nc-muted">还没有标签（可在笔记页创建）</span>
        </div>
      </div>
    </aside>

    <section class="nc-tasks__main">
      <div class="nc-tasks__head">
        <n-input v-model:value="search" size="small" clearable placeholder="搜索任务…" />
        <span class="nc-muted">{{ store.tasks.length }} 项</span>
      </div>

      <div class="nc-tasks__quick">
        <n-input
          v-model:value="quickTitle"
          placeholder="添加任务，回车创建"
          :disabled="store.isTrashView"
          @keyup.enter="quickAdd"
        />
        <n-button type="primary" secondary :loading="quickAdding" @click="quickAdd">添加</n-button>
      </div>

      <div class="nc-tasks__body">
        <n-spin v-if="store.loading && store.tasks.length === 0" style="display: block; margin: 48px auto" />

        <n-empty
          v-else-if="store.isEmpty"
          :description="store.isTrashView ? '回收站是空的' : '这里还没有任务'"
          style="margin: 64px 0"
        />

        <div v-for="group in grouped" :key="group.key" class="nc-tasks__group">
          <div v-if="group.label" class="nc-tasks__grouplabel">
            {{ group.label }}
            <span class="nc-tasks__groupcount">{{ group.items.length }}</span>
          </div>

          <div
            v-for="task in group.items"
            :key="task.id"
            class="nc-task"
            :class="{ 'is-done': task.status === 'DONE', 'is-open': store.current?.id === task.id && detailOpen }"
            @click="openDetail(task)"
          >
            <n-checkbox
              :checked="task.status === 'DONE'"
              :disabled="store.isTrashView"
              @click.stop
              @update:checked="toggleDone(task)"
            />

            <div class="nc-task__main">
              <div class="nc-task__title">{{ task.title }}</div>
              <div class="nc-task__meta">
                <span
                  v-if="task.priority !== 'NONE'"
                  class="nc-task__priority"
                  :style="{ color: TASK_PRIORITY_COLOR[task.priority] }"
                >
                  ● {{ TASK_PRIORITY_LABEL[task.priority] }}
                </span>

                <span v-if="task.dueAt" class="nc-task__due" :class="{ 'is-overdue': isOverdue(task) }">
                  {{ formatDue(task) }}
                </span>

                <span v-if="task.checklistTotal > 0" class="nc-task__chk">
                  ☑ {{ task.checklistDone }}/{{ task.checklistTotal }}
                </span>

                <span v-if="task.tags.length" class="nc-task__tags">
                  {{ task.tags.map((t) => `#${t.name}`).join(' ') }}
                </span>

                <span v-if="task.status === 'IN_PROGRESS'" class="nc-task__status">进行中</span>
              </div>
            </div>

            <n-avatar v-if="task.assignee" round :size="20" :src="task.assignee.avatarUrl ?? undefined">
              {{ task.assignee.name[0] }}
            </n-avatar>

            <div class="nc-task__actions" @click.stop>
              <template v-if="store.isTrashView">
                <n-button size="tiny" quaternary @click="restoreTask(task.id)">恢复</n-button>
                <n-popconfirm @positive-click="purgeTask(task.id)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error">彻底删除</n-button>
                  </template>
                  删除后无法恢复，确定吗？
                </n-popconfirm>
              </template>
              <n-popconfirm v-else @positive-click="removeTask(task)">
                <template #trigger>
                  <n-button size="tiny" quaternary type="error">删除</n-button>
                </template>
                移入回收站？30 天后自动清理。
              </n-popconfirm>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 详情抽屉 -->
    <n-drawer v-model:show="detailOpen" :width="560" placement="right">
      <n-drawer-content v-if="store.current" closable>
        <template #header>
          <div style="display: flex; align-items: center; justify-content: space-between; width: 100%">
            <span>任务详情</span>
            <n-button
              size="tiny"
              quaternary
              :type="watching ? 'primary' : 'default'"
              @click="toggleWatch"
            >
              {{ watching ? '🔔 已关注' : '🔕 关注' }}
            </n-button>
          </div>
        </template>

        <n-alert v-if="conflictTask" type="warning" :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
            <span>这项任务已被他人修改（{{ relativeTime(conflictTask.updatedAt) }}），你的改动不会被静默覆盖。</span>
            <n-button size="tiny" @click="useRemote">用服务端版本</n-button>
          </div>
        </n-alert>

        <n-input
          v-model:value="draft.title"
          placeholder="任务标题"
          style="font-size: 16px; font-weight: 600; margin-bottom: 12px"
        />

        <div class="nc-detail__grid">
          <div class="nc-detail__label">状态</div>
          <n-select v-model:value="draft.status" size="small" :options="statusOptions" />

          <div class="nc-detail__label">优先级</div>
          <n-select
            v-model:value="draft.priority"
            size="small"
            :options="priorityOptions"
          />

          <div class="nc-detail__label">截止时间</div>
          <n-date-picker v-model:value="draft.dueAt" type="datetime" size="small" clearable />

          <div class="nc-detail__label">提醒</div>
          <n-date-picker v-model:value="draft.reminderAt" type="datetime" size="small" clearable />

          <div class="nc-detail__label">负责人</div>
          <n-select v-model:value="draft.assigneeId" size="small" clearable :options="memberOptions" placeholder="未指派" />

          <div class="nc-detail__label">标签</div>
          <n-select v-model:value="draft.tagIds" multiple size="small" :options="tagOptions" placeholder="添加标签" />

          <div class="nc-detail__label">看板列</div>
          <n-select
            :value="currentColumnId"
            size="small"
            clearable
            placeholder="不在看板上（选择一列即可加入）"
            :options="columnOptions"
            @update:value="changeColumn"
          />
        </div>

        <n-divider style="margin: 16px 0" />

        <div class="nc-detail__section">描述</div>
        <n-input
          v-model:value="draft.description"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 10 }"
          placeholder="补充说明（纯文本，暂不支持 Markdown）"
        />

        <n-divider style="margin: 16px 0" />

        <div class="nc-detail__section">
          子任务
          <span v-if="store.current.checklistTotal" class="nc-muted">
            {{ store.current.checklistDone }}/{{ store.current.checklistTotal }}
          </span>
        </div>

        <div v-for="item in store.current.checklist" :key="item.id" class="nc-chk">
          <n-checkbox :checked="item.done" @update:checked="toggleItem(item)" />
          <span class="nc-chk__title" :class="{ 'is-done': item.done }">{{ item.title }}</span>
          <n-button size="tiny" quaternary @click="removeChecklistItem(item.id)">×</n-button>
        </div>

        <div style="display: flex; gap: 8px; margin-top: 6px">
          <n-input
            v-model:value="newChecklistTitle"
            size="small"
            placeholder="添加子任务，回车确认"
            @keyup.enter="addChecklistItem"
          />
          <n-button size="small" @click="addChecklistItem">添加</n-button>
        </div>

        <n-divider style="margin: 16px 0" />

        <div class="nc-detail__section">评论</div>

        <n-spin v-if="store.commentsLoading" size="small" style="display: block; margin: 12px auto" />

        <template v-else>
          <n-empty v-if="store.comments.length === 0" size="small" description="还没有评论" style="margin: 12px 0" />

          <div v-for="c in store.comments" :key="c.id" class="nc-comment">
            <n-avatar round :size="24" :src="c.author.avatarUrl ?? undefined">{{ c.author.name[0] }}</n-avatar>
            <div class="nc-comment__body">
              <div class="nc-comment__head">
                <strong>{{ c.author.name }}</strong>
                <span class="nc-muted">{{ relativeTime(c.createdAt) }}</span>
                <n-popconfirm v-if="c.author.id === auth.user?.id" @positive-click="store.removeComment(c.id)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error">删除</n-button>
                  </template>
                  删除这条评论？
                </n-popconfirm>
              </div>
              <div class="nc-comment__text">
                <span
                  v-for="(seg, i) in renderComment(c.body)"
                  :key="i"
                  :class="{ 'nc-mention': seg.mention }"
                >{{ seg.text }}</span>
              </div>
            </div>
          </div>

          <div class="nc-comment__compose">
            <n-input
              v-model:value="commentBody"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 5 }"
              placeholder="写评论…（可用 @ 提及成员）"
            />
            <div class="nc-comment__tools">
              <n-dropdown :options="mentionOptions" trigger="click" @select="insertMention">
                <n-button size="tiny" quaternary>@ 提及</n-button>
              </n-dropdown>
              <n-button size="small" type="primary" @click="submitComment">发送</n-button>
            </div>
          </div>
        </template>

        <template #footer>
          <div style="display: flex; justify-content: space-between; width: 100%">
            <n-popconfirm @positive-click="removeTask(store.current)">
              <template #trigger>
                <n-button size="small" type="error" quaternary>移入回收站</n-button>
              </template>
              移入回收站？30 天后自动清理。
            </n-popconfirm>
            <n-button size="small" @click="detailOpen = false">关闭</n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.nc-tasks {
  display: grid;
  grid-template-columns: 208px 1fr;
  height: 100%;
  min-height: 0;
  background: #fff;
}

.nc-tasks__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid #eef0f2;
  background: #fbfcfd;
  overflow-y: auto;
}

.nc-tasks__views {
  padding: 8px 6px;
}

.nc-view {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #3d4450;
}

.nc-view:hover {
  background: #f2f4f7;
}

.nc-view.is-active {
  background: #e8f3ee;
  color: #18a058;
  font-weight: 500;
}

.nc-tasks__tags {
  padding: 6px 10px 14px;
}

.nc-tasks__tagshead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: #8a8f99;
  margin-bottom: 6px;
}

.nc-tasks__main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.nc-tasks__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px 6px;
}

.nc-tasks__quick {
  display: flex;
  gap: 8px;
  padding: 0 16px 10px;
  border-bottom: 1px solid #f2f3f5;
}

.nc-tasks__body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px 16px 24px;
  max-width: 900px;
  width: 100%;
}

.nc-tasks__group {
  margin-top: 14px;
}

.nc-tasks__grouplabel {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #8a8f99;
  margin-bottom: 6px;
}

.nc-tasks__groupcount {
  font-weight: 400;
  color: #b0b6bf;
}

.nc-task {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
}

.nc-task:hover {
  background: #fafbfc;
  border-color: #f0f2f4;
}

.nc-task.is-open {
  background: #f0f7f3;
  border-color: #d6ecdf;
}

.nc-task__main {
  flex: 1 1 auto;
  min-width: 0;
}

.nc-task__title {
  font-size: 13.5px;
  color: #1f2430;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-task.is-done .nc-task__title {
  text-decoration: line-through;
  color: #a0a6af;
}

.nc-task__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 3px;
  font-size: 11px;
  color: #a0a6af;
}

.nc-task__due.is-overdue {
  color: #d03050;
  font-weight: 500;
}

.nc-task__tags {
  color: #8aa89a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.nc-task__status {
  color: #2080f0;
}

.nc-task__actions {
  display: flex;
  gap: 2px;
  opacity: 0;
}

.nc-task:hover .nc-task__actions {
  opacity: 1;
}

/* 抽屉内 */
.nc-detail__grid {
  display: grid;
  grid-template-columns: 76px 1fr;
  align-items: center;
  gap: 10px 12px;
}

.nc-detail__label {
  font-size: 12px;
  color: #8a8f99;
}

.nc-detail__section {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #6b7280;
  margin-bottom: 8px;
}

.nc-chk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.nc-chk__title {
  flex: 1 1 auto;
  font-size: 13px;
}

.nc-chk__title.is-done {
  text-decoration: line-through;
  color: #a0a6af;
}

.nc-comment {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #f6f7f8;
}

.nc-comment__body {
  flex: 1 1 auto;
  min-width: 0;
}

.nc-comment__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 2px;
}

.nc-comment__text {
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.nc-mention {
  color: #2080f0;
  background: #eef4ff;
  border-radius: 3px;
  padding: 0 2px;
}

.nc-comment__compose {
  margin-top: 14px;
}

.nc-comment__tools {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 6px;
}
</style>

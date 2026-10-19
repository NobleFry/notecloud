<script setup lang="ts">
import {
  NAlert,
  NButton,
  NButtonGroup,
  NCheckbox,
  NDivider,
  NEmpty,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpin,
  NTag,
  NTooltip,
  useMessage,
} from 'naive-ui';
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { TRASH_RETENTION_DAYS, type NoteView } from '@notecloud/shared';

import NotebookTree from '@/components/notes/NotebookTree.vue';
import ShareDialog from '@/components/notes/ShareDialog.vue';
import TagManager from '@/components/notes/TagManager.vue';
import * as smartViewApi from '@/api/smartViews';
import type { SmartViewDto } from '@/api/smartViews';
import { useNotesStore } from '@/stores/notes';
import { useRealtimeStore } from '@/stores/realtime';

// 编辑器（CodeMirror + markdown-it + highlight.js）体积较大，
// 且只有真正打开笔记时才需要 —— 异步加载，让列表页秒开。
const MarkdownEditor = defineAsyncComponent({
  loader: () => import('@/components/notes/MarkdownEditor.vue'),
  delay: 120,
  timeout: 15000,
});
import { errorMessage } from '@/utils/error';
import { relativeTime, trashDaysLeft } from '@/utils/time';

const route = useRoute();
const store = useNotesStore();
const realtime = useRealtimeStore();
const message = useMessage();

let offRealtime: (() => void) | null = null;

const workspaceId = computed(() => String(route.params.id ?? ''));

// ── 草稿与自动保存 ──────────────────────────────────────────────
const draftTitle = ref('');
const draftContent = ref('');
const dirty = ref(false);
let saveTimer: number | null = null;

const SMART_VIEWS: Array<{ key: NoteView; label: string; icon: string }> = [
  { key: 'all', label: '全部笔记', icon: '📝' },
  { key: 'starred', label: '收藏', icon: '⭐' },
  { key: 'archived', label: '归档', icon: '🗄️' },
  { key: 'trash', label: '回收站', icon: '🗑️' },
];

const tagManagerVisible = ref(false);
const shareOpen = ref(false);

// ── 智能视图（保存的过滤器）────────────────────────────────
const savedViews = ref<SmartViewDto[]>([]);
const saveViewOpen = ref(false);
const saveViewName = ref('');
const saveViewShared = ref(false);
const savingView = ref(false);

async function loadSavedViews(): Promise<void> {
  try {
    savedViews.value = (await smartViewApi.listSmartViews(workspaceId.value)).items;
  } catch {
    savedViews.value = [];
  }
}

function applySavedView(v: SmartViewDto): void {
  store.applyFilter(v.filter);
}

async function saveCurrentView(): Promise<void> {
  const name = saveViewName.value.trim();
  if (!name) {
    message.warning('请填写视图名称');
    return;
  }

  savingView.value = true;
  try {
    await smartViewApi.createSmartView(workspaceId.value, {
      name,
      isShared: saveViewShared.value,
      filter: {
        view: store.view,
        ...(store.notebookId ? { notebookId: store.notebookId } : {}),
        ...(store.tagId ? { tagId: store.tagId } : {}),
        ...(store.q.trim() ? { q: store.q.trim() } : {}),
      },
    });
    saveViewOpen.value = false;
    saveViewName.value = '';
    saveViewShared.value = false;
    await loadSavedViews();
    message.success('已保存视图');
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    savingView.value = false;
  }
}

async function removeSavedView(v: SmartViewDto): Promise<void> {
  try {
    await smartViewApi.deleteSmartView(workspaceId.value, v.id);
    await loadSavedViews();
  } catch (err) {
    message.error(errorMessage(err));
  }
}

watch(
  () => store.current,
  (note) => {
    if (!note) {
      draftTitle.value = '';
      draftContent.value = '';
      dirty.value = false;
      return;
    }
    draftTitle.value = note.title;
    draftContent.value = note.content;
    dirty.value = false;
  },
  { immediate: true },
);

function queueSave(): void {
  dirty.value = true;
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), 1000);
}

async function flushSave(): Promise<void> {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!store.current || !dirty.value) return;

  dirty.value = false;
  const result = await store.save({ title: draftTitle.value, content: draftContent.value });

  if (result === 'conflict') {
    // 保持本地草稿不变，等用户决定
    dirty.value = true;
    return;
  }
  if (result === 'error') {
    dirty.value = true;
    message.error('保存失败，请检查网络后重试');
  }
}

onBeforeUnmount(() => {
  if (saveTimer) window.clearTimeout(saveTimer);
  window.removeEventListener('keydown', onKeydown);
  offRealtime?.();
  void flushSave();
});

// ── 列表与选择 ──────────────────────────────────────────────────
async function selectNote(id: string): Promise<void> {
  if (store.current?.id === id) return;
  await flushSave();
  try {
    await store.openNote(id);
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function createNote(): Promise<void> {
  await flushSave();
  try {
    const note = await store.createNew({ title: '', content: '' });
    if (note) {
      draftTitle.value = note.title;
      draftContent.value = note.content;
    }
  } catch (err) {
    message.error(errorMessage(err));
  }
}

// 搜索防抖
let searchTimer: number | null = null;
const search = ref('');
watch(search, (value) => {
  store.q = value;
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void store.loadNotes(true), 350);
});

// ── 元信息操作 ──────────────────────────────────────────────────
async function toggleStar(): Promise<void> {
  if (!store.current) return;
  await store.save({ isStarred: !store.current.isStarred });
}

async function togglePin(): Promise<void> {
  if (!store.current) return;
  await store.save({ isPinned: !store.current.isPinned });
}

async function archive(): Promise<void> {
  if (!store.current) return;

  const wasArchived = store.current.archived;
  const result = await store.save({ archived: !wasArchived });
  if (result !== 'ok') {
    message.error('操作失败，请重试');
    return;
  }

  message.success(wasArchived ? '已取消归档' : '已归档');
  await store.loadNotes(true);

  // 归档后它就不在当前视图里了；在归档视图里取消归档同理
  if (!wasArchived || store.view === 'archived') {
    store.current = null;
  }
}

// ── 搜索命中高亮 ────────────────────────────────────────────────
function segments(text: string): Array<{ t: string; hit: boolean }> {
  const q = store.q.trim();
  if (!q) return [{ t: text, hit: false }];

  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const out: Array<{ t: string; hit: boolean }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lower.indexOf(lq, cursor);
    if (idx === -1) {
      out.push({ t: text.slice(cursor), hit: false });
      break;
    }
    if (idx > cursor) out.push({ t: text.slice(cursor, idx), hit: false });
    out.push({ t: text.slice(idx, idx + q.length), hit: true });
    cursor = idx + q.length;
  }

  return out;
}

// ── 快捷键 ──────────────────────────────────────────────────────
const searchInput = ref<{ focus: () => void } | null>(null);

async function onKeydown(event: KeyboardEvent): Promise<void> {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return;

  switch (event.key.toLowerCase()) {
    case 's':
      event.preventDefault();
      if (dirty.value) {
        await flushSave();
        message.success('已保存');
      } else {
        message.info('没有需要保存的改动');
      }
      break;
    case 'n':
      event.preventDefault();
      await createNote();
      break;
    case 'k':
      event.preventDefault();
      searchInput.value?.focus();
      break;
    default:
      break;
  }
}

async function moveToTrash(): Promise<void> {
  if (!store.current) return;
  try {
    await store.moveToTrash(store.current.id);
    draftTitle.value = '';
    draftContent.value = '';
    dirty.value = false;
    message.success('已移入回收站');
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function restore(id: string): Promise<void> {
  try {
    await store.restore(id);
    message.success('已恢复');
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function purge(id: string): Promise<void> {
  try {
    await store.purge(id);
    message.success('已彻底删除');
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function emptyAll(): Promise<void> {
  try {
    const count = await store.emptyTrash();
    message.success(`已清空 ${count} 条`);
  } catch (err) {
    message.error(errorMessage(err));
  }
}

// ── 笔记本 / 标签归属 ───────────────────────────────────────────
const notebookOptions = computed(() =>
  store.notebooks.map((n) => ({ label: `${'　'.repeat(n.depth)}${n.name}`, value: n.id })),
);
const tagOptions = computed(() => store.tags.map((t) => ({ label: t.name, value: t.id })));

const selectedNotebooks = computed({
  get: () => store.current?.notebookIds ?? [],
  set: (ids: string[]) => void store.setNotebooksForCurrent(ids),
});

const selectedTags = computed({
  get: () => store.current?.tags.map((t) => t.id) ?? [],
  set: (ids: string[]) => void store.setTagsForCurrent(ids),
});

// ── 冲突处理 ────────────────────────────────────────────────────
async function useRemote(): Promise<void> {
  store.acceptRemote();
  if (store.current) {
    draftTitle.value = store.current.title;
    draftContent.value = store.current.content;
  }
  dirty.value = false;
  message.success('已改用服务端版本');
}

async function keepMine(): Promise<void> {
  const ok = await store.overwriteRemote({ title: draftTitle.value, content: draftContent.value });
  if (ok) {
    dirty.value = false;
    message.success('已用你的版本覆盖');
  } else {
    message.error('覆盖失败，请重试');
  }
}

// ── 生命周期 ────────────────────────────────────────────────────
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  try {
    await store.init(workspaceId.value);
    await loadSavedViews();
    // 别人改了笔记 → 只刷新列表，不动当前草稿
    offRealtime = realtime.subscribe('note.changed', () => {
      void store.loadNotes(true);
    });
  } catch (err) {
    message.error(errorMessage(err));
  }
});

watch(workspaceId, async (id) => {
  if (!id) return;
  try {
    await store.init(id);
  } catch (err) {
    message.error(errorMessage(err));
  }
});
</script>

<template>
  <div class="nc-notes">
    <!-- 左侧：智能视图 + 笔记本 + 标签 -->
    <aside class="nc-notes__side">
      <div class="nc-notes__views">
        <div
          v-for="v in SMART_VIEWS"
          :key="v.key"
          class="nc-view"
          :class="{ 'is-active': store.view === v.key }"
          @click="store.setView(v.key)"
        >
          <span>{{ v.icon }}</span>
          <span>{{ v.label }}</span>
        </div>

        <div class="nc-saved__head">
          <span>我的视图</span>
          <n-button size="tiny" quaternary @click="saveViewOpen = true">＋</n-button>
        </div>

        <div
          v-for="v in savedViews"
          :key="v.id"
          class="nc-view nc-view--saved"
          @click="applySavedView(v)"
        >
          <span>{{ v.icon ?? '🔎' }}</span>
          <span class="nc-saved__name">{{ v.name }}</span>
          <span class="nc-saved__badge" v-if="v.isShared">共享</span>
          <span class="nc-saved__del" title="删除视图" @click.stop="removeSavedView(v)">×</span>
        </div>

        <div v-if="savedViews.length === 0" class="nc-saved__empty nc-muted">
          把当前筛选保存下来
        </div>
      </div>

      <n-divider style="margin: 4px 0" />

      <notebook-tree style="flex: 1 1 auto" />

      <n-divider style="margin: 4px 0" />

      <div class="nc-tags">
        <div class="nc-tags__head">
          <span>标签</span>
          <span style="display: flex; gap: 2px; align-items: center">
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button size="tiny" quaternary @click="tagManagerVisible = true">管理</n-button>
              </template>
              创建 / 重命名 / 删除标签
            </n-tooltip>
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button size="tiny" quaternary @click="store.selectTag(null)">×</n-button>
              </template>
              清除标签筛选
            </n-tooltip>
          </span>
        </div>
        <div class="nc-tags__list">
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
            <span v-if="t.noteCount" class="nc-tags__count">{{ t.noteCount }}</span>
          </n-tag>
          <span v-if="store.tags.length === 0" class="nc-muted">还没有标签</span>
        </div>
      </div>
    </aside>

    <!-- 中间：笔记列表 -->
    <section class="nc-notes__list">
      <div class="nc-notes__listhead">
        <n-input ref="searchInput" v-model:value="search" size="small" clearable placeholder="搜索标题或正文…（Ctrl+K）" />
        <n-button size="small" type="primary" secondary @click="createNote">新建</n-button>
      </div>

      <div class="nc-notes__listbody">
        <n-spin v-if="store.loadingList && store.notes.length === 0" style="display: block; margin: 40px auto" />

        <template v-else>
          <n-empty
            v-if="store.isEmpty"
            size="small"
            :description="store.isTrashView ? '回收站是空的' : '这里还没有笔记'"
            style="margin: 48px 0"
          >
            <template v-if="!store.isTrashView" #extra>
              <n-button size="small" @click="createNote">写第一篇</n-button>
            </template>
          </n-empty>

          <div
            v-for="item in store.notes"
            :key="item.id"
            class="nc-noteitem"
            :class="{ 'is-active': store.current?.id === item.id }"
            @click="selectNote(item.id)"
          >
            <div class="nc-noteitem__top">
              <span class="nc-noteitem__title">
                <span
                  v-for="(seg, si) in segments(item.title || '未命名笔记')"
                  :key="si"
                  :class="{ 'nc-hit': seg.hit }"
                >{{ seg.t }}</span>
              </span>
              <span v-if="item.isPinned" title="已置顶">📌</span>
              <span v-if="item.isStarred" title="已收藏">⭐</span>
            </div>
            <div class="nc-noteitem__excerpt">
              <template v-if="item.excerpt">
                <span
                  v-for="(seg, si) in segments(item.excerpt)"
                  :key="si"
                  :class="{ 'nc-hit': seg.hit }"
                >{{ seg.t }}</span>
              </template>
              <template v-else>（空白笔记）</template>
            </div>
            <div class="nc-noteitem__meta">
              <span>{{ relativeTime(item.updatedAt) }}</span>
              <span v-if="item.updatedBy">· {{ item.updatedBy.name }}</span>
              <span v-if="item.tags.length" class="nc-noteitem__tags">
                {{ item.tags.map((t) => `#${t.name}`).join(' ') }}
              </span>
            </div>

            <div v-if="store.isTrashView" class="nc-noteitem__trash" @click.stop>
              <n-tag size="tiny" :bordered="false" type="warning">
                剩 {{ trashDaysLeft(item.deletedAt, TRASH_RETENTION_DAYS) }} 天
              </n-tag>
              <n-button size="tiny" quaternary @click="restore(item.id)">恢复</n-button>
              <n-popconfirm @positive-click="purge(item.id)">
                <template #trigger>
                  <n-button size="tiny" quaternary type="error">彻底删除</n-button>
                </template>
                删除后无法恢复，确定吗？
              </n-popconfirm>
            </div>
          </div>

          <div v-if="store.hasMore" style="text-align: center; padding: 10px">
            <n-button size="tiny" quaternary @click="store.loadMore()">加载更多</n-button>
          </div>
        </template>
      </div>

      <div v-if="store.isTrashView && store.notes.length > 0" class="nc-notes__listfoot">
        <n-popconfirm @positive-click="emptyAll">
          <template #trigger>
            <n-button size="tiny" type="error" quaternary block>清空回收站</n-button>
          </template>
          将彻底删除回收站里所有你有权删除的笔记，确定吗？
        </n-popconfirm>
      </div>
    </section>

    <!-- 右侧：编辑器 -->
    <section class="nc-notes__main">
      <div v-if="!store.current" class="nc-notes__placeholder">
        <n-empty description="选择一篇笔记，或新建一篇">
          <template #extra>
            <n-button type="primary" @click="createNote">新建笔记</n-button>
          </template>
        </n-empty>
      </div>

      <template v-else>
        <div class="nc-editorhead">
          <n-input
            v-model:value="draftTitle"
            class="nc-editorhead__title"
            placeholder="未命名笔记"
            :bordered="false"
            maxlength="255"
            @update:value="queueSave"
          />

          <div class="nc-editorhead__actions">
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button size="tiny" quaternary @click="togglePin">{{ store.current.isPinned ? '📌' : '📍' }}</n-button>
              </template>
              {{ store.current.isPinned ? '取消置顶' : '置顶' }}
            </n-tooltip>
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button size="tiny" quaternary @click="toggleStar">{{ store.current.isStarred ? '⭐' : '☆' }}</n-button>
              </template>
              {{ store.current.isStarred ? '取消收藏' : '收藏' }}
            </n-tooltip>
            <n-button size="tiny" quaternary @click="archive">
              {{ store.current.archived ? '取消归档' : '归档' }}
            </n-button>
            <n-button size="tiny" quaternary @click="shareOpen = true">分享</n-button>
            <n-popconfirm @positive-click="moveToTrash">
              <template #trigger>
                <n-button size="tiny" quaternary type="error">删除</n-button>
              </template>
              移入回收站？{{ TRASH_RETENTION_DAYS }} 天后自动清理。
            </n-popconfirm>
          </div>
        </div>

        <div class="nc-editorbar">
          <n-select
            v-model:value="selectedNotebooks"
            multiple
            size="tiny"
            :options="notebookOptions"
            placeholder="加入笔记本"
            :max-tag-count="2"
            style="min-width: 180px; flex: 0 1 240px"
          />
          <n-select
            v-model:value="selectedTags"
            multiple
            size="tiny"
            :options="tagOptions"
            placeholder="添加标签"
            :max-tag-count="2"
            style="min-width: 160px; flex: 0 1 220px"
          />
          <div class="nc-editorbar__status">
            <span v-if="store.saving">保存中…</span>
            <span v-else-if="dirty">未保存</span>
            <span v-else-if="store.lastSavedAt">已保存 {{ relativeTime(store.lastSavedAt) }}</span>
            <span v-else>v{{ store.current.version }}</span>
          </div>
        </div>

        <n-alert
          v-if="store.conflict"
          type="warning"
          :bordered="false"
          style="margin: 8px 12px 0"
        >
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
            <span>
              {{ store.conflict.updatedBy?.name ?? '其他人' }} 已经修改了这篇笔记（{{
                relativeTime(store.conflict.updatedAt)
              }}）。你的改动不会被静默覆盖。
            </span>
            <n-button-group size="tiny">
              <n-button @click="useRemote">用服务端版本</n-button>
              <n-button type="primary" @click="keepMine">用我的覆盖</n-button>
            </n-button-group>
          </div>
        </n-alert>

        <div class="nc-editorbody">
          <markdown-editor
            v-model="draftContent"
            :readonly="store.isTrashView"
            :workspace-id="workspaceId"
            @update:model-value="queueSave"
          />
        </div>
      </template>
    </section>

    <tag-manager v-model:show="tagManagerVisible" />

    <share-dialog
      v-if="store.current"
      v-model:show="shareOpen"
      :workspace-id="workspaceId"
      :note-id="store.current.id"
      :note-title="store.current.title"
    />

    <n-modal v-model:show="saveViewOpen" preset="card" title="保存为智能视图" style="max-width: 400px">
      <div style="display: grid; gap: 12px">
        <div>
          <div class="nc-label">名称</div>
          <n-input v-model:value="saveViewName" placeholder="例如：本周待整理" :maxlength="64" @keyup.enter="saveCurrentView" />
        </div>
        <div class="nc-muted">
          会保存当前的筛选条件：
          {{ SMART_VIEWS.find((v) => v.key === store.view)?.label ?? store.view
          }}<template v-if="store.notebookId"> · 指定笔记本</template
          ><template v-if="store.tagId"> · 指定标签</template
          ><template v-if="store.q"> · 关键词「{{ store.q }}」</template>
        </div>
        <n-checkbox v-model:checked="saveViewShared">工作区共享（其他人也能看到）</n-checkbox>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="saveViewOpen = false">取消</n-button>
          <n-button type="primary" :loading="savingView" @click="saveCurrentView">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.nc-hit {
  background: #ffe58f;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

.nc-notes {
  display: grid;
  grid-template-columns: 236px 300px 1fr;
  height: 100%;
  min-height: 0;
  background: #fff;
}

.nc-notes__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid #eef0f2;
  background: #fbfcfd;
}

.nc-notes__views {
  padding: 8px 6px;
  flex: 0 0 auto;
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

/* 智能视图 */
.nc-saved__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 4px;
  font-size: 12px;
  font-weight: 600;
  color: #8a8f99;
}

.nc-saved__empty {
  padding: 2px 12px 8px;
  font-size: 11px;
}

.nc-view--saved .nc-saved__name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-saved__badge {
  font-size: 10px;
  color: #8aa89a;
  border: 1px solid #d6ecdf;
  border-radius: 3px;
  padding: 0 3px;
}

.nc-saved__del {
  opacity: 0;
  color: #b0b6bf;
  padding: 0 2px;
}

.nc-view--saved:hover .nc-saved__del {
  opacity: 1;
}

.nc-label {
  font-size: 12px;
  color: #8a8f99;
  margin-bottom: 4px;
}

.nc-tags {
  flex: 0 0 auto;
  padding: 6px 10px 12px;
  max-height: 180px;
  overflow-y: auto;
}

.nc-tags__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: #8a8f99;
  margin-bottom: 6px;
}

.nc-tags__list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.nc-tags__count {
  margin-left: 2px;
  opacity: 0.6;
}

.nc-notes__list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid #eef0f2;
}

.nc-notes__listhead {
  display: flex;
  gap: 8px;
  padding: 10px;
  flex: 0 0 auto;
  border-bottom: 1px solid #f2f3f5;
}

.nc-notes__listbody {
  flex: 1 1 auto;
  overflow-y: auto;
}

.nc-notes__listfoot {
  flex: 0 0 auto;
  padding: 8px 10px;
  border-top: 1px solid #f2f3f5;
}

.nc-noteitem {
  padding: 10px 12px;
  border-bottom: 1px solid #f5f6f7;
  cursor: pointer;
}

.nc-noteitem:hover {
  background: #fafbfc;
}

.nc-noteitem.is-active {
  background: #f0f7f3;
  box-shadow: inset 3px 0 0 #18a058;
}

.nc-noteitem__top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.nc-noteitem__title {
  font-size: 13.5px;
  font-weight: 600;
  color: #1f2430;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-noteitem__excerpt {
  font-size: 12px;
  color: #7d848f;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.nc-noteitem__meta {
  margin-top: 6px;
  font-size: 11px;
  color: #a3a9b2;
  display: flex;
  gap: 6px;
  align-items: center;
}

.nc-noteitem__tags {
  color: #8aa89a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-noteitem__trash {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.nc-notes__main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.nc-notes__placeholder {
  margin: auto;
}

.nc-editorhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 0;
  flex: 0 0 auto;
}

.nc-editorhead__title {
  flex: 1 1 auto;
  font-size: 18px;
  font-weight: 600;
}

.nc-editorhead__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.nc-editorbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 8px;
  flex: 0 0 auto;
  border-bottom: 1px solid #f2f3f5;
}

.nc-editorbar__status {
  margin-left: auto;
  font-size: 11px;
  color: #a3a9b2;
  white-space: nowrap;
}

.nc-editorbody {
  flex: 1 1 auto;
  min-height: 0;
}
</style>

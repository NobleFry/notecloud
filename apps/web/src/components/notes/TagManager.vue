<script setup lang="ts">
import { NButton, NEmpty, NInput, NModal, NPopconfirm, useMessage } from 'naive-ui';
import { ref } from 'vue';

import * as api from '@/api/notes';
import type { TagDto } from '@/api/notes';
import { useNotesStore } from '@/stores/notes';
import { errorMessage } from '@/utils/error';

const show = defineModel<boolean>('show', { default: false });

const store = useNotesStore();
const message = useMessage();

const PALETTE = ['#18a058', '#2080f0', '#f0a020', '#d03050', '#8a2be2', '#13c2c2', '#8a8f99'];

const newName = ref('');
const newColor = ref<string | null>(null);
const creating = ref(false);

const editingId = ref<string | null>(null);
const editingName = ref('');
const busy = ref(false);

async function create(): Promise<void> {
  const name = newName.value.trim();
  if (!name) {
    message.warning('请填写标签名');
    return;
  }

  creating.value = true;
  try {
    await api.createTag(store.workspaceId!, { name, color: newColor.value });
    newName.value = '';
    newColor.value = null;
    await store.loadTags();
    message.success('标签已添加');
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    creating.value = false;
  }
}

function startEdit(tag: TagDto): void {
  editingId.value = tag.id;
  editingName.value = tag.name;
}

function cancelEdit(): void {
  editingId.value = null;
  editingName.value = '';
}

async function saveRename(tag: TagDto): Promise<void> {
  const name = editingName.value.trim();
  if (!name || name === tag.name) {
    cancelEdit();
    return;
  }

  busy.value = true;
  try {
    await api.updateTag(store.workspaceId!, tag.id, { name });
    await store.loadTags();
    cancelEdit();
    message.success('已重命名');
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}

async function setColor(tag: TagDto, color: string): Promise<void> {
  try {
    await api.updateTag(store.workspaceId!, tag.id, { color });
    await store.loadTags();
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function remove(tag: TagDto): Promise<void> {
  try {
    await api.deleteTag(store.workspaceId!, tag.id);
    if (store.tagId === tag.id) store.selectTag(null);
    await store.loadTags();
    await store.loadNotes(true);
    message.success(`已删除标签「${tag.name}」`);
  } catch (err) {
    message.error(errorMessage(err));
  }
}
</script>

<template>
  <n-modal v-model:show="show" preset="card" title="标签管理" style="max-width: 560px">
    <!-- 新建 -->
    <div class="tm-create">
      <n-input
        v-model:value="newName"
        placeholder="新标签名，回车添加"
        :maxlength="32"
        @keyup.enter="create"
      />
      <div class="tm-palette">
        <button
          v-for="c in PALETTE"
          :key="c"
          class="tm-swatch"
          :class="{ 'is-active': newColor === c }"
          :style="{ background: c }"
          :title="c"
          @click="newColor = newColor === c ? null : c"
        />
      </div>
      <n-button type="primary" :loading="creating" @click="create">添加</n-button>
    </div>

    <div class="tm-list">
      <n-empty v-if="store.tags.length === 0" size="small" description="还没有标签" style="margin: 24px 0" />

      <div v-for="tag in store.tags" :key="tag.id" class="tm-row">
        <span class="tm-dot" :style="{ background: tag.color ?? '#c9ced6' }" />

        <template v-if="editingId === tag.id">
          <n-input
            v-model:value="editingName"
            size="small"
            :maxlength="32"
            autofocus
            @keyup.enter="saveRename(tag)"
            @keyup.esc="cancelEdit"
          />
          <n-button size="tiny" type="primary" :loading="busy" @click="saveRename(tag)">保存</n-button>
          <n-button size="tiny" quaternary @click="cancelEdit">取消</n-button>
        </template>

        <template v-else>
          <span class="tm-name">#{{ tag.name }}</span>
          <span class="tm-count">
            {{ tag.noteCount }} 篇<template v-if="tag.taskCount"> · {{ tag.taskCount }} 项</template>
          </span>

          <div class="tm-colors">
            <button
              v-for="c in PALETTE"
              :key="c"
              class="tm-swatch tm-swatch--sm"
              :style="{ background: c }"
              :title="`设为 ${c}`"
              @click="setColor(tag, c)"
            />
          </div>

          <n-button size="tiny" quaternary @click="startEdit(tag)">重命名</n-button>
          <n-popconfirm @positive-click="remove(tag)">
            <template #trigger>
              <n-button size="tiny" quaternary type="error">删除</n-button>
            </template>
            删除标签会同时解除它与所有笔记的关联（笔记本身不会丢），确定吗？
          </n-popconfirm>
        </template>
      </div>
    </div>

    <template #footer>
      <div class="tm-foot">
        标签是工作区级别的。删除标签不会删除笔记，只会去掉这个标记。
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.tm-create {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f2f3f5;
}

.tm-palette {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
}

.tm-swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid transparent;
  padding: 0;
  cursor: pointer;
}

.tm-swatch.is-active {
  border-color: #333;
}

.tm-swatch--sm {
  width: 10px;
  height: 10px;
  opacity: 0.45;
}

.tm-swatch--sm:hover {
  opacity: 1;
}

.tm-list {
  max-height: 360px;
  overflow-y: auto;
  margin-top: 4px;
}

.tm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px;
  border-bottom: 1px solid #f6f7f8;
}

.tm-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.tm-name {
  flex: 1 1 auto;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tm-count {
  flex: 0 0 auto;
  font-size: 11px;
  color: #a0a6af;
}

.tm-colors {
  display: flex;
  gap: 3px;
  flex: 0 0 auto;
}

.tm-foot {
  font-size: 12px;
  color: #a0a6af;
}
</style>

<script setup lang="ts">
import { NButton, NCard, NEmpty, NInput, NModal, NSpin, useMessage } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import * as api from '@/api/boards';
import type { BoardSummary } from '@/api/boards';
import { errorMessage } from '@/utils/error';
import { relativeTime } from '@/utils/time';

const route = useRoute();
const router = useRouter();
const message = useMessage();

const workspaceId = computed(() => String(route.params.id ?? ''));

const boards = ref<BoardSummary[]>([]);
const loading = ref(true);

const showCreate = ref(false);
const form = ref({ name: '', description: '' });
const creating = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    boards.value = (await api.listBoards(workspaceId.value)).items;
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function create(): Promise<void> {
  const name = form.value.name.trim();
  if (!name) {
    message.warning('请填写看板名称');
    return;
  }

  creating.value = true;
  try {
    const { board } = await api.createBoard(workspaceId.value, {
      name,
      description: form.value.description || null,
    });
    showCreate.value = false;
    form.value = { name: '', description: '' };
    await router.push({ name: 'board', params: { id: workspaceId.value, boardId: board.id } });
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    creating.value = false;
  }
}

function open(board: BoardSummary): void {
  void router.push({ name: 'board', params: { id: workspaceId.value, boardId: board.id } });
}
</script>

<template>
  <div>
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px">
      <div>
        <h3 style="margin: 0 0 4px">看板</h3>
        <div class="nc-muted">卡片就是待办任务，拖进哪一列就等于把它改成那个状态。</div>
      </div>
      <n-button type="primary" @click="showCreate = true">新建看板</n-button>
    </div>

    <n-spin v-if="loading" style="display: block; margin: 64px auto" />

    <n-empty v-else-if="boards.length === 0" description="还没有看板" style="margin: 64px 0">
      <template #extra>
        <n-button type="primary" @click="showCreate = true">创建第一块看板</n-button>
      </template>
    </n-empty>

    <div v-else class="nc-boardgrid">
      <n-card v-for="board in boards" :key="board.id" hoverable size="small" @click="open(board)">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px">
          <span style="font-size: 18px">{{ board.icon ?? '🗂️' }}</span>
          <strong style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ board.name }}</strong>
        </div>

        <div class="nc-muted" style="min-height: 20px; margin-bottom: 10px">
          {{ board.description || '暂无描述' }}
        </div>

        <div style="display: flex; gap: 14px; font-size: 12px; color: #8a8f99">
          <span>{{ board.columnCount }} 列</span>
          <span>{{ board.taskCount }} 张卡片</span>
          <span style="margin-left: auto">{{ relativeTime(board.updatedAt) }}</span>
        </div>
      </n-card>
    </div>

    <n-modal v-model:show="showCreate" preset="card" title="新建看板" style="max-width: 420px">
      <div style="display: grid; gap: 12px">
        <div>
          <div class="nc-label">名称</div>
          <n-input v-model:value="form.name" placeholder="例如：产品迭代" :maxlength="64" @keyup.enter="create" />
        </div>
        <div>
          <div class="nc-label">描述（可选）</div>
          <n-input
            v-model:value="form.description"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="这块看板用来跟踪什么"
            :maxlength="500"
          />
        </div>
        <div class="nc-muted">创建后会自动带上「待办 / 进行中 / 已完成」三列，可以随时改。</div>
      </div>

      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" :loading="creating" @click="create">创建</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.nc-boardgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.nc-label {
  font-size: 12px;
  color: #8a8f99;
  margin-bottom: 4px;
}
</style>

<script setup lang="ts">
import { NAlert, NButton, NCard, NDescriptions, NDescriptionsItem, NTag, useMessage } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';

import { ROLE_LABEL } from '@notecloud/shared';

import { apiGet, apiPost } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';
import { errorMessage } from '@/utils/error';

const auth = useAuthStore();
const workspace = useWorkspaceStore();
const message = useMessage();

const current = computed(() => auth.workspaces.find((w) => w.id === workspace.currentId) ?? null);

interface DeletedWorkspace {
  id: string;
  name: string;
  daysLeft: number;
  deletedAt: string;
}

const deleted = ref<DeletedWorkspace[]>([]);

async function loadDeleted(): Promise<void> {
  try {
    deleted.value = (await apiGet<{ items: DeletedWorkspace[] }>('/workspaces/deleted')).items;
  } catch {
    deleted.value = [];
  }
}

async function restore(id: string): Promise<void> {
  try {
    await apiPost(`/workspaces/${id}/restore`);
    message.success('工作区已恢复');
    await auth.fetchMe();
    await loadDeleted();
  } catch (err) {
    message.error(errorMessage(err));
  }
}

onMounted(loadDeleted);
</script>

<template>
  <div>
    <n-card v-if="deleted.length" title="已删除的工作区" style="margin-bottom: 16px">
      <n-alert type="info" :bordered="false" style="margin-bottom: 12px">
        删除后 30 天内可以恢复；到期后会连同其中的笔记、任务、附件一起物理删除。
      </n-alert>

      <div v-for="item in deleted" :key="item.id" class="nc-deleted">
        <span class="nc-deleted__name">{{ item.name }}</span>
        <span class="nc-muted">剩 {{ item.daysLeft }} 天</span>
        <n-button size="tiny" type="primary" @click="restore(item.id)">恢复</n-button>
      </div>
    </n-card>

    <n-card title="工作区概览" style="margin-bottom: 16px">
      <n-descriptions v-if="current" :column="2" label-placement="left" bordered size="small">
        <n-descriptions-item label="名称">{{ current.name }}</n-descriptions-item>
        <n-descriptions-item label="标识">{{ current.slug }}</n-descriptions-item>
        <n-descriptions-item label="我的角色">
          <n-tag size="small" :bordered="false" type="success">{{ ROLE_LABEL[current.role] }}</n-tag>
        </n-descriptions-item>
        <n-descriptions-item label="成员数">{{ current.memberCount }}</n-descriptions-item>
      </n-descriptions>

      <n-alert v-else type="warning" :bordered="false">还没有选择工作区。</n-alert>
    </n-card>
  </div>
</template>

<style scoped>
.nc-deleted {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #f7f8f9;
}

.nc-deleted:last-child {
  border-bottom: none;
}

.nc-deleted__name {
  flex: 1 1 auto;
  font-size: 13px;
}
</style>

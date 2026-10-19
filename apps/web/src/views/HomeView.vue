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

const roadmap = [
  { title: '笔记', desc: 'Markdown 分栏编辑、笔记本树、标签、回收站、中文全文检索', milestone: 'M2' },
  { title: '待办', desc: '任务分配、优先级、截止时间、今日与逾期视图、评论与 @提及', milestone: 'M3' },
  { title: '看板', desc: '拖拽排序与跨列流转（卡片即任务）、WIP 限制、多视图', milestone: 'M4' },
  { title: '同步与加固', desc: '增量同步、WebSocket 实时广播、分享链接、附件、通知中心', milestone: 'M5' },
];
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

    <n-card title="M1 已完成的能力">
      <ul style="margin: 0; padding-left: 20px; line-height: 1.9">
        <li>账户体系：注册、登录、登出、Refresh Token 轮转与重放检测</li>
        <li>安全：argon2id 密码哈希、会话设备管理、修改密码后吊销其它会话</li>
        <li>工作区：创建、成员邀请（通用链接 / 指定邮箱）、四级角色权限</li>
        <li>权限不变量：每个工作区至少一个所有者、不能移除所有者、转让所有权</li>
        <li>审计日志：注册、建工作区、删工作区、移除成员、接受邀请</li>
      </ul>
    </n-card>

    <n-card title="接下来的里程碑" style="margin-top: 16px">
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px">
        <div
          v-for="item in roadmap"
          :key="item.milestone"
          style="border: 1px solid #efefef; border-radius: 8px; padding: 12px"
        >
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px">
            <strong>{{ item.title }}</strong>
            <n-tag size="tiny" :bordered="false">{{ item.milestone }}</n-tag>
          </div>
          <div class="nc-muted">{{ item.desc }}</div>
        </div>
      </div>
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

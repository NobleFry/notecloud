<script setup lang="ts">
import { NAlert, NButton, NEmpty, NInputNumber, NModal, NPopconfirm, NTag, useMessage } from 'naive-ui';
import { ref, watch } from 'vue';

import * as api from '@/api/share';
import type { ShareLinkDto } from '@/api/share';
import { errorMessage } from '@/utils/error';

const props = defineProps<{ workspaceId: string; noteId: string; noteTitle: string }>();
const show = defineModel<boolean>('show', { default: false });

const message = useMessage();

const links = ref<ShareLinkDto[]>([]);
const loading = ref(false);
const creating = ref(false);
const expiresInDays = ref<number | null>(null);
const lastCreated = ref<string | null>(null);

watch(show, async (open) => {
  if (!open) return;
  lastCreated.value = null;
  await load();
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    links.value = (await api.listShareLinks(props.workspaceId, props.noteId)).items;
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  creating.value = true;
  try {
    const res = await api.createShareLink(props.workspaceId, props.noteId, expiresInDays.value);
    lastCreated.value = `${window.location.origin}${res.link.path}`;
    await copy(lastCreated.value);
    await load();
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    creating.value = false;
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success('链接已复制');
  } catch {
    message.warning('复制失败，请手动选中复制');
  }
}

function fullUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

async function revoke(link: ShareLinkDto): Promise<void> {
  try {
    await api.revokeShareLink(props.workspaceId, link.id);
    await load();
    message.success('已撤销');
  } catch (err) {
    message.error(errorMessage(err));
  }
}
</script>

<template>
  <n-modal v-model:show="show" preset="card" title="分享笔记" style="max-width: 560px">
    <div class="nc-share__note">{{ noteTitle || '未命名笔记' }}</div>

    <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
      任何拿到链接的人都能以**只读**方式查看这篇笔记，不需要登录。
      链接里的 token 不可猜测；撤销后立即失效。
    </n-alert>

    <div class="nc-share__create">
      <n-input-number v-model:value="expiresInDays" :min="1" :max="365" clearable placeholder="永久有效" style="width: 150px">
        <template #suffix>天</template>
      </n-input-number>
      <n-button type="primary" :loading="creating" @click="create">创建链接</n-button>
    </div>

    <n-alert v-if="lastCreated" type="success" :bordered="false" style="margin: 12px 0">
      <div style="display: flex; gap: 8px; align-items: center">
        <code style="flex: 1; word-break: break-all; font-size: 12px">{{ lastCreated }}</code>
        <n-button size="tiny" @click="copy(lastCreated)">复制</n-button>
      </div>
    </n-alert>

    <div class="nc-share__list">
      <n-empty v-if="links.length === 0" size="small" description="还没有分享链接" style="margin: 20px 0" />

      <div v-for="link in links" :key="link.id" class="nc-share__item">
        <div class="nc-share__meta">
          <n-tag size="tiny" :bordered="false" :type="link.usable ? 'success' : 'default'">
            {{ link.usable ? '有效' : '已失效' }}
          </n-tag>
          <span class="nc-muted">
            {{ link.expiresAt ? `到期 ${new Date(link.expiresAt).toLocaleDateString('zh-CN')}` : '永久有效' }}
            · 浏览 {{ link.viewCount }} 次
            · {{ link.createdBy.name }}
          </span>
        </div>

        <div class="nc-share__actions">
          <n-button v-if="link.usable" size="tiny" quaternary @click="copy(fullUrl(link.path))">复制</n-button>
          <n-popconfirm v-if="link.usable" @positive-click="revoke(link)">
            <template #trigger>
              <n-button size="tiny" quaternary type="error">撤销</n-button>
            </template>
            撤销后该链接立即失效，确定吗？
          </n-popconfirm>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.nc-share__note {
  font-weight: 600;
  margin-bottom: 10px;
}

.nc-share__create {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid #f2f3f5;
}

.nc-share__list {
  max-height: 300px;
  overflow-y: auto;
  margin-top: 8px;
}

.nc-share__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
  border-bottom: 1px solid #f7f8f9;
}

.nc-share__meta {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}

.nc-share__actions {
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}
</style>

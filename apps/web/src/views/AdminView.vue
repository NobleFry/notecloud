<script setup lang="ts">
import {
  NAlert,
  NAvatar,
  NButton,
  NCard,
  NDataTable,
  NInput,
  NModal,
  NPopconfirm,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { computed, h, onMounted, ref, watch } from 'vue';

import * as api from '@/api/admin';
import type { AdminOverview, AdminUser } from '@/api/admin';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/error';
import { relativeTime } from '@/utils/time';

const auth = useAuthStore();
const message = useMessage();

const overview = ref<AdminOverview | null>(null);
const users = ref<AdminUser[]>([]);
const loading = ref(true);
const search = ref('');

const tempPassword = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [o, list] = await Promise.all([
      api.adminOverview(),
      api.adminListUsers({ q: search.value.trim() || undefined, limit: 50 }),
    ]);
    overview.value = o;
    users.value = list.items;
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    loading.value = false;
  }
}

let searchTimer: number | null = null;
watch(search, () => {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void load(), 350);
});

onMounted(load);

// ── 表格 ────────────────────────────────────────────────────────
const columns: DataTableColumns<AdminUser> = [
  {
    title: '用户',
    key: 'name',
    render: (row) =>
      h('div', { style: 'display:flex;align-items:center;gap:8px' }, [
        h(NAvatar, { round: true, size: 26, src: row.avatarUrl ?? undefined }, { default: () => row.name[0] }),
        h('div', [
          h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
            row.name,
            row.role === 'ADMIN'
              ? h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => '站点管理员' })
              : null,
          ]),
          h('div', { style: 'font-size:12px;color:#8a8f99' }, row.email),
        ]),
      ]),
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: row.status === 'ACTIVE' ? 'success' : 'error' },
        { default: () => (row.status === 'ACTIVE' ? '正常' : '已停用') },
      ),
  },
  {
    title: '内容',
    key: 'counts',
    width: 150,
    render: (row) =>
      h(
        'div',
        { style: 'font-size:12px;color:#8a8f99' },
        `${row.counts.workspaces} 空间 · ${row.counts.notes} 笔记 · ${row.counts.tasks} 任务`,
      ),
  },
  {
    title: '最后登录',
    key: 'lastLoginAt',
    width: 120,
    render: (row) => (row.lastLoginAt ? relativeTime(row.lastLoginAt) : h('span', { style: 'color:#a0a6af' }, '从未')),
  },
  {
    title: '操作',
    key: 'actions',
    width: 300,
    render: (row) => {
      const self = row.id === auth.user?.id;
      return h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' }, [
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            disabled: self,
            onClick: () =>
              void updateUser(row, { status: row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }),
          },
          { default: () => (row.status === 'ACTIVE' ? '停用' : '启用') },
        ),
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            disabled: self,
            onClick: () => void updateUser(row, { role: row.role === 'ADMIN' ? 'USER' : 'ADMIN' }),
          },
          { default: () => (row.role === 'ADMIN' ? '取消管理员' : '设为管理员') },
        ),
        h(
          NPopconfirm,
          { onPositiveClick: () => void resetPassword(row) },
          {
            trigger: () =>
              h(NButton, { size: 'tiny', quaternary: true, disabled: self }, { default: () => '重置密码' }),
            default: () => `重置后该用户所有设备会被登出，确定吗？`,
          },
        ),
      ]);
    },
  },
];

async function updateUser(row: AdminUser, payload: { status?: 'ACTIVE' | 'DISABLED'; role?: 'USER' | 'ADMIN' }): Promise<void> {
  try {
    await api.adminUpdateUser(row.id, payload);
    message.success('已更新');
    await load();
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function resetPassword(row: AdminUser): Promise<void> {
  try {
    const res = await api.adminResetPassword(row.id);
    tempPassword.value = res.temporaryPassword;
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function copyTemp(): Promise<void> {
  if (!tempPassword.value) return;
  try {
    await navigator.clipboard.writeText(tempPassword.value);
    message.success('已复制');
  } catch {
    message.warning('复制失败，请手动选中');
  }
}

// ── 概览卡片 ────────────────────────────────────────────────────
const stats = computed(() => {
  const o = overview.value;
  if (!o) return [];
  return [
    { label: '用户', value: o.users, hint: `${o.activeUsers} 个正常` },
    { label: '工作区', value: o.workspaces, hint: '未删除' },
    { label: '笔记', value: o.notes, hint: '未删除' },
    { label: '任务', value: o.tasks, hint: '未删除' },
    { label: '附件', value: o.attachments.count, hint: `${(o.attachments.bytes / 1024 / 1024).toFixed(1)} MB` },
    { label: '在线会话', value: o.activeSessions, hint: '未过期' },
  ];
});
</script>

<template>
  <div>
    <div style="margin-bottom: 16px">
      <h3 style="margin: 0 0 4px">站点管理</h3>
      <div class="nc-muted">跨工作区的全局视图。这里的操作会影响整个站点。</div>
    </div>

    <div class="nc-statgrid">
      <n-card v-for="s in stats" :key="s.label" size="small" :bordered="false">
        <div class="nc-stat__label">{{ s.label }}</div>
        <div class="nc-stat__value">{{ s.value }}</div>
        <div class="nc-stat__hint">{{ s.hint }}</div>
      </n-card>
    </div>

    <n-card title="用户" size="small" style="margin-top: 16px">
      <template #header-extra>
        <n-input v-model:value="search" size="small" clearable placeholder="搜索邮箱或昵称" style="width: 220px" />
      </template>

      <n-data-table
        :columns="columns"
        :data="users"
        :loading="loading"
        :bordered="false"
        size="small"
        :row-key="(row: AdminUser) => row.id"
      />
    </n-card>

    <n-modal
      :show="tempPassword !== null"
      preset="card"
      title="临时密码"
      style="max-width: 420px"
      @update:show="(v: boolean) => !v && (tempPassword = null)"
    >
      <n-alert type="warning" :bordered="false" style="margin-bottom: 12px">
        这个密码只显示一次，请立刻转交给用户。该用户的所有设备已被登出。
      </n-alert>
      <div style="display: flex; gap: 8px; align-items: center">
        <code style="flex: 1; font-size: 15px; padding: 8px; background: #f6f7f8; border-radius: 6px">
          {{ tempPassword }}
        </code>
        <n-button size="small" @click="copyTemp">复制</n-button>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.nc-statgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.nc-stat__label {
  font-size: 12px;
  color: #8a8f99;
}

.nc-stat__value {
  font-size: 24px;
  font-weight: 600;
  color: #1f2430;
  line-height: 1.3;
}

.nc-stat__hint {
  font-size: 11px;
  color: #a0a6af;
}
</style>

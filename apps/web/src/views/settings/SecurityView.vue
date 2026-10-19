<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NPopconfirm,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { h, onMounted, ref } from 'vue';

import { passwordSchema } from '@notecloud/shared';

import { apiDelete, apiGet, apiPost } from '@/api/client';
import type { SessionRow } from '@/api/types';
import { errorMessage } from '@/utils/error';

const message = useMessage();

const pwModel = ref({ currentPassword: '', newPassword: '', confirm: '' });
const pwSaving = ref(false);
const pwError = ref('');

const sessions = ref<SessionRow[]>([]);
const sessionsLoading = ref(false);

function shortAgent(ua: string | null): string {
  if (!ua) return '未知设备';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/curl\//i.test(ua)) return 'curl';
  return '未知设备';
}

const columns: DataTableColumns<SessionRow> = [
  {
    title: '设备',
    key: 'userAgent',
    render: (row) =>
      h('div', [
        h('div', shortAgent(row.userAgent)),
        h('div', { style: 'font-size:12px;color:#8a8f99' }, row.ip ?? '—'),
      ]),
  },
  {
    title: '最后活跃',
    key: 'lastUsedAt',
    render: (row) => new Date(row.lastUsedAt).toLocaleString('zh-CN'),
  },
  {
    title: '',
    key: 'actions',
    render: (row) =>
      row.current
        ? h(NTag, { size: 'small', bordered: false, type: 'success' }, { default: () => '当前设备' })
        : h(
            NPopconfirm,
            { onPositiveClick: () => revoke(row.id) },
            {
              trigger: () => h(NButton, { size: 'tiny', quaternary: true, type: 'error' }, { default: () => '撤销' }),
              default: () => '撤销后该设备需要重新登录，确定吗？',
            },
          ),
  },
];

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  try {
    const data = await apiGet<{ items: SessionRow[] }>('/me/sessions');
    sessions.value = data.items;
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    sessionsLoading.value = false;
  }
}

async function revoke(sessionId: string): Promise<void> {
  try {
    await apiDelete(`/me/sessions/${sessionId}`);
    message.success('已撤销该设备');
    await loadSessions();
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function setPassword(): Promise<void> {
  pwError.value = '';
  if (pwModel.value.newPassword !== pwModel.value.confirm) {
    pwError.value = '两次输入的新密码不一致';
    return;
  }
  const parsed = passwordSchema.safeParse(pwModel.value.newPassword);
  if (!parsed.success) {
    pwError.value = parsed.error.issues[0]?.message ?? '新密码不符合要求';
    return;
  }

  pwSaving.value = true;
  try {
    await apiPost('/auth/password/change', {
      currentPassword: pwModel.value.currentPassword,
      newPassword: pwModel.value.newPassword,
    });
    message.success('密码已更新，其它设备已被强制下线');
    pwModel.value = { currentPassword: '', newPassword: '', confirm: '' };
    await loadSessions();
  } catch (err) {
    pwError.value = errorMessage(err);
  } finally {
    pwSaving.value = false;
  }
}

onMounted(loadSessions);
</script>

<template>
  <div style="display: grid; gap: 16px; max-width: 760px">
    <n-card title="修改密码">
      <n-alert v-if="pwError" type="error" :bordered="false" style="margin-bottom: 16px">
        {{ pwError }}
      </n-alert>

      <n-form label-placement="top" :model="pwModel">
        <n-form-item label="当前密码">
          <n-input v-model:value="pwModel.currentPassword" type="password" show-password-on="click" />
        </n-form-item>
        <n-form-item label="新密码">
          <n-input
            v-model:value="pwModel.newPassword"
            type="password"
            show-password-on="click"
            placeholder="至少 10 位，需含字母与数字"
          />
        </n-form-item>
        <n-form-item label="确认新密码">
          <n-input v-model:value="pwModel.confirm" type="password" show-password-on="click" />
        </n-form-item>
      </n-form>

      <n-button type="primary" :loading="pwSaving" @click="setPassword">更新密码</n-button>
      <div class="nc-muted" style="margin-top: 10px">
        修改成功后，除当前设备外的所有登录会话都会被吊销。
      </div>
    </n-card>

    <n-card title="登录设备">
      <n-data-table
        :columns="columns"
        :data="sessions"
        :loading="sessionsLoading"
        :bordered="false"
        size="small"
      />
    </n-card>
  </div>
</template>

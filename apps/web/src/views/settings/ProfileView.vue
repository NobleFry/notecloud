<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  useMessage,
} from 'naive-ui';
import { ref } from 'vue';

import { apiPatch } from '@/api/client';
import type { PublicUser } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/error';

const auth = useAuthStore();
const message = useMessage();

const model = ref({
  name: auth.user?.name ?? '',
  avatarUrl: auth.user?.avatarUrl ?? '',
  timezone: auth.user?.timezone ?? 'Asia/Shanghai',
});

const timezones = [
  { label: '(UTC+08:00) 北京 / 上海', value: 'Asia/Shanghai' },
  { label: '(UTC+08:00) 香港 / 新加坡', value: 'Asia/Hong_Kong' },
  { label: '(UTC+09:00) 东京', value: 'Asia/Tokyo' },
  { label: '(UTC+00:00) UTC', value: 'UTC' },
  { label: '(UTC-05:00) 纽约', value: 'America/New_York' },
  { label: '(UTC-08:00) 洛杉矶', value: 'America/Los_Angeles' },
];

const saving = ref(false);
const error = ref('');

async function save(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    const { user } = await apiPatch<{ user: PublicUser }>('/auth/me', {
      name: model.value.name,
      avatarUrl: model.value.avatarUrl || null,
      timezone: model.value.timezone,
    });
    auth.user = user;
    message.success('已保存');
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <n-card title="个人资料" style="max-width: 560px">
    <n-alert v-if="error" type="error" :bordered="false" style="margin-bottom: 16px">{{ error }}</n-alert>

    <n-form label-placement="top" :model="model">
      <n-form-item label="邮箱">
        <n-input :value="auth.user?.email" disabled />
      </n-form-item>
      <n-form-item label="昵称">
        <n-input v-model:value="model.name" placeholder="你的名字" />
      </n-form-item>
      <n-form-item label="头像地址">
        <n-input v-model:value="model.avatarUrl" placeholder="https://... （留空则用昵称首字母）" />
      </n-form-item>
      <n-form-item label="时区">
        <n-select v-model:value="model.timezone" :options="timezones" />
      </n-form-item>
    </n-form>

    <n-button type="primary" :loading="saving" @click="save">保存</n-button>
  </n-card>
</template>

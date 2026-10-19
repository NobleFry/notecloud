<script setup lang="ts">
import { ROLE_LABEL, type WorkspaceRole } from '@notecloud/shared';
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NSpin,
  useMessage,
} from 'naive-ui';
import { onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { apiGet, apiPost } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/error';

interface InvitePreview {
  valid: boolean;
  workspaceName: string | null;
  workspaceIcon: string | null;
  invitedByName: string | null;
  role: WorkspaceRole | null;
  email: string | null;
}

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const message = useMessage();

const token = String(route.params.token ?? '');
const preview = ref<InvitePreview | null>(null);
const loading = ref(true);
const accepting = ref(false);
const error = ref('');

onMounted(async () => {
  try {
    preview.value = await apiGet<InvitePreview>(`/invitations/${token}`);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
});

async function accept(): Promise<void> {
  accepting.value = true;
  error.value = '';
  try {
    const result = await apiPost<{ workspaceId: string; alreadyMember: boolean }>(
      `/invitations/${token}/accept`,
    );
    message.success(result.alreadyMember ? '你已经是该工作区成员' : '已加入工作区');
    await auth.fetchMe();
    await router.replace({ name: 'home' });
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    accepting.value = false;
  }
}
</script>

<template>
  <div class="nc-centered">
    <n-card class="nc-card" title="工作区邀请">
      <n-spin v-if="loading" style="display: block; margin: 24px auto" />

      <template v-else>
        <n-alert v-if="error" type="error" :bordered="false" style="margin-bottom: 16px">
          {{ error }}
        </n-alert>

        <template v-if="preview?.valid">
          <n-descriptions :column="1" bordered size="small" style="margin-bottom: 16px">
            <n-descriptions-item label="工作区">
              {{ preview.workspaceIcon ?? '📁' }} {{ preview.workspaceName }}
            </n-descriptions-item>
            <n-descriptions-item label="邀请人">{{ preview.invitedByName ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="加入后角色">
              {{ preview.role ? ROLE_LABEL[preview.role] : '—' }}
            </n-descriptions-item>
            <n-descriptions-item v-if="preview.email" label="限定邮箱">
              {{ preview.email }}
            </n-descriptions-item>
          </n-descriptions>

          <template v-if="auth.isAuthenticated">
            <n-button type="primary" block :loading="accepting" @click="accept">接受邀请</n-button>
            <div v-if="preview.email && preview.email !== auth.user?.email" class="nc-muted" style="margin-top: 10px">
              该邀请限定其它邮箱，你当前登录的账号无法接受。
            </div>
          </template>

          <template v-else>
            <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
              请先登录或注册账号，再接受邀请。
            </n-alert>
            <div style="display: flex; gap: 10px">
              <n-button
                style="flex: 1"
                @click="router.push({ name: 'login', query: { redirect: route.fullPath } })"
              >
                去登录
              </n-button>
              <n-button
                style="flex: 1"
                type="primary"
                @click="router.push({ name: 'register', query: { invite: token } })"
              >
                注册并加入
              </n-button>
            </div>
          </template>
        </template>

        <template v-else>
          <n-alert type="error" :bordered="false">
            该邀请链接无效、已过期或已达使用上限。请联系工作区管理员重新生成。
          </n-alert>
          <div style="margin-top: 14px; text-align: center">
            <RouterLink :to="{ name: 'login' }">返回登录</RouterLink>
          </div>
        </template>
      </template>
    </n-card>
  </div>
</template>

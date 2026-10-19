<script setup lang="ts">
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NPopconfirm, useMessage } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { apiDelete } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';
import { errorMessage } from '@/utils/error';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const workspace = useWorkspaceStore();
const message = useMessage();

const workspaceId = computed(() => String(route.params.id ?? ''));

const model = ref({ name: '', color: '' });
const saving = ref(false);
const deleting = ref(false);

const isPersonal = computed(() => workspace.detail?.workspace.isPersonal ?? false);

onMounted(async () => {
  try {
    await workspace.load(workspaceId.value);
    model.value = {
      name: workspace.detail?.workspace.name ?? '',
      color: workspace.detail?.workspace.color ?? '',
    };
  } catch (err) {
    message.error(errorMessage(err));
  }
});

async function save(): Promise<void> {
  saving.value = true;
  try {
    await workspace.updateWorkspace({
      name: model.value.name,
      color: model.value.color || null,
    });
    await auth.fetchMe(); // 侧栏名称要跟着变
    message.success('已保存');
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}

async function remove(): Promise<void> {
  const slug = workspace.detail?.workspace.slug;
  if (!slug) return;

  deleting.value = true;
  try {
    await apiDelete(`/workspaces/${workspaceId.value}`, { params: { confirm: slug } });
    message.success('工作区已删除');
    await auth.fetchMe();
    await router.push({ name: 'home' });
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div style="display: grid; gap: 16px; max-width: 620px">
    <n-card title="工作区设置">
      <n-form label-placement="top" :model="model">
        <n-form-item label="名称">
          <n-input v-model:value="model.name" placeholder="工作区名称" />
        </n-form-item>
        <n-form-item label="标识 slug">
          <n-input :value="workspace.detail?.workspace.slug" disabled />
        </n-form-item>
        <n-form-item label="品牌色">
          <n-input v-model:value="model.color" placeholder="#18a058（可留空）" />
        </n-form-item>
      </n-form>

      <n-button type="primary" :loading="saving" @click="save">保存</n-button>
      <div class="nc-muted" style="margin-top: 10px">
        slug 只是展示用标识，页面链接使用工作区 id，改名不会影响已有链接。
      </div>
    </n-card>

    <n-card v-if="workspace.isOwner" title="危险操作">
      <n-alert v-if="isPersonal" type="info" :bordered="false">
        个人空间不能删除。
      </n-alert>

      <template v-else>
        <n-alert type="warning" :bordered="false" style="margin-bottom: 14px">
          删除工作区后，所有成员将无法访问其中的内容（软删除，可联系运维从数据库恢复）。
        </n-alert>
        <n-popconfirm @positive-click="remove">
          <template #trigger>
            <n-button type="error" :loading="deleting">删除工作区</n-button>
          </template>
          确定要删除「{{ workspace.detail?.workspace.name }}」吗？此操作需要二次确认。
        </n-popconfirm>
      </template>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { ROLE_LABEL } from '@notecloud/shared';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSelect,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { computed, h, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import type { InvitationRow, MemberRow } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';
import { errorMessage } from '@/utils/error';

const route = useRoute();
const auth = useAuthStore();
const workspace = useWorkspaceStore();
const message = useMessage();

const workspaceId = computed(() => String(route.params.id ?? ''));

// ── 成员 ────────────────────────────────────────────────────────
const roleOptions = [
  { label: ROLE_LABEL.ADMIN, value: 'ADMIN' },
  { label: ROLE_LABEL.MEMBER, value: 'MEMBER' },
  { label: ROLE_LABEL.GUEST, value: 'GUEST' },
];

const memberColumns = computed<DataTableColumns<MemberRow>>(() => [
  {
    title: '成员',
    key: 'name',
    render: (row) =>
      h('div', [
        h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
          row.user.name,
          row.user.id === auth.user?.id
            ? h(NTag, { size: 'tiny', bordered: false }, { default: () => '你' })
            : null,
          row.user.status === 'DISABLED'
            ? h(NTag, { size: 'tiny', bordered: false, type: 'error' }, { default: () => '已停用' })
            : null,
        ]),
        h('div', { style: 'font-size:12px;color:#8a8f99' }, row.user.email),
      ]),
  },
  {
    title: '角色',
    key: 'role',
    width: 160,
    render: (row) => {
      // 所有者行不可改；也不能改自己的角色（要改得走"转让所有权"）
      if (row.role === 'OWNER' || !workspace.canAdmin || row.user.id === auth.user?.id) {
        return h(NTag, { size: 'small', bordered: false, type: row.role === 'OWNER' ? 'warning' : 'default' }, {
          default: () => ROLE_LABEL[row.role],
        });
      }
      return h(NSelect, {
        value: row.role,
        size: 'small',
        options: roleOptions,
        consistentMenuWidth: false,
        onUpdateValue: (value: string) => void changeRole(row, value as 'ADMIN' | 'MEMBER' | 'GUEST'),
      });
    },
  },
  {
    title: '',
    key: 'actions',
    width: 110,
    render: (row) => {
      if (!workspace.canAdmin || row.role === 'OWNER' || row.user.id === auth.user?.id) return null;
      return h(
        NPopconfirm,
        { onPositiveClick: () => void removeMember(row) },
        {
          trigger: () =>
            h(NButton, { size: 'tiny', quaternary: true, type: 'error' }, { default: () => '移除' }),
          default: () => `确定把 ${row.user.name} 移出工作区吗？`,
        },
      );
    },
  },
]);

async function changeRole(row: MemberRow, role: 'ADMIN' | 'MEMBER' | 'GUEST'): Promise<void> {
  try {
    await workspace.updateMemberRole(row.user.id, role);
    message.success(`已将 ${row.user.name} 设为${ROLE_LABEL[role]}`);
  } catch (err) {
    message.error(errorMessage(err));
  }
}

async function removeMember(row: MemberRow): Promise<void> {
  try {
    await workspace.removeMember(row.user.id);
    message.success('已移除成员');
  } catch (err) {
    message.error(errorMessage(err));
  }
}

// ── 转让所有权 ──────────────────────────────────────────────────
const transferVisible = ref(false);
const transferTargetId = ref<string | null>(null);
const transferCandidates = computed(() =>
  workspace.members
    .filter((m) => m.role !== 'OWNER' && m.user.id !== auth.user?.id)
    .map((m) => ({ label: `${m.user.name}（${ROLE_LABEL[m.role]}）`, value: m.user.id })),
);

async function doTransfer(): Promise<void> {
  if (!transferTargetId.value) return;
  try {
    await workspace.transferOwnership(transferTargetId.value);
    await auth.fetchMe();
    message.success('所有权已转让，你已被降为管理员');
    transferVisible.value = false;
    transferTargetId.value = null;
  } catch (err) {
    message.error(errorMessage(err));
  }
}

// ── 邀请 ────────────────────────────────────────────────────────
const inviteForm = ref({ email: '', role: 'MEMBER' as 'ADMIN' | 'MEMBER' | 'GUEST', maxUses: 1, expiresInDays: 7 });
const creatingInvite = ref(false);
const createdUrl = ref('');

async function createInvite(): Promise<void> {
  creatingInvite.value = true;
  createdUrl.value = '';
  try {
    const result = await workspace.createInvitation({
      ...(inviteForm.value.email ? { email: inviteForm.value.email } : {}),
      role: inviteForm.value.role,
      maxUses: inviteForm.value.maxUses,
      expiresInDays: inviteForm.value.expiresInDays,
    });
    createdUrl.value = result.url;
    message.success('邀请链接已生成');
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    creatingInvite.value = false;
  }
}

async function copyUrl(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    message.success('已复制到剪贴板');
  } catch {
    message.warning('复制失败，请手动选中复制');
  }
}

const invitationColumns: DataTableColumns<InvitationRow> = [
  {
    title: '目标',
    key: 'target',
    render: (row) => (row.email ? row.email : h(NTag, { size: 'small', bordered: false }, { default: () => '通用链接' })),
  },
  { title: '角色', key: 'role', width: 90, render: (row) => ROLE_LABEL[row.role] },
  {
    title: '使用',
    key: 'uses',
    width: 80,
    render: (row) => `${row.uses} / ${row.maxUses}`,
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: row.usable ? 'success' : 'default' },
        { default: () => (row.usable ? '可用' : '已失效') },
      ),
  },
  {
    title: '有效期至',
    key: 'expiresAt',
    render: (row) => new Date(row.expiresAt).toLocaleDateString('zh-CN'),
  },
  {
    title: '',
    key: 'actions',
    width: 90,
    render: (row) =>
      row.usable
        ? h(
            NPopconfirm,
            { onPositiveClick: () => void revokeInvite(row.id) },
            {
              trigger: () => h(NButton, { size: 'tiny', quaternary: true, type: 'error' }, { default: () => '撤销' }),
              default: () => '撤销后该链接立即失效，确定吗？',
            },
          )
        : null,
  },
];

async function revokeInvite(id: string): Promise<void> {
  try {
    await workspace.revokeInvitation(id);
    message.success('已撤销邀请');
  } catch (err) {
    message.error(errorMessage(err));
  }
}

onMounted(async () => {
  try {
    await workspace.load(workspaceId.value);
    await workspace.loadMembers();
    if (workspace.canAdmin) await workspace.loadInvitations();
  } catch (err) {
    message.error(errorMessage(err));
  }
});
</script>

<template>
  <div style="display: grid; gap: 16px">
    <n-card title="成员">
      <template #header-extra>
        <n-button v-if="workspace.isOwner" size="small" @click="transferVisible = true">转让所有权</n-button>
      </template>

      <n-data-table
        :columns="memberColumns"
        :data="workspace.members"
        :loading="workspace.loading"
        :bordered="false"
        size="small"
        :row-key="(row: MemberRow) => row.userId"
      />
    </n-card>

    <n-card v-if="workspace.canInvite" title="邀请成员">
      <n-alert type="info" :bordered="false" style="margin-bottom: 16px">
        当前站点为邀请制。生成链接后发给对方即可；不填邮箱则任何人拿到链接都能使用。
      </n-alert>

      <n-form inline label-placement="top" :model="inviteForm">
        <n-form-item label="指定邮箱（可选）">
          <n-input v-model:value="inviteForm.email" placeholder="留空则为通用链接" style="width: 220px" />
        </n-form-item>
        <n-form-item label="角色">
          <n-select v-model:value="inviteForm.role" :options="roleOptions" style="width: 130px" />
        </n-form-item>
        <n-form-item label="可加入人数">
          <n-input-number v-model:value="inviteForm.maxUses" :min="1" :max="100" style="width: 120px" />
        </n-form-item>
        <n-form-item label="有效天数">
          <n-input-number v-model:value="inviteForm.expiresInDays" :min="1" :max="90" style="width: 120px" />
        </n-form-item>
        <n-form-item>
          <n-button type="primary" :loading="creatingInvite" @click="createInvite">生成链接</n-button>
        </n-form-item>
      </n-form>

      <n-alert v-if="createdUrl" type="success" :bordered="false" style="margin: 8px 0 16px">
        <div style="margin-bottom: 6px">链接已生成（只显示这一次，请立即复制）：</div>
        <div style="display: flex; gap: 8px; align-items: center">
          <code style="flex: 1; word-break: break-all; font-size: 12px">{{ createdUrl }}</code>
          <n-button size="small" @click="copyUrl(createdUrl)">复制</n-button>
        </div>
      </n-alert>

      <n-data-table
        v-if="workspace.invitations.length"
        :columns="invitationColumns"
        :data="workspace.invitations"
        :bordered="false"
        size="small"
      />
    </n-card>

    <n-modal v-model:show="transferVisible" preset="card" title="转让工作区所有权" style="max-width: 420px">
      <n-alert type="warning" :bordered="false" style="margin-bottom: 14px">
        转让后你会被降为管理员，新所有者可以删除工作区。
      </n-alert>
      <n-select
        v-model:value="transferTargetId"
        :options="transferCandidates"
        placeholder="选择接收所有权的成员"
      />
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="transferVisible = false">取消</n-button>
          <n-button type="primary" :disabled="!transferTargetId" @click="doTransfer">确认转让</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

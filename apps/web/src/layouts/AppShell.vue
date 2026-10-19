<script setup lang="ts">
import {
  NAlert,
  NAvatar,
  NBadge,
  NButton,
  NDropdown,
  NEmpty,
  NInput,
  NLayout,
  NLayoutSider,
  NMenu,
  NModal,
  NPopover,
  NSelect,
  NTag,
  NTooltip,
  useMessage,
  type MenuOption,
} from 'naive-ui';
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter, type RouteLocationRaw } from 'vue-router';

import { NOTIFICATION_TYPE_ICON, ROLE_LABEL } from '@notecloud/shared';

import type { NotificationDto } from '@/api/notifications';
import { createWorkspace } from '@/api/workspaces';
import { useAuthStore } from '@/stores/auth';
import { useNotificationsStore } from '@/stores/notifications';
import { useRealtimeStore } from '@/stores/realtime';
import { useWorkspaceStore } from '@/stores/workspace';
import { errorMessage } from '@/utils/error';
import { relativeTime } from '@/utils/time';

const auth = useAuthStore();
const workspace = useWorkspaceStore();
const notif = useNotificationsStore();
const realtime = useRealtimeStore();
const router = useRouter();
const route = useRoute();
const message = useMessage();

const ACTIVE_KEY = 'notecloud.activeWorkspace';
const activeId = ref<string | null>(localStorage.getItem(ACTIVE_KEY));

/** 保证 activeId 始终指向一个真实存在的工作区 */
const effectiveId = computed(() => {
  const list = auth.workspaces;
  if (list.length === 0) return null;
  const found = list.find((w) => w.id === activeId.value);
  return (found ?? list.find((w) => w.isPersonal) ?? list[0])!.id;
});

const activeWorkspace = computed(() => auth.workspaces.find((w) => w.id === effectiveId.value) ?? null);

const workspaceOptions = computed(() =>
  auth.workspaces.map((w) => ({
    label: w.isPersonal ? `${w.name}` : `${w.name}（${w.memberCount} 人）`,
    value: w.id,
  })),
);

watch(effectiveId, async (id) => {
  if (!id) return;
  localStorage.setItem(ACTIVE_KEY, id);
  activeId.value = id;
  await workspace.load(id);

  // 如果当前停留在某个工作区的子页面，切换工作区时同步跳转到新工作区的同名页面
  const currentName = route.name;
  if (currentName === 'workspace-members') {
    await router.push({ name: 'workspace-members', params: { id } });
  } else if (currentName === 'workspace-settings') {
    await router.push({ name: 'workspace-settings', params: { id } });
  }
}, { immediate: false });

onMounted(async () => {
  if (effectiveId.value) await workspace.load(effectiveId.value);

  // 通知：先拉一次，然后每 30 秒轮询未读数（WebSocket 断线时的兜底）
  void notif.pollUnread();
  notif.startPolling();
  window.addEventListener('focus', onWindowFocus);

  // 实时：有新通知立刻更新角标，不必等轮询
  offNotification = realtime.subscribe('notification', () => {
    void notif.pollUnread();
  });
  realtime.connect();
});

onBeforeUnmount(() => {
  offNotification?.();
  realtime.disconnect();
  notif.stopPolling();
  window.removeEventListener('focus', onWindowFocus);
});

let offNotification: (() => void) | null = null;

function onWindowFocus(): void {
  void notif.pollUnread();
}

// ── 通知面板 ────────────────────────────────────────────────────
const notifOpen = ref(false);

// ── 新建工作区 ──────────────────────────────────────────────────
const createOpen = ref(false);
const newWorkspaceName = ref('');
const creating = ref(false);

async function submitCreateWorkspace(): Promise<void> {
  const name = newWorkspaceName.value.trim();
  if (!name) {
    message.warning('请填写工作区名称');
    return;
  }

  creating.value = true;
  try {
    const { workspace: created } = await createWorkspace({ name });
    await auth.fetchMe();
    // 建完直接切过去，省一次点击
    activeId.value = created.id;
    await workspace.load(created.id);
    createOpen.value = false;
    newWorkspaceName.value = '';
    message.success(`已创建「${created.name}」，去「成员」页邀请人加入`);
  } catch (err) {
    message.error(errorMessage(err));
  } finally {
    creating.value = false;
  }
}

function onNotifToggle(open: boolean): void {
  if (open) void notif.refresh();
}

async function openNotification(item: NotificationDto): Promise<void> {
  await notif.markRead(item.id);
  notifOpen.value = false;
  if (item.link) await router.push(item.link);
}

function renderLink(to: RouteLocationRaw, label: string) {
  return () => h(RouterLink, { to }, { default: () => label });
}

const menuOptions = computed<MenuOption[]>(() => {
  const id = effectiveId.value;
  const options: MenuOption[] = [
    { label: renderLink({ name: 'home' }, '首页'), key: 'home' },
  ];

  if (id) {
    options.push({ label: renderLink({ name: 'notes', params: { id } }, '笔记'), key: 'notes' });
    options.push({ label: renderLink({ name: 'tasks', params: { id } }, '待办'), key: 'tasks' });
    options.push({ label: renderLink({ name: 'boards', params: { id } }, '看板'), key: 'boards' });
    options.push({ label: renderLink({ name: 'workspace-members', params: { id } }, '成员'), key: 'members' });
    if (workspace.canAdmin) {
      options.push({
        label: renderLink({ name: 'workspace-settings', params: { id } }, '工作区设置'),
        key: 'workspace-settings',
      });
    }
  }

  options.push(
    { type: 'divider', key: 'd1' },
    { label: renderLink({ name: 'profile' }, '个人资料'), key: 'profile' },
    { label: renderLink({ name: 'security' }, '安全设置'), key: 'security' },
  );

  // 站点管理员才有这个入口
  if (auth.isSiteAdmin) {
    options.push({ type: 'divider', key: 'd2' }, { label: renderLink({ name: 'admin' }, '站点管理'), key: 'admin' });
  }

  return options;
});

const activeMenuKey = computed(() => {
  const name = String(route.name ?? '');
  if (name === 'home') return 'home';
  if (name === 'notes') return 'notes';
  if (name === 'tasks') return 'tasks';
  if (name === 'boards' || name === 'board') return 'boards';
  if (name === 'admin') return 'admin';
  if (name === 'workspace-members') return 'members';
  if (name === 'workspace-settings') return 'workspace-settings';
  if (name === 'profile') return 'profile';
  if (name === 'security') return 'security';
  return '';
});

const userMenuOptions = [
  { label: '个人资料', key: 'profile' },
  { label: '安全设置', key: 'security' },
  { type: 'divider', key: 'd' },
  { label: '退出登录', key: 'logout' },
] as const;

async function handleUserMenu(key: string): Promise<void> {
  if (key === 'profile') await router.push({ name: 'profile' });
  if (key === 'security') await router.push({ name: 'security' });
  if (key === 'logout') {
    await auth.logout();
    workspace.reset();
    message.success('已退出登录');
    await router.push({ name: 'login' });
  }
}
</script>

<template>
  <n-layout has-sider style="height: 100vh">
    <n-layout-sider bordered :width="248" :native-scrollbar="false">
      <div style="padding: 18px 16px 8px">
        <div class="nc-brand">
          <span style="font-size: 22px">📚</span>
          <span>{{ auth.siteStatus?.siteName ?? 'NoteCloud' }}</span>
        </div>
        <div class="nc-muted">v{{ auth.siteStatus?.version ?? '0.1.0' }}</div>
      </div>

      <div style="padding: 8px 16px 12px">
        <div style="display: flex; gap: 6px">
          <n-select
            v-model:value="activeId"
            :options="workspaceOptions"
            :consistent-menu-width="false"
            placeholder="选择工作区"
            style="flex: 1 1 auto"
          />
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button size="small" @click="createOpen = true">＋</n-button>
            </template>
            新建团队工作区（个人空间不能邀请他人）
          </n-tooltip>
        </div>

        <div v-if="activeWorkspace" style="margin-top: 8px; display: flex; gap: 6px; align-items: center">
          <n-tag size="small" :bordered="false" type="success">
            {{ ROLE_LABEL[activeWorkspace.role] }}
          </n-tag>
          <n-tag v-if="activeWorkspace.isPersonal" size="small" :bordered="false">个人空间</n-tag>
        </div>
      </div>

      <n-menu :options="menuOptions" :value="activeMenuKey" :indent="18" />
    </n-layout-sider>

    <n-layout>
      <div
        style="
          height: 56px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 20px;
          border-bottom: 1px solid #efefef;
        "
      >
        <div style="font-weight: 600">{{ activeWorkspace?.name ?? '未选择工作区' }}</div>

        <div style="display: flex; align-items: center; gap: 10px">
          <n-popover
            v-model:show="notifOpen"
            trigger="click"
            placement="bottom-end"
            :width="380"
            @update:show="onNotifToggle"
          >
            <template #trigger>
              <n-badge :value="notif.unread" :max="99" :show="notif.hasUnread" :offset="[-2, 4]">
                <n-button quaternary circle>🔔</n-button>
              </n-badge>
            </template>

            <div class="nc-notif">
              <div class="nc-notif__head">
                <strong>通知</strong>
                <n-button size="tiny" quaternary :disabled="!notif.hasUnread" @click="notif.markAll()">
                  全部已读
                </n-button>
              </div>

              <div class="nc-notif__list">
                <n-empty v-if="notif.items.length === 0" size="small" description="没有通知" style="margin: 24px 0" />

                <div
                  v-for="item in notif.items"
                  :key="item.id"
                  class="nc-notif__item"
                  :class="{ 'is-unread': !item.read }"
                  @click="openNotification(item)"
                >
                  <span class="nc-notif__icon">{{ NOTIFICATION_TYPE_ICON[item.type] }}</span>
                  <div class="nc-notif__body">
                    <div class="nc-notif__title">{{ item.title }}</div>
                    <div v-if="item.body" class="nc-notif__excerpt">{{ item.body }}</div>
                    <div class="nc-notif__meta">
                      <span>{{ item.workspace.name }}</span>
                      <span>·</span>
                      <span>{{ relativeTime(item.createdAt) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </n-popover>

          <n-dropdown :options="[...userMenuOptions]" trigger="click" @select="handleUserMenu">
            <n-button quaternary>
              <template #icon>
                <n-avatar round :size="22" :src="auth.user?.avatarUrl ?? undefined">
                  {{ auth.user?.name?.[0]?.toUpperCase() ?? '?' }}
                </n-avatar>
              </template>
              <span style="margin-left: 8px">{{ auth.user?.name }}</span>
              <n-badge v-if="auth.isSiteAdmin" dot type="warning" style="margin-left: 6px" />
            </n-button>
          </n-dropdown>
        </div>
      </div>

      <div :class="route.meta.fullBleed ? 'nc-content nc-content--bleed' : 'nc-content'">
        <router-view />
      </div>
    </n-layout>

    <n-modal v-model:show="createOpen" preset="card" title="新建团队工作区" style="max-width: 420px">
      <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
        团队工作区可以被邀请加入、共享笔记与看板。<br />
        你的<strong>个人空间</strong>只属于你，不能邀请别人。
      </n-alert>

      <div style="margin-bottom: 8px" class="nc-muted">名称</div>
      <n-input
        v-model:value="newWorkspaceName"
        placeholder="例如：产品团队"
        :maxlength="64"
        @keyup.enter="submitCreateWorkspace"
      />

      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="createOpen = false">取消</n-button>
          <n-button type="primary" :loading="creating" @click="submitCreateWorkspace">创建</n-button>
        </div>
      </template>
    </n-modal>
  </n-layout>
</template>

<style scoped>
.nc-content {
  padding: 20px;
  max-width: var(--nc-page-max);
  margin: 0 auto;
}

/* 笔记页要占满整个可用高度，不能有外边距和内边距 */
.nc-content--bleed {
  padding: 0;
  max-width: none;
  margin: 0;
  height: calc(100vh - 56px);
  overflow: hidden;
}

/* 通知面板 */
.nc-notif__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid #f2f3f5;
}

.nc-notif__list {
  max-height: 420px;
  overflow-y: auto;
  margin-top: 4px;
}

.nc-notif__item {
  display: flex;
  gap: 10px;
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.nc-notif__item:hover {
  background: #f7f9fb;
}

.nc-notif__item.is-unread {
  background: #f2f9f5;
}

.nc-notif__icon {
  flex: 0 0 auto;
  width: 20px;
  text-align: center;
  line-height: 1.6;
}

.nc-notif__body {
  flex: 1 1 auto;
  min-width: 0;
}

.nc-notif__title {
  font-size: 13px;
  color: #1f2430;
  line-height: 1.45;
}

.nc-notif__excerpt {
  font-size: 12px;
  color: #7d848f;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-notif__meta {
  font-size: 11px;
  color: #a3a9b2;
  margin-top: 4px;
  display: flex;
  gap: 5px;
}
</style>

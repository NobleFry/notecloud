import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { apiGet, apiPost, setAccessToken, setSessionLostHandler } from '@/api/client';
import type { PublicUser, SiteStatus, WorkspaceSummary } from '@/api/types';

interface SessionPayload {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  workspaces?: WorkspaceSummary[];
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<PublicUser | null>(null);
  const workspaces = ref<WorkspaceSummary[]>([]);
  const siteStatus = ref<SiteStatus | null>(null);
  /** 是否已经尝试过恢复会话（避免路由守卫重复请求） */
  const restored = ref(false);

  const isAuthenticated = computed(() => user.value !== null);
  const isSiteAdmin = computed(() => user.value?.role === 'ADMIN');
  const personalWorkspace = computed(() => workspaces.value.find((w) => w.isPersonal) ?? null);
  const teamWorkspaces = computed(() => workspaces.value.filter((w) => !w.isPersonal));

  function clearSession(): void {
    user.value = null;
    workspaces.value = [];
    setAccessToken(null);
  }

  // 会话被服务端吊销时（重放检测 / 被踢下线），store 自己清干净
  setSessionLostHandler(clearSession);

  async function loadSiteStatus(force = false): Promise<SiteStatus> {
    if (siteStatus.value && !force) return siteStatus.value;
    siteStatus.value = await apiGet<SiteStatus>('/site/status');
    return siteStatus.value;
  }

  async function fetchMe(): Promise<void> {
    const data = await apiGet<{ user: PublicUser; workspaces: WorkspaceSummary[] }>('/auth/me');
    user.value = data.user;
    workspaces.value = data.workspaces;
  }

  /** 应用启动时尝试用 httpOnly cookie 里的 refresh token 恢复登录态 */
  async function restore(): Promise<void> {
    if (restored.value) return;
    try {
      const data = await apiPost<SessionPayload>('/auth/refresh');
      setAccessToken(data.accessToken);
      user.value = data.user;
      await fetchMe();
    } catch {
      clearSession();
    } finally {
      restored.value = true;
    }
  }

  function applySession(data: SessionPayload): void {
    setAccessToken(data.accessToken);
    user.value = data.user;
    if (data.workspaces) workspaces.value = data.workspaces;
  }

  async function login(email: string, password: string): Promise<void> {
    applySession(await apiPost<SessionPayload>('/auth/login', { email, password }));
  }

  async function register(payload: {
    email: string;
    password: string;
    name: string;
    inviteToken?: string;
  }): Promise<void> {
    applySession(await apiPost<SessionPayload>('/auth/register', payload));
  }

  async function logout(): Promise<void> {
    try {
      await apiPost('/auth/logout');
    } catch {
      // 服务端已经失效也无所谓，本地清掉即可
    } finally {
      clearSession();
    }
  }

  function resetBootstrap(): void {
    restored.value = false;
  }

  return {
    user,
    workspaces,
    siteStatus,
    restored,
    isAuthenticated,
    isSiteAdmin,
    personalWorkspace,
    teamWorkspaces,
    loadSiteStatus,
    fetchMe,
    restore,
    login,
    register,
    logout,
    clearSession,
    resetBootstrap,
  };
});

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/setup',
    name: 'setup',
    component: () => import('@/views/SetupView.vue'),
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/invite/:token',
    name: 'invite',
    component: () => import('@/views/InviteView.vue'),
  },
  {
    path: '/share/:token',
    name: 'shared-note',
    component: () => import('@/views/SharedNoteView.vue'),
  },
  {
    path: '/',
    component: () => import('@/layouts/AppShell.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', name: 'home', component: () => import('@/views/HomeView.vue') },
      {
        path: 'w/:id/notes',
        name: 'notes',
        component: () => import('@/views/NotesView.vue'),
        meta: { fullBleed: true },
      },
      {
        path: 'w/:id/tasks',
        name: 'tasks',
        component: () => import('@/views/TasksView.vue'),
        meta: { fullBleed: true },
      },
      {
        path: 'w/:id/boards',
        name: 'boards',
        component: () => import('@/views/BoardsListView.vue'),
      },
      {
        path: 'w/:id/boards/:boardId',
        name: 'board',
        component: () => import('@/views/BoardView.vue'),
        meta: { fullBleed: true },
      },
      { path: 'settings/profile', name: 'profile', component: () => import('@/views/settings/ProfileView.vue') },
      { path: 'settings/security', name: 'security', component: () => import('@/views/settings/SecurityView.vue') },
      {
        path: 'w/:id/settings',
        name: 'workspace-settings',
        component: () => import('@/views/workspace/SettingsView.vue'),
      },
      {
        path: 'admin',
        name: 'admin',
        component: () => import('@/views/AdminView.vue'),
      },
      {
        path: 'w/:id/members',
        name: 'workspace-members',
        component: () => import('@/views/workspace/MembersView.vue'),
      },
    ],
  },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue') },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // 1) 站点是否已初始化 —— 决定能否进 /setup
  let status = auth.siteStatus;
  if (!status) {
    try {
      status = await auth.loadSiteStatus();
    } catch {
      // 后端不可用时不要卡死在守卫里，交给页面显示错误
      return true;
    }
  }

  if (!status.initialized) {
    return to.name === 'setup' ? true : { name: 'setup' };
  }
  if (to.name === 'setup') {
    return { name: 'login' };
  }

  // 2) 尝试用 cookie 恢复登录态（只做一次）
  if (!auth.restored) {
    await auth.restore();
  }

  // 3) 权限跳转
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guestOnly && auth.isAuthenticated) {
    return { name: 'home' };
  }

  return true;
});

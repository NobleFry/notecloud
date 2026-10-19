import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import * as api from '@/api/notifications';
import type { NotificationDto } from '@/api/notifications';

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<NotificationDto[]>([]);
  const unread = ref(0);
  const loading = ref(false);

  /** 轮询句柄。AppShell 挂载时启动，卸载时停掉。 */
  let timer: number | null = null;

  const hasUnread = computed(() => unread.value > 0);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const [list, count] = await Promise.all([api.listNotifications({ limit: 30 }), api.unreadCount()]);
      items.value = list.items;
      unread.value = count.count;
    } finally {
      loading.value = false;
    }
  }

  /** 只拉未读数（轮询用，比拉整页便宜） */
  async function pollUnread(): Promise<void> {
    try {
      unread.value = (await api.unreadCount()).count;
    } catch {
      // 轮询失败不打扰用户
    }
  }

  async function markRead(id: string): Promise<void> {
    const target = items.value.find((n) => n.id === id);
    if (target && !target.read) {
      target.read = true;
      unread.value = Math.max(0, unread.value - 1);
    }
    try {
      await api.markRead(id);
    } catch {
      // 失败就下次刷新时纠正
    }
  }

  async function markAll(): Promise<void> {
    await api.markAllRead();
    for (const item of items.value) item.read = true;
    unread.value = 0;
  }

  function startPolling(intervalMs = 30_000): void {
    stopPolling();
    timer = window.setInterval(() => void pollUnread(), intervalMs);
  }

  function stopPolling(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function reset(): void {
    stopPolling();
    items.value = [];
    unread.value = 0;
  }

  return {
    items,
    unread,
    loading,
    hasUnread,
    refresh,
    pollUnread,
    markRead,
    markAll,
    startPolling,
    stopPolling,
    reset,
  };
});

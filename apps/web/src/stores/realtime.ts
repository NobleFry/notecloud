import { defineStore } from 'pinia';
import { ref } from 'vue';

import { getAccessToken } from '@/api/client';

export type RealtimeEventType =
  | 'notification'
  | 'note.changed'
  | 'task.changed'
  | 'board.changed'
  | 'connected';

export interface RealtimeEvent {
  type: RealtimeEventType;
  workspaceId?: string;
  payload?: Record<string, unknown>;
}

type Handler = (event: RealtimeEvent) => void;

/**
 * WebSocket 客户端。
 *
 * 设计要点：
 *   * token 走 query（浏览器 WebSocket 不能带请求头）
 *   * 断线自动重连，指数退避封顶 30 秒
 *   * 事件按 type 分发；没人订阅也照常维护连接（通知需要它）
 */
export const useRealtimeStore = defineStore('realtime', () => {
  const connected = ref(false);

  const handlers = new Map<string, Set<Handler>>();
  let socket: WebSocket | null = null;
  let retry = 0;
  let reconnectTimer: number | null = null;
  /** 主动断开时不再重连 */
  let closedByUs = false;

  function subscribe(type: RealtimeEventType, handler: Handler): () => void {
    const set = handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(type, set);

    return () => {
      set.delete(handler);
      if (set.size === 0) handlers.delete(type);
    };
  }

  function emit(event: RealtimeEvent): void {
    const set = handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(event);
      } catch (err) {
        console.error('[realtime] 处理器异常', err);
      }
    }
  }

  function buildUrl(): string | null {
    const token = getAccessToken();
    if (!token) return null;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 开发环境同源（Vite 代理 /api），生产同理（Nginx 反代）
    return `${protocol}//${window.location.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
  }

  function connect(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = buildUrl();
    if (!url) return;

    closedByUs = false;
    socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      connected.value = true;
      retry = 0;
    });

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as RealtimeEvent;
        emit(data);
      } catch {
        /* 忽略非 JSON 消息 */
      }
    });

    socket.addEventListener('close', (event) => {
      connected.value = false;
      socket = null;
      if (closedByUs) return;

      // 4401 = 认证失败，重连也没用，等下次登录
      if (event.code === 4401) return;

      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // close 会紧跟着触发，重连逻辑统一放在 close 里
      connected.value = false;
    });
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** retry, 30_000);
    retry += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function disconnect(): void {
    closedByUs = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
    connected.value = false;
  }

  return { connected, subscribe, connect, disconnect };
});

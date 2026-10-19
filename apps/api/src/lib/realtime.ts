import type { WebSocket } from 'ws';

import { prisma } from '../db/prisma.js';

/**
 * WebSocket 连接登记表。
 *
 * 按 userId 分组：一个用户可以同时开多个标签页/设备，每个都要收到。
 * 进程内内存表 —— 自部署是单实例，够用。多实例部署需要换成 Redis pub/sub，
 * 这一点写进 docs/BACKLOG.md 了。
 */
const clients = new Map<string, Set<WebSocket>>();

export interface RealtimeEvent {
  /** 事件名，前端按它分发 */
  type: 'notification' | 'note.changed' | 'task.changed' | 'board.changed';
  workspaceId?: string;
  /** 触发者的 userId，前端可用来忽略自己发起的变更 */
  actorId?: string;
  payload?: unknown;
}

function send(socket: WebSocket, event: RealtimeEvent): void {
  if (socket.readyState !== 1 /* OPEN */) return;
  try {
    socket.send(JSON.stringify(event));
  } catch {
    /* 单个连接发送失败不影响其它连接 */
  }
}

export function registerConnection(userId: string, socket: WebSocket): void {
  const set = clients.get(userId) ?? new Set<WebSocket>();
  set.add(socket);
  clients.set(userId, set);

  const cleanup = (): void => {
    const current = clients.get(userId);
    if (!current) return;
    current.delete(socket);
    if (current.size === 0) clients.delete(userId);
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);

  // 心跳：服务端定期 ping，客户端不回应就断开，避免半开连接堆积
  const heartbeat = setInterval(() => {
    if (socket.readyState === 1) {
      try {
        socket.ping();
      } catch {
        cleanup();
      }
    }
  }, 30_000);

  socket.on('close', () => clearInterval(heartbeat));
}

export function sendToUser(userId: string, event: RealtimeEvent): void {
  const set = clients.get(userId);
  if (!set) return;
  for (const socket of set) send(socket, event);
}

/**
 * 广播给工作区的在线成员。
 *
 * 没有任何在线连接时直接跳过查库 —— 大多数时间其实没人连着。
 */
export async function broadcastWorkspace(
  workspaceId: string,
  event: RealtimeEvent,
  excludeUserId?: string,
): Promise<void> {
  if (clients.size === 0) return;

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    select: { userId: true },
  });

  for (const member of members) {
    if (member.userId === excludeUserId) continue;
    sendToUser(member.userId, { ...event, workspaceId });
  }
}

export function connectionCount(): number {
  let total = 0;
  for (const set of clients.values()) total += set.size;
  return total;
}

/**
 * 广播给工作区成员，但**不等结果**。
 *
 * 业务代码不关心有没有人在线 —— 实时推送是锦上添花，
 * 不能因为它失败或变慢而拖累写请求。
 */
export function emitWorkspace(workspaceId: string, event: RealtimeEvent, excludeUserId?: string): void {
  void broadcastWorkspace(workspaceId, event, excludeUserId).catch(() => undefined);
}

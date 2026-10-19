import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import { verifyAccessToken } from '../../lib/tokens.js';
import { registerConnection } from '../../lib/realtime.js';
import { prisma } from '../../db/prisma.js';

/**
 * WebSocket 入口：`GET /api/v1/ws?token=<accessToken>`
 *
 * 为什么 token 走 query 而不是 Authorization 头：
 * 浏览器的 WebSocket 构造函数不支持自定义请求头。
 * 代价是 token 可能出现在访问日志里 —— 自部署场景可接受，
 * 但**不要**把 WS 地址打到第三方日志里。
 */
export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, async (socket: WebSocket, req) => {
    const token = (req.query as { token?: string }).token;

    if (!token) {
      socket.close(4401, '缺少访问令牌');
      return;
    }

    let userId: string;
    let sessionId: string;
    try {
      const payload = verifyAccessToken(token);
      userId = payload.sub;
      sessionId = payload.sid;
    } catch {
      socket.close(4401, '登录状态无效');
      return;
    }

    // 会话可能已被吊销（登出/改密/重放检测）
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, user: { select: { status: true } } },
    });

    if (!session || session.user.status === 'DISABLED') {
      socket.close(4401, '会话已失效');
      return;
    }

    registerConnection(userId, socket);

    // 客户端可以用这条消息确认连接可用
    socket.send(JSON.stringify({ type: 'connected', payload: { userId } }));
  });
}

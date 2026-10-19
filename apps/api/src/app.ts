import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { env, isProduction, isTest } from './config/env.js';
import { prisma } from './db/prisma.js';
import { attachmentRoutes } from './modules/attachments/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { boardRoutes } from './modules/boards/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { notesRoutes } from './modules/notes/routes.js';
import { realtimeRoutes } from './modules/realtime/routes.js';
import { shareRoutes } from './modules/share/routes.js';
import { siteRoutes } from './modules/site/routes.js';
import { smartViewRoutes } from './modules/smart-views/routes.js';
import { syncRoutes } from './modules/sync/routes.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { invitationRoutes, workspaceRoutes } from './modules/workspaces/routes.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerIdempotencyRecorder } from './plugins/idempotency.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isTest
      ? false
      : {
          level: env.LOG_LEVEL,
          // 开发环境用 pino-pretty 更可读；生产输出 JSON 交给采集器
          ...(isProduction
            ? {}
            : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
        },
    // 生成 requestId，贯穿响应体与日志
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    trustProxy: true,
    bodyLimit: env.MAX_UPLOAD_MB * 1024 * 1024,
  });

  // 容忍「空 body + Content-Type: application/json」
  //
  // 为什么必须处理：axios / fetch 在 POST 无参数时仍可能带上这个头（我们的 axios 实例
  // 就设了默认头），Fastify 默认会直接抛 500 "Body cannot be empty"。
  // 把空 body 解析成 {} 之后，走 zod 的可选字段校验就完全正常了。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    if (raw.trim().length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // ── 安全与基础中间件 ───────────────────────────────────────────
  await app.register(helmet, {
    // 纯 JSON API，不需要 CSP；由前端 Nginx 负责静态资源安全头
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN.split(',').map((s) => s.trim()),
    // Refresh Token 走 cookie，必须允许携带凭据
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
  });

  await app.register(cookie, {
    parseOptions: {},
  });

  // 文件上传：单文件、大小上限来自 .env 的 MAX_UPLOAD_MB
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_MB * 1024 * 1024,
      files: 1,
      fields: 4,
    },
  });

  // WebSocket：实时广播（看板移动、笔记变更、通知）
  await app.register(websocket, {
    options: { maxPayload: 1024 * 64 },
  });

  await app.register(rateLimit, {
    global: false, // 默认不限流，各路由按需开启（见 auth/routes.ts）
    max: 300,
    timeWindow: '1 minute',
  });

  // ── 健康检查（不带 /api/v1 前缀，给容器与负载均衡用）───────────
  app.get('/healthz', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', db: 'up' };
    } catch (err) {
      app.log.error({ err }, 'readyz 检查失败');
      return reply.status(503).send({ status: 'not-ready', db: 'down' });
    }
  });

  registerErrorHandler(app);
  registerIdempotencyRecorder(app);

  // ── 业务路由 ───────────────────────────────────────────────────
  await app.register(
    async (v1) => {
      await v1.register(siteRoutes);
      await v1.register(authRoutes);
      await v1.register(meRoutes);
      await v1.register(workspaceRoutes);
      await v1.register(invitationRoutes);
      await v1.register(notesRoutes);
      await v1.register(taskRoutes);
      await v1.register(boardRoutes);
      await v1.register(attachmentRoutes);
      await v1.register(notificationRoutes);
      await v1.register(syncRoutes);
      await v1.register(shareRoutes);
      await v1.register(smartViewRoutes);
      await v1.register(realtimeRoutes);
      await v1.register(adminRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

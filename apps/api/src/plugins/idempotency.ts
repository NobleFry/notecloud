import { ErrorCode } from '@notecloud/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { prisma } from '../db/prisma.js';
import { AppError } from '../lib/errors.js';

const TTL_MS = 24 * 3_600_000;

/**
 * 幂等保护。
 *
 * 客户端在写请求上带 `Idempotency-Key: <uuid>`，同一 key 重放时直接返回
 * 第一次的响应，而不是再执行一次。典型场景：用户连点两下"保存"、
 * 网络超时后客户端重试。
 *
 * 必须挂在鉴权之后（需要 userId 作为命名空间）。
 */
export async function idempotencyGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.headers['idempotency-key'];
  if (typeof raw !== 'string') return;

  const key = raw.trim();
  // 太短容易碰撞，太长没意义
  if (key.length < 8 || key.length > 128) {
    throw AppError.validation([{ path: 'Idempotency-Key', message: '长度需在 8~128 之间' }]);
  }

  const userId = req.auth?.user.id;
  if (!userId) return;

  const endpoint = `${req.method} ${req.routeOptions.url ?? req.url}`;
  const where = { userId_key_endpoint: { userId, key, endpoint } };

  const existing = await prisma.idempotencyKey.findUnique({ where });

  if (existing?.response) {
    // 重放：原样返回第一次的响应
    void reply
      .header('Idempotency-Replayed', 'true')
      .status(existing.status ?? 200)
      .send(existing.response);
    return;
  }

  if (existing) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, '相同请求正在处理中，请稍后重试');
  }

  await prisma.idempotencyKey.create({
    data: { userId, key, endpoint, expiresAt: new Date(Date.now() + TTL_MS) },
  });

  req.idempotencyContext = { userId, key, endpoint };
}

/**
 * 把成功响应写回幂等记录。
 * 失败（4xx/5xx）**不缓存** —— 否则客户端重试也会拿到同一个错误，没法自愈。
 */
export function registerIdempotencyRecorder(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    const ctx = req.idempotencyContext;
    if (!ctx) return payload;

    try {
      if (reply.statusCode >= 400) {
        await prisma.idempotencyKey.delete({ where: { userId_key_endpoint: ctx } });
        return payload;
      }

      const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
      await prisma.idempotencyKey.update({
        where: { userId_key_endpoint: ctx },
        data: { response: body as never, status: reply.statusCode },
      });
    } catch {
      /* 记录失败不该影响正常响应 */
    }

    return payload;
  });
}

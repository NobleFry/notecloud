import { ErrorCode, HTTP_STATUS_BY_CODE } from '@notecloud/shared';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { isProduction } from '../config/env.js';
import { AppError } from '../lib/errors.js';

interface ErrorBody {
  code: number;
  message: string;
  data: unknown;
  requestId: string;
}

/** 统一响应体，成功路径也走它，保证前端只需认一种形状 */
export function ok<T>(requestId: string, data: T, message = 'ok') {
  return { code: ErrorCode.OK, message, data, requestId };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = {
      code: ErrorCode.NOT_FOUND,
      message: `接口不存在: ${req.method} ${req.url}`,
      data: null,
      requestId: req.id,
    };
    void reply.status(404).send(body);
  });

  app.setErrorHandler((error, req, reply) => {
    const requestId = req.id;
    // Fastify 把 error 参数声明为 unknown，这里统一归一化后再分支
    const err: unknown = error;

    // 1) 我们主动抛的业务错误
    if (err instanceof AppError) {
      const body: ErrorBody = {
        code: err.code,
        message: err.message,
        data: err.details ?? null,
        requestId,
      };
      void reply.status(err.status).send(body);
      return;
    }

    // 2) Zod 校验失败 —— 把字段级错误一并返回，前端可直接标红
    if (err instanceof ZodError) {
      const body: ErrorBody = {
        code: ErrorCode.VALIDATION_FAILED,
        message: '参数校验失败',
        data: {
          issues: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        requestId,
      };
      void reply.status(400).send(body);
      return;
    }

    // 3) 限流（@fastify/rate-limit 抛的）
    if ((err as { statusCode?: number } | null)?.statusCode === 429) {
      const body: ErrorBody = {
        code: ErrorCode.RATE_LIMITED,
        message: '操作过于频繁，请稍后再试',
        data: null,
        requestId,
      };
      void reply.status(429).send(body);
      return;
    }

    // 4) Fastify 自身的校验/解析错误
    const fastifyCode = (err as { code?: string } | null)?.code ?? '';
    if (fastifyCode.startsWith('FST_ERR_VALIDATION') || fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      void reply.status(400).send({
        code: ErrorCode.VALIDATION_FAILED,
        message: err instanceof Error ? err.message : '请求格式不正确',
        data: null,
        requestId,
      } satisfies ErrorBody);
      return;
    }

    // 5) 兜底：真正的意外。记全栈，但不要把内部细节漏给客户端
    req.log.error({ err }, '未处理的服务端异常');
    void reply.status(HTTP_STATUS_BY_CODE[ErrorCode.INTERNAL] ?? 500).send({
      code: ErrorCode.INTERNAL,
      message: isProduction ? '服务器开小差了，请稍后重试' : (err instanceof Error ? err.message : String(err)),
      data: isProduction ? null : { stack: err instanceof Error ? err.stack : undefined },
      requestId,
    } satisfies ErrorBody);
  });
}

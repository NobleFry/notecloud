import type { FastifyInstance } from 'fastify';

import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { ok } from '../../plugins/error-handler.js';

/**
 * 站点公开信息 —— 前端启动后的第一个请求。
 * 前端据此决定：去首次启动引导、去登录页、还是显示注册入口。
 */
export async function siteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/site/status', async (req) => {
    const userCount = await prisma.user.count();

    return ok(req.id, {
      siteName: env.SITE_NAME,
      version: '0.1.0',
      /** false → 前端跳 /setup 创建第一个管理员 */
      initialized: userCount > 0,
      registration: {
        /** 当前为邀请制：false */
        enabled: env.ALLOW_PUBLIC_REGISTRATION || userCount === 0,
        requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION,
        /** SMTP 尚未配置（见 .env 的"邮件 —— 待办"），前端据此隐藏"忘记密码" */
        mailConfigured: Boolean(process.env.SMTP_HOST),
      },
    });
  });
}

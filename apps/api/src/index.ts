import { buildApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { startMaintenance } from './lib/maintenance.js';

async function main(): Promise<void> {
  const app = await buildApp();
  let stopMaintenance: (() => void) | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，开始优雅关闭 ...`);
    stopMaintenance?.();
    try {
      await app.close();
      await prisma.$disconnect();
      app.log.info('已关闭');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '关闭过程出错');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, '启动失败');
    process.exit(1);
  }

  // 测试环境不跑定时任务，否则测试进程会挂着不退出
  if (env.NODE_ENV !== 'test') {
    stopMaintenance = startMaintenance(app.log);
    app.log.info('维护任务已启动（每天 03:15 清理过期回收站/会话/邀请）');
  }
}

void main();

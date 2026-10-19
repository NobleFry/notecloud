/**
 * 种子数据。
 *
 * M1 阶段刻意保持克制：不造 demo 用户、不造假数据。
 * 因为站点管理员是由"首个注册用户"产生的（见 auth/service.ts），
 * 而且这是自部署产品 —— 不该有人在生产库里发现不知道从哪来的测试账号。
 *
 * 只做一件事：把站点配置的默认值写进 site_settings。
 */
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

import { env } from '../src/config/env.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

function makeClient(): PrismaClient {
  const url = new URL(env.DATABASE_URL);
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    connectionLimit: 2,
  });
  return new PrismaClient({ adapter });
}

const DEFAULT_SETTINGS: Array<{ key: string; value: unknown }> = [
  { key: 'site.name', value: 'NoteCloud' },
  // 邀请制：默认不开放公开注册
  { key: 'registration.enabled', value: false },
  { key: 'registration.requireEmailVerification', value: false },
  // SMTP 尚未配置（见 .env 的"邮件 —— 待办"）
  { key: 'mail.enabled', value: false },
  { key: 'invitation.defaultTtlDays', value: 7 },
  { key: 'invitation.defaultMaxUses', value: 1 },
];

async function main(): Promise<void> {
  const prisma = makeClient();
  try {
    for (const setting of DEFAULT_SETTINGS) {
      await prisma.siteSetting.upsert({
        where: { key: setting.key },
        update: {}, // 已存在就不覆盖，避免把管理员改过的配置打回默认值
        create: { key: setting.key, value: setting.value as never },
      });
    }
    console.log(`✓ 已写入 ${DEFAULT_SETTINGS.length} 条站点默认配置`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('✗ 种子数据写入失败:', err);
  process.exit(1);
});

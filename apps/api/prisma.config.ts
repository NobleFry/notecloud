/**
 * Prisma 7 的 CLI 配置。
 *
 * 与 Prisma 6 的三个关键差异：
 *   1. 数据库连接串不再写在 schema 的 datasource 里，而是放这里
 *   2. 环境变量不会自动加载，必须显式 dotenv
 *   3. `prisma migrate dev` 不再自动跑 `prisma generate`
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

const here = dirname(fileURLToPath(import.meta.url));
// apps/api/prisma.config.ts -> 仓库根 .env
loadEnv({ path: resolve(here, '../../.env') });

const databaseUrl = process.env.DATABASE_URL;
const testUrl = process.env.TEST_DATABASE_URL;
const shadowUrl = process.env.SHADOW_DATABASE_URL ?? testUrl;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
    // migrate dev 需要一个「影子库」做 schema diff。
    // 我们的数据库用户没有全局 CREATE DATABASE 权限，所以显式复用 notecloud_test。
    //
    // 但影子库不能与主库相同（Prisma 会报 P3025）—— 跑集成测试时
    // DATABASE_URL 会指向 notecloud_test，这种情况下自动省略。
    ...(shadowUrl && shadowUrl !== databaseUrl ? { shadowDatabaseUrl: shadowUrl } : {}),
  },
});

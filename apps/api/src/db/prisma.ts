import { PrismaMariaDb } from '@prisma/adapter-mariadb';

import { env, isProduction } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Prisma 7 起，所有数据库都必须通过 driver adapter 连接。
 * MySQL / MariaDB 用 @prisma/adapter-mariadb（底层是 node 的 mariadb 驱动）。
 *
 * 连接池参数由底层驱动决定 —— 注意这与 Prisma 6 的默认值不同，
 * 所以这里显式设置，避免升级后出现"连接超时行为变化"的怪问题。
 */
function createAdapter(): PrismaMariaDb {
  const url = new URL(env.DATABASE_URL);

  return new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    connectionLimit: 10,
    // acquireTimeout 与 Prisma 6 的 5s connect_timeout 对齐
    acquireTimeout: 5_000,
    // MySQL 8 默认用 caching_sha2_password。第一次认证（或 MySQL 重启后
    // 认证缓存被清空）时，驱动需要向服务端索取 RSA 公钥来加密密码；
    // 不开启这项就会报 "RSA public key is not available client side"。
    // 连接只走 127.0.0.1 或 compose 内网，开启的 MITM 风险可接受；
    // 若数据库跨公网，应改用 TLS 而不是依赖这个开关。
    allowPublicKeyRetrieval: true,
  });
}

export const prisma = new PrismaClient({
  adapter: createAdapter(),
  log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

export type { Prisma } from '../generated/prisma/client.js';

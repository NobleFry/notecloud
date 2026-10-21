import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

/** 从 start 逐级向上找文件，找到第一个就返回 */
function findUp(start: string, filename: string, maxDepth = 6): string | null {
  let dir = resolve(start);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = resolve(dir, filename);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 定位 .env。
 *
 * 不能写死"模块在 src/config 下往上跳 4 级" —— 打包成 dist/index.js 之后
 * 位置变了，那样会指到仓库外面去（曾经真的读到了仓库外的 .env）。
 * 所以从 cwd 和模块位置分别往上找；都找不到就认为环境变量由容器注入（生产即如此）。
 */
const envFile = findUp(process.cwd(), '.env') ?? findUp(here, '.env');
if (envFile) {
  // dotenv 默认不覆盖已存在的环境变量 —— 容器/CI 注入的优先
  loadEnv({ path: envFile });
}

const repoRoot = envFile ? dirname(envFile) : process.cwd();

/** 把 "true"/"1" 解析成 boolean（z.coerce.boolean() 会把 "false" 也当成 true） */
const boolEnv = (defaultValue: 'true' | 'false' = 'false') =>
  z
    .string()
    .default(defaultValue)
    .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SITE_NAME: z.string().default('NoteCloud'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL 未配置'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少需要 32 个字符'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),

  ALLOW_PUBLIC_REGISTRATION: boolEnv('false'),
  REQUIRE_EMAIL_VERIFICATION: boolEnv('false'),
  FIRST_USER_IS_ADMIN: boolEnv('true'),
  INVITATION_TTL: z.string().default('7d'),
  INVITATION_MAX_USES: z.coerce.number().int().min(1).max(100).default(1),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().default(50),
});

const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  · ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // 配置错误必须在启动时就炸掉，而不是等到某个请求才暴露
  console.error(
    `\n✗ 环境变量校验失败：\n${issues}\n\n` +
      (envFile
        ? `请检查 ${envFile}（可参考 .env.example）\n`
        : '没有找到 .env，且进程环境里缺少必需变量（容器部署请检查 env_file / environment）\n'),
  );
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export { repoRoot };

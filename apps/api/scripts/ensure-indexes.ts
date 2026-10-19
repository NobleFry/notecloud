/**
 * 确保 FULLTEXT（ngram）索引存在。
 *
 * 为什么需要这个脚本：
 *   Prisma 的 schema 语法不支持 `WITH PARSER ngram`，所以这些索引只能是手写 SQL。
 *   但 Prisma 在做 schema diff 时会把"schema 里没有的索引"当成 drift，
 *   于是**每一次** `prisma migrate dev` 都会生成 `DROP INDEX notes_ft_title_content`。
 *
 *   这不是理论问题 —— M3 的迁移第一行就是这句 DROP，把笔记的全文索引删掉了，
 *   导致中文搜索直接失效（MySQL 报 "Can't find FULLTEXT index matching the column list"）。
 *
 * 所以：任何 apply 迁移之后都必须跑一次这个脚本。`db:deploy` 已经内置。
 */
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

import { env } from '../src/config/env.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

interface WantedIndex {
  table: string;
  index: string;
  columns: string;
}

const WANTED: WantedIndex[] = [
  { table: 'notes', index: 'notes_ft_title_content', columns: '`title`, `content`' },
  { table: 'tasks', index: 'tasks_ft_title_description', columns: '`title`, `description`' },
];

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

async function main(): Promise<void> {
  const prisma = makeClient();
  let fixed = 0;

  try {
    for (const want of WANTED) {
      const rows = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*) AS c
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ${want.table}
          AND INDEX_NAME = ${want.index}
      `;

      if (Number(rows[0]?.c ?? 0) > 0) continue;

      // 表可能还未创建（比如只跑了部分迁移），跳过而不是报错
      const table = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*) AS c
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${want.table}
      `;
      if (Number(table[0]?.c ?? 0) === 0) continue;

      await prisma.$executeRawUnsafe(
        `ALTER TABLE \`${want.table}\` ADD FULLTEXT INDEX \`${want.index}\` (${want.columns}) WITH PARSER ngram`,
      );
      console.log(`✓ 重建全文索引 ${want.table}.${want.index}`);
      fixed += 1;
    }

    if (fixed === 0) console.log('✓ 全文索引齐备');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('✗ 索引检查失败:', err);
  process.exit(1);
});

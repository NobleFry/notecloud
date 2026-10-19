import { randomBytes } from 'node:crypto';

/**
 * 生成 slug。
 *
 * 注意：工作区在前端路由里用的是 **id**（已确认的决策），slug 只是给人看的展示字段，
 * 因此这里不需要为"好看"做复杂处理 —— 中文名会退化成随机后缀。
 */
export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  if (base.length >= 2) return base;
  return `ws-${randomBytes(4).toString('hex')}`;
}

/** slug 后加随机后缀，用于冲突重试 */
export function slugWithSuffix(slug: string, attempt: number): string {
  if (attempt === 0) return slug;
  return `${slug.slice(0, 40)}-${randomBytes(2).toString('hex')}`;
}

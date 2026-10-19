import { z } from 'zod';

import { NOTE_VIEWS } from './notes';

// ─────────────────────────────────────────────────────────────────
// 分享链接
// ─────────────────────────────────────────────────────────────────

export const createShareLinkSchema = z.object({
  /** 有效天数；不传 = 永久（直到手动撤销） */
  expiresInDays: z.number().int().min(1).max(365).nullish(),
});
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;

export const SHARE_PATH_PREFIX = '/share/';

// ─────────────────────────────────────────────────────────────────
// 智能视图（保存的过滤器）
//
// 目前只支持笔记列表的过滤维度。任务/看板的智能视图等以后再加。
// ─────────────────────────────────────────────────────────────────

export const smartViewFilterSchema = z.object({
  view: z.enum(NOTE_VIEWS).optional(),
  /** 'none' 表示收件箱 */
  notebookId: z.string().min(1).optional(),
  tagId: z.string().min(1).optional(),
  q: z.string().trim().max(100).optional(),
});
export type SmartViewFilter = z.infer<typeof smartViewFilterSchema>;

export const createSmartViewSchema = z.object({
  name: z.string().trim().min(1, '请填写视图名称').max(64),
  icon: z.string().max(16).nullish(),
  filter: smartViewFilterSchema,
  /** true = 工作区共享；false = 只自己可见 */
  isShared: z.boolean().default(false),
});
export type CreateSmartViewInput = z.infer<typeof createSmartViewSchema>;

export const updateSmartViewSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    icon: z.string().max(16).nullish(),
    filter: smartViewFilterSchema.optional(),
    isShared: z.boolean().optional(),
    position: z.number().int().min(0).max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

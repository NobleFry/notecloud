import { z } from 'zod';

import { TASK_STATUSES } from './tasks';

// ─────────────────────────────────────────────────────────────────
// 看板
//
// 方案 A：卡片就是任务。看板列只是任务的视图维度，
// 拖进某列 = 改 tasks.columnId + 把 status 同步成该列的 status。
// ─────────────────────────────────────────────────────────────────

export const BOARD_NAME_MAX = 64;
export const BOARD_DESC_MAX = 500;
export const COLUMN_NAME_MAX = 64;
export const COLUMN_MAX = 20;
export const BOARD_MAX = 50;

/** 新建看板时自动生成的默认列 */
export const DEFAULT_BOARD_COLUMNS = [
  { name: '待办', status: 'TODO' as const, color: '#8a8f99' },
  { name: '进行中', status: 'IN_PROGRESS' as const, color: '#2080f0' },
  { name: '已完成', status: 'DONE' as const, color: '#18a058' },
] as const;

export const createBoardSchema = z.object({
  name: z.string().trim().min(1, '请填写看板名称').max(BOARD_NAME_MAX),
  description: z.string().trim().max(BOARD_DESC_MAX).nullish(),
  icon: z.string().max(32).nullish(),
  color: z.string().max(16).nullish(),
});
export type CreateBoardInput = z.infer<typeof createBoardSchema>;

export const updateBoardSchema = z
  .object({
    name: z.string().trim().min(1).max(BOARD_NAME_MAX).optional(),
    description: z.string().trim().max(BOARD_DESC_MAX).nullish(),
    icon: z.string().max(32).nullish(),
    color: z.string().max(16).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>;

// ─────────────────────────────────────────────────────────────────
// 列
// ─────────────────────────────────────────────────────────────────

export const createColumnSchema = z.object({
  name: z.string().trim().min(1, '请填写列名').max(COLUMN_NAME_MAX),
  /** 这一列映射的任务状态 */
  status: z.enum(TASK_STATUSES).default('TODO'),
  color: z.string().max(16).nullish(),
  /** WIP 上限；null = 不限 */
  wipLimit: z.number().int().min(1).max(100).nullish(),
});
export type CreateColumnInput = z.infer<typeof createColumnSchema>;

export const updateColumnSchema = z
  .object({
    name: z.string().trim().min(1).max(COLUMN_NAME_MAX).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    color: z.string().max(16).nullish(),
    wipLimit: z.number().int().min(1).max(100).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>;

export const reorderColumnsSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(COLUMN_MAX),
});

/**
 * 拖动任务。
 *
 * `orderedTaskIds` 是**目标列的完整顺序**（含被拖动的任务本身）。
 * 用"整体重排"而不是稀疏索引：一列通常几十张卡，整组重写最简单也最不容易错。
 */
export const moveTaskSchema = z.object({
  taskId: z.string().min(1),
  columnId: z.string().min(1),
  orderedTaskIds: z.array(z.string().min(1)).max(500),
});
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;

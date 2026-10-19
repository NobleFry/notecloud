import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────
// 枚举与展示文案（前后端共用，避免两边各写一套中文）
// ─────────────────────────────────────────────────────────────────

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: '待办',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  CANCELED: '已取消',
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  NONE: '无',
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  URGENT: '紧急',
};

export const TASK_PRIORITY_COLOR: Record<TaskPriority, string> = {
  NONE: '#a8b0ba',
  LOW: '#18a058',
  MEDIUM: '#2080f0',
  HIGH: '#f0a020',
  URGENT: '#d03050',
};

/** 优先级权重，用于排序（数值越大越靠前） */
export const TASK_PRIORITY_RANK: Record<TaskPriority, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  URGENT: 4,
};

export const TASK_VIEWS = ['all', 'today', 'week', 'overdue', 'done', 'assigned', 'mine', 'trash'] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export const TASK_VIEW_LABEL: Record<TaskView, string> = {
  all: '全部待办',
  today: '今天',
  week: '未来 7 天',
  overdue: '已逾期',
  done: '已完成',
  assigned: '指派给我',
  mine: '我创建的',
  trash: '回收站',
};

export const TASK_TITLE_MAX = 255;
export const TASK_DESC_MAX = 20_000;
export const TASK_CHECKLIST_MAX = 50;
export const COMMENT_BODY_MAX = 5_000;

// ─────────────────────────────────────────────────────────────────
// 字段
// ─────────────────────────────────────────────────────────────────

/**
 * ISO 时间字符串。不用 z.iso.datetime() 是为了同时接受
 * `2026-10-17T10:00:00.000Z` 与 `2026-10-17` 两种写法（后者来自日期选择器）。
 */
const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), '时间格式不正确');

// ─────────────────────────────────────────────────────────────────
// 任务
// ─────────────────────────────────────────────────────────────────

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, '请填写任务标题').max(TASK_TITLE_MAX),
  description: z.string().max(TASK_DESC_MAX).nullish(),
  status: z.enum(TASK_STATUSES).default('TODO'),
  priority: z.enum(TASK_PRIORITIES).default('NONE'),
  startAt: isoDate.nullish(),
  dueAt: isoDate.nullish(),
  isAllDay: z.boolean().default(true),
  assigneeId: z.string().min(1).nullish(),
  tagIds: z.array(z.string().min(1)).max(20).default([]),
  /** 直接建在某块看板的某一列上（从看板视图新建卡片时用） */
  columnId: z.string().min(1).nullish(),
  /** 提醒时间 */
  reminderAt: isoDate.nullish(),
  checklist: z
    .array(z.object({ title: z.string().trim().min(1, '子任务不能为空').max(TASK_TITLE_MAX) }))
    .max(TASK_CHECKLIST_MAX)
    .default([]),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * 更新任务。`version` 必填 —— 和笔记同一套乐观锁协议。
 * checklist 与 tagIds 是**整体覆盖**语义（传了就替换掉全部）。
 */
export const updateTaskSchema = z.object({
  version: z.number().int().min(1, '缺少版本号，无法安全保存'),
  title: z.string().trim().min(1).max(TASK_TITLE_MAX).optional(),
  description: z.string().max(TASK_DESC_MAX).nullish(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  startAt: isoDate.nullish(),
  dueAt: isoDate.nullish(),
  isAllDay: z.boolean().optional(),
  assigneeId: z.string().min(1).nullish(),
  /** 提醒时间；传 null 清除 */
  reminderAt: isoDate.nullish(),
  tagIds: z.array(z.string().min(1)).max(20).optional(),
  checklist: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        title: z.string().trim().min(1).max(TASK_TITLE_MAX),
        done: z.boolean().default(false),
      }),
    )
    .max(TASK_CHECKLIST_MAX)
    .optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskListQuerySchema = z.object({
  view: z.enum(TASK_VIEWS).default('all'),
  status: z.enum(TASK_STATUSES).optional(),
  tagId: z.string().min(1).optional(),
  q: z.string().trim().max(100).optional(),
  /** 只看"不在任何看板上"的任务（往看板里加卡片时用） */
  unassigned: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** 勾选/取消勾选单个子任务（比整体提交轻） */
export const toggleChecklistSchema = z.object({
  done: z.boolean(),
});

/** 把任务放进某个看板列，或从看板移出（columnId = null） */
export const setTaskColumnSchema = z.object({
  columnId: z.string().min(1).nullable(),
});

// ─────────────────────────────────────────────────────────────────
// 评论
// ─────────────────────────────────────────────────────────────────

export const createCommentSchema = z.object({
  body: z.string().trim().min(1, '评论不能为空').max(COMMENT_BODY_MAX),
  /** 被 @ 的 userId；M3 只用于高亮，M5 通知复用 */
  mentions: z.array(z.string().min(1)).max(20).optional(),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({
  body: z.string().trim().min(1, '评论不能为空').max(COMMENT_BODY_MAX),
});

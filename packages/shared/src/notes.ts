import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────
// 常量（前后端共用，避免两边写死不同的数字）
// ─────────────────────────────────────────────────────────────────

/** 回收站保留天数。到期由定时任务物理删除 */
export const TRASH_RETENTION_DAYS = 30;

/** 笔记本最大嵌套层级（0 起算，即最多 5 层） */
export const NOTEBOOK_MAX_DEPTH = 4;

export const NOTE_TITLE_MAX = 255;
/** 单篇正文上限 2MB —— 纯文本，够写很长的文档了；超过说明用法不对 */
export const NOTE_CONTENT_MAX = 2_000_000;
export const NOTE_EXCERPT_LEN = 200;
export const NOTEBOOK_NAME_MAX = 64;
export const TAG_NAME_MAX = 32;

export const RESOURCE_VISIBILITIES = ['PRIVATE', 'WORKSPACE'] as const;
export type ResourceVisibility = (typeof RESOURCE_VISIBILITIES)[number];

export const NOTE_VIEWS = ['all', 'starred', 'archived', 'trash'] as const;
export type NoteView = (typeof NOTE_VIEWS)[number];

// ─────────────────────────────────────────────────────────────────
// 笔记本
// ─────────────────────────────────────────────────────────────────

export const createNotebookSchema = z.object({
  name: z.string().trim().min(1, '请填写笔记本名称').max(NOTEBOOK_NAME_MAX),
  parentId: z.string().min(1).nullish(),
  icon: z.string().max(32).nullish(),
  color: z.string().max(16).nullish(),
});
export type CreateNotebookInput = z.infer<typeof createNotebookSchema>;

export const updateNotebookSchema = z
  .object({
    name: z.string().trim().min(1).max(NOTEBOOK_NAME_MAX).optional(),
    icon: z.string().max(32).nullish(),
    color: z.string().max(16).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });
export type UpdateNotebookInput = z.infer<typeof updateNotebookSchema>;

/**
 * 拖拽排序：直接提交新顺序。
 * 笔记本数量是几十级别，整组重排比维护稀疏索引更简单、更不容易出错。
 *
 * `orderedIds` 允许为空：把唯一一个子笔记本拖走时，源父级会剩下空列表，
 * 前端仍会发一次"重排空列表"来把序号清干净。
 */
export const reorderNotebooksSchema = z.object({
  parentId: z.string().min(1).nullish(),
  orderedIds: z.array(z.string().min(1)).max(300),
});
export type ReorderNotebooksInput = z.infer<typeof reorderNotebooksSchema>;

/** 把笔记挂到哪几个笔记本（整体覆盖语义） */
export const setNoteNotebooksSchema = z.object({
  notebookIds: z.array(z.string().min(1)).max(20),
});

// ─────────────────────────────────────────────────────────────────
// 标签
// ─────────────────────────────────────────────────────────────────

export const createTagSchema = z.object({
  name: z.string().trim().min(1, '请填写标签名').max(TAG_NAME_MAX),
  color: z.string().max(16).nullish(),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(TAG_NAME_MAX).optional(),
    color: z.string().max(16).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

export const setNoteTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).max(30),
});

// ─────────────────────────────────────────────────────────────────
// 笔记
// ─────────────────────────────────────────────────────────────────

export const createNoteSchema = z.object({
  title: z.string().trim().max(NOTE_TITLE_MAX).default(''),
  content: z.string().max(NOTE_CONTENT_MAX).default(''),
  notebookIds: z.array(z.string().min(1)).max(20).default([]),
  tagIds: z.array(z.string().min(1)).max(30).default([]),
  visibility: z.enum(RESOURCE_VISIBILITIES).default('WORKSPACE'),
});
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

/**
 * 更新笔记。
 * `version` 必填 —— 这是乐观锁的载体。客户端不传 version 就不许写，
 * 从协议层面杜绝"静默覆盖别人的修改"。
 */
export const updateNoteSchema = z.object({
  version: z.number().int().min(1, '缺少版本号，无法安全保存'),
  title: z.string().trim().max(NOTE_TITLE_MAX).optional(),
  content: z.string().max(NOTE_CONTENT_MAX).optional(),
  visibility: z.enum(RESOURCE_VISIBILITIES).optional(),
  isPinned: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

export const noteListQuerySchema = z.object({
  view: z.enum(NOTE_VIEWS).default('all'),
  notebookId: z.string().min(1).optional(),
  /** 传 'none' 表示只看收件箱（不属于任何笔记本） */
  tagId: z.string().min(1).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});
export type NoteListQuery = z.infer<typeof noteListQuerySchema>;

export const searchNotesQuerySchema = z.object({
  q: z.string().trim().min(1, '请输入搜索词').max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

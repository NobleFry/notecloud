import {
  ErrorCode,
  NOTE_EXCERPT_LEN,
  NOTEBOOK_MAX_DEPTH,
  type NoteListQuery,
  type NoteView,
} from '@notecloud/shared';

import { prisma, type Prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
import { emitWorkspace } from '../../lib/realtime.js';
import { recordChange } from '../sync/service.js';

// ─────────────────────────────────────────────────────────────────
// 通用工具
// ─────────────────────────────────────────────────────────────────

/** 把 Markdown 剥成纯文本摘要，用于列表页 */
export function excerptOf(content: string): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ') // 代码块
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
    .replace(/^#{1,6}\s+/gm, '') // 标题标记
    .replace(/^\s*[-*+]\s+/gm, '') // 列表标记
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return plain.slice(0, NOTE_EXCERPT_LEN);
}

/**
 * 可见性过滤：工作区公开的笔记 + 自己创建的私有笔记。
 * 这条规则必须在**所有**读取笔记的查询里出现，否则就是越权泄漏。
 */
function visibilityFilter(userId: string) {
  return {
    OR: [{ visibility: 'WORKSPACE' as const }, { createdById: userId }],
  };
}

function viewFilter(view: NoteView, userId: string) {
  const base = {
    ...(view === 'trash' ? { deletedAt: { not: null } } : { deletedAt: null }),
    ...visibilityFilter(userId),
  };

  switch (view) {
    case 'trash':
      return base;
    case 'archived':
      return { ...base, archivedAt: { not: null } };
    case 'starred':
      return { ...base, archivedAt: null, isStarred: true };
    default:
      return { ...base, archivedAt: null };
  }
}

// ─────────────────────────────────────────────────────────────────
// 笔记本
// ─────────────────────────────────────────────────────────────────

interface NotebookRow {
  id: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  depth: number;
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  _count: { notes: number };
}

function notebookDto(n: NotebookRow) {
  return {
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    icon: n.icon,
    color: n.color,
    position: n.position,
    depth: n.depth,
    noteCount: n._count.notes,
    createdById: n.createdById,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

export async function listNotebooks(workspaceId: string) {
  const rows = await prisma.notebook.findMany({
    where: { workspaceId, deletedAt: null },
    include: { _count: { select: { notes: { where: { note: { deletedAt: null } } } } } },
    orderBy: [{ parentId: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
  });

  return rows.map((n) => notebookDto(n as unknown as NotebookRow));
}

async function assertParent(workspaceId: string, parentId: string | null | undefined) {
  if (!parentId) return 0;

  const parent = await prisma.notebook.findFirst({
    where: { id: parentId, workspaceId, deletedAt: null },
  });
  if (!parent) throw AppError.notFound('父笔记本');
  if (parent.depth >= NOTEBOOK_MAX_DEPTH) {
    throw AppError.validation([{ path: 'parentId', message: `笔记本最多 ${NOTEBOOK_MAX_DEPTH + 1} 层` }]);
  }
  return parent.depth + 1;
}

/** 工作区内全部未删除的笔记本（构树用） */
async function loadNotebookTree(workspaceId: string) {
  return prisma.notebook.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, parentId: true, depth: true, position: true },
  });
}

/**
 * 环路检测：目标父节点不能是自己，也不能是自己的子孙。
 *
 * 这一步必须在写入**之前**做。一旦树里出现环，所有 recursive 构树逻辑
 * 都会死循环 —— 这是数据损坏，不是显示问题。
 */
async function assertNoCycle(workspaceId: string, movingIds: string[], targetParentId: string | null) {
  if (!targetParentId) return;

  if (movingIds.includes(targetParentId)) {
    throw AppError.validation([{ path: 'parentId', message: '不能把笔记本移动到它自己下面' }]);
  }

  const rows = await loadNotebookTree(workspaceId);
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));

  const seen = new Set<string>();
  let cursor: string | null = targetParentId;
  while (cursor) {
    if (movingIds.includes(cursor)) {
      throw AppError.validation([{ path: 'parentId', message: '不能把笔记本移动到它自己的子节点下面' }]);
    }
    // 防御：万一库里已有脏数据成环，别在这里死循环
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
}

/**
 * 重算整棵树的 depth。
 *
 * 为什么全量重算而不是增量更新？移动一个笔记本会改变它**全部子孙**的深度，
 * 增量维护极容易漏一层。笔记本数量是几十级，全量重算是毫秒级的，且不会错。
 */
async function recomputeDepths(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
  const rows = await tx.notebook.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, parentId: true, depth: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const cache = new Map<string, number>();
  const depthOf = (id: string, guard: Set<string>): number => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;

    const node = byId.get(id);
    if (!node?.parentId) {
      cache.set(id, 0);
      return 0;
    }
    // 脏数据成环时截断，宁可深度算错也不要栈溢出
    if (guard.has(id) || guard.size > 64) {
      cache.set(id, 0);
      return 0;
    }
    guard.add(id);

    const depth = depthOf(node.parentId, guard) + 1;
    cache.set(id, depth);
    return depth;
  };

  for (const row of rows) {
    const next = depthOf(row.id, new Set());
    if (next !== row.depth) {
      await tx.notebook.update({ where: { id: row.id }, data: { depth: next } });
    }
  }
}

export async function createNotebook(
  workspaceId: string,
  userId: string,
  input: { name: string; parentId?: string | null; icon?: string | null; color?: string | null },
) {
  const depth = await assertParent(workspaceId, input.parentId);

  // 新笔记本排到同级末尾
  const last = await prisma.notebook.findFirst({
    where: { workspaceId, parentId: input.parentId ?? null, deletedAt: null },
    orderBy: { position: 'desc' },
    select: { position: true },
  });

  const created = await prisma.notebook.create({
    data: {
      workspaceId,
      parentId: input.parentId ?? null,
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? null,
      depth,
      position: (last?.position ?? -1) + 1,
      createdById: userId,
    },
    include: { _count: { select: { notes: true } } },
  });

  return notebookDto(created as unknown as NotebookRow);
}

export async function updateNotebook(
  workspaceId: string,
  notebookId: string,
  input: { name?: string; icon?: string | null; color?: string | null },
) {
  const existing = await prisma.notebook.findFirst({ where: { id: notebookId, workspaceId, deletedAt: null } });
  if (!existing) throw AppError.notFound('笔记本');

  const updated = await prisma.notebook.update({
    where: { id: notebookId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.icon !== undefined ? { icon: input.icon ?? null } : {}),
      ...(input.color !== undefined ? { color: input.color ?? null } : {}),
    },
    include: { _count: { select: { notes: { where: { note: { deletedAt: null } } } } } },
  });

  return notebookDto(updated as unknown as NotebookRow);
}

/**
 * 删除笔记本。
 * 关键行为（已确认的设计）：**只解除关联，不删笔记**。
 * 所以这里要物理删除 note_notebooks 记录 —— 否则笔记会因为
 * "还挂着已删除的笔记本" 而既不在收件箱、也找不到归属。
 */
export async function deleteNotebook(workspaceId: string, notebookId: string, userId: string, isAdmin: boolean) {
  const notebook = await prisma.notebook.findFirst({ where: { id: notebookId, workspaceId, deletedAt: null } });
  if (!notebook) throw AppError.notFound('笔记本');

  if (!isAdmin && notebook.createdById !== userId) {
    throw AppError.forbidden('只有创建者或管理员可以删除笔记本');
  }

  // 收集自身 + 全部子孙
  const all = await prisma.notebook.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, parentId: true } });
  const ids = new Set<string>([notebookId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of all) {
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        changed = true;
      }
    }
  }
  const targetIds = [...ids];

  await prisma.$transaction([
    // 先解除与笔记的关联（笔记本身保留）
    prisma.noteNotebook.deleteMany({ where: { notebookId: { in: targetIds } } }),
    prisma.notebook.updateMany({
      where: { id: { in: targetIds } },
      data: { deletedAt: new Date() },
    }),
  ]);

  return { deletedCount: targetIds.length, noteIds: [] as string[] };
}

export async function reorderNotebooks(
  workspaceId: string,
  userId: string,
  parentId: string | null | undefined,
  orderedIds: string[],
) {
  const targetParentId = parentId ?? null;

  await assertNoCycle(workspaceId, orderedIds, targetParentId);

  if (targetParentId) {
    const parent = await prisma.notebook.findFirst({
      where: { id: targetParentId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) throw AppError.notFound('父笔记本');
  }

  const found = await prisma.notebook.findMany({
    where: { id: { in: orderedIds }, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (found.length !== orderedIds.length) throw AppError.notFound('笔记本');

  await prisma.$transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.notebook.update({ where: { id }, data: { parentId: targetParentId, position: index } });
    }

    await recomputeDepths(tx, workspaceId);

    // 层级上限放在重算之后判断：用真实深度，而不是凭感觉估算子树高度
    const deepest = await tx.notebook.aggregate({
      where: { workspaceId, deletedAt: null },
      _max: { depth: true },
    });
    if ((deepest._max.depth ?? 0) > NOTEBOOK_MAX_DEPTH) {
      throw AppError.validation([
        { path: 'parentId', message: `移动后会超过 ${NOTEBOOK_MAX_DEPTH + 1} 层，请先整理子笔记本` },
      ]);
    }
  });

  void userId;
  return { reordered: orderedIds.length };
}

// ─────────────────────────────────────────────────────────────────
// 标签
// ─────────────────────────────────────────────────────────────────

export async function listTags(workspaceId: string) {
  const rows = await prisma.tag.findMany({
    where: { workspaceId },
    include: {
      _count: {
        select: {
          notes: { where: { note: { deletedAt: null } } },
          tasks: { where: { task: { deletedAt: null } } },
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    noteCount: t._count.notes,
    taskCount: t._count.tasks,
    createdAt: t.createdAt,
  }));
}

export async function createTag(workspaceId: string, input: { name: string; color?: string | null }) {
  const existing = await prisma.tag.findUnique({
    where: { workspaceId_name: { workspaceId, name: input.name } },
  });
  // 同名标签直接复用，比报错更符合直觉
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      color: existing.color,
      noteCount: 0,
      taskCount: 0,
      createdAt: existing.createdAt,
    };
  }

  const tag = await prisma.tag.create({
    data: { workspaceId, name: input.name, color: input.color ?? null },
  });
  return { id: tag.id, name: tag.name, color: tag.color, noteCount: 0, taskCount: 0, createdAt: tag.createdAt };
}

export async function updateTag(workspaceId: string, tagId: string, input: { name?: string; color?: string | null }) {
  const tag = await prisma.tag.findFirst({ where: { id: tagId, workspaceId } });
  if (!tag) throw AppError.notFound('标签');

  if (input.name && input.name !== tag.name) {
    const clash = await prisma.tag.findUnique({ where: { workspaceId_name: { workspaceId, name: input.name } } });
    if (clash) throw new AppError(ErrorCode.SLUG_TAKEN, '已存在同名标签');
  }

  return prisma.tag.update({
    where: { id: tagId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color ?? null } : {}),
    },
  });
}

export async function deleteTag(workspaceId: string, tagId: string) {
  const tag = await prisma.tag.findFirst({ where: { id: tagId, workspaceId } });
  if (!tag) throw AppError.notFound('标签');
  // 关联表有 onDelete: Cascade，删除标签会自动解除与笔记的关联
  await prisma.tag.delete({ where: { id: tagId } });
}

// ─────────────────────────────────────────────────────────────────
// 笔记
// ─────────────────────────────────────────────────────────────────

const noteListSelect = {
  id: true,
  title: true,
  excerpt: true,
  visibility: true,
  isPinned: true,
  isStarred: true,
  archivedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  createdById: true,
  updatedById: true,
  createdBy: { select: { id: true, name: true, avatarUrl: true } },
  updatedBy: { select: { id: true, name: true, avatarUrl: true } },
  notebooks: { select: { notebookId: true } },
  tags: { select: { tagId: true, tag: { select: { name: true, color: true } } } },
} as const;

function noteListDto(n: {
  id: string;
  title: string;
  excerpt: string | null;
  visibility: string;
  isPinned: boolean;
  isStarred: boolean;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  createdById: string;
  updatedById: string | null;
  createdBy: { id: string; name: string; avatarUrl: string | null };
  updatedBy: { id: string; name: string; avatarUrl: string | null } | null;
  notebooks: { notebookId: string }[];
  tags: { tagId: string; tag: { name: string; color: string | null } }[];
}) {
  return {
    id: n.id,
    title: n.title,
    excerpt: n.excerpt,
    visibility: n.visibility,
    isPinned: n.isPinned,
    isStarred: n.isStarred,
    archived: n.archivedAt !== null,
    version: n.version,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    deletedAt: n.deletedAt,
    createdBy: n.createdBy,
    updatedBy: n.updatedBy,
    notebookIds: n.notebooks.map((x) => x.notebookId),
    tags: n.tags.map((t) => ({ id: t.tagId, name: t.tag.name, color: t.tag.color })),
  };
}

export async function listNotes(workspaceId: string, userId: string, query: NoteListQuery) {
  // 单字符查询走 LIKE：ngram_token_size=2 时 1 个字切不出词，MATCH 必然空结果
  if (query.q && query.q.length < 2) {
    return listNotesByTitleLike(workspaceId, userId, query);
  }
  if (query.q) {
    return searchNotes(workspaceId, userId, query);
  }

  const where = {
    workspaceId,
    ...viewFilter(query.view, userId),
    ...(query.notebookId
      ? query.notebookId === 'none'
        ? { notebooks: { none: {} } }
        : { notebooks: { some: { notebookId: query.notebookId } } }
      : {}),
    ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
  };

  const rows = await prisma.note.findMany({
    where,
    select: noteListSelect,
    orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const items = (hasMore ? rows.slice(0, query.limit) : rows).map((n) => noteListDto(n));
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null, hasMore };
}

async function listNotesByTitleLike(workspaceId: string, userId: string, query: NoteListQuery) {
  const rows = await prisma.note.findMany({
    where: {
      workspaceId,
      ...viewFilter(query.view, userId),
      title: { contains: query.q! },
    },
    select: noteListSelect,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const items = (hasMore ? rows.slice(0, query.limit) : rows).map((n) => noteListDto(n));
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null, hasMore };
}

/**
 * 中文全文检索。
 *
 * 为什么不用 Prisma 的 `search`？它生成的是 LIKE，完全不走 FULLTEXT 索引，
 * 数据量一上来就全表扫描。这里直接用 ngram 全文索引 + 相关度排序。
 *
 * 注意列名是 camelCase（Prisma 默认），不是 snake_case。
 */
export async function searchNotes(workspaceId: string, userId: string, query: NoteListQuery) {
  const q = query.q!;

  const scored = await prisma.$queryRaw<Array<{ id: string; score: number }>>`
    SELECT id, MATCH(title, content) AGAINST (${q}) AS score
    FROM \`notes\`
    WHERE \`workspaceId\` = ${workspaceId}
      AND \`deletedAt\` IS NULL
      AND (\`visibility\` = 'WORKSPACE' OR \`createdById\` = ${userId})
      AND MATCH(title, content) AGAINST (${q})
    ORDER BY score DESC
    LIMIT 200
  `;

  if (scored.length === 0) return { items: [], nextCursor: null, hasMore: false };

  const ids = scored.map((r) => r.id).slice(0, 200);

  const rows = await prisma.note.findMany({
    where: {
      id: { in: ids },
      ...(query.notebookId
        ? query.notebookId === 'none'
          ? { notebooks: { none: {} } }
          : { notebooks: { some: { notebookId: query.notebookId } } }
        : {}),
      ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
    },
    select: noteListSelect,
    take: query.limit,
  });

  // 保持相关度顺序
  const rank = new Map(scored.map((r, i) => [r.id, i]));
  rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  return {
    items: rows.map((n) => noteListDto(n)),
    nextCursor: null,
    hasMore: scored.length > query.limit,
  };
}

export async function getNote(workspaceId: string, userId: string, noteId: string, includeDeleted = false) {
  const note = await prisma.note.findFirst({
    where: {
      id: noteId,
      workspaceId,
      ...(includeDeleted ? {} : { deletedAt: null }),
      ...visibilityFilter(userId),
    },
    select: { ...noteListSelect, content: true },
  });

  if (!note) throw AppError.notFound('笔记');
  return { ...noteListDto(note), content: note.content };
}

async function assertNotebookIds(workspaceId: string, ids: string[]) {
  if (ids.length === 0) return;
  const count = await prisma.notebook.count({ where: { id: { in: ids }, workspaceId, deletedAt: null } });
  if (count !== ids.length) throw AppError.validation([{ path: 'notebookIds', message: '包含不存在或已删除的笔记本' }]);
}

async function assertTagIds(workspaceId: string, ids: string[]) {
  if (ids.length === 0) return;
  const count = await prisma.tag.count({ where: { id: { in: ids }, workspaceId } });
  if (count !== ids.length) throw AppError.validation([{ path: 'tagIds', message: '包含不存在的标签' }]);
}

export async function createNote(
  workspaceId: string,
  userId: string,
  input: { title: string; content: string; notebookIds: string[]; tagIds: string[]; visibility: string },
) {
  await assertNotebookIds(workspaceId, input.notebookIds);
  await assertTagIds(workspaceId, input.tagIds);

  const note = await prisma.note.create({
    data: {
      workspaceId,
      title: input.title || '未命名笔记',
      content: input.content,
      excerpt: excerptOf(input.content),
      visibility: input.visibility as 'PRIVATE' | 'WORKSPACE',
      createdById: userId,
      notebooks: { create: input.notebookIds.map((notebookId) => ({ notebookId })) },
      tags: { create: input.tagIds.map((tagId) => ({ tagId })) },
    },
    select: { ...noteListSelect, content: true },
  });

  const dto = { ...noteListDto(note), content: note.content };

  await recordChange({ workspaceId, entityType: 'note', entityId: note.id, op: 'upsert', version: note.version });
  emitWorkspace(workspaceId, { type: 'note.changed', payload: { noteId: note.id } }, userId);

  return dto;
}

/**
 * 更新笔记（乐观锁）。
 *
 * 用 updateMany + version 条件做原子 CAS：
 *   命中 0 行 = 版本已被别人推进 → 409 + 返回服务端最新内容，让前端决定怎么办。
 * 绝不静默覆盖 —— 这是团队协作里最容易丢数据的地方。
 */
export async function updateNote(
  workspaceId: string,
  userId: string,
  noteId: string,
  input: {
    version: number;
    title?: string;
    content?: string;
    visibility?: string;
    isPinned?: boolean;
    isStarred?: boolean;
    archived?: boolean;
  },
) {
  const data: Record<string, unknown> = {
    version: { increment: 1 },
    updatedById: userId,
  };

  if (input.title !== undefined) data.title = input.title || '未命名笔记';
  if (input.content !== undefined) {
    data.content = input.content;
    data.excerpt = excerptOf(input.content);
  }
  if (input.visibility !== undefined) data.visibility = input.visibility;
  if (input.isPinned !== undefined) data.isPinned = input.isPinned;
  if (input.isStarred !== undefined) data.isStarred = input.isStarred;
  if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;

  const result = await prisma.note.updateMany({
    where: {
      id: noteId,
      workspaceId,
      version: input.version,
      deletedAt: null,
      ...visibilityFilter(userId),
    },
    data,
  });

  if (result.count === 0) {
    const current = await prisma.note.findFirst({
      where: { id: noteId, workspaceId, deletedAt: null, ...visibilityFilter(userId) },
      select: { ...noteListSelect, content: true },
    });

    if (!current) throw AppError.notFound('笔记');

    throw new AppError(ErrorCode.VERSION_CONFLICT, '内容已被他人修改', {
      current: { ...noteListDto(current), content: current.content },
    });
  }

  const updated = await getNote(workspaceId, userId, noteId);

  await recordChange({
    workspaceId,
    entityType: 'note',
    entityId: noteId,
    op: 'upsert',
    version: updated.version,
  });
  emitWorkspace(workspaceId, { type: 'note.changed', payload: { noteId } }, userId);

  return updated;
}

export async function setNoteNotebooks(workspaceId: string, noteId: string, notebookIds: string[]) {
  const note = await prisma.note.findFirst({ where: { id: noteId, workspaceId, deletedAt: null } });
  if (!note) throw AppError.notFound('笔记');

  await assertNotebookIds(workspaceId, notebookIds);

  await prisma.$transaction([
    prisma.noteNotebook.deleteMany({ where: { noteId } }),
    ...(notebookIds.length
      ? [prisma.noteNotebook.createMany({ data: notebookIds.map((notebookId) => ({ noteId, notebookId })) })]
      : []),
  ]);
}

export async function setNoteTags(workspaceId: string, noteId: string, tagIds: string[]) {
  const note = await prisma.note.findFirst({ where: { id: noteId, workspaceId, deletedAt: null } });
  if (!note) throw AppError.notFound('笔记');

  await assertTagIds(workspaceId, tagIds);

  await prisma.$transaction([
    prisma.noteTag.deleteMany({ where: { noteId } }),
    ...(tagIds.length ? [prisma.noteTag.createMany({ data: tagIds.map((tagId) => ({ noteId, tagId })) })] : []),
  ]);
}

/** 移入回收站（软删） */
export async function trashNote(workspaceId: string, userId: string, noteId: string) {
  const result = await prisma.note.updateMany({
    where: { id: noteId, workspaceId, deletedAt: null, ...visibilityFilter(userId) },
    data: { deletedAt: new Date() },
  });
  if (result.count === 0) throw AppError.notFound('笔记');

  await recordChange({ workspaceId, entityType: 'note', entityId: noteId, op: 'delete' });
  emitWorkspace(workspaceId, { type: 'note.changed', payload: { noteId, deleted: true } }, userId);
}

export async function restoreNote(workspaceId: string, userId: string, noteId: string) {
  const result = await prisma.note.updateMany({
    where: { id: noteId, workspaceId, deletedAt: { not: null }, ...visibilityFilter(userId) },
    data: { deletedAt: null },
  });
  if (result.count === 0) throw AppError.notFound('回收站中的笔记');

  await recordChange({ workspaceId, entityType: 'note', entityId: noteId, op: 'upsert' });
  emitWorkspace(workspaceId, { type: 'note.changed', payload: { noteId } }, userId);
}

/** 彻底删除。只有创建者或管理员可以做 */
export async function purgeNote(workspaceId: string, userId: string, noteId: string, isAdmin: boolean) {
  const note = await prisma.note.findFirst({ where: { id: noteId, workspaceId, deletedAt: { not: null } } });
  if (!note) throw AppError.notFound('回收站中的笔记');

  if (!isAdmin && note.createdById !== userId) {
    throw AppError.forbidden('只有创建者或管理员可以彻底删除');
  }

  await prisma.note.delete({ where: { id: noteId } });

  await recordChange({ workspaceId, entityType: 'note', entityId: noteId, op: 'delete' });
  emitWorkspace(workspaceId, { type: 'note.changed', payload: { noteId, deleted: true } }, userId);
}

/** 清空回收站（只清自己有权删的） */
export async function emptyTrash(workspaceId: string, userId: string, isAdmin: boolean) {
  const result = await prisma.note.deleteMany({
    where: {
      workspaceId,
      deletedAt: { not: null },
      ...(isAdmin ? {} : { createdById: userId }),
    },
  });
  return { purged: result.count };
}

import {
  ErrorCode,
  TASK_CHECKLIST_MAX,
  type TaskListQuery,
  type TaskPriority,
  type TaskStatus,
} from '@notecloud/shared';

import { prisma, type Prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
import { emitWorkspace } from '../../lib/realtime.js';
import { notifyTaskAssigned, notifyTaskComment, watchTask } from '../notifications/service.js';
import { recordChange } from '../sync/service.js';

// ─────────────────────────────────────────────────────────────────
// 时区：把"今天/本周"算对
//
// 数据库一律存 UTC，但用户说"今天"指的是**他自己时区的今天**。
// 这里不引入 dayjs/moment，用 Intl 求出某时刻的时区偏移再换算。
// 中国没有夏令时，所以简单平移足够；有 DST 的时区在切换当天可能差一小时，
// 对"今天"这个粒度可以接受。
// ─────────────────────────────────────────────────────────────────

function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }

  const hour = map.hour === 24 ? 0 : (map.hour ?? 0);
  const asUTC = Date.UTC(map.year ?? 1970, (map.month ?? 1) - 1, map.day ?? 1, hour, map.minute ?? 0, map.second ?? 0);
  return asUTC - at.getTime();
}

/** 指定时区下"今天 00:00"对应的 UTC 时刻 */
export function startOfDayInTz(timeZone: string, at = new Date()): Date {
  const offset = tzOffsetMs(timeZone, at);
  const shifted = new Date(at.getTime() + offset);
  const localMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(localMidnight - offset);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

// ─────────────────────────────────────────────────────────────────
// 序列化
// ─────────────────────────────────────────────────────────────────

export const taskSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  startAt: true,
  dueAt: true,
  isAllDay: true,
  completedAt: true,
  canceledAt: true,
  position: true,
  columnId: true,
  reminderAt: true,
  reminderSentAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  assignee: { select: { id: true, name: true, avatarUrl: true } },
  createdBy: { select: { id: true, name: true, avatarUrl: true } },
  checklists: {
    select: { id: true, title: true, done: true, position: true },
    orderBy: { position: 'asc' },
  },
  tags: { select: { tagId: true, tag: { select: { name: true, color: true } } } },
} satisfies Prisma.TaskSelect;

export type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

export function taskDto(t: TaskRow) {
  const doneCount = t.checklists.filter((c) => c.done).length;
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    startAt: t.startAt,
    dueAt: t.dueAt,
    isAllDay: t.isAllDay,
    completedAt: t.completedAt,
    canceledAt: t.canceledAt,
    position: t.position,
    columnId: t.columnId,
    reminderAt: t.reminderAt,
    version: t.version,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    deletedAt: t.deletedAt,
    assignee: t.assignee,
    createdBy: t.createdBy,
    checklist: t.checklists,
    checklistDone: doneCount,
    checklistTotal: t.checklists.length,
    tags: t.tags.map((x) => ({ id: x.tagId, name: x.tag.name, color: x.tag.color })),
  };
}

// ─────────────────────────────────────────────────────────────────
// 可见性 / 查询条件
// ─────────────────────────────────────────────────────────────────

/** 已结束的状态：不算"待办" */
const CLOSED: TaskStatus[] = ['DONE', 'CANCELED'];

function viewWhere(view: TaskListQuery['view'], userId: string, timeZone: string): Prisma.TaskWhereInput {
  const todayStart = startOfDayInTz(timeZone);
  const weekEnd = addDays(todayStart, 7);
  const now = new Date();

  switch (view) {
    case 'trash':
      return { deletedAt: { not: null } };

    case 'done':
      return { deletedAt: null, status: 'DONE' };

    case 'today':
      return {
        deletedAt: null,
        status: { notIn: CLOSED },
        dueAt: { gte: todayStart, lt: addDays(todayStart, 1) },
      };

    case 'week':
      return {
        deletedAt: null,
        status: { notIn: CLOSED },
        dueAt: { gte: todayStart, lt: weekEnd },
      };

    case 'overdue':
      return {
        deletedAt: null,
        status: { notIn: CLOSED },
        dueAt: { lt: now },
      };

    case 'assigned':
      return { deletedAt: null, status: { notIn: CLOSED }, assigneeId: userId };

    case 'mine':
      return { deletedAt: null, status: { notIn: CLOSED }, createdById: userId };

    default:
      // 全部待办：只看还没结束的
      return { deletedAt: null, status: { notIn: CLOSED } };
  }
}

// ─────────────────────────────────────────────────────────────────
// 任务
// ─────────────────────────────────────────────────────────────────

async function assertAssignee(workspaceId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: assigneeId } },
    select: { userId: true },
  });
  if (!member) {
    throw AppError.validation([{ path: 'assigneeId', message: '负责人不是该工作区成员' }]);
  }
}

async function assertTagIds(workspaceId: string, tagIds: string[]) {
  if (tagIds.length === 0) return;
  const count = await prisma.tag.count({ where: { id: { in: tagIds }, workspaceId } });
  if (count !== tagIds.length) {
    throw AppError.validation([{ path: 'tagIds', message: '包含不存在的标签' }]);
  }
}

export function statusTimestamps(status: TaskStatus) {
  const now = new Date();
  if (status === 'DONE') return { completedAt: now, canceledAt: null };
  if (status === 'CANCELED') return { canceledAt: now, completedAt: null };
  return { completedAt: null, canceledAt: null };
}

export async function listTasks(
  workspaceId: string,
  userId: string,
  timeZone: string,
  query: TaskListQuery,
) {
  const where: Prisma.TaskWhereInput = {
    workspaceId,
    ...viewWhere(query.view, userId, timeZone),
    ...(query.status ? { status: query.status } : {}),
    ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
    ...(query.unassigned ? { columnId: null } : {}),
    ...(query.q ? { OR: [{ title: { contains: query.q } }] } : {}),
  };

  const rows = await prisma.task.findMany({
    where,
    select: taskSelect,
    // 无截止时间的任务会被排到最前（MySQL ASC 对 NULL 的处理），
    // 前端会按"已逾期/今天/本周/以后/无日期"重新分组，所以这里不用强求顺序
    orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const items = (hasMore ? rows.slice(0, query.limit) : rows).map(taskDto);
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null, hasMore };
}

/** ngram 全文检索任务（标题 + 描述） */
export async function searchTasks(workspaceId: string, q: string, limit: number) {
  const scored = await prisma.$queryRaw<Array<{ id: string; score: number }>>`
    SELECT id, MATCH(title, description) AGAINST (${q}) AS score
    FROM \`tasks\`
    WHERE \`workspaceId\` = ${workspaceId}
      AND \`deletedAt\` IS NULL
      AND MATCH(title, description) AGAINST (${q})
    ORDER BY score DESC
    LIMIT 200
  `;

  if (scored.length === 0) return { items: [], nextCursor: null, hasMore: false };

  const ids = scored.map((r) => r.id).slice(0, limit);
  const rows = await prisma.task.findMany({ where: { id: { in: ids } }, select: taskSelect });

  const rank = new Map(scored.map((r, i) => [r.id, i]));
  rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  return { items: rows.map(taskDto), nextCursor: null, hasMore: scored.length > limit };
}

export async function getTask(workspaceId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    select: taskSelect,
  });
  if (!task) throw AppError.notFound('任务');
  return taskDto(task);
}

export async function createTask(
  workspaceId: string,
  actor: { id: string; name: string },
  input: {
    title: string;
    description?: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    startAt?: string | null;
    dueAt?: string | null;
    isAllDay: boolean;
    assigneeId?: string | null;
    tagIds: string[];
    checklist: Array<{ title: string }>;
    columnId?: string | null;
    reminderAt?: string | null;
  },
) {
  await assertAssignee(workspaceId, input.assigneeId);
  await assertTagIds(workspaceId, input.tagIds);

  // 从看板新建卡片时，列决定状态与位置
  const column = input.columnId ? await resolveColumn(workspaceId, input.columnId) : null;
  const position = column ? await nextPositionInColumn(column.id) : 0;

  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: input.title,
      description: input.description ?? null,
      status: column ? column.status : input.status,
      priority: input.priority,
      startAt: input.startAt ? new Date(input.startAt) : null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      isAllDay: input.isAllDay,
      assigneeId: input.assigneeId ?? null,
      createdById: actor.id,
      columnId: column?.id ?? null,
      position,
      reminderAt: input.reminderAt ? new Date(input.reminderAt) : null,
      ...statusTimestamps(column ? column.status : input.status),
      tags: { create: input.tagIds.map((tagId) => ({ tagId })) },
      checklists: {
        create: input.checklist.slice(0, TASK_CHECKLIST_MAX).map((c, i) => ({ title: c.title, position: i })),
      },
      // 创建者自动关注：之后有人评论会收到通知，也可以手动取关
      watchers: { create: { userId: actor.id } },
    },
    select: taskSelect,
  });

  // 建任务时就指定了负责人，也要通知他
  if (input.assigneeId) {
    await notifyTaskAssigned({
      workspaceId,
      taskId: task.id,
      taskTitle: task.title,
      actor,
      assigneeId: input.assigneeId,
    });
    await watchTask(task.id, input.assigneeId);
  }

  await recordChange({ workspaceId, entityType: 'task', entityId: task.id, op: 'upsert', version: task.version });
  emitWorkspace(workspaceId, { type: 'task.changed', payload: { taskId: task.id } }, actor.id);

  return taskDto(task);
}

/** 校验列属于当前工作区的某块未删除看板 */
export async function resolveColumn(workspaceId: string, columnId: string) {
  const column = await prisma.boardColumn.findFirst({
    where: { id: columnId, board: { workspaceId, deletedAt: null } },
    select: { id: true, status: true, boardId: true, wipLimit: true, name: true },
  });
  if (!column) {
    throw AppError.validation([{ path: 'columnId', message: '看板列不存在或已删除' }]);
  }
  return column;
}

async function nextPositionInColumn(columnId: string): Promise<number> {
  const last = await prisma.task.findFirst({
    where: { columnId, deletedAt: null },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return (last?.position ?? -1) + 1;
}

/** 更新任务（乐观锁 + 子任务/标签整体覆盖） */
export async function updateTask(
  workspaceId: string,
  taskId: string,
  input: {
    version: number;
    title?: string;
    description?: string | null;
    status?: TaskStatus;
    priority?: TaskPriority;
    startAt?: string | null;
    dueAt?: string | null;
    isAllDay?: boolean;
    assigneeId?: string | null;
    reminderAt?: string | null;
    tagIds?: string[];
    checklist?: Array<{ id?: string; title: string; done: boolean }>;
  },
  actor: { id: string; name: string },
) {
  const current = await prisma.task.findFirst({ where: { id: taskId, workspaceId, deletedAt: null } });
  if (!current) throw AppError.notFound('任务');

  if (input.assigneeId !== undefined) await assertAssignee(workspaceId, input.assigneeId);
  if (input.tagIds !== undefined) await assertTagIds(workspaceId, input.tagIds);

  const data: Prisma.TaskUncheckedUpdateManyInput = { version: { increment: 1 } };

  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.isAllDay !== undefined) data.isAllDay = input.isAllDay;
  if (input.startAt !== undefined) data.startAt = input.startAt ? new Date(input.startAt) : null;
  if (input.dueAt !== undefined) data.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId ?? null;
  if (input.reminderAt !== undefined) {
    data.reminderAt = input.reminderAt ? new Date(input.reminderAt) : null;
    // 改了提醒时间就重置"已发送"标记，否则新的提醒永远不会触发
    data.reminderSentAt = null;
  }
  if (input.status !== undefined) {
    data.status = input.status;
    Object.assign(data, statusTimestamps(input.status));
  }

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.task.updateMany({
      where: { id: taskId, workspaceId, version: input.version, deletedAt: null },
      data,
    });

    if (updated.count === 0) return { conflict: true as const };

    // 子任务：整体覆盖。带 id 的保留（更新标题与勾选），没带 id 的新建，缺的删掉
    if (input.checklist) {
      const keepIds = input.checklist.map((c) => c.id).filter((id): id is string => Boolean(id));
      await tx.taskChecklist.deleteMany({ where: { taskId, id: { notIn: keepIds.length ? keepIds : ['__none__'] } } });

      for (const [index, item] of input.checklist.entries()) {
        if (item.id) {
          await tx.taskChecklist.updateMany({
            where: { id: item.id, taskId },
            data: { title: item.title, done: item.done, position: index },
          });
        } else {
          await tx.taskChecklist.create({ data: { taskId, title: item.title, done: item.done, position: index } });
        }
      }
    }

    if (input.tagIds) {
      await tx.taskTag.deleteMany({ where: { taskId } });
      if (input.tagIds.length) {
        await tx.taskTag.createMany({ data: input.tagIds.map((tagId) => ({ taskId, tagId })) });
      }
    }

    return { conflict: false as const };
  });

  if (result.conflict) {
    const latest = await prisma.task.findFirst({ where: { id: taskId, workspaceId, deletedAt: null }, select: taskSelect });
    if (!latest) throw AppError.notFound('任务');
    throw new AppError(ErrorCode.VERSION_CONFLICT, '任务已被他人修改', { current: taskDto(latest) });
  }

  // 指派变更 → 通知新负责人，并把他加进关注者
  if (input.assigneeId !== undefined && input.assigneeId && input.assigneeId !== current.assigneeId) {
    await notifyTaskAssigned({
      workspaceId,
      taskId,
      taskTitle: input.title ?? current.title,
      actor,
      assigneeId: input.assigneeId,
    });
    await watchTask(taskId, input.assigneeId);
  }

  const updated = await getTask(workspaceId, taskId);

  await recordChange({
    workspaceId,
    entityType: 'task',
    entityId: taskId,
    op: 'upsert',
    version: updated.version,
  });
  emitWorkspace(workspaceId, { type: 'task.changed', payload: { taskId } }, actor.id);

  return updated;
}

/** 勾选/取消勾选单个子任务（不带乐观锁：勾一下复选框不该因为版本冲突而失败） */
export async function toggleChecklist(workspaceId: string, taskId: string, itemId: string, done: boolean) {  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!task) throw AppError.notFound('任务');

  const result = await prisma.taskChecklist.updateMany({
    where: { id: itemId, taskId },
    data: { done },
  });
  if (result.count === 0) throw AppError.notFound('子任务');

  return getTask(workspaceId, taskId);
}

/**
 * 把任务放进某个看板列，或从看板移出（columnId = null）。
 *
 * 这是「待办」与「看板」之间的桥：在待办页创建的任务 columnId 是空的，
 * 需要用户显式把它放到某块板的某一列。
 */
export async function setTaskColumn(
  workspaceId: string,
  taskId: string,
  columnId: string | null,
  actor?: { id: string },
) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId, deletedAt: null },
    select: { id: true, columnId: true },
  });
  if (!task) throw AppError.notFound('任务');

  if (columnId === null) {
    await prisma.task.update({ where: { id: taskId }, data: { columnId: null } });
  } else {
    const column = await resolveColumn(workspaceId, columnId);

    if (column.wipLimit && task.columnId !== columnId) {
      const current = await prisma.task.count({ where: { columnId, deletedAt: null } });
      if (current >= column.wipLimit) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `「${column.name}」已达到 WIP 上限 ${column.wipLimit}`,
          { wipLimit: true },
        );
      }
    }

    await prisma.task.update({
      where: { id: taskId },
      data: {
        columnId,
        status: column.status,
        ...statusTimestamps(column.status),
        position: await nextPositionInColumn(columnId),
      },
    });

    emitWorkspace(workspaceId, { type: 'board.changed', payload: { boardId: column.boardId, taskId } }, actor?.id);
  }

  await recordChange({ workspaceId, entityType: 'task', entityId: taskId, op: 'upsert' });
  emitWorkspace(workspaceId, { type: 'task.changed', payload: { taskId } }, actor?.id);

  return getTask(workspaceId, taskId);
}

export async function trashTask(workspaceId: string, taskId: string) {
  const result = await prisma.task.updateMany({
    where: { id: taskId, workspaceId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (result.count === 0) throw AppError.notFound('任务');

  await recordChange({ workspaceId, entityType: 'task', entityId: taskId, op: 'delete' });
  emitWorkspace(workspaceId, { type: 'task.changed', payload: { taskId, deleted: true } });
}

export async function restoreTask(workspaceId: string, taskId: string) {
  const result = await prisma.task.updateMany({
    where: { id: taskId, workspaceId, deletedAt: { not: null } },
    data: { deletedAt: null },
  });
  if (result.count === 0) throw AppError.notFound('回收站中的任务');

  await recordChange({ workspaceId, entityType: 'task', entityId: taskId, op: 'upsert' });
  emitWorkspace(workspaceId, { type: 'task.changed', payload: { taskId } });
}

/**
 * 彻底删除任务。
 * 评论是多态表（没有外键），必须手动清 —— 否则会留下永远看不到也删不掉的孤儿行。
 */
export async function purgeTask(workspaceId: string, taskId: string, userId: string, isAdmin: boolean) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId, deletedAt: { not: null } },
  });
  if (!task) throw AppError.notFound('回收站中的任务');
  if (!isAdmin && task.createdById !== userId) {
    throw AppError.forbidden('只有创建者或管理员可以彻底删除');
  }

  await prisma.$transaction([
    prisma.comment.deleteMany({ where: { workspaceId, targetType: 'TASK', targetId: taskId } }),
    prisma.task.delete({ where: { id: taskId } }),
  ]);

  await recordChange({ workspaceId, entityType: 'task', entityId: taskId, op: 'delete' });
  emitWorkspace(workspaceId, { type: 'task.changed', payload: { taskId, deleted: true } });
}

// ─────────────────────────────────────────────────────────────────
// 评论
// ─────────────────────────────────────────────────────────────────

async function assertTaskExists(workspaceId: string, taskId: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!task) throw AppError.notFound('任务');
}

export async function listComments(workspaceId: string, taskId: string) {
  await assertTaskExists(workspaceId, taskId);

  const rows = await prisma.comment.findMany({
    where: { workspaceId, targetType: 'TASK', targetId: taskId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { id: true, name: true, avatarUrl: true } } },
  });

  return rows.map((c) => ({
    id: c.id,
    body: c.body,
    mentions: (c.mentions as string[] | null) ?? [],
    author: c.author,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
}

export async function createComment(
  workspaceId: string,
  taskId: string,
  actor: { id: string; name: string },
  body: string,
  mentions?: string[],
) {
  await assertTaskExists(workspaceId, taskId);

  // 只保留真正是成员的 mention，避免存进无效 id
  let validMentions: string[] = [];
  if (mentions?.length) {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: mentions } },
      select: { userId: true },
    });
    validMentions = members.map((m) => m.userId);
  }

  const comment = await prisma.comment.create({
    data: {
      workspaceId,
      targetType: 'TASK',
      targetId: taskId,
      body,
      mentions: validMentions.length ? validMentions : undefined,
      authorId: actor.id,
    },
    include: { author: { select: { id: true, name: true, avatarUrl: true } } },
  });

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    select: { title: true },
  });

  // 评论者自动关注这个任务 —— 之后别人再评论他也会收到通知
  await watchTask(taskId, actor.id);

  if (task) {
    await notifyTaskComment({
      workspaceId,
      taskId,
      taskTitle: task.title,
      actor,
      body,
      mentions: validMentions,
    });
  }

  return {
    id: comment.id,
    body: comment.body,
    mentions: validMentions,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

export async function updateComment(workspaceId: string, commentId: string, userId: string, body: string) {
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, workspaceId, deletedAt: null },
  });
  if (!comment) throw AppError.notFound('评论');
  if (comment.authorId !== userId) throw AppError.forbidden('只能编辑自己的评论');

  return prisma.comment.update({ where: { id: commentId }, data: { body } });
}

export async function deleteComment(workspaceId: string, commentId: string, userId: string, isAdmin: boolean) {
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, workspaceId, deletedAt: null },
  });
  if (!comment) throw AppError.notFound('评论');
  if (!isAdmin && comment.authorId !== userId) throw AppError.forbidden('只能删除自己的评论');

  await prisma.comment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });
}

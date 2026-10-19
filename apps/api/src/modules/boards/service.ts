import { BOARD_MAX, COLUMN_MAX, DEFAULT_BOARD_COLUMNS, ErrorCode } from '@notecloud/shared';
import type { TaskStatus } from '@notecloud/shared';

import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
import { emitWorkspace } from '../../lib/realtime.js';
import { recordChange } from '../sync/service.js';
import { resolveColumn, statusTimestamps, taskDto, taskSelect } from '../tasks/service.js';

// ─────────────────────────────────────────────────────────────────
// 看板
// ─────────────────────────────────────────────────────────────────

export async function listBoards(workspaceId: string) {
  const boards = await prisma.board.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { columns: true } } },
  });

  // 每个看板的卡片数：按列聚合再求和（卡片就是任务，没有独立卡片表）
  const columnCounts = await prisma.boardColumn.findMany({
    where: { board: { workspaceId, deletedAt: null } },
    select: {
      boardId: true,
      _count: { select: { tasks: { where: { deletedAt: null } } } },
    },
  });

  const taskCountByBoard = new Map<string, number>();
  for (const c of columnCounts) {
    taskCountByBoard.set(c.boardId, (taskCountByBoard.get(c.boardId) ?? 0) + c._count.tasks);
  }

  return boards.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    icon: b.icon,
    color: b.color,
    columnCount: b._count.columns,
    taskCount: taskCountByBoard.get(b.id) ?? 0,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  }));
}

/** 所有看板的列（供"把任务放进看板"的选择器用） */
export async function listAllColumns(workspaceId: string) {
  return prisma.board.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      columns: {
        orderBy: { position: 'asc' },
        select: { id: true, name: true, status: true, wipLimit: true },
      },
    },
  });
}

export async function createBoard(
  workspaceId: string,
  userId: string,
  input: { name: string; description?: string | null; icon?: string | null; color?: string | null },
) {
  const count = await prisma.board.count({ where: { workspaceId, deletedAt: null } });
  if (count >= BOARD_MAX) {
    throw AppError.validation([{ path: 'name', message: `每个工作区最多 ${BOARD_MAX} 块看板` }]);
  }

  const board = await prisma.board.create({
    data: {
      workspaceId,
      name: input.name,
      description: input.description ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      createdById: userId,
      // 建板即带三列默认流程，否则用户看到的是空白
      columns: {
        create: DEFAULT_BOARD_COLUMNS.map((c, i) => ({
          name: c.name,
          status: c.status,
          color: c.color,
          position: i,
        })),
      },
    },
    include: { _count: { select: { columns: true } } },
  });

  return {
    id: board.id,
    name: board.name,
    description: board.description,
    icon: board.icon,
    color: board.color,
    columnCount: board._count.columns,
    taskCount: 0,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

export async function updateBoard(
  workspaceId: string,
  boardId: string,
  input: { name?: string; description?: string | null; icon?: string | null; color?: string | null },
) {
  await assertBoard(workspaceId, boardId);

  return prisma.board.update({
    where: { id: boardId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.icon !== undefined ? { icon: input.icon ?? null } : {}),
      ...(input.color !== undefined ? { color: input.color ?? null } : {}),
    },
  });
}

export async function deleteBoard(workspaceId: string, boardId: string) {
  await assertBoard(workspaceId, boardId);
  // 软删除看板。任务不删，只是 columnId 仍指向列（列随看板软删但没被删）。
  // 为了让"不在任何看板上的任务"语义干净，这里顺手把任务的 columnId 清空。
  await prisma.$transaction([
    prisma.task.updateMany({ where: { columnId: { in: await columnIdsOf(boardId) } }, data: { columnId: null } }),
    prisma.board.update({ where: { id: boardId }, data: { deletedAt: new Date() } }),
  ]);
}

async function columnIdsOf(boardId: string): Promise<string[]> {
  const cols = await prisma.boardColumn.findMany({ where: { boardId }, select: { id: true } });
  return cols.map((c) => c.id);
}

async function assertBoard(workspaceId: string, boardId: string) {
  const board = await prisma.board.findFirst({ where: { id: boardId, workspaceId, deletedAt: null } });
  if (!board) throw AppError.notFound('看板');
  return board;
}

// ─────────────────────────────────────────────────────────────────
// 看板详情（列 + 卡片）
// ─────────────────────────────────────────────────────────────────

export async function getBoard(workspaceId: string, boardId: string) {  const board = await assertBoard(workspaceId, boardId);

  const columns = await prisma.boardColumn.findMany({
    where: { boardId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });

  const tasks = await prisma.task.findMany({
    where: { columnId: { in: columns.map((c) => c.id) }, deletedAt: null },
    select: taskSelect,
    orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
  });

  const grouped = new Map<string, ReturnType<typeof taskDto>[]>();
  for (const t of tasks) {
    const key = t.columnId!;
    const list = grouped.get(key) ?? [];
    list.push(taskDto(t));
    grouped.set(key, list);
  }

  return {
    board: {
      id: board.id,
      name: board.name,
      description: board.description,
      icon: board.icon,
      color: board.color,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    },
    columns: columns.map((c) => ({
      id: c.id,
      boardId: c.boardId,
      name: c.name,
      status: c.status,
      position: c.position,
      color: c.color,
      wipLimit: c.wipLimit,
      tasks: grouped.get(c.id) ?? [],
    })),
  };
}

// ─────────────────────────────────────────────────────────────────
// 列
// ─────────────────────────────────────────────────────────────────

export async function createColumn(
  workspaceId: string,
  boardId: string,
  input: { name: string; status: TaskStatus; color?: string | null; wipLimit?: number | null },
) {
  await assertBoard(workspaceId, boardId);

  const count = await prisma.boardColumn.count({ where: { boardId } });
  if (count >= COLUMN_MAX) {
    throw AppError.validation([{ path: 'name', message: `每块看板最多 ${COLUMN_MAX} 列` }]);
  }

  return prisma.boardColumn.create({
    data: {
      boardId,
      name: input.name,
      status: input.status,
      color: input.color ?? null,
      wipLimit: input.wipLimit ?? null,
      position: count,
    },
  });
}

export async function updateColumn(
  workspaceId: string,
  columnId: string,
  input: { name?: string; status?: TaskStatus; color?: string | null; wipLimit?: number | null },
) {
  const column = await findColumn(workspaceId, columnId);

  const updated = await prisma.boardColumn.update({
    where: { id: columnId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.color !== undefined ? { color: input.color ?? null } : {}),
      ...(input.wipLimit !== undefined ? { wipLimit: input.wipLimit ?? null } : {}),
    },
  });

  // 改了列的映射状态 → 这一列里的任务状态必须跟着改，否则看板与待办会不一致
  if (input.status !== undefined && input.status !== column.status) {
    await prisma.task.updateMany({
      where: { columnId, deletedAt: null },
      data: { status: input.status, ...statusTimestamps(input.status) },
    });
  }

  return updated;
}

export async function deleteColumn(workspaceId: string, columnId: string) {
  await findColumn(workspaceId, columnId);

  const count = await prisma.boardColumn.count({ where: { boardId: (await findColumn(workspaceId, columnId)).boardId } });
  if (count <= 1) {
    throw AppError.validation([{ path: 'columnId', message: '看板至少要保留一列' }]);
  }

  // 外键是 ON DELETE SET NULL：列删掉后，里面的任务脱离看板但不会被删除
  await prisma.boardColumn.delete({ where: { id: columnId } });
}

export async function reorderColumns(workspaceId: string, boardId: string, orderedIds: string[]) {
  await assertBoard(workspaceId, boardId);

  const found = await prisma.boardColumn.findMany({
    where: { id: { in: orderedIds }, boardId },
    select: { id: true },
  });
  if (found.length !== orderedIds.length) throw AppError.notFound('看板列');

  await prisma.$transaction(
    orderedIds.map((id, index) => prisma.boardColumn.update({ where: { id }, data: { position: index } })),
  );
}

async function findColumn(workspaceId: string, columnId: string) {
  const column = await prisma.boardColumn.findFirst({
    where: { id: columnId, board: { workspaceId, deletedAt: null } },
  });
  if (!column) throw AppError.notFound('看板列');
  return column;
}

// ─────────────────────────────────────────────────────────────────
// 拖动卡片
// ─────────────────────────────────────────────────────────────────

/**
 * 把任务拖到某一列。
 *
 * 关键点：**这一步同时改 columnId 和 status**，所以待办列表与看板永远一致 ——
 * 这就是"卡片即任务"的全部意义。
 *
 * 不做乐观锁：拖拽是高频操作，用版本号会让"别人刚改过标题"导致拖不动。
 * 多个用户同时拖同一张卡时按到达顺序后写生效，这是看板类产品的通行做法。
 */
export async function moveTask(
  workspaceId: string,
  boardId: string,
  taskId: string,
  columnId: string,
  orderedTaskIds: string[],
  actorId?: string,
) {
  const column = await resolveColumn(workspaceId, columnId);
  if (column.boardId !== boardId) {
    throw AppError.validation([{ path: 'columnId', message: '该列不属于这块看板' }]);
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId, deletedAt: null },
    select: { id: true, columnId: true, status: true },
  });
  if (!task) throw AppError.notFound('任务');

  // WIP 上限：从别的列移进来才检查（列内重排不该被拦）
  if (column.wipLimit && task.columnId !== columnId) {
    const current = await prisma.task.count({ where: { columnId, deletedAt: null } });
    if (current >= column.wipLimit) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `「${column.name}」已达到 WIP 上限 ${column.wipLimit}，先把里面的卡片处理掉`,
        { wipLimit: true },
      );
    }
  }

  // 客户端没把被拖的卡放进顺序里时，补到最后
  const ordered = orderedTaskIds.includes(taskId) ? orderedTaskIds : [...orderedTaskIds, taskId];

  await prisma.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: taskId },
      data: {
        columnId,
        status: column.status,
        ...statusTimestamps(column.status),
      },
    });

    for (const [index, id] of ordered.entries()) {
      // 只重排"确实在同一列"的任务，避免客户端塞进无关 id 打乱别的列
      await tx.task.updateMany({
        where: { id, columnId, workspaceId, deletedAt: null },
        data: { position: index },
      });
    }
  });

  const updated = await getBoard(workspaceId, boardId);

  await recordChange({ workspaceId, entityType: 'task', entityId: taskId, op: 'upsert' });
  emitWorkspace(workspaceId, { type: 'board.changed', payload: { boardId, taskId, columnId } }, actorId);

  return updated;
}

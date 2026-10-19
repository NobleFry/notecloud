import { prisma } from '../../db/prisma.js';

export type SyncEntityType = 'note' | 'task' | 'board' | 'notebook';

export interface ChangeInput {
  workspaceId: string;
  entityType: SyncEntityType;
  entityId: string;
  op: 'upsert' | 'delete';
  version?: number | null;
}

/**
 * 追加一条变更日志。
 *
 * 刻意做成**尽力而为**：写失败不抛错。原因 —— 变更日志是给客户端做增量拉取的，
 * 丢一条最多让某个客户端多刷新一次，而让主业务因为日志写失败而回滚是不可接受的。
 */
export async function recordChange(input: ChangeInput): Promise<void> {
  try {
    await prisma.syncChange.create({
      data: {
        workspaceId: input.workspaceId,
        entityType: input.entityType,
        entityId: input.entityId,
        op: input.op,
        version: input.version ?? null,
      },
    });
  } catch {
    /* 见上 */
  }
}

export async function listChanges(workspaceId: string, since: bigint, limit: number) {
  const rows = await prisma.syncChange.findMany({
    where: { workspaceId, seq: { gt: since } },
    orderBy: { seq: 'asc' },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    changes: page.map((r) => ({
      // BigInt 不能直接 JSON 序列化，统一转字符串
      seq: r.seq.toString(),
      entityType: r.entityType,
      entityId: r.entityId,
      op: r.op,
      version: r.version,
      changedAt: r.changedAt,
    })),
    cursor: page.length > 0 ? page[page.length - 1]!.seq.toString() : since.toString(),
    hasMore,
  };
}

/** 当前工作区的最新游标（客户端第一次同步时用） */
export async function latestSeq(workspaceId: string): Promise<string> {
  const row = await prisma.syncChange.findFirst({
    where: { workspaceId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return row ? row.seq.toString() : '0';
}

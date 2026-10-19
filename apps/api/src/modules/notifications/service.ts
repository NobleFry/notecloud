import type { NotificationType } from '@notecloud/shared';

import { prisma } from '../../db/prisma.js';
import { sendToUser } from '../../lib/realtime.js';

// ─────────────────────────────────────────────────────────────────
// 写入通知
// ─────────────────────────────────────────────────────────────────

export interface NotifyInput {
  workspaceId: string;
  recipientId: string;
  /** 触发者；系统通知（到期提醒）为 null */
  actorId?: string | null;
  type: NotificationType;
  targetType?: 'task' | 'note' | 'board' | 'comment';
  targetId?: string;
  title: string;
  body?: string;
  /** 点击后跳转的前端路径 */
  link?: string;
}

export async function notify(input: NotifyInput): Promise<void> {
  // 自己触发的不通知自己 —— 否则每次编辑都会给自己发一条
  if (input.recipientId === input.actorId) return;

  const created = await prisma.notification.create({
    data: {
      workspaceId: input.workspaceId,
      recipientId: input.recipientId,
      actorId: input.actorId ?? null,
      type: input.type,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      title: input.title.slice(0, 255),
      body: input.body?.slice(0, 500) ?? null,
      link: input.link?.slice(0, 500) ?? null,
    },
  });

  // 在线的话立刻推给前端，不用等 30 秒轮询
  sendToUser(input.recipientId, {
    type: 'notification',
    workspaceId: input.workspaceId,
    payload: {
      id: created.id,
      title: created.title,
      body: created.body,
      link: created.link,
      notificationType: created.type,
    },
  });
}

/** 批量写，自动去重收件人 */
export async function notifyMany(inputs: NotifyInput[]): Promise<void> {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (input.recipientId === input.actorId) continue;
    const key = `${input.recipientId}:${input.type}:${input.targetId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await notify(input);
  }
}

// ─────────────────────────────────────────────────────────────────
// 读取
// ─────────────────────────────────────────────────────────────────

export async function listNotifications(
  userId: string,
  params: { unreadOnly: boolean; limit: number; cursor?: string },
) {
  const rows = await prisma.notification.findMany({
    where: { recipientId: userId, ...(params.unreadOnly ? { readAt: null } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      actor: { select: { id: true, name: true, avatarUrl: true } },
      workspace: { select: { id: true, name: true, isPersonal: true } },
    },
  });

  const hasMore = rows.length > params.limit;
  const items = (hasMore ? rows.slice(0, params.limit) : rows).map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    targetType: n.targetType,
    targetId: n.targetId,
    read: n.readAt !== null,
    createdAt: n.createdAt,
    actor: n.actor,
    workspace: n.workspace,
  }));

  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null, hasMore };
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { recipientId: userId, readAt: null } });
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, recipientId: userId, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function markAllRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { recipientId: userId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

// ─────────────────────────────────────────────────────────────────
// 业务投递：评论 / @提及 / 指派
// ─────────────────────────────────────────────────────────────────

/**
 * 一条评论产生的所有通知。
 *
 * 收件人 = @提及的人 ∪ 关注者，再去掉作者自己。
 * 创建者/负责人不是特殊照顾对象 —— 他们建任务/被指派时会自动成为关注者，
 * 这样"取消关注"才真的能停止通知。
 */
export async function notifyTaskComment(params: {
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  actor: { id: string; name: string };
  body: string;
  mentions: string[];
}) {
  const task = await prisma.task.findFirst({
    where: { id: params.taskId, workspaceId: params.workspaceId },
    select: {
      title: true,
      watchers: { select: { userId: true } },
    },
  });
  if (!task) return;

  const link = `/w/${params.workspaceId}/tasks?task=${params.taskId}`;
  const excerpt = params.body.length > 120 ? `${params.body.slice(0, 120)}…` : params.body;

  const recipients = new Set<string>();
  for (const id of params.mentions) recipients.add(id);
  for (const w of task.watchers) recipients.add(w.userId);
  recipients.delete(params.actor.id);

  const inputs: NotifyInput[] = [];
  for (const recipientId of recipients) {
    const mentioned = params.mentions.includes(recipientId);
    inputs.push({
      workspaceId: params.workspaceId,
      recipientId,
      actorId: params.actor.id,
      type: mentioned ? 'MENTION' : 'TASK_COMMENT',
      targetType: 'task',
      targetId: params.taskId,
      title: mentioned
        ? `${params.actor.name} 在「${task.title}」中提到了你`
        : `${params.actor.name} 评论了「${task.title}」`,
      body: excerpt,
      link,
    });
  }

  await notifyMany(inputs);
}

/** 任务被指派给别人 */
export async function notifyTaskAssigned(params: {
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  actor: { id: string; name: string };
  assigneeId: string;
}) {
  await notify({
    workspaceId: params.workspaceId,
    recipientId: params.assigneeId,
    actorId: params.actor.id,
    type: 'TASK_ASSIGNED',
    targetType: 'task',
    targetId: params.taskId,
    title: `${params.actor.name} 把「${params.taskTitle}」指派给你`,
    link: `/w/${params.workspaceId}/tasks?task=${params.taskId}`,
  });
}

// ─────────────────────────────────────────────────────────────────
// 关注者
// ─────────────────────────────────────────────────────────────────

export async function watchTask(taskId: string, userId: string): Promise<void> {
  await prisma.taskWatcher.upsert({
    where: { taskId_userId: { taskId, userId } },
    update: {},
    create: { taskId, userId },
  });
}

export async function unwatchTask(taskId: string, userId: string): Promise<void> {
  await prisma.taskWatcher.deleteMany({ where: { taskId, userId } });
}

export async function listWatchers(taskId: string, viewerId: string) {
  const rows = await prisma.taskWatcher.findMany({
    where: { taskId },
    include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return {
    items: rows.map((r) => r.user),
    watching: rows.some((r) => r.userId === viewerId),
  };
}

// ─────────────────────────────────────────────────────────────────
// 到期提醒扫描（由定时任务每分钟调用）
// ─────────────────────────────────────────────────────────────────

export async function scanReminders(now = new Date()): Promise<number> {
  const due = await prisma.task.findMany({
    where: {
      reminderAt: { lte: now },
      reminderSentAt: null,
      deletedAt: null,
      status: { notIn: ['DONE', 'CANCELED'] },
    },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      assigneeId: true,
      createdById: true,
      reminderAt: true,
    },
    take: 100,
  });

  for (const task of due) {
    const recipientId = task.assigneeId ?? task.createdById;

    await notify({
      workspaceId: task.workspaceId,
      recipientId,
      // 系统提醒没有触发者
      actorId: null,
      type: 'TASK_DUE',
      targetType: 'task',
      targetId: task.id,
      title: `任务提醒：${task.title}`,
      body: task.reminderAt ? `提醒时间 ${task.reminderAt.toISOString()}` : undefined,
      link: `/w/${task.workspaceId}/tasks?task=${task.id}`,
    });

    // 标记已发，避免下一分钟重复投递
    await prisma.task.update({ where: { id: task.id }, data: { reminderSentAt: now } });
  }

  return due.length;
}

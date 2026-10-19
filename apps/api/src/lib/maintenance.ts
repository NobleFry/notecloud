import { TRASH_RETENTION_DAYS } from '@notecloud/shared';
import cron from 'node-cron';

import { prisma } from '../db/prisma.js';
import { scanReminders } from '../modules/notifications/service.js';
import { storage } from './storage.js';

/**
 * 定期清理。
 *
 * 为什么必须有它：产品对用户承诺了「回收站保留 30 天」，如果只写 deletedAt
 * 而不真删，库里会无限堆积，自部署用户的磁盘迟早被撑爆。
 */

export interface MaintenanceResult {
  purgedNotes: number;
  purgedTasks: number;
  purgedWorkspaces: number;
  orphanComments: number;
  expiredSessions: number;
  expiredInvitations: number;
  expiredEmailTokens: number;
  expiredIdempotencyKeys: number;
  purgedAttachments: number;
}

export async function runMaintenance(now = new Date()): Promise<MaintenanceResult> {
  const trashCutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 86_400_000);

  // 1) 回收站到期：先查 id 再删。
  //    不能直接 deleteMany —— 评论是多态表、没有外键，
  //    必须先按 id 把评论清掉，否则会留下永远看不到也删不掉的孤儿行。
  const expiredNotes = await prisma.note.findMany({
    where: { deletedAt: { lt: trashCutoff } },
    select: { id: true },
  });
  const expiredTasks = await prisma.task.findMany({
    where: { deletedAt: { lt: trashCutoff } },
    select: { id: true },
  });

  let purgedNotes = 0;
  let purgedTasks = 0;
  let orphanComments = 0;

  if (expiredNotes.length > 0) {
    const noteIds = expiredNotes.map((n) => n.id);
    const [, notes] = await prisma.$transaction([
      prisma.comment.deleteMany({ where: { targetType: 'NOTE', targetId: { in: noteIds } } }),
      prisma.note.deleteMany({ where: { id: { in: noteIds } } }),
    ]);
    purgedNotes = notes.count;
  }

  if (expiredTasks.length > 0) {
    const taskIds = expiredTasks.map((t) => t.id);
    const [comments, tasks] = await prisma.$transaction([
      prisma.comment.deleteMany({ where: { targetType: 'TASK', targetId: { in: taskIds } } }),
      prisma.task.deleteMany({ where: { id: { in: taskIds } } }),
    ]);
    purgedTasks = tasks.count;
    orphanComments = comments.count;
  }

  // 2) 过期会话：refresh token 已经无用，留着只是扩大泄漏面
  const sessions = await prisma.session.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  // 3) 过期邀请：标记状态而不是删除，保留"发过多少次邀请"的痕迹
  const invitations = await prisma.invitation.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  // 4) 过期的一次性邮件令牌
  const emailTokens = await prisma.emailToken.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  // 5) 过期幂等键：只是重放缓存，过期即删
  const idempotencyKeys = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  // 5) 孤儿附件：上传超过 24 小时，且没有任何未删除的笔记正文引用它。
  //
  // 为什么用 "content LIKE %id%"：附件与笔记是多对多（同一张图可以出现在多篇笔记），
  // 建引用表会带来一致性问题。代价是全表扫描 —— 单次最多处理 200 个，
  // 自部署规模下完全够用；真到瓶颈时再换成引用表。
  //
  // 24 小时的宽限期是为了避免：用户刚粘贴图片、还没保存笔记时被误删。
  const orphanCutoff = new Date(now.getTime() - 24 * 3_600_000);
  const candidates = await prisma.attachment.findMany({
    where: { createdAt: { lt: orphanCutoff }, deletedAt: null },
    select: { id: true, workspaceId: true, storageKey: true },
    take: 200,
  });

  let purgedAttachments = 0;
  for (const attachment of candidates) {
    const referenced = await prisma.note.count({
      where: { workspaceId: attachment.workspaceId, deletedAt: null, content: { contains: attachment.id } },
    });
    if (referenced > 0) continue;

    await prisma.attachment.delete({ where: { id: attachment.id } });
    await storage.delete(attachment.storageKey);
    purgedAttachments += 1;
  }

  // 6) 30 天前删除的工作区：物理删除。
  //    先收集附件文件路径 —— 行会被级联删掉，文件不会。
  const expiredWorkspaces = await prisma.workspace.findMany({
    where: { deletedAt: { lt: trashCutoff } },
    select: { id: true },
  });

  let purgedWorkspaces = 0;
  for (const workspace of expiredWorkspaces) {
    const files = await prisma.attachment.findMany({
      where: { workspaceId: workspace.id },
      select: { storageKey: true },
    });

    // sync_changes 没有外键，必须手动清
    await prisma.syncChange.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });

    for (const file of files) await storage.delete(file.storageKey);
    purgedWorkspaces += 1;
  }

  return {
    purgedNotes,
    purgedTasks,
    purgedWorkspaces,
    orphanComments,
    expiredSessions: sessions.count,
    expiredInvitations: invitations.count,
    expiredEmailTokens: emailTokens.count,
    expiredIdempotencyKeys: idempotencyKeys.count,
    purgedAttachments,
  };
}

interface MaintenanceLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * 启动定时任务。返回一个停止函数，用于优雅关闭。
 *
 * 调度：每天 03:15（低峰期）跑一次；另外启动 30 秒后补跑一次，
 * 把上次停机期间积压的过期数据清掉。延迟 30 秒是为了避开连接池初始化与
 * 可能的迁移操作，避免启动瞬间和数据库争资源。
 */
export function startMaintenance(log: MaintenanceLogger): () => void {
  const run = (reason: string): void => {
    void runMaintenance()
      .then((result) => {
        // 只在这些数字非零时打 info，避免每天刷一条"什么都没做"的日志
        if (Object.values(result).some((n) => n > 0)) {
          log.info(result, `维护任务完成（${reason}）`);
        }
      })
      .catch((err: unknown) => log.error({ err }, `维护任务失败（${reason}）`));
  };

  const task = cron.schedule('15 3 * * *', () => run('定时'));

  // 到期提醒：每分钟扫一次。用 * * * * * 而不是把提醒塞进日任务，
  // 因为用户会设"提前 10 分钟"这类精确时间。
  const reminderTask = cron.schedule('* * * * *', () => {
    void scanReminders()
      .then((count) => {
        if (count > 0) log.info({ sent: count }, '任务提醒已投递');
      })
      .catch((err: unknown) => log.error({ err }, '任务提醒扫描失败'));
  });

  const bootTimer = setTimeout(() => run('启动补跑'), 30_000);

  return () => {
    task.stop();
    reminderTask.stop();
    clearTimeout(bootTimer);
  };
}

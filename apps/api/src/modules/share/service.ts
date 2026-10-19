import { randomBytes } from 'node:crypto';

import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';

/** 分享链接只支持笔记（看板分享留到以后） */
const RESOURCE_TYPE = 'note';

export async function createShareLink(
  workspaceId: string,
  userId: string,
  noteId: string,
  expiresInDays?: number | null,
) {
  const note = await prisma.note.findFirst({
    where: { id: noteId, workspaceId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!note) throw AppError.notFound('笔记');

  const token = randomBytes(24).toString('base64url');

  const link = await prisma.shareLink.create({
    data: {
      token,
      workspaceId,
      resourceType: RESOURCE_TYPE,
      resourceId: noteId,
      createdById: userId,
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
    },
  });

  return {
    id: link.id,
    token: link.token,
    /** 前端可直接拼 origin */
    path: `/share/${link.token}`,
    expiresAt: link.expiresAt,
    createdAt: link.createdAt,
    viewCount: link.viewCount,
  };
}

export async function listShareLinks(workspaceId: string, noteId: string) {
  const rows = await prisma.shareLink.findMany({
    where: { workspaceId, resourceType: RESOURCE_TYPE, resourceId: noteId },
    orderBy: { createdAt: 'desc' },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  return rows.map((l) => ({
    id: l.id,
    path: `/share/${l.token}`,
    expiresAt: l.expiresAt,
    revokedAt: l.revokedAt,
    viewCount: l.viewCount,
    createdAt: l.createdAt,
    createdBy: l.createdBy,
    usable: !l.revokedAt && (!l.expiresAt || l.expiresAt.getTime() > Date.now()),
  }));
}

export async function revokeShareLink(workspaceId: string, linkId: string, userId: string, isAdmin: boolean) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, workspaceId } });
  if (!link) throw AppError.notFound('分享链接');
  if (!isAdmin && link.createdById !== userId) {
    throw AppError.forbidden('只有创建者或管理员可以撤销分享');
  }

  await prisma.shareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
}

/**
 * 公开读取（无需登录）。
 *
 * 注意：笔记的 `visibility = PRIVATE` 也可以被分享 —— 分享本身就是显式授权，
 * 与"工作区内可见性"是两件事。
 */
export async function getSharedNote(token: string) {
  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      workspace: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });

  if (!link) throw AppError.notFound('分享链接');
  if (link.revokedAt) throw AppError.notFound('分享链接已撤销');
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    throw AppError.notFound('分享链接已过期');
  }

  const note = await prisma.note.findFirst({
    where: { id: link.resourceId, workspaceId: link.workspaceId, deletedAt: null },
    include: { createdBy: { select: { name: true } } },
  });
  if (!note) throw AppError.notFound('笔记');

  // 访问计数是附带信息，失败不该影响阅读
  await prisma.shareLink
    .update({ where: { id: link.id }, data: { viewCount: { increment: 1 } } })
    .catch(() => undefined);

  return {
    title: note.title,
    content: note.content,
    updatedAt: note.updatedAt,
    author: note.createdBy.name,
    workspaceName: link.workspace.name,
    sharedBy: link.createdBy.name,
    expiresAt: link.expiresAt,
    viewCount: link.viewCount + 1,
  };
}

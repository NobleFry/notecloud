import { randomBytes, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { ErrorCode } from '@notecloud/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
import { storage } from '../../lib/storage.js';
import { isWorkspaceAdmin, workspaceGuard } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';

/**
 * 允许上传的类型白名单。
 *
 * 刻意**不收 image/svg+xml**：SVG 可以内嵌脚本，直接在新标签页打开
 * 同源 URL 时会执行。图片走 inline，其它类型一律 Content-Disposition: attachment。
 */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** 允许的扩展名（从原始文件名里取，取不到就按 mime 推断） */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
};

function safeExt(filename: string, mimeType: string): string {
  const ext = extname(filename).replace('.', '').toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  return MIME_EXT[mimeType] ?? 'bin';
}

/** 存储键：<workspaceId>/<yyyy>/<mm>/<uuid>.<ext> —— 完全由服务端生成，不含用户输入 */
function buildStorageKey(workspaceId: string, ext: string): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `${workspaceId}/${yyyy}/${mm}/${randomUUID()}.${ext}`;
}

function attachmentDto(a: {
  id: string;
  token: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: Date;
}) {
  return {
    id: a.id,
    url: `/api/v1/attachments/${a.id}/${a.token}`,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    createdAt: a.createdAt,
  };
}

type WsParams = { Params: { id: string } };
type AttachmentParams = { Params: { id: string; attachmentId: string } };

function ws(req: FastifyRequest) {
  return req.workspaceCtx!.workspace.id;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  // ── 上传 ──────────────────────────────────────────────────────
  app.post<WsParams>(
    '/workspaces/:id/attachments',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const file = await req.file();
      if (!file) {
        throw AppError.validation([{ path: 'file', message: '请选择要上传的文件' }]);
      }

      if (!ALLOWED_MIME.has(file.mimetype)) {
        throw new AppError(
          ErrorCode.PAYLOAD_TOO_LARGE,
          `不支持的文件类型：${file.mimetype}。允许图片、PDF、文本与常见办公文档。`,
        );
      }

      const buffer = await file.toBuffer();

      // multipart 的 limits.fileSize 会在超限时截断流，这里再兜一次
      const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
      if (buffer.byteLength > maxBytes) {
        throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, `文件超过 ${env.MAX_UPLOAD_MB}MB 上限`);
      }

      const filename = file.filename?.slice(0, 255) || '未命名文件';
      const ext = safeExt(filename, file.mimetype);
      const storageKey = buildStorageKey(ws(req), ext);

      await storage.put(storageKey, buffer);

      const attachment = await prisma.attachment.create({
        data: {
          workspaceId: ws(req),
          token: randomBytes(24).toString('base64url'),
          filename,
          mimeType: file.mimetype,
          size: buffer.byteLength,
          storageKey,
          uploaderId: req.auth!.user.id,
        },
      });

      return ok(req.id, { attachment: attachmentDto(attachment) });
    },
  );

  // ── 列表（工作区维度，便于排查与清理）─────────────────────────
  app.get<WsParams>('/workspaces/:id/attachments', { preHandler: workspaceGuard('ADMIN') }, async (req) => {
    const rows = await prisma.attachment.findMany({
      where: { workspaceId: ws(req), deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { uploader: { select: { id: true, name: true } } },
    });

    return ok(req.id, {
      items: rows.map((a) => ({ ...attachmentDto(a), uploader: a.uploader })),
      storage: { driver: env.STORAGE_DRIVER, maxUploadMB: env.MAX_UPLOAD_MB },
    });
  });

  // ── 删除（上传者或管理员）────────────────────────────────────
  app.delete<AttachmentParams>(
    '/workspaces/:id/attachments/:attachmentId',
    { preHandler: workspaceGuard('MEMBER') },
    async (req) => {
      const attachment = await prisma.attachment.findFirst({
        where: { id: req.params.attachmentId, workspaceId: ws(req), deletedAt: null },
      });
      if (!attachment) throw AppError.notFound('附件');

      if (!isWorkspaceAdmin(req) && attachment.uploaderId !== req.auth!.user.id) {
        throw AppError.forbidden('只有上传者或管理员可以删除附件');
      }

      await prisma.attachment.delete({ where: { id: attachment.id } });
      await storage.delete(attachment.storageKey);

      return ok(req.id, { deleted: true });
    },
  );

  // ── 读取（能力链接，无需登录）────────────────────────────────
  //
  // 这是全站唯一不需要鉴权的业务路由。URL 里的 token 是 32 字节随机值，
  // 不可猜测；换成"必须登录"就得改写 Markdown 渲染（<img> 发不了 Bearer）。
  app.get<{ Params: { id: string; token: string } }>(
    '/attachments/:id/:token',
    async (req, reply) => {
      const attachment = await prisma.attachment.findFirst({
        where: { id: req.params.id, token: req.params.token, deletedAt: null },
      });

      if (!attachment) throw AppError.notFound('附件');

      if (!(await storage.exists(attachment.storageKey))) {
        throw AppError.notFound('附件文件');
      }

      const inline = attachment.mimeType.startsWith('image/');

      void reply
        .header('Content-Type', attachment.mimeType)
        .header('Content-Length', attachment.size)
        // URL 里的 token 绑定内容，内容不会变 → 可以长期缓存
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        );

      return reply.send(storage.getStream(attachment.storageKey));
    },
  );
}

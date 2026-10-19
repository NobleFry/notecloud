import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────
// 站点管理后台（仅 SiteRole = ADMIN）
// ─────────────────────────────────────────────────────────────────

export const adminUserListQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).optional(),
});

export const updateAdminUserSchema = z
  .object({
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    role: z.enum(['USER', 'ADMIN']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

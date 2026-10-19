import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────
// 通用
// ─────────────────────────────────────────────────────────────────

/** 统一响应包（见 docs/API.md §1.1） */
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  requestId?: string;
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ─────────────────────────────────────────────────────────────────
// 枚举（与 Prisma schema 保持一致，手写而非从 Prisma 导入，
// 这样前端不必依赖被生成到 apps/api 里的 Prisma Client）
// ─────────────────────────────────────────────────────────────────

export const SITE_ROLES = ['USER', 'ADMIN'] as const;
export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'GUEST'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** 角色权重，数值越大权限越高。权限判定统一用它比较 */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  GUEST: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  MEMBER: '成员',
  GUEST: '访客',
};

export function roleAtLeast(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ─────────────────────────────────────────────────────────────────
// 基础字段
// ─────────────────────────────────────────────────────────────────

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, '请输入邮箱')
  .max(255)
  .pipe(z.email('邮箱格式不正确'));

/**
 * 密码强度：至少 10 位，且同时包含字母与数字。
 * 上限 128 位是为了防止超长输入拖垮哈希计算（DoS）。
 */
export const passwordSchema = z
  .string()
  .min(10, '密码至少 10 位')
  .max(128, '密码最长 128 位')
  .regex(/[A-Za-z]/, '密码需要包含字母')
  .regex(/[0-9]/, '密码需要包含数字');

export const nameSchema = z
  .string()
  .trim()
  .min(1, '请填写名称')
  .max(64, '名称最长 64 个字符');

export const tokenSchema = z.string().trim().min(16).max(256);

// ─────────────────────────────────────────────────────────────────
// 认证
// ─────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
  /** 来自邀请链接；带它注册时会同时加入对应工作区 */
  inviteToken: tokenSchema.optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, '请输入密码').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z.object({
  name: nameSchema.optional(),
  avatarUrl: z.union([z.url(), z.literal(''), z.null()]).optional(),
  timezone: z.string().max(64).optional(),
  locale: z.string().max(16).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ─────────────────────────────────────────────────────────────────
// 工作区
// ─────────────────────────────────────────────────────────────────

export const createWorkspaceSchema = z.object({
  name: nameSchema,
  icon: z.string().max(32).nullish(),
  color: z.string().max(16).nullish(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    icon: z.string().max(32).nullish(),
    color: z.string().max(16).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

// ─────────────────────────────────────────────────────────────────
// 成员与邀请
// ─────────────────────────────────────────────────────────────────

/** 可被指派的角色：不允许通过接口把某人直接变成 OWNER（必须走转让流程） */
export const assignableRoleSchema = z.enum(['ADMIN', 'MEMBER', 'GUEST']);

export const updateMemberRoleSchema = z.object({
  role: assignableRoleSchema,
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const transferOwnershipSchema = z.object({
  /** 接收所有权（成为新 OWNER）的成员 userId */
  userId: z.string().min(1),
  /** 自己转让后的角色，默认降为 ADMIN */
  selfRole: z.enum(['ADMIN', 'MEMBER']).default('ADMIN'),
});
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

export const createInvitationSchema = z.object({
  /** 不传 = 通用邀请链接（当前主要形态，不依赖 SMTP） */
  email: emailSchema.optional(),
  role: assignableRoleSchema.default('MEMBER'),
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresInDays: z.number().int().min(1).max(90).default(7),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

// ─────────────────────────────────────────────────────────────────
// 分页
// ─────────────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
  q: z.string().trim().max(64).optional(),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

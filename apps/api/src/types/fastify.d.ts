import type { WorkspaceRole } from '@notecloud/shared';

import type { User, Workspace, WorkspaceMember } from '../generated/prisma/client.js';
/**
 * 给 FastifyRequest 挂上鉴权与工作区上下文。
 * 这些字段只允许由 plugins/auth.ts 与 plugins/workspace.ts 写入。
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** 已通过 requireAuth 的用户 */
    auth?: {
      user: User;
      sessionId: string;
      siteRole: string;
    };
    /** 已通过 requireWorkspace 的工作区上下文 */
    workspaceCtx?: {
      workspace: Workspace;
      membership: WorkspaceMember;
      role: WorkspaceRole;
    };
    /** 幂等键上下文，由 plugins/idempotency.ts 写入 */
    idempotencyContext?: {
      userId: string;
      key: string;
      endpoint: string;
    };
  }
}

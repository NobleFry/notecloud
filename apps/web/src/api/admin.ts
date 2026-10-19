import { apiGet, apiPatch, apiPost } from './client';

export interface AdminOverview {
  users: number;
  activeUsers: number;
  workspaces: number;
  notes: number;
  tasks: number;
  attachments: { count: number; bytes: number };
  activeSessions: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'DISABLED';
  emailVerified: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  counts: { workspaces: number; notes: number; tasks: number };
}

export function adminOverview() {
  return apiGet<AdminOverview>('/admin/overview');
}

export function adminListUsers(params: { q?: string; limit?: number; cursor?: string } = {}) {
  const query: Record<string, string> = {};
  if (params.q) query.q = params.q;
  if (params.limit) query.limit = String(params.limit);
  if (params.cursor) query.cursor = params.cursor;

  return apiGet<{ items: AdminUser[]; nextCursor: string | null; hasMore: boolean }>('/admin/users', {
    params: query,
  });
}

export function adminUpdateUser(
  userId: string,
  payload: { status?: 'ACTIVE' | 'DISABLED'; role?: 'USER' | 'ADMIN' },
) {
  return apiPatch<{ user: { id: string; role: string; status: string } }>(`/admin/users/${userId}`, payload);
}

export function adminResetPassword(userId: string) {
  return apiPost<{ temporaryPassword: string }>(`/admin/users/${userId}/reset-password`);
}

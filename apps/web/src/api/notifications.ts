import type { NotificationType } from '@notecloud/shared';

import { apiGet, apiPost } from './client';

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  targetType: string | null;
  targetId: string | null;
  read: boolean;
  createdAt: string;
  actor: { id: string; name: string; avatarUrl: string | null } | null;
  workspace: { id: string; name: string; isPersonal: boolean };
}

export function listNotifications(params: { unreadOnly?: boolean; limit?: number } = {}) {
  const query: Record<string, string> = {};
  if (params.unreadOnly) query.unreadOnly = '1';
  if (params.limit) query.limit = String(params.limit);

  return apiGet<{ items: NotificationDto[]; nextCursor: string | null; hasMore: boolean }>(
    '/me/notifications',
    { params: query },
  );
}

export function unreadCount() {
  return apiGet<{ count: number }>('/me/notifications/unread-count');
}

export function markRead(notificationId: string) {
  return apiPost<{ read: boolean }>(`/me/notifications/${notificationId}/read`);
}

export function markAllRead() {
  return apiPost<{ marked: number }>('/me/notifications/read-all');
}

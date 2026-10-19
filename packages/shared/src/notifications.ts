import { z } from 'zod';

export const NOTIFICATION_TYPES = ['MENTION', 'TASK_ASSIGNED', 'TASK_COMMENT', 'TASK_DUE'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  MENTION: '@ 提及',
  TASK_ASSIGNED: '任务指派',
  TASK_COMMENT: '任务评论',
  TASK_DUE: '任务提醒',
};

export const NOTIFICATION_TYPE_ICON: Record<NotificationType, string> = {
  MENTION: '@',
  TASK_ASSIGNED: '👤',
  TASK_COMMENT: '💬',
  TASK_DUE: '⏰',
};

export const NOTIFICATION_LIMIT_MAX = 100;

/** 查询串里的布尔值：'1' / 'true' 为真 */
const boolQuery = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');

export const notificationListQuerySchema = z.object({
  unreadOnly: boolQuery,
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_LIMIT_MAX).default(30),
  cursor: z.string().min(1).optional(),
});

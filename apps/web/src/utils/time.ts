/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 03-12 */
export function relativeTime(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return '';

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';

  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return sameYear ? `${mm}-${dd}` : `${date.getFullYear()}-${mm}-${dd}`;
}

export function absoluteTime(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 回收站剩余天数（30 天保留） */
export function trashDaysLeft(deletedAt: string | null, retentionDays = 30): number {
  if (!deletedAt) return retentionDays;
  const elapsed = (Date.now() - new Date(deletedAt).getTime()) / 86_400_000;
  return Math.max(0, Math.ceil(retentionDays - elapsed));
}

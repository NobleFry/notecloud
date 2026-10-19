import type { ApiResponse } from '@notecloud/shared';

interface ValidationIssue {
  path: string;
  message: string;
}

/** 从接口错误里提取一条能直接展示给用户的文案 */
export function errorMessage(err: unknown): string {
  const res = err as Partial<ApiResponse> | null;

  if (res && typeof res.code === 'number') {
    const data = res.data as { issues?: ValidationIssue[] } | null;
    // 字段级校验错误优先，比笼统的"参数校验失败"有用得多
    if (data?.issues?.length) {
      return data.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('；');
    }
    if (res.message) return res.message;
  }

  if (err instanceof Error) return err.message;
  return '未知错误';
}

import {
  DEFAULT_MESSAGE_BY_CODE,
  ErrorCode,
  HTTP_STATUS_BY_CODE,
  type ErrorCodeValue,
} from '@notecloud/shared';

/**
 * 业务异常。所有主动抛出的错误都用它，保证错误码与 HTTP 状态码一一对应。
 * 路由里只管 `throw new AppError(...)`，格式化统一交给 error-handler 插件。
 */
export class AppError extends Error {
  readonly code: number;
  readonly status: number;
  readonly details: unknown;

  constructor(code: number, message?: string, details?: unknown) {
    super(message ?? DEFAULT_MESSAGE_BY_CODE[code] ?? '未知错误');
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code] ?? 400;
    this.details = details;
  }

  static validation(details?: unknown): AppError {
    return new AppError(ErrorCode.VALIDATION_FAILED, undefined, details);
  }
  static unauthorized(message?: string): AppError {
    return new AppError(ErrorCode.UNAUTHORIZED, message);
  }
  static forbidden(message?: string): AppError {
    return new AppError(ErrorCode.FORBIDDEN, message);
  }
  static notMember(): AppError {
    return new AppError(ErrorCode.NOT_MEMBER);
  }
  static insufficientRole(required?: string): AppError {
    return new AppError(
      ErrorCode.INSUFFICIENT_ROLE,
      required ? `当前角色权限不足（需要 ${required} 及以上）` : undefined,
    );
  }
  static notFound(what = '资源'): AppError {
    return new AppError(ErrorCode.NOT_FOUND, `${what}不存在`);
  }
  static emailTaken(): AppError {
    return new AppError(ErrorCode.EMAIL_TAKEN);
  }
  static lastOwner(): AppError {
    return new AppError(ErrorCode.LAST_OWNER);
  }
  static invitationInvalid(): AppError {
    return new AppError(ErrorCode.INVITATION_INVALID);
  }
  static registrationClosed(): AppError {
    return new AppError(ErrorCode.REGISTRATION_CLOSED);
  }
}

export type { ErrorCodeValue };

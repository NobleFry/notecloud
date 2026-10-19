/**
 * 业务错误码 —— 前后端共用同一份定义。
 * HTTP 状态码只做粗粒度分类，前端一律按 `code` 分支（见 docs/API.md §1.3）。
 */
export const ErrorCode = {
  OK: 0,

  // 4xxxx 客户端错误
  VALIDATION_FAILED: 40000,
  INVITATION_INVALID: 40010,

  UNAUTHORIZED: 40100,
  TOKEN_EXPIRED: 40101,
  REFRESH_REUSED: 40102,
  ACCOUNT_DISABLED: 40103,

  FORBIDDEN: 40300,
  NOT_MEMBER: 40301,
  INSUFFICIENT_ROLE: 40302,
  REGISTRATION_CLOSED: 40310,

  NOT_FOUND: 40400,

  VERSION_CONFLICT: 40900,
  EMAIL_TAKEN: 40901,
  LAST_OWNER: 40902,
  SLUG_TAKEN: 40903,

  PAYLOAD_TOO_LARGE: 41300,
  RATE_LIMITED: 42900,

  // 5xxxx 服务端错误
  INTERNAL: 50000,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码 → HTTP 状态码 */
export const HTTP_STATUS_BY_CODE: Record<number, number> = {
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.INVITATION_INVALID]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.REFRESH_REUSED]: 401,
  [ErrorCode.ACCOUNT_DISABLED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_MEMBER]: 403,
  [ErrorCode.INSUFFICIENT_ROLE]: 403,
  [ErrorCode.REGISTRATION_CLOSED]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.VERSION_CONFLICT]: 409,
  [ErrorCode.EMAIL_TAKEN]: 409,
  [ErrorCode.LAST_OWNER]: 409,
  [ErrorCode.SLUG_TAKEN]: 409,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL]: 500,
};

/** 错误码 → 默认中文提示（服务端可覆盖，前端可直接展示） */
export const DEFAULT_MESSAGE_BY_CODE: Record<number, string> = {
  [ErrorCode.OK]: 'ok',
  [ErrorCode.VALIDATION_FAILED]: '参数校验失败',
  [ErrorCode.INVITATION_INVALID]: '邀请链接无效、已过期或已达使用上限',
  [ErrorCode.UNAUTHORIZED]: '邮箱或密码错误',
  [ErrorCode.TOKEN_EXPIRED]: '登录已过期，请刷新后重试',
  [ErrorCode.REFRESH_REUSED]: '登录状态异常，请重新登录',
  [ErrorCode.ACCOUNT_DISABLED]: '账号已被停用，请联系站点管理员',
  [ErrorCode.FORBIDDEN]: '没有操作权限',
  [ErrorCode.NOT_MEMBER]: '你不是该工作区的成员',
  [ErrorCode.INSUFFICIENT_ROLE]: '当前角色权限不足',
  [ErrorCode.REGISTRATION_CLOSED]: '站点已关闭注册，请使用邀请链接',
  [ErrorCode.NOT_FOUND]: '资源不存在',
  [ErrorCode.VERSION_CONFLICT]: '内容已被他人修改',
  [ErrorCode.EMAIL_TAKEN]: '该邮箱已被注册',
  [ErrorCode.LAST_OWNER]: '工作区必须至少保留一位所有者，请先转让所有权',
  [ErrorCode.SLUG_TAKEN]: '该标识已被占用',
  [ErrorCode.PAYLOAD_TOO_LARGE]: '上传内容过大',
  [ErrorCode.RATE_LIMITED]: '操作过于频繁，请稍后再试',
  [ErrorCode.INTERNAL]: '服务器开小差了',
};

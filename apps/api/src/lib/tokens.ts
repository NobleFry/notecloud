import { createHash, randomBytes } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import { AppError } from './errors.js';

export interface AccessTokenPayload {
  /** userId */
  sub: string;
  /** sessionId */
  sid: string;
  /** 站点角色 */
  role: string;
  /** 授权时所属用户的工作区列表会频繁变化，故不入 token，按需查库 */
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    issuer: 'notecloud',
  });
}

/**
 * 校验 Access Token。
 * 过期与非法要区分开：过期（40101）前端应当静默 refresh 后重试，非法（40100）直接登出。
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET, { issuer: 'notecloud' }) as AccessTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(40101);
    }
    throw AppError.unauthorized('登录状态无效，请重新登录');
  }
}

/** 生成不可猜测的随机令牌（refresh token / 邀请 token 的明文） */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * 令牌入库前统一哈希。
 * 数据库里永远没有明文令牌 —— 即使库被拖走也无法直接冒用。
 * 用 sha256 而非 argon2：令牌本身已是高熵随机串，不需要抗暴力破解的慢哈希。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** "30d" / "15m" / "12h" → 毫秒 */
export function parseDuration(input: string): number {
  const match = /^(\d+)([smhd])$/.exec(input.trim());
  if (!match) throw new Error(`无法解析时长: ${input}`);
  const value = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const factor = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return value * factor;
}

export function expiresAtFrom(duration: string): Date {
  return new Date(Date.now() + parseDuration(duration));
}

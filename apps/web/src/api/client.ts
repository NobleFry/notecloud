import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';

import { ErrorCode, type ApiResponse } from '@notecloud/shared';

/**
 * 统一的 API 客户端。
 *
 * 关键设计：
 *   * 多个请求同时收到 40101（token 过期）时，只发起一次 refresh，其余请求等它 ——
 *     否则会同时打出一串 refresh，触发服务端的"重放检测"把整族会话吊销。
 *   * refresh 请求本身用裸 axios 发出，不走拦截器，避免递归。
 */

const BASE_URL = '/api/v1';

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** 会话彻底失效（重放检测/被踢下线）时的回调，由 auth store 注册 */
export function setSessionLostHandler(handler: () => void): void {
  onSessionLost = handler;
}

export const http = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  try {
    const { data } = await axios.post<ApiResponse<{ accessToken: string }>>(
      `${BASE_URL}/auth/refresh`,
      {},
      { withCredentials: true, timeout: 20_000 },
    );
    if (data.code === ErrorCode.OK) {
      accessToken = data.data.accessToken;
      return accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResponse>) => {
    const body = error.response?.data;

    // 网络层失败（后端没起、断网）
    if (!error.response) {
      return Promise.reject({
        code: ErrorCode.INTERNAL,
        message: '无法连接到服务器，请确认后端已启动',
        data: null,
      } satisfies ApiResponse);
    }

    // Access Token 过期 → 静默续期后重放原请求
    if (body?.code === ErrorCode.TOKEN_EXPIRED && error.config) {
      refreshInFlight ??= refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });

      const fresh = await refreshInFlight;
      if (fresh) {
        const retry: AxiosRequestConfig = {
          ...error.config,
          headers: { ...error.config.headers, Authorization: `Bearer ${fresh}` },
        };
        return http.request(retry);
      }
    }

    // 会话被吊销 / 账号停用 / 重放检测命中 → 强制登出
    if (
      body?.code === ErrorCode.REFRESH_REUSED ||
      body?.code === ErrorCode.UNAUTHORIZED ||
      body?.code === ErrorCode.ACCOUNT_DISABLED
    ) {
      accessToken = null;
      onSessionLost?.();
    }

    return Promise.reject(
      body ?? ({ code: ErrorCode.INTERNAL, message: '请求失败', data: null } satisfies ApiResponse),
    );
  },
);

/** 取出 data 字段，失败时抛 ApiResponse（内含业务错误码） */
export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const { data } = await http.get<ApiResponse<T>>(url, config);
  return data.data;
}

export async function apiPost<T>(url: string, payload?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const { data } = await http.post<ApiResponse<T>>(url, payload, config);
  return data.data;
}

export async function apiPatch<T>(url: string, payload?: unknown): Promise<T> {
  const { data } = await http.patch<ApiResponse<T>>(url, payload);
  return data.data;
}

export async function apiPut<T>(url: string, payload?: unknown): Promise<T> {
  const { data } = await http.put<ApiResponse<T>>(url, payload);
  return data.data;
}

export async function apiDelete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const { data } = await http.delete<ApiResponse<T>>(url, config);
  return data.data;
}

/**
 * multipart 上传。
 * 必须把 Content-Type 置空，让浏览器自己带上 boundary ——
 * axios 实例的默认头是 application/json，不覆盖就会解析失败。
 */
export async function apiUpload<T>(url: string, form: FormData): Promise<T> {
  const { data } = await http.post<ApiResponse<T>>(url, form, {
    headers: { 'Content-Type': undefined } as never,
    timeout: 120_000,
  });
  return data.data;
}

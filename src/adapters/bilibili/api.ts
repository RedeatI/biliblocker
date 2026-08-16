/**
 * Bilibili API 低层客户端（仅在内容脚本上下文运行）。
 *
 * 为什么在内容脚本发请求：
 * - fetch 携带页面同源 Cookie（.bilibili.com 域），无需 cookies 权限；
 * - Bilibili 接口对 www.bilibili.com 源开放 CORS（页面自身前端同样方式调用）；
 * - 因此不需要扩展后台直接访问 api.bilibili.com，也就不需要额外 host 权限与 cookies 权限。
 *
 * 安全约束：
 * - 只请求与功能相关的第一方接口；
 * - 不保存 Cookie；CSRF 令牌仅瞬时读取用于请求签名；
 * - 不向任何第三方转发 Cookie / CSRF / 页面内容；
 * - 登录失效、风控、接口变更都会标准化为可识别的错误类型。
 */
import type { TaskErrorType } from '../../shared/types';

export interface BiliRawResponse<T = unknown> {
  code: number;
  message?: string;
  data?: T;
  ttl?: number;
}

export class BiliNetworkError extends Error {
  readonly errorType: TaskErrorType = 'network';
  constructor(message: string) {
    super(message);
    this.name = 'BiliNetworkError';
  }
}

export class BiliApiError extends Error {
  readonly errorType: TaskErrorType;
  readonly code: number;
  constructor(code: number, message: string, errorType: TaskErrorType) {
    super(message);
    this.name = 'BiliApiError';
    this.code = code;
    this.errorType = errorType;
  }
}

/** 读取 CSRF 令牌（bili_jct cookie，Bilibili 页面前端同样读取该值）。仅内存使用，不持久化。 */
export function getCsrfToken(): string {
  try {
    for (const part of document.cookie.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim();
      if (key === 'bili_jct') return part.slice(idx + 1).trim();
    }
  } catch {
    // cookie 不可读时按未登录处理
  }
  return '';
}

/**
 * 标准化的接口调用。
 * @param url 仅允许 Bilibili 第一方域名（内部白名单校验，防止被注入任意 URL）。
 */
export async function biliFetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<BiliRawResponse<T>> {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const allowed =
    host === 'api.bilibili.com' ||
    host === 'www.bilibili.com' ||
    host === 'passport.bilibili.com' ||
    host === 'account.bilibili.com';
  if (!allowed) throw new BiliApiError(-1, `不允许的接口域名：${host}`, 'api_changed');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...(init?.headers as Record<string, string> | undefined),
      },
      ...init,
    });
  } catch (e) {
    throw new BiliNetworkError(e instanceof Error ? e.message : '网络请求失败');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new BiliApiError(404, '接口不存在（可能已改版）', 'api_changed');
    }
    if (res.status === 412 || res.status === 403) {
      throw new BiliApiError(res.status, `HTTP ${res.status}（疑似风控）`, 'risk_control');
    }
    throw new BiliNetworkError(`HTTP ${res.status}`);
  }
  return (await res.json()) as BiliRawResponse<T>;
}

export interface ClassifiedResult {
  ok: boolean;
  status: string;
  code: number;
  message?: string;
  errorType?: TaskErrorType;
}

/**
 * 把 Bilibili 业务 code 归类为标准化结果。
 * 参考：bilibili-API-collect 与公开资料整理；具体 code 含义随版本变化，
 * 无法确证的 code 一律归类为 unknown（不猜、不冒充成功）。
 */
export function classifyApiCode(code: number, message?: string): ClassifiedResult {
  if (code === 0) return { ok: true, status: 'success', code: 0 };
  switch (code) {
    case -101:
      return { ok: false, status: '未登录', code, message: message ?? '未登录或登录已失效', errorType: 'login_invalid' };
    case -352:
      return { ok: false, status: '风控', code, message: message ?? '触发风控/需要验证码', errorType: 'risk_control' };
    case -403:
      return { ok: false, status: '拒绝访问', code, message: message ?? '访问被拒绝（可能风控）', errorType: 'risk_control' };
    case -400:
      return { ok: false, status: '参数错误', code, message: message ?? '参数错误', errorType: 'validation' };
    case -404:
      return { ok: false, status: '接口失效', code, message: message ?? '接口失效（可能已改版）', errorType: 'api_changed' };
    case -111:
      return { ok: false, status: 'csrf 校验失败', code, message: message ?? 'CSRF 校验失败', errorType: 'validation' };
    case -509:
      return { ok: false, status: '频率限制', code, message: message ?? '操作过于频繁', errorType: 'risk_control' };
    default:
      return { ok: false, status: `拒绝(${code})`, code, message: message ?? `接口返回错误码 ${code}`, errorType: 'unknown' };
  }
}

/** 统一捕获异常并转为 TaskResult */
export function toTaskResultError(e: unknown): {
  ok: false;
  status: string;
  message?: string;
  errorType: TaskErrorType;
} {
  if (e instanceof BiliApiError) {
    return { ok: false, status: e.message, message: e.message, errorType: e.errorType };
  }
  if (e instanceof BiliNetworkError) {
    return { ok: false, status: e.message, message: e.message, errorType: 'network' };
  }
  return {
    ok: false,
    status: e instanceof Error ? e.message : String(e),
    message: e instanceof Error ? e.message : String(e),
    errorType: 'unknown',
  };
}

/**
 * BilibiliAuthStateAdapter：登录状态检查。
 * 使用 /x/web-interface/nav 第一方接口；60 秒缓存；失败按未登录处理。
 */
import { biliFetchJson, BiliNetworkError } from './api';

export interface LoginState {
  isLogin: boolean;
  mid: number | null;
  /** 网络不可达（非未登录）时置 true，用于区分「无法确认」与「确定未登录」 */
  networkError: boolean;
}

interface NavData {
  isLogin: boolean;
  mid?: number;
  uname?: string;
  wbi_img?: unknown;
}

const CACHE_TTL = 60_000;

export class BilibiliAuthStateAdapter {
  private cache: { state: LoginState; at: number } | null = null;

  /** 检查登录状态；force=true 强制刷新缓存 */
  async checkLogin(force = false): Promise<LoginState> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL) {
      return this.cache.state;
    }
    try {
      const json = await biliFetchJson<NavData>('https://api.bilibili.com/x/web-interface/nav');
      if (json.code === 0 && json.data) {
        const state: LoginState = {
          isLogin: json.data.isLogin === true,
          mid: typeof json.data.mid === 'number' && json.data.mid > 0 ? json.data.mid : null,
          networkError: false,
        };
        this.cache = { state, at: Date.now() };
        return state;
      }
      if (json.code === -101) {
        const state: LoginState = { isLogin: false, mid: null, networkError: false };
        this.cache = { state, at: Date.now() };
        return state;
      }
      const state: LoginState = { isLogin: false, mid: null, networkError: false };
      this.cache = { state, at: Date.now() };
      return state;
    } catch (e) {
      if (e instanceof BiliNetworkError) {
        return { isLogin: false, mid: null, networkError: true };
      }
      return { isLogin: false, mid: null, networkError: false };
    }
  }

  /** 当前登录用户 UID；未登录返回 null */
  async currentMid(): Promise<number | null> {
    const state = await this.checkLogin();
    return state.mid;
  }

  clearCache(): void {
    this.cache = null;
  }
}

/**
 * FrameRegistry（P1-6 v0.1.3 / P0-5 v0.1.4）：帧身份注册表。
 *
 * SW 重启后 frame registry 是内存状态，内容脚本需要重新 PING 注册。
 * v0.1.4：任务派发时区分三种失败：
 * - not_registered：页面尚未重新注册（SW 重启宽限期）→ 有限等待后重试，不立即终态失败；
 * - nonce_mismatch：页面已刷新/导航（会话 nonce 变化）→ 明确终态，绝不迁移到新页面；
 * - not_bilibili：页面已离开 Bilibili → 明确终态。
 * tab 存在性由 background（browser.tabs.get）负责，本类只做纯身份判定（可单测）。
 */
export interface FrameIdentity {
  nonce: string;
  url: string;
  registeredAt: number;
}

export type FrameVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_registered' | 'nonce_mismatch' | 'not_bilibili' | 'no_tab'; message: string };

export interface FrameTask {
  tabId?: number;
  frameId?: number;
  frameNonce?: string;
}

export class FrameRegistry {
  private frames = new Map<string, FrameIdentity>();

  constructor(
    private readonly maxFrames = 500,
    private readonly now: () => number = () => Date.now(),
    private readonly isAllowedUrl: (url: string) => boolean = () => false,
  ) {}

  /** 内容脚本 PING 时注册帧身份（同 tab/frame 重复 PING 更新 nonce/url/时间） */
  register(tabId: number, frameId: number, nonce: string, url: string): void {
    const key = `${tabId}:${frameId}`;
    this.frames.set(key, { nonce, url, registeredAt: this.now() });
    if (this.frames.size > this.maxFrames) {
      const oldest = [...this.frames.entries()].sort((a, b) => a[1].registeredAt - b[1].registeredAt)[0];
      if (oldest) this.frames.delete(oldest[0]);
    }
  }

  identityFor(tabId: number, frameId: number): FrameIdentity | undefined {
    return this.frames.get(`${tabId}:${frameId}`);
  }

  /**
   * P0-5（v0.1.4）：任务身份校验（纯判定；tab 存在性由调用方负责）。
   * - not_registered：等待重新注册（宽限期重试）；
   * - nonce_mismatch / not_bilibili / no_tab：明确终态。
   */
  verify(task: FrameTask): FrameVerifyResult {
    if (task.tabId === undefined) {
      return { ok: false, reason: 'no_tab', message: '任务未关联页面' };
    }
    const identity = this.frames.get(`${task.tabId}:${task.frameId ?? 0}`);
    if (!identity) {
      return {
        ok: false,
        reason: 'not_registered',
        message: '发起任务的页面尚未重新注册（SW 重启宽限期），等待重新 PING',
      };
    }
    if (identity.nonce !== task.frameNonce) {
      return {
        ok: false,
        reason: 'nonce_mismatch',
        message: '发起任务的页面已刷新（会话 nonce 不匹配），任务不会在旧页面上执行',
      };
    }
    if (!this.isAllowedUrl(identity.url)) {
      return {
        ok: false,
        reason: 'not_bilibili',
        message: '发起任务的页面已离开 Bilibili，拒绝在复用 tabId 上执行',
      };
    }
    return { ok: true };
  }

  /** 测试/诊断：当前注册帧数 */
  size(): number {
    return this.frames.size;
  }
}

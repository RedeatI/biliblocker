/**
 * 1.10（5.4 v0.1.4）：SW 重启与帧重新注册（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE 5.4）：frame registry 是 SW 内存状态；重启后队列可能先
 * pump，而内容脚本尚未重新 PING → 任务被立即标记为页面失效。
 * 修复要求：
 * - 内容脚本尚未 PING 时不立即标记失败（not_registered → 宽限期重试）；
 * - 在合理等待窗口内重新注册相同 tab/frame/nonce 后可继续；
 * - 页面确实关闭或 nonce 改变时才进入明确终态；
 * - 不在旧页面执行。
 */
import { describe, expect, it } from 'vitest';
import { FrameRegistry } from '@/entrypoints/background/frame-registry';
import { QUEUE } from '@/shared/constants/defaults';

function makeRegistry(): FrameRegistry {
  return new FrameRegistry(500, () => 1_000_000, (url) => url.startsWith('https://www.bilibili.com/'));
}

describe('1.10 SW 重启与帧重新注册（5.4）', () => {
  it('SW 重启后内容脚本尚未 PING → not_registered（不立即标记失败）', () => {
    const registry = makeRegistry();
    const verdict = registry.verify({ tabId: 1, frameId: 0, frameNonce: 'n1' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('not_registered');
      expect(verdict.message).toContain('重新注册');
    }
  });

  it('宽限期内重新注册相同 tab/frame/nonce → 可继续', () => {
    const registry = makeRegistry();
    registry.register(1, 0, 'n1', 'https://www.bilibili.com/video/BV1');
    const verdict = registry.verify({ tabId: 1, frameId: 0, frameNonce: 'n1' });
    expect(verdict).toEqual({ ok: true });
  });

  it('页面 nonce 改变（刷新）→ 明确终态 nonce_mismatch，旧任务不迁移到新页面', () => {
    const registry = makeRegistry();
    registry.register(1, 0, 'n2', 'https://www.bilibili.com/video/BV1'); // 页面刷新后新 nonce
    const verdict = registry.verify({ tabId: 1, frameId: 0, frameNonce: 'n1' }); // 旧任务 old nonce
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('nonce_mismatch');
      expect(verdict.message).toContain('nonce 不匹配');
    }
  });

  it('页面离开 Bilibili（导航）→ 明确终态 not_bilibili，拒绝在复用 tabId 上执行', () => {
    const registry = makeRegistry();
    registry.register(1, 0, 'n1', 'https://example.com/other');
    const verdict = registry.verify({ tabId: 1, frameId: 0, frameNonce: 'n1' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('not_bilibili');
    }
  });

  it('任务未关联页面 → no_tab（明确终态）', () => {
    const registry = makeRegistry();
    const verdict = registry.verify({ frameId: 0, frameNonce: 'n1' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('no_tab');
    }
  });

  it('宽限期常量存在且为正（executeViaContent 等待窗口）', () => {
    expect(QUEUE.FRAME_REGISTRATION_GRACE_MS).toBeGreaterThan(0);
  });
});

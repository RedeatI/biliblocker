/**
 * 复验 E2-P0-3B（阶段 E 第三轮）：pause retry 全部耗尽后，相同原因再次 pause
 * 不得静默 resolve（先红后绿）。
 *
 * 反例路径（复验报告）：
 * schedulePauseRetry 耗尽分支当前写：
 *   if (attempt >= PAUSE_RETRY.MAX_ATTEMPTS || !this.control.paused) {
 *     this.pauseRetryTimer = null;
 *     this.pausePersistPending = false;  // ← 错误：重试耗尽 ≠ 持久化成功
 *     return;
 *   }
 * 于是：
 *   pause() → saveControl 失败 → pausePersistPending=true → 3 次 retry 全失败
 *   → 达 MAX_ATTEMPTS → pausePersistPending=false（错误）
 *   → queueControl 实际仍 paused:false
 *   → 再次 pause(相同 reason/kind) → 命中 !pausePersistPending → return/resolve（静默成功）
 *
 * 原则（复验方）：只有 saveControl 真正成功 / 用户显式 resume / 已转入其他
 * 被证明安全的持久状态，才允许 pausePersistPending=false；「重试次数耗尽」绝不能算成功。
 *
 * 断言（修复后）：
 * - 首次 pause：saveControl + 3 次 retry 全部失败 → reject；
 * - 等待 retry 链彻底耗尽后，storage queueControl 仍 paused:false；
 * - 相同原因再次 pause → 必须 reject（不得早退 resolve）。
 */
import { describe, expect, it, vi } from 'vitest';
import { cloneBackend, makeRealEnv015, memoryLatch } from './helpers/v015-env';

vi.mock('@/shared/capabilities', () => ({
  isCapabilityEnabled: () => true,
  canReportContentType: () => true,
  capabilityDenyReason: () => null,
  selectorCapabilityFor: () => 'selectorsVideo',
  areSelectorsVerified: () => true,
  capabilityForTaskType: (type: string) => (type === 'report' ? 'reportVideoComment' : type === 'unblock' ? 'unblockUser' : 'blockUser'),
}));
vi.mock('@/shared/constants/report-reasons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/constants/report-reasons')>();
  return { ...actual, REPORT_REASONS: { ...actual.REPORT_REASONS, verified: true } };
});

describe('复验 E2-P0-3B：pause retry 耗尽后相同原因 pause 不得静默成功', () => {
  it('saveControl + 全部 retry 失败 → storage 仍 paused:false → 相同原因再次 pause 必须 reject', async () => {
    // bb.queueControl（paused=true）写**永远**失败（initial + 所有 retry 均失败）
    const base = cloneBackend();
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        if (
          items['bb.queueControl'] !== undefined &&
          (items['bb.queueControl'] as { paused: boolean }).paused === true
        ) {
          throw new Error('queueControl 写失败');
        }
        await base.set(items);
      },
      remove: (keys: string[]) => base.remove(keys),
    };
    const latch = memoryLatch(false);
    const env = await makeRealEnv015({}, undefined, { backend, latch });

    // ---- 1. 首次 pause：写失败 → reject；retry 链（3 次）全部失败 ----
    await expect(env.queue.pause('检测到验证码/风控', 'risk_control', true)).rejects.toThrow();

    // ---- 2. 等待 retry 链彻底耗尽（BASE_DELAY_MS=500，attempt 1/2/3 → 500+1000+2000ms 约 3.5s）----
    await new Promise((r) => setTimeout(r, 4200));
    // storage 仍 paused:false（从未成功持久化）
    const raw = await base.get(['bb.queueControl']);
    expect((raw['bb.queueControl'] as { paused: boolean }).paused).toBe(false);

    // ---- 3. 相同原因再次 pause：必须 reject ----
    // 当前实现：retry 耗尽分支把 pausePersistPending 置 false → 相同原因早退 return → resolve → red
    await expect(env.queue.pause('检测到验证码/风控', 'risk_control', true)).rejects.toThrow();
    // 内存仍 fail-closed，latch 保持
    expect(env.queue.getStatus().paused).toBe(true);
    expect(await latch.isSet()).toBe(true);
  });
});

/**
 * 复验 E2-P0-3A（阶段 E 第三轮）：persistent latch 自身 set() 失败时，
 * 浏览器完全重启仍必须 fail-closed（先红后绿）。
 *
 * 反例路径（复验报告）：
 * compositeSafetyLatch.set() 顺序双写 session → persistent：
 * 1. 风控发生，pause() 先把内存设成 paused=true；
 * 2. session.set(true) 成功；
 * 3. persistent（chrome.storage.local）set() 失败；
 * 4. latch.set() 抛异常 → pause() reject；
 * 5. 因异常发生在 latch 阶段，w.saveControl() 根本未执行；
 * 6. 当前 SW 内存 fail-closed，session latch 仍在；
 * 7. 浏览器崩溃/完全退出 → storage.session 清空；
 * 8. persistent latch 从未写入；bb.queueControl 仍 paused:false；
 * 9. 新浏览器启动 → composite.isSet()=false → start() 恢复未暂停（fail-open）。
 *
 * 断言（修复后）：
 * - pause() 在 persistent 失败时仍应显式失败（reject，安全锁不完整）；
 * - **但 local control（paused:true）必须被写入**——它本身就是跨浏览器重启的
 *   持久证据：即使 session/persistent 全丢，start() 读 control.paused=true 仍 fail-closed；
 * - 浏览器完全重启后 paused=true、不派发、executor 不被调用。
 */
import { describe, expect, it, vi } from 'vitest';
import { cloneBackend, makeRealEnv015, restartableLatch } from './helpers/v015-env';
import { compositeSafetyLatch, type SafetyLatch } from '@/storage/safety-latch';
import { StorageRepository } from '@/storage/repository';
import { StorageCoordinator } from '@/storage/coordinator';
import { ActionQueue } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';

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

describe('复验 E2-P0-3A：persistent latch set() 自身失败 → 浏览器完全重启仍 fail-closed', () => {
  it('persistent 失败 + session 成功：pause 显式失败；control 仍写入 paused:true；重启后 fail-closed', async () => {
    // session 通道可被浏览器重启清空
    const session = restartableLatch(false);
    // persistent 通道：set 抛错（模拟 chrome.storage.local 写失败）
    let failPersistent = true;
    const persistent: SafetyLatch = {
      isSet: async () => false,
      set: async () => {
        if (failPersistent) throw new Error('persistent 写失败');
      },
      clear: async () => undefined,
    };
    const latch = compositeSafetyLatch(session, persistent);
    // control 写**正常**（只注入 persistent 失败——复验核心：latch 失败不得阻断 control 写入）
    const base = cloneBackend();
    const env = await makeRealEnv015({}, undefined, { backend: base, latch });

    // ---- 1. pause：latch.set() 抛错（session 已写、persistent 失败）→ 显式失败 ----
    let pauseRejected = false;
    try {
      await env.queue.pause('检测到验证码/风控', 'risk_control', true);
    } catch {
      pauseRejected = true;
    }
    expect(pauseRejected).toBe(true);

    // ---- 2. 关键断言：local control 必须已被写入 paused:true（跨浏览器重启的持久证据）----
    const raw = await base.get(['bb.queueControl']);
    expect((raw['bb.queueControl'] as { paused: boolean }).paused).toBe(true);

    // ---- 3. 浏览器完全重启：session 清空；persistent 从未写入 ----
    session.browserRestart();
    await new Promise((r) => setTimeout(r, 30));

    // ---- 4. 新 SW/浏览器启动：同一 local（control 已 paused:true）----
    const repo2 = new StorageRepository(base);
    await repo2.init();
    const coordinator2 = new StorageCoordinator(repo2, null, null);
    const dedup2 = new DeduplicationRegistry(repo2, coordinator2.writer);
    let executed = 0;
    const queue2 = new ActionQueue({
      repo: repo2,
      dedup: dedup2,
      writer: coordinator2.writer,
      latch,
      executor: {
        execute: async () => {
          executed++;
          return { ok: true, status: 'ok' };
        },
      },
    });
    coordinator2.attachQueue(queue2);
    await queue2.start();

    // ---- 5. 浏览器完全重启后必须 fail-closed（靠 control.paused=true 兜底）----
    // 当前实现：pause 在 latch 阶段 reject 后 control 未写 → 重启后 paused=false → red
    expect(queue2.getStatus().paused).toBe(true);
    expect(queue2.getStatus().pauseKind).toBe('risk_control');
    // 不派发
    await queue2.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(executed).toBe(0);

    // ---- 6. 用户显式恢复后才允许继续 ----
    failPersistent = false;
    await queue2.resume('user');
    expect(queue2.getStatus().paused).toBe(false);
  });
});

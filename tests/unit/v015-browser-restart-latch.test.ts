/**
 * 复验 P0-3（阶段 E 第二轮）：浏览器完全重启必须 fail-closed（先红后绿）。
 *
 * 反例路径（复验报告）：
 * - 风控发生；session latch = true 成功；
 * - bb.queueControl local 写失败 → 持久状态仍 paused:false；
 * - 500ms retry 成功之前浏览器崩溃/退出；
 * - 浏览器重新启动 → chrome.storage.session 被清空（官方文档确认）；
 * - storage.local.bb.queueControl 仍 paused:false；
 * - queue.start() 读取不到 latch → 队列恢复运行（fail-open）。
 *
 * 断言（修复后）：
 * - 浏览器完全重启后，若无法证明上次暂停已安全清除 → 必须 fail-closed（paused=true）；
 * - 需要**持久化**安全 latch（chrome.storage.local），不能只依赖 session；
 * - 只有用户显式恢复（清除 latch）后才允许继续。
 */
import { describe, expect, it, vi } from 'vitest';
import { cloneBackend, failingBackend, makeRealEnv015, memoryLatch, restartableLatch } from './helpers/v015-env';
import { compositeSafetyLatch } from '@/storage/safety-latch';
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

describe('复验 P0-3：浏览器完全重启必须 fail-closed（持久安全 latch）', () => {
  it('session latch 随浏览器重启清空 + local control 未持久化 → 重启后必须 fail-closed（不得恢复运行）', async () => {
    let failPausedControl = true;
    const base = cloneBackend();
    // bb.queueControl（paused=true）写失败 → 持久状态保持 paused:false
    const backend = failingBackend(
      base,
      (items) =>
        failPausedControl &&
        items['bb.queueControl'] !== undefined &&
        (items['bb.queueControl'] as { paused: boolean }).paused === true,
    );
    // 修复后生产形态：composite latch = session（浏览器完全重启清空）+ local 持久（不清空）
    const session = restartableLatch(false);
    const persistent = memoryLatch(false);
    const latch = compositeSafetyLatch(session, persistent);
    const env = await makeRealEnv015({}, undefined, { backend, latch });
    // start 已完成；开启 fail（pause 持久化失败）
    failPausedControl = true;

    // ---- 1. 风控 → pause 写失败（reject）；双通道 latch 均已 set ----
    await expect(env.queue.pause('检测到验证码/风控', 'risk_control', true)).rejects.toThrow();
    expect(await session.isSet()).toBe(true);
    expect(await persistent.isSet()).toBe(true);
    // 存储仍 paused:false（local control 写失败）
    const raw = await base.get(['bb.queueControl']);
    expect((raw['bb.queueControl'] as { paused: boolean }).paused).toBe(false);

    // ---- 2. 模拟浏览器完全重启（retry 成功前崩溃）：session 清空；local 持久 latch 保留 ----
    session.browserRestart();
    // retry timer 尚未成功（保持 failPausedControl=true，retry 也失败 → local 永不变为 paused:true）
    await new Promise((r) => setTimeout(r, 50));

    // ---- 3. 新 SW/浏览器启动：同一 local（backend）+ 同一 composite latch（持久通道仍在） ----
    const repo2 = new StorageRepository(backend);
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

    // ---- 4. 浏览器完全重启后无法证明上次暂停已安全清除 → 必须 fail-closed ----
    // 修复后：local 持久 latch 仍在 → isSet()=true → fail-closed（paused=true）
    expect(queue2.getStatus().paused).toBe(true);
    expect(queue2.getStatus().pauseKind).toBe('risk_control');
    // 不派发
    await queue2.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(executed).toBe(0);

    // ---- 5. 只有用户显式修复/恢复后才允许继续 ----
    failPausedControl = false;
    await queue2.resume('user');
    expect(queue2.getStatus().paused).toBe(false);
  });
});

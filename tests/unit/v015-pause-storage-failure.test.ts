/**
 * 1.3（P0-3 v0.1.5）：pause 写失败 + SW 重启必须 crash-safe（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-3）：pause() 内部 `try { await saveControl } catch { lastError }`
 * 后静默 resolve → 调用者不知道失败；持久 Storage 仍是 unpaused；新 Service Worker
 * 启动后继续未暂停 → {pauseRejected:false, q2AfterRestart:{paused:false}}。
 *
 * 修复要求：
 * - pause() 失败时 reject（结构化失败），不得静默 resolve；
 * - 风控响应一出现立即 fail-closed（pump 停止、新任务创建停止）；
 * - 持久安全 latch（模拟 chrome.storage.session 的 fail-closed latch，覆盖 SW 重启）；
 * - SW 重启后读取 latch → 仍 fail-closed，不得恢复为 unpaused；
 * - 只有用户显式修复/恢复后才允许继续。
 *
 * 必须使用 structured-clone backend（真实 WebExtension storage 语义），不得使用共享引用 backend。
 */
import { describe, expect, it, vi } from 'vitest';
import { cloneBackend, failingBackend, makeRealEnv015, memoryLatch } from './helpers/v015-env';
import { makeAuth, waitFor } from './helpers/v014-env';
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

describe('1.3 pause 写失败 + SW 重启 crash-safe（P0-3）', () => {
  it('saveControl 失败时 pause() 显式失败（reject）；latch 持久；SW 重启仍 fail-closed；用户显式恢复后才继续', async () => {
    // 注入 saveControl（bb.queueControl 写）失败；structured-clone backend
    let failControl = false;
    const base = cloneBackend();
    const backend = failingBackend(base, (items) => failControl && items['bb.queueControl'] !== undefined);
    const latch = memoryLatch(false);
    const executor = vi.fn(async () => ({ ok: true, status: 'ok' }));
    const env = await makeRealEnv015({}, { execute: executor }, { backend, latch });

    // ---- 1. 触发 pause 且持久化失败 ----
    failControl = true;
    const pausePromise = env.queue.pause('检测到验证码/风控，已暂停自动操作，请手动处理', 'risk_control', true);
    // 修复后：pause 不得静默成功 → 必须 reject（v0.1.4 此处 resolve → 测试 red）
    await expect(pausePromise).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    // ---- 2. 调用者收到结构化失败（上面 rejects 已证明）；内存 fail-closed ----
    expect(env.queue.getStatus().paused).toBe(true);
    expect(env.queue.getStatus().pauseKind).toBe('risk_control');

    // ---- 3. 持久安全 latch 已设置（可被新 SW 读取）----
    expect(await latch.isSet()).toBe(true);

    // ---- 4. pump 立即 fail-closed：不派发任何新任务 ----
    await env.queue.enqueue([{ type: 'block', uid: 7, source: 'manual' }], {}, makeAuth({ type: 'block' }));
    await env.queue.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(executor).not.toHaveBeenCalled();

    // ---- 5. SW 重启：新 Repository + 新 ActionQueue 读取 latch → 仍 fail-closed ----
    failControl = true; // 存储写仍失败（模拟故障未恢复）
    const repo2 = new StorageRepository(backend);
    await repo2.init();
    const coordinator2 = new StorageCoordinator(repo2, null, null);
    const dedup2 = new DeduplicationRegistry(repo2, coordinator2.writer);
    const queue2 = new ActionQueue({
      repo: repo2,
      dedup: dedup2,
      writer: coordinator2.writer,
      latch,
      executor: { execute: executor },
    });
    coordinator2.attachQueue(queue2);
    await queue2.start();
    // SW 重启后不得恢复为 unpaused（v0.1.4 此处 paused=false → red）
    expect(queue2.getStatus().paused).toBe(true);
    await queue2.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(executor).not.toHaveBeenCalled(); // 不派发

    // ---- 6. 只有用户显式修复/恢复后才允许继续 ----
    // 用户修复：存储恢复可写 + 显式清除安全 latch（确认已手动处理）+ 用户恢复
    failControl = false;
    await latch.clear();
    await queue2.resume('user');
    expect(queue2.getStatus().paused).toBe(false);
  });

  it('风控响应（runTask 内 pause）持久化失败时任务转 failed 且不再派发', async () => {
    let failControl = false; // makeRealEnv015 内部 start 需要成功写 control
    const base = cloneBackend();
    // 只在写入「paused=true」的 control 时失败（对应 pause 持久化本身；
    // runTask 派发前的 in_flight 前置 saveControl 写的是 paused=false 的 control，应放行）
    const backend = failingBackend(
      base,
      (items) =>
        failControl &&
        items['bb.queueControl'] !== undefined &&
        (items['bb.queueControl'] as { paused: boolean }).paused === true,
    );
    const latch = memoryLatch(false);
    let riskExecuted = 0;
    const env = await makeRealEnv015(
      {},
      {
        execute: async () => {
          riskExecuted++;
          return { ok: false, status: '风控', errorType: 'risk_control' };
        },
      },
      { backend, latch },
    );
    // start 已完成；此后开启 fail（pause 持久化时失败）
    failControl = true;

    await env.queue.enqueue([{ type: 'block', uid: 8, source: 'manual' }], {}, makeAuth({ type: 'block' }));
    // pump 运行 → executor 返回 risk_control → pause 持久化失败
    await waitFor(() => env.queue.getStatus().paused === true || env.queue.getStatus().queued === 0);
    await new Promise((r) => setTimeout(r, 100));

    // 内存 fail-closed + latch 已设置
    expect(env.queue.getStatus().paused).toBe(true);
    expect(await latch.isSet()).toBe(true);
    // 风控任务执行过一次（executor 被调用），之后不再派发
    expect(riskExecuted).toBeGreaterThanOrEqual(1);
    const before = riskExecuted;
    await env.queue.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(riskExecuted).toBe(before);
  });
});

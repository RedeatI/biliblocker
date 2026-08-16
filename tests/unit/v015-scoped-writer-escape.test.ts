/**
 * 复验 P0-1（阶段 E 第二轮）：ScopedWriter 不得逃逸出 lease 生命周期（先红后绿）。
 *
 * 反例路径（复验报告）：
 * StorageCoordinator.execute() 在 withGlobalWrite() 中建立 scoped writer，
 * setQueuePaused 把它传入 ActionQueue.pause()；pause 写失败后执行
 * `schedulePauseRetry(w)`，把 scoped writer 捕获进 setTimeout。
 * 定时器稍后调用 w.saveControl() —— 直接进 repo.saveQueueControl()，
 * **不重新获取 globalWriteMutex** → 与另一条 coordinator.execute() 的
 * backend.set 重叠 → maxActive=2。
 *
 * 断言（修复后）：
 * - retry timer 触发的写必须经公共 writer（execute 排队重新抢锁），
 *   与正在进行的 backend.set 永不重叠（maxActive 恒为 1）；
 * - retry 最终成功持久化 paused=true；
 * - pauseRetryTimer 成功后复位：后续新的 pause 失败仍能再次安排 retry；
 * - 相同原因 pause 在持久化未完成时不得早退 return（不能假装已持久化）。
 */
import { describe, expect, it, vi } from 'vitest';
import { deferred, waitFor } from './helpers/v014-env';
import { cloneBackend, makeRealEnv015, memoryLatch, waitForAsync } from './helpers/v015-env';

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

describe('复验 P0-1：ScopedWriter 不得逃逸出 lease 生命周期（retry timer）', () => {
  it('pause 写失败后 retry timer 经公共 execute 重新抢锁（与另一条 execute 的 backend.set 不重叠，maxActive=1）', async () => {
    const gate1 = deferred(); // addBlocked 写挂起（第一条 execute 占锁）
    const gate2 = deferred(); // addVerified 写挂起（第二条 execute 占锁）
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    let failPausedControl = true; // paused=true 的 queueControl 写失败（pause 持久化失败）
    const base = cloneBackend();
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        const label = Object.keys(items).join(',');
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${label}`);
        try {
          if (Array.isArray(items['bb.blocked']) && (items['bb.blocked'] as unknown[]).length > 0) {
            await gate1.promise; // 第一条 execute 挂起
          }
          if (Array.isArray(items['bb.verified']) && (items['bb.verified'] as unknown[]).length > 0) {
            await gate2.promise; // 第二条 execute 挂起
          }
          if (
            failPausedControl &&
            items['bb.queueControl'] !== undefined &&
            (items['bb.queueControl'] as { paused: boolean }).paused === true
          ) {
            events.push('fail:queueControl');
            throw new Error('queueControl 写失败');
          }
          await base.set(items);
        } finally {
          active--;
          events.push(`end:${label}`);
        }
      },
      remove: (keys: string[]) => base.remove(keys),
      maxActive: () => maxActive,
    };
    const latch = memoryLatch(false);
    const env = await makeRealEnv015({}, undefined, { backend, latch });
    failPausedControl = true;
    events.length = 0;

    // 第一条 execute：addBlocked 在 backend.set 内挂起（占锁）
    const p1 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 1, source: 'manual' } });
    await waitFor(() => events.some((e) => e.startsWith('start:bb.blocked')));

    // 锁内 pause：setQueuePaused 排队（等 p1 释放锁）
    const p2 = env.coordinator.execute({
      kind: 'setQueuePaused',
      reason: '检测到验证码/风控',
      pauseKind: 'risk_control',
      requiresExplicitResume: true,
    });
    await new Promise((r) => setTimeout(r, 30));
    gate1.resolve();
    await p1;
    // p2 进入锁：pause → saveControl 失败 → schedulePauseRetry → reject
    await expect(p2).rejects.toThrow();
    // 恢复存储可写：retry 应能成功持久化（但必须经公共 writer 排队，不与 p3 挂起写重叠）
    failPausedControl = false;
    expect(await latch.isSet()).toBe(true);

    // 第二条 execute：addVerified 在 backend.set 内挂起（占锁，等待 retry timer 触发）
    const p3 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addVerified', uid: 2, source: 'user_action' } });
    await waitFor(() => events.some((e) => e.startsWith('start:bb.verified')));

    // retry timer（500ms）在 p3 挂起期间触发
    await new Promise((r) => setTimeout(r, 700));
    // 修复后：retry 经公共 writer（execute 排队）→ 等 p3 完成 → 不重叠 → maxActive=1
    // 未修复：scoped writer 逃逸 → 直接写 → 与 p3 重叠 → maxActive=2
    expect(backend.maxActive()).toBe(1);

    gate2.resolve();
    await p3;
    // retry 最终成功持久化 paused=true（重试写经锁内队列执行）
    await waitForAsync(async () => {
      const raw = await base.get(['bb.queueControl']);
      return (raw['bb.queueControl'] as { paused: boolean }).paused === true;
    });
  });

  it('pauseRetryTimer 成功后复位：后续新的 pause 失败仍能再次安排 retry', async () => {
    let failPausedControl = true; // 每轮 pause 持久化失败一次，之后成功
    const base = cloneBackend();
    let pausedWrites = 0;
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        if (
          items['bb.queueControl'] !== undefined &&
          (items['bb.queueControl'] as { paused: boolean }).paused === true
        ) {
          pausedWrites++;
          if (failPausedControl && pausedWrites % 2 === 1) throw new Error('queueControl 写失败');
        }
        await base.set(items);
      },
      remove: (keys: string[]) => base.remove(keys),
    };
    const latch = memoryLatch(false);
    const env = await makeRealEnv015({}, undefined, { backend, latch });
    failPausedControl = true;

    // 第一次 pause：写失败 → reject；retry 成功后持久化
    await expect(env.queue.pause('风控-1', 'risk_control', true)).rejects.toThrow();
    await waitForAsync(async () => {
      const raw = await base.get(['bb.queueControl']);
      return (raw['bb.queueControl'] as { paused: boolean }).paused === true;
    });
    // 显式恢复（清 latch + resume）
    await latch.clear();
    await env.queue.resume('user');

    // 第二次 pause：写失败 → reject；retry 仍能再次安排（timer 已复位）
    failPausedControl = true;
    pausedWrites = 0;
    await expect(env.queue.pause('风控-2', 'risk_control', true)).rejects.toThrow();
    await waitForAsync(async () => {
      const raw = await base.get(['bb.queueControl']);
      return (raw['bb.queueControl'] as { paused: boolean }).paused === true;
    });
  });

  it('相同原因 pause 在持久化未完成时不得早退（不能假装已持久化）', async () => {
    let failPausedControl = true;
    const base = cloneBackend();
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        if (
          failPausedControl &&
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
    failPausedControl = true;

    // 第一次 pause：写失败 → reject（内存已 fail-closed）
    await expect(env.queue.pause('检测到验证码/风控', 'risk_control', true)).rejects.toThrow();

    // 相同原因再次 pause：持久化仍未完成（retry 尚未成功，存储仍 paused:false）→ 不得早退 return
    // （v0.1.4 的早退 `if (paused && reason===reason && kind===kind) return` 会静默成功 → red）
    const before = (await base.get(['bb.queueControl']))['bb.queueControl'] as { paused: boolean };
    expect(before.paused).toBe(false);
    const second = env.queue.pause('检测到验证码/风控', 'risk_control', true);
    // 早退实现会 resolve（假装成功）→ 测试断言 rejects → red
    await expect(second).rejects.toThrow();
  });
});

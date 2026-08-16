/**
 * 1.1（P0-1 v0.1.4）：coordinator 外部并发写串行（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-1）：共享 inLock 布尔使第二条外部命令在第一条 await 期间
 * 绕过全局锁 → {overlap:true, globalWriteEntries:1}。
 * 修复要求：
 * - 所有公共 execute 无条件进入全局锁（KeyMutex 串行）；
 * - 不使用共享 inLock 布尔；内部嵌套通过显式 WriteLease；
 * - 两条命令在 backend await 期间进入 → 最大活跃写入数恒为 1；
 * - 双 Tab、popup 与 options 并发同样串行；
 * - 固定锁顺序 + 死锁测试（并发 mutation/commitAction/reset 不死锁）。
 */
import { describe, expect, it, vi } from 'vitest';
import { StorageCoordinator } from '@/storage/coordinator';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { deferred, makeRealEnv, trackConcurrency, commitRequest } from './helpers/v014-env';

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

/** 延迟 backend：bb.blocked 的 set 在 gate 释放前挂起 */
function delayedBlockedBackend(inner: ReturnType<typeof inMemoryBackend>, gate: { promise: Promise<unknown> }, events: string[]) {
  return {
    get: (keys: string[]) => inner.get(keys),
    set: async (items: Record<string, unknown>) => {
      const blocked = items['bb.blocked'];
      const isRealAdd = Array.isArray(blocked) && blocked.length > 0;
      if (isRealAdd) {
        events.push(`start:${(blocked as { uid: number }[])[(blocked as { uid: number }[]).length - 1]?.uid}`);
        await gate.promise;
        try {
          await inner.set(items);
        } finally {
          events.push('end');
        }
      } else {
        await inner.set(items);
      }
    },
    remove: (keys: string[]) => inner.remove(keys),
  };
}

describe('1.1 coordinator 外部并发写串行（P0-1）', () => {
  it('两条外部并发命令：最大活跃写入数=1，两条公共 execute 均进入全局锁', async () => {
    const gate = deferred();
    const tracked = trackConcurrency(inMemoryBackend());
    const backend = delayedBlockedBackend(tracked as never, gate, []);
    const repo = new StorageRepository(backend);
    await repo.init();
    const coordinator = new StorageCoordinator(repo, null, null);
    const spy = vi.spyOn(repo, 'withGlobalWrite');

    const p1 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 1, source: 'manual' } });
    await Promise.resolve();
    await Promise.resolve();
    const p2 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 2, source: 'manual' } });
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    await Promise.all([p1, p2]);

    expect(tracked.maxActive()).toBe(1); // 最大活跃写入数恒为 1
    expect(spy).toHaveBeenCalledTimes(2); // 两条公共 execute 均进入全局锁（无绕过）
    const list = await repo.getBlocked();
    expect(list.map((b) => b.uid).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('事件顺序证明第二条未利用第一条的可重入状态绕锁（start:1 → end → start:2 → end）', async () => {
    const gate = deferred();
    const events: string[] = [];
    const base = inMemoryBackend();
    const backend = delayedBlockedBackend(base, gate, events);
    const repo = new StorageRepository(backend);
    await repo.init();
    const coordinator = new StorageCoordinator(repo, null, null);

    const p1 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 11, source: 'manual' } });
    await Promise.resolve();
    await Promise.resolve();
    const p2 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 12, source: 'manual' } });
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    await Promise.all([p1, p2]);

    expect(events).toEqual(['start:11', 'end', 'start:12', 'end']);
  });

  it('双 Tab / popup / options 并发（三条不同来源命令）同样串行', async () => {
    const gate = deferred();
    const events: string[] = [];
    const base = inMemoryBackend();
    const backend = delayedBlockedBackend(base, gate, events);
    const repo = new StorageRepository(backend);
    await repo.init();
    const coordinator = new StorageCoordinator(repo, null, null);

    const p1 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 21, source: 'manual' } });
    await Promise.resolve();
    const p2 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addVerified', uid: 22, source: 'user_action' } });
    await Promise.resolve();
    const p3 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addWhitelist', uid: 23 } });
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    await Promise.all([p1, p2, p3]);

    expect(events.filter((e) => e.startsWith('start'))).toEqual(['start:21']);
    // 三条命令全部完成（无死锁、无丢失）
    expect(await repo.getBlocked()).toHaveLength(1);
    expect(await repo.getVerified()).toHaveLength(1);
    expect(await repo.getWhitelist()).toHaveLength(1);
  });

  it('固定锁顺序 + 并发 mutation/commitAction/reset 不死锁（死锁测试）', async () => {
    const env = await makeRealEnv();
    const results = await Promise.all([
      env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 31, source: 'manual' } }),
      env.coordinator.execute({ kind: 'commitAction', request: commitRequest({ uid: 32, contentId: 'rpid-32' }) }),
      env.coordinator.execute({ kind: 'mutation', mutation: { op: 'updateSettings', patch: { enabled: false } } }),
      env.coordinator.execute({ kind: 'mutation', mutation: { op: 'resetDefaults' } }),
    ]);
    expect(results.every((r) => r.ok === true)).toBe(true);
    // resetDefaults 后 epoch 单调（>=1）且 paused
    const control = env.queue.controlSnapshot();
    expect(control.authorizationEpoch).toBeGreaterThanOrEqual(1);
    expect(control.paused).toBe(true);
  });
});

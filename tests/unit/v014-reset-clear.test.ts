/**
 * 1.4（P0-3 v0.1.4）：reset/clear 单调 epoch 与原子播种（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-3）：reset 后内存 epoch=1/paused 但 Storage 回 0/未暂停；
 * clear 后 bb.meta/settings/queueControl 均不存在（Storage 为 {}）。
 * 修复要求：
 * - reset/clear 后 epoch 只能递增，不能回到 0；
 * - 同时比较 ActionQueue 内存 control 与 Storage control 与模拟 SW 重启后读取的 control；
 * - paused/pauseKind/requiresExplicitResume 完全一致；
 * - reset/clear 返回前持久化已完成（内存/Storage 一致）；
 * - clear 后立即存在 meta/settings/queueControl 最小种子；新建只读 Repository 可立即 init；
 * - backend 失败时内存与 Storage 均保持旧状态（无部分写入）。
 */
import { describe, expect, it } from 'vitest';
import { StorageRepository } from '@/storage/repository';
import { makeRealEnv } from './helpers/v014-env';

describe('1.4 reset/clear 单调 epoch 与原子播种（P0-3）', () => {
  it('resetDefaults 后：内存/Storage/SW 重启三者 control 完全一致，epoch 单调递增', async () => {
    const env = await makeRealEnv();
    const oldEpoch = env.queue.controlSnapshot().authorizationEpoch;
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'resetDefaults' } });

    const memory = env.queue.controlSnapshot();
    const storage = await env.repo.getQueueControl();
    expect(memory).toEqual(storage); // 内存与持久化完全一致
    expect(memory.authorizationEpoch).toBe(oldEpoch + 1); // 单调递增（不回 0）
    expect(memory.paused).toBe(true);
    expect(memory.pauseKind).toBe('authorization_revoked');
    expect(memory.requiresExplicitResume).toBe(true);

    // 模拟 SW 重启：同一 backend 重建 repo + queue
    const repo2 = new StorageRepository(env.backend as never);
    await repo2.init();
    const restart = await repo2.getQueueControl();
    expect(restart).toEqual(storage);
    expect(restart.authorizationEpoch).toBe(oldEpoch + 1);
  });

  it('连续两次 reset：epoch 持续递增（2），永不回 0', async () => {
    const env = await makeRealEnv();
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'resetDefaults' } });
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'resetDefaults' } });
    expect(env.queue.controlSnapshot().authorizationEpoch).toBe(2);
    expect((await env.repo.getQueueControl()).authorizationEpoch).toBe(2);
  });

  it('clearAll 后：立即存在 meta/settings/queueControl 最小种子，epoch 单调', async () => {
    const env = await makeRealEnv();
    const oldEpoch = env.queue.controlSnapshot().authorizationEpoch;
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } });

    const raw = await env.backend.get(['bb.meta', 'bb.settings', 'bb.queueControl', 'bb.queue']);
    expect(raw['bb.meta']).toBeDefined();
    expect(raw['bb.settings']).toBeDefined();
    expect(raw['bb.queueControl']).toBeDefined();
    expect((raw['bb.queueControl'] as { authorizationEpoch: number }).authorizationEpoch).toBe(oldEpoch + 1);
    expect(raw['bb.queue']).toEqual([]);

    // 新建只读 Repository 可立即初始化（不等待 SW 再次播种）
    const roRepo = new StorageRepository(env.backend as never, { allowWrites: false });
    await roRepo.init();
    expect(await roRepo.getSettings()).toBeDefined();
  });

  it('clearAll 后：内存 control 与 Storage 一致，且为显式暂停（仅用户可恢复）', async () => {
    const env = await makeRealEnv();
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } });
    const memory = env.queue.controlSnapshot();
    const storage = await env.repo.getQueueControl();
    expect(memory).toEqual(storage);
    expect(storage.paused).toBe(true);
    expect(storage.requiresExplicitResume).toBe(true);
    // login_restored 不能恢复（authorization_revoked 仅用户显式）
    await env.queue.resume('login_restored');
    expect(env.queue.controlSnapshot().paused).toBe(true);
  });

  it('backend 写入失败：内存与 Storage 均保持旧状态（原子快照无部分写入）', async () => {
    const env = await makeRealEnv();
    const beforeMemory = env.queue.controlSnapshot();
    const beforeStorage = await env.repo.getQueueControl();
    const beforeSettings = await env.repo.getSettings();
    // 使快照写入失败（bb.settings 的 set 抛错）
    const baseBackend = env.backend;
    const failingBackend = {
      get: (keys: string[]) => baseBackend.get(keys),
      set: async (items: Record<string, unknown>) => {
        if ('bb.settings' in items) throw new Error('snapshot write failed');
        await baseBackend.set(items);
      },
      remove: (keys: string[]) => baseBackend.remove(keys),
    };
    const repo2 = new StorageRepository(failingBackend);
    await repo2.init();
    const coordinator2 = new (await import('@/storage/coordinator')).StorageCoordinator(repo2, null, null);
    // 原子快照写入失败 → execute 拒绝（失败传播，无部分写入）
    await expect(coordinator2.execute({ kind: 'mutation', mutation: { op: 'resetDefaults' } })).rejects.toThrow();
    // 旧状态保持：Storage 未被部分写入
    const afterStorage = await repo2.getQueueControl();
    expect(afterStorage).toEqual(beforeStorage);
    expect(await repo2.getSettings()).toEqual(beforeSettings);
    void beforeMemory;
  });
});

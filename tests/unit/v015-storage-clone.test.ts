/**
 * 1.5（P1-2 v0.1.5）：Storage structured-clone 语义与只读边界（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P1-2）：inMemoryBackend 的 get/set 直接保存和返回对象引用；
 * Repository.read() 返回 cache 引用 → 修改读取对象看起来像已持久化；read-only 实例
 * 返回的数组可被 push，缓存读取看到变化但底层 Storage 没变。
 *
 * 修复要求：
 * - inMemoryBackend：initial 输入克隆、set 输入克隆、get 输出克隆；
 * - StorageRepository.read() 返回 clone/冻结对象；cache 存独立 clone；
 * - lists/settings/control/tasks/rules 不暴露可变内部引用；
 * - read-only 实例不允许通过返回引用修改逻辑视图；
 * - 写失败后 cache 和 backend 均保持旧值；新 Repository 读取与真实持久状态一致。
 */
import { describe, expect, it } from 'vitest';
import { inMemoryBackend } from '@/storage/backend';
import { StorageRepository } from '@/storage/repository';
import { cloneBackend, failingBackend } from './helpers/v015-env';
import { makeAuth, verifiedSettings } from './helpers/v014-env';
import { STORAGE_KEYS } from '@/shared/constants/defaults';

describe('1.5 Storage structured-clone 与只读边界（P1-2）', () => {
  it('inMemoryBackend：initial 输入被克隆（修改 initial 不影响 store）', async () => {
    const initial: Record<string, unknown> = {
      'bb.blocked': [{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }],
    };
    const backend = inMemoryBackend(initial);
    // 修改 initial（构造后）不得影响 store
    (initial['bb.blocked'] as { uid: number; username: string; source: string; blockedAt: number }[]).push({
      uid: 2,
      username: 'b',
      source: 'manual',
      blockedAt: 2,
    });
    const raw = await backend.get(['bb.blocked']);
    expect(raw['bb.blocked']).toEqual([{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }]);
  });

  it('inMemoryBackend：set 输入被克隆（修改传入原对象不影响 store）', async () => {
    const backend = inMemoryBackend();
    const item = { uid: 5, username: 'x', source: 'manual', blockedAt: 5 };
    await backend.set({ 'bb.blocked': [item] });
    item.uid = 999; // 修改原对象
    const raw = await backend.get(['bb.blocked']);
    expect(raw['bb.blocked']).toEqual([{ uid: 5, username: 'x', source: 'manual', blockedAt: 5 }]);
  });

  it('inMemoryBackend：get 输出被克隆（修改返回对象不影响 store）', async () => {
    const backend = inMemoryBackend({ 'bb.blocked': [{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }] });
    const raw1 = await backend.get(['bb.blocked']);
    const raw1List = raw1['bb.blocked'] as { uid: number; username: string; source: string; blockedAt: number }[];
    raw1List[0]!.uid = 777;
    raw1List.push({ uid: 8, username: 'z', source: 'manual', blockedAt: 8 });
    const raw2 = await backend.get(['bb.blocked']);
    expect(raw2['bb.blocked']).toEqual([{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }]);
  });

  it('StorageRepository 写失败：cache 与 backend 均保持旧值', async () => {
    const base = cloneBackend();
    // init 播种也会写 bb.blocked（空数组）——用开关在 init 完成后再开启失败
    let failBlocked = false;
    const backend = failingBackend(base, (items) => failBlocked && items[STORAGE_KEYS.blocked] !== undefined);
    const repo = new StorageRepository(backend);
    await repo.init();
    failBlocked = true;
    // 写入失败 → 抛错
    await expect(repo.addBlocked({ uid: 1, username: 'a', source: 'manual' })).rejects.toThrow();
    // cache 保持旧值（空）
    expect(await repo.getBlocked()).toEqual([]);
    // backend 保持旧值
    const raw = await backend.get([STORAGE_KEYS.blocked]);
    expect(raw[STORAGE_KEYS.blocked]).toEqual([]);
  });

  it('StorageRepository 写失败后：新 Repository 读取与真实持久状态一致（不读被污染引用）', async () => {
    const base = cloneBackend({ 'bb.settings': verifiedSettings() });
    let failBlocked = false;
    const backend = failingBackend(base, (items) => failBlocked && items[STORAGE_KEYS.blocked] !== undefined);
    const repo = new StorageRepository(backend);
    await repo.init();
    failBlocked = true;
    // 第一次写失败
    await expect(repo.addBlocked({ uid: 1, username: 'a', source: 'manual' })).rejects.toThrow();
    // 第二次写失败
    await expect(repo.addBlocked({ uid: 2, username: 'b', source: 'manual' })).rejects.toThrow();
    // 新 Repository（同一 backend）读取：真实持久状态为空
    const repo2 = new StorageRepository(backend);
    await repo2.init();
    expect(await repo2.getBlocked()).toEqual([]);
  });

  it('read-only 实例：返回的 lists/settings/control/rules/tasks 不能通过引用修改内部 cache', async () => {
    // 先通过可写实例建立数据
    const base = cloneBackend({
      'bb.settings': verifiedSettings(),
      'bb.blocked': [{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }],
      'bb.verified': [{ uid: 2, username: 'b', source: 'manual', addedAt: 2 }],
      'bb.whitelist': [{ uid: 3, username: 'c', addedAt: 3 }],
      'bb.queue': [],
      'bb.queueControl': {
        paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null,
        requiresExplicitResume: false, authorizationEpoch: 0,
        recentAttempts: { block: [], report: [], unblock: [] },
      },
      'bb.rules': [],
    });
    const writable = new StorageRepository(base);
    await writable.init();

    // read-only 实例（allowWrites=false）——模拟 content/popup/options
    const ro = new StorageRepository(base, { allowWrites: false });
    await ro.init();

    // 修改 read-only 返回的数组/对象引用，不得改变内部 cache 逻辑视图
    // （cast 成宽松类型以模拟调用方错误修改；底层语义仍是结构化克隆）
    const blocked = (await ro.getBlocked()) as { uid: number; username: string; source: string; blockedAt: number }[];
    blocked.push({ uid: 99, username: 'evil', source: 'manual', blockedAt: 99 });
    const verified = (await ro.getVerified()) as { uid: number; username: string; source: string; addedAt: number }[];
    verified.push({ uid: 98, username: 'evil', source: 'manual', addedAt: 98 });
    const whitelist = (await ro.getWhitelist()) as { uid: number; username: string; addedAt: number }[];
    whitelist.push({ uid: 97, username: 'evil', addedAt: 97 });
    const settings = (await ro.getSettings()) as { enabled: boolean };
    settings.enabled = false;
    const rules = (await ro.getRules()) as unknown[];
    rules.push({ id: 'evil-rule' });
    const control = (await ro.getQueueControl()) as { paused: boolean };
    control.paused = true;

    // 再次读取：逻辑视图未被修改
    expect(await ro.getBlocked()).toEqual([{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }]);
    expect(await ro.getVerified()).toEqual([{ uid: 2, username: 'b', source: 'manual', addedAt: 2 }]);
    expect(await ro.getWhitelist()).toEqual([{ uid: 3, username: 'c', addedAt: 3 }]);
    expect((await ro.getSettings()).enabled).toBe(true);
    expect(await ro.getRules()).toEqual([]);
    expect((await ro.getQueueControl()).paused).toBe(false);
    // 底层 Storage 也不变
    const raw = await base.get([
      STORAGE_KEYS.blocked, STORAGE_KEYS.verified, STORAGE_KEYS.whitelist,
      STORAGE_KEYS.settings, STORAGE_KEYS.rules, STORAGE_KEYS.queueControl,
    ]);
    expect(raw[STORAGE_KEYS.blocked]).toEqual([{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }]);
    expect(raw[STORAGE_KEYS.verified]).toEqual([{ uid: 2, username: 'b', source: 'manual', addedAt: 2 }]);
    expect(raw[STORAGE_KEYS.whitelist]).toEqual([{ uid: 3, username: 'c', addedAt: 3 }]);
    expect((raw[STORAGE_KEYS.settings] as { enabled: boolean }).enabled).toBe(true);
    expect(raw[STORAGE_KEYS.rules]).toEqual([]);
    expect((raw[STORAGE_KEYS.queueControl] as { paused: boolean }).paused).toBe(false);
  });

  it('队列任务列表：pendingTasks 类读取返回克隆（修改返回值不影响内部状态）', async () => {
    const backend = cloneBackend({
      'bb.settings': verifiedSettings(),
      'bb.queue': [
        {
          id: 't1', groupId: 'g1', type: 'block', uid: 1, source: 'manual',
          createdAt: 1, attempts: 0, maxAttempts: 3, nextAttemptAt: 1,
          status: 'queued',
          authorization: makeAuth({ type: 'block' }),
        },
      ],
    });
    const repo = new StorageRepository(backend);
    await repo.init();
    const tasks = (await repo.getQueueTasks()) as { id: string; status: string }[];
    tasks[0]!.status = 'succeeded';
    (tasks as unknown[]).push({ id: 'evil', type: 'block' });
    const tasks2 = await repo.getQueueTasks();
    expect(tasks2).toHaveLength(1);
    expect(tasks2[0]).toMatchObject({ id: 't1', status: 'queued' });
  });
});

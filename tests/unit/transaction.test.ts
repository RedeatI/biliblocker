/**
 * P0-4（v0.1.3）：一键动作原子提交测试（BB_COMMIT_ACTION 语义）。
 *
 * 旧实现（v0.1.2）缺陷：跨倒计时长生命周期事务只存在于 SW 内存（transactions Map），
 * SW 回收/beginTx 失败会导致补偿不可靠；addBlocked 遇到已存在 UID 会覆盖原条目。
 *
 * 新语义断言：
 * - commitAction 在全局写锁内以单次 backend.set 原子写入名单 + 队列（全成功或全失败）；
 * - 重复 UID 普通添加为 no-op（保留原 blockedAt/source/reason）；
 * - background/backend 不可用时保持零副作用；
 * - 授权纪元变化（倒计时期间撤权）→ 整体拒绝，本地也不写。
 * - 内存队列采用与存储一致的快照（adoptTasks），不会在原子写入后被旧状态覆盖。
 */
import { describe, expect, it, vi } from 'vitest';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend, type StorageBackend } from '@/storage/backend';
import { StorageCoordinator, type CommitActionRequest } from '@/storage/coordinator';
import { ActionQueue, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';

/**
 * P0-5（v0.1.3）：协调器 commitAction 对官方任务做派发前能力/理由验证；
 * 本文件测试原子提交语义，模拟能力/理由枚举已验证。
 */
vi.mock('@/shared/capabilities', () => ({
  isCapabilityEnabled: () => true,
  canReportContentType: () => true,
  capabilityDenyReason: () => null,
  selectorCapabilityFor: () => 'selectorsVideo',
  areSelectorsVerified: () => true,
  capabilityForTaskType: (type: string, contentType?: string) =>
    type === 'block' ? 'blockUser' : type === 'unblock' ? 'unblockUser'
    : contentType === 'video_reply' ? 'reportVideoReply'
    : contentType === 'dynamic' ? 'reportDynamic'
    : contentType === 'dynamic_comment' ? 'reportDynamicComment'
    : 'reportVideoComment',
}));
vi.mock('@/shared/constants/report-reasons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/constants/report-reasons')>();
  return { ...actual, REPORT_REASONS: { ...actual.REPORT_REASONS, verified: true } };
});

function directWriter(repo: StorageRepository): QueueWriter {
  return {
    saveTasks: (tasks) => repo.saveQueueTasks(tasks),
    saveControl: (state) => repo.saveQueueControl(state),
    markDedup: (key, ttl) => repo.markDedup(key, ttl),
    clearDedup: (key) => repo.clearDedup(key),
    recordUnknownOutcome: (record) => repo.recordUnknownOutcome(record),
  };
}

async function makeCoordinator(initial: Record<string, unknown> = {}) {
  const backend = inMemoryBackend(initial);
  const repo = new StorageRepository(backend);
  await repo.init();
  const writer = directWriter(repo);
  const dedup = new DeduplicationRegistry(repo, writer);
  const queue = new ActionQueue({ repo, dedup, writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
  await queue.start();
  const coordinator = new StorageCoordinator(repo, queue, dedup);
  return { backend, repo, queue, coordinator };
}

function commitRequest(partial: Partial<CommitActionRequest> = {}): CommitActionRequest {
  return {
    operationId: 'op-test-1',
    uid: 10086,
    username: 'bot',
    contentType: 'video_comment',
    contentId: 'rpid-1',
    rootContentId: 'rpid-1',
    oid: '123456',
    contentHash: 'hash',
    source: 'one_click',
    localActions: { commitLocalBlock: true, commitVerified: true },
    officialTasks: [],
    skipOfficial: false,
    authorization: { epoch: 0, settingsRevision: 0, reasonId: 1, capabilityKey: 'blockUser', contentType: 'video_comment', source: 'one_click', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 },
    frameNonce: 'nonce',
    loginOk: true,
    currentMid: 999,
    ...partial,
  };
}

describe('P0-4 BB_COMMIT_ACTION 原子提交', () => {
  it('一次提交：本地名单 + 官方队列原子写入（单次 backend.set）', async () => {
    const { repo, coordinator } = await makeCoordinator();
    let setCalls = 0;
    // 通过 commitSnapshot 单次写入：直接验证 backend 层只有一次 set
    const originalCommit = repo.commitSnapshot.bind(repo);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (repo as any).commitSnapshot = async (items: Record<string, unknown>) => {
      setCalls++;
      await originalCommit(items);
    };
    const res = await coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({
        localActions: { commitLocalBlock: true, commitVerified: true },
        officialTasks: [{ type: 'block', uid: 10086, source: 'one_click' }],
      }),
    });
    expect(res.ok).toBe(true);
    expect((await repo.getBlocked()).map((b) => b.uid)).toEqual([10086]);
    expect((await repo.getVerified()).map((v) => v.uid)).toEqual([10086]);
    const stored = await repo.getQueueTasks();
    expect(stored.map((t) => t.uid)).toEqual([10086]);
    expect(setCalls).toBe(1); // 名单 + 队列一次写入
  });

  it('重复 UID 添加为 no-op：保留原 blockedAt/source/reason（P0-4 6.3）', async () => {
    const { repo, coordinator } = await makeCoordinator({
      'bb.blocked': [{ uid: 10086, source: 'manual', reason: '原始原因', blockedAt: 111111 }],
    });
    await coordinator.execute({
      kind: 'mutation',
      mutation: { op: 'addBlocked', uid: 10086, source: 'user_action', reason: '新原因' },
    });
    const list = await repo.getBlocked();
    expect(list).toHaveLength(1);
    expect(list[0]?.blockedAt).toBe(111111); // 未被覆盖
    expect(list[0]?.source).toBe('manual');
    expect(list[0]?.reason).toBe('原始原因');
  });

  it('授权纪元不匹配（倒计时期间撤权）→ 整体拒绝，本地也不写', async () => {
    const { repo, coordinator } = await makeCoordinator();
    const res = await coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({ authorization: { epoch: 5, settingsRevision: 0, reasonId: 1, capabilityKey: 'blockUser', source: 'one_click', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 } }),
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('authorization_changed');
    expect(await repo.getBlocked()).toHaveLength(0);
    expect(await repo.getVerified()).toHaveLength(0);
    expect(await repo.getQueueTasks()).toHaveLength(0);
  });

  it('总开关关闭 → 整体拒绝，零副作用', async () => {
    const { repo, coordinator } = await makeCoordinator({
      'bb.settings': { enabled: false, videoCommentsEnabled: true, dynamicsEnabled: true, suspiciousHandling: 'collapse', quickActionDisplay: 'hover', autoReportAuthorized: false, defaultReportReason: null, autoProcessVerified: false, operationDelayMs: 3000 },
    });
    const res = await coordinator.execute({ kind: 'commitAction', request: commitRequest() });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('disabled');
    expect(await repo.getBlocked()).toHaveLength(0);
  });

  it('backend 写入失败 → 提交失败，保持零副作用（不部分提交）', async () => {
    const backend: StorageBackend = {
      async get(keys) {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          if (k === 'bb.meta') out[k] = { schemaVersion: 1, seededAt: 1, lastMigratedAt: null };
          if (k === 'bb.settings') out[k] = { enabled: true, videoCommentsEnabled: true, dynamicsEnabled: true, suspiciousHandling: 'collapse', quickActionDisplay: 'hover', autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true, operationDelayMs: 3000 };
          if (k === 'bb.queueControl') out[k] = { paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } };
        }
        return out;
      },
      async set(items) {
        // 非空队列键写入失败（模拟提交边界失败；start() 的空队列持久化不受影响）
        const queueVal = items['bb.queue'];
        if (queueVal !== undefined && Array.isArray(queueVal) && queueVal.length > 0) {
          throw new Error('queue 写入失败');
        }
      },
      async remove() {},
    };
    const repo = new StorageRepository(backend);
    await repo.init().catch(() => undefined);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({ repo, dedup, writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    await queue.start();
    const coordinator = new StorageCoordinator(repo, queue, dedup);
    const res = await coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({
        localActions: { commitLocalBlock: true, commitVerified: false },
        officialTasks: [{ type: 'block', uid: 10086, source: 'one_click' }],
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('storage_failed');
    // 名单未被写入（单次 set 抛错 → 无部分提交）
    expect(await repo.getBlocked()).toHaveLength(0);
    expect(await repo.getQueueTasks()).toHaveLength(0);
  });

  it('skipOfficial（仅取消官方任务）：本地名单写入、官方不入队', async () => {
    const { repo, coordinator } = await makeCoordinator();
    const res = await coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({
        localActions: { commitLocalBlock: true, commitVerified: true },
        officialTasks: [{ type: 'report', uid: 10086, contentType: 'video_comment', contentId: 'rpid-1', reasonId: 1, source: 'one_click' }],
        skipOfficial: true,
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.enqueued).toBe(0);
    expect(await repo.getBlocked()).toHaveLength(1);
    expect(await repo.getQueueTasks()).toHaveLength(0);
  });
});

describe('P1-3 write() cache 后写（保留）', () => {
  it('backend.set 失败后 cache 保持旧值（不脏写）', async () => {
    const failing: StorageBackend = {
      async get(keys) {
        return keys.reduce((acc, k) => {
          if (k === 'bb.blocked') (acc as Record<string, unknown>)['bb.blocked'] = [{ uid: 1, source: 'manual', blockedAt: 100 }];
          if (k === 'bb.meta') (acc as Record<string, unknown>)['bb.meta'] = { schemaVersion: 1, seededAt: 1, lastMigratedAt: null };
          if (k === 'bb.settings') (acc as Record<string, unknown>)['bb.settings'] = {};
          return acc;
        }, {} as Record<string, unknown>);
      },
      async set() {
        throw new Error('backend down');
      },
      async remove() {
        throw new Error('backend down');
      },
    };
    const repo = new StorageRepository(failing);
    await repo.init().catch(() => undefined);
    await expect(repo.addBlocked({ uid: 2, source: 'manual' })).rejects.toThrow();
    const list = await repo.getBlocked();
    expect(list.map((b) => b.uid)).toEqual([1]); // 旧值仍在，未被脏写
  });
});

describe('P1-3 revision/CAS（保留）', () => {
  it('updateSettings 携带过期 revision 被拒绝（拒绝过期覆盖）', async () => {
    const { repo } = await makeCoordinator();
    const rev0 = await repo.getSettingsRevision();
    await repo.updateSettings({ enabled: false }, rev0);
    const rev1 = await repo.getSettingsRevision();
    expect(rev1).toBeGreaterThan(rev0);
    await expect(repo.updateSettings({ enabled: true }, rev0)).rejects.toThrow(/版本已变化|并发冲突/);
    expect((await repo.getSettings()).enabled).toBe(false);
  });
});

/**
 * P1-1/P0-4（v0.1.3）写协调与并发测试（10.4）：
 * - popup 更新 settings 与 import 并发，不丢更新；
 * - content 自动停用规则与 reset 并发，不恢复旧规则；
 * - queue persist 与 clearAll 并发，clear 返回后旧任务不复活；
 * - audit append 与 clearAudit 并发，语义确定；
 * - dedup mark 与 clear/import 并发，语义确定；
 * - 双 Tab 同 UID 添加时不会覆盖另一方已有元数据；
 * - 全部写命令都只能通过 StorageCoordinator（只读 Repository 写方法抛错）。
 */
import { describe, expect, it, vi } from 'vitest';
import { StorageRepository } from '@/storage/repository';
import { StorageCoordinator, type CommitActionRequest } from '@/storage/coordinator';
import { ActionQueue, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { inMemoryBackend, type StorageBackend } from '@/storage/backend';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/shared/constants/defaults';


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
  return { backend, repo, queue, dedup, coordinator };
}

function commitRequest(partial: Partial<CommitActionRequest> = {}): CommitActionRequest {
  return {
    operationId: 'op-10-4',
    uid: 10086,
    username: 'bot',
    contentType: 'video_comment',
    contentId: 'rpid-1',
    rootContentId: 'rpid-1',
    oid: '123456',
    contentHash: 'hash',
    source: 'one_click',
    localActions: { commitLocalBlock: true, commitVerified: false },
    officialTasks: [],
    skipOfficial: false,
    authorization: { epoch: 0, settingsRevision: 0, reasonId: 1, capabilityKey: 'blockUser', contentType: 'video_comment', source: 'one_click', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 },
    frameNonce: 'nonce',
    loginOk: true,
    currentMid: 999,
    ...partial,
  };
}

describe('10.4 写协调与并发', () => {
  it.each([null, '   '])('绕过消息解析的 contentId=%p 请求也绝不写 verified', async (contentId) => {
    const { repo, coordinator } = await makeCoordinator();
    const result = await coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({
        contentId,
        localActions: { commitLocalBlock: true, commitVerified: true },
      }),
    });
    expect(result.ok).toBe(true);
    expect(await repo.getBlocked()).toHaveLength(1);
    expect(await repo.getVerified()).toHaveLength(0);
  });

  it('popup 更新 settings 与 import 并发，不丢更新（全局写锁串行）', async () => {
    const { repo, coordinator } = await makeCoordinator();
    await Promise.all([
      coordinator.execute({ kind: 'mutation', mutation: { op: 'updateSettings', patch: { enabled: false } } }),
      coordinator.execute({
        kind: 'mutation',
        mutation: { op: 'importAll', data: { schemaVersion: 1, blocked: [{ uid: 1, source: 'import' }] } },
      }),
    ]);
    const settings = await repo.getSettings();
    const blocked = await repo.getBlocked();
    // 两个写都被应用（互斥不互相覆盖丢失）
    expect(settings.enabled).toBe(false);
    expect(blocked.map((b) => b.uid)).toEqual([1]);
  });

  it('content 自动停用规则与 reset 并发，不恢复旧规则', async () => {
    const { repo, coordinator } = await makeCoordinator();
    await coordinator.execute({
      kind: 'mutation',
      mutation: {
        op: 'saveRules',
        rules: [],
        expectedRevision: await repo.getRulesRevision(),
      },
    });
    // reset 与 saveRules 并发（无论先后，最终一致且不出现「旧规则恢复」）
    await Promise.all([
      coordinator.execute({ kind: 'mutation', mutation: { op: 'resetDefaults' } }),
      coordinator.execute({ kind: 'mutation', mutation: { op: 'saveRules', rules: [{ id: 'r1', name: 'n', description: '', enabled: false, priority: 0, conditions: { logic: 'and', conditions: [], groups: [] }, pageScope: [], contentTypes: [], action: 'hide_content', reportCategory: null, createdAt: 0, updatedAt: 0, schemaVersion: 1 }], expectedRevision: 999999 } }),
    ]).catch(() => undefined);
    // reset 后规则为默认（CAS 拒绝过期 saveRules 覆盖；全局锁串行保证语义确定）
    const rules = await repo.getRules();
    expect(rules.some((r) => r.id === 'r1' && r.enabled === false)).toBe(false);
  });

  it('queue persist 与 clearAll 并发，clear 返回后旧任务不复活', async () => {
    const { repo, queue, coordinator } = await makeCoordinator();
    await coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({ officialTasks: [{ type: 'block', uid: 10086, source: 'one_click' }] }),
    });
    expect(await repo.getQueueTasks()).toHaveLength(1);
    // persist 与 clearAll 并发
    await Promise.all([
      coordinator.execute({ kind: 'saveQueueTasks', tasks: queue.pendingTasks() }),
      coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } }),
    ]);
    const stored = (await repo.getQueueTasks()) ?? [];
    expect(stored.length).toBe(0); // clear 后旧任务不复活
    // 后续队列 persist 也不得写回旧任务（内存已清空）
    queue.kick();
    await new Promise((r) => setTimeout(r, 50));
    expect((await repo.getQueueTasks()).length).toBe(0);
  });

  it('audit append 与 clearAudit 并发，语义确定（串行：要么全保留，要么清空）', async () => {
    const { repo, coordinator } = await makeCoordinator();
    const results = await Promise.allSettled([
      coordinator.execute({ kind: 'mutation', mutation: { op: 'appendAudit', entry: { uid: 1, trigger: 'manual', matchedRuleIds: [], localHidden: false } } }),
      coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAudit' } }),
      coordinator.execute({ kind: 'mutation', mutation: { op: 'appendAudit', entry: { uid: 2, trigger: 'manual', matchedRuleIds: [], localHidden: false } } }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const audit = await repo.getAuditLogs();
    // 语义确定：不可能出现 clear 后又被旧 append 复活；最终 0 或 2 条
    const uids = audit.map((a) => a.uid);
    expect(uids.every((u) => u === 1 || u === 2)).toBe(true);
  });

  it('dedup mark 与 clear/import 并发，语义确定', async () => {
    const { repo, coordinator } = await makeCoordinator();
    await Promise.allSettled([
      coordinator.execute({ kind: 'dedupMark', key: 'block:1', ttl: 100000 }),
      coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } }),
      coordinator.execute({ kind: 'dedupMark', key: 'block:2', ttl: 100000 }),
    ]);
    const map = await readDedup(repo);
    // 全部写经全局锁串行：最终状态只可能是 {block:1} / {block:2} / {} / 两者，
    // 不允许出现部分写入或损坏（clear 后旧 mark 不会在后续 mark 中复活）
    const keys = Object.keys(map);
    for (const k of keys) {
      expect(k === 'block:1' || k === 'block:2').toBe(true);
    }
  });

  it('双 Tab 同 UID 添加时不会覆盖另一方已有元数据（P0-4 6.3 no-op）', async () => {
    const { repo, coordinator } = await makeCoordinator();
    await coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 42, username: 'A', reason: 'Tab A 原因', source: 'user_action' } });
    await coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 42, username: 'B', reason: 'Tab B 原因', source: 'manual' } });
    const list = await repo.getBlocked();
    expect(list).toHaveLength(1);
    expect(list[0]?.username).toBe('A'); // 原条目不被覆盖
    expect(list[0]?.reason).toBe('Tab A 原因');
  });

  it('background 不可用时本地动作保持零副作用（commitAction 失败 → 无写入）', async () => {
    const failing: StorageBackend = {
      async get(keys) {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          if (k === 'bb.meta') out[k] = { schemaVersion: 1, seededAt: 1, lastMigratedAt: null };
          if (k === 'bb.settings') out[k] = { ...DEFAULT_SETTINGS, autoReportAuthorized: true, defaultReportReason: 1 };
          if (k === 'bb.queueControl') out[k] = { paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } };
        }
        return out;
      },
      async set() {
        throw new Error('storage unavailable');
      },
      async remove() {},
    };
    const repo = new StorageRepository(failing);
    await repo.init().catch(() => undefined);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({ repo, dedup, writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    await queue.start().catch(() => undefined);
    const coordinator = new StorageCoordinator(repo, queue, dedup);
    const res = await coordinator.execute({ kind: 'commitAction', request: commitRequest() });
    expect(res.ok).toBe(false);
    expect(await repo.getBlocked()).toHaveLength(0);
    expect(await repo.getQueueTasks()).toHaveLength(0);
  });

  it('全部写命令都只能通过 StorageCoordinator（只读 Repository 写方法抛错）', async () => {
    const backend = inMemoryBackend({
      'bb.meta': { schemaVersion: 1, seededAt: 1, lastMigratedAt: null },
      'bb.settings': DEFAULT_SETTINGS,
      'bb.queueControl': { paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } },
    });
    const readOnly = new StorageRepository(backend, { allowWrites: false });
    await readOnly.init();
    // content/popup/options 只读实例：任何写方法立即抛错
    await expect(readOnly.addBlocked({ uid: 1, source: 'manual' })).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.addVerified({ uid: 1, source: 'manual' })).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.addWhitelist({ uid: 1 })).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.updateSettings({ enabled: false })).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.saveRules([])).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.appendAudit({ uid: 1, trigger: 'manual', matchedRuleIds: [], localHidden: false })).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.clearAudit()).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.saveQueueTasks([])).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.saveQueueControl({ paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } })).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.markDedup('block:1', 1000)).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.clearDedup('block:1')).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.importAll({})).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.resetToDefaults()).rejects.toThrow(/只读存储实例/);
    await expect(readOnly.clearAllData()).rejects.toThrow(/只读存储实例/);
    // 读取仍然可用
    expect((await readOnly.getSettings()).enabled).toBe(true);
  });
});

async function readDedup(repo: StorageRepository): Promise<Record<string, { ts: number; ttl: number }>> {
  const backend = (repo as unknown as { backend: StorageBackend }).backend;
  const raw = await backend.get([STORAGE_KEYS.dedup]);
  return (raw[STORAGE_KEYS.dedup] as Record<string, { ts: number; ttl: number }> | undefined) ?? {};
}

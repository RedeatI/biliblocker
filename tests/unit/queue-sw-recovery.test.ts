/**
 * P0-5（v0.1.3）SW 恢复测试（10.3）：
 * - risk_control pause 在重建 ActionQueue 后仍保持；
 * - risk_control 未经用户显式恢复不会 pump（login_restored 不生效）；
 * - 最近一分钟 report 尝试预算在重启后保持；
 * - SW 在 UI 倒计时中重启，不产生无归属事务（无 beginTx/commitTx/rollbackTx 消息、无 shortId('tx') 降级）；
 * - SW 在本地 commit 与入队边界失败，结果为全成功或全失败（见 transaction.test.ts 原子性用例）；
 * - unknown_outcome 永不自动重发。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ActionQueue, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { DEFAULT_SETTINGS, QUEUE } from '@/shared/constants/defaults';
import type { AuthorizationSnapshot, QueueControlState } from '@/shared/types';
import type { TaskInput } from '@/shared/messages';

const ROOT = resolve(__dirname, '../..');

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

function verifiedSettings() {
  return { ...DEFAULT_SETTINGS, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true };
}

function control(patch: Partial<QueueControlState>): QueueControlState {
  return {
    paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null,
    requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] },
    ...patch,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('10.3 SW 恢复', () => {
  it('risk_control pause 在重建 ActionQueue 后仍保持（跨 SW 重启持久）', async () => {
    const backend = inMemoryBackend({ 'bb.settings': verifiedSettings() });
    // 第一个队列实例：执行返回风控 → 持久化 pause(kind=risk_control)
    {
      const repo = new StorageRepository(backend);
      const writer = directWriter(repo);
      const dedup = new DeduplicationRegistry(repo, writer);
      const q1 = new ActionQueue({
        repo, dedup, writer,
        executor: { execute: async () => ({ ok: false, status: '风控', errorType: 'risk_control' }) },
      });
  injectDefaultAuth(q1);
      await q1.start();
      await q1.enqueue([{ type: 'block', uid: 1, source: 'manual' }]);
      await waitFor(() => q1.getStatus().paused === true);
      expect(q1.getStatus().pauseKind).toBe('risk_control');
    }
    // 重建队列实例（模拟 SW 重启）：暂停必须保持
    const repo2 = new StorageRepository(backend);
    const writer2 = directWriter(repo2);
    const dedup2 = new DeduplicationRegistry(repo2, writer2);
    let executed = 0;
    const q2 = new ActionQueue({
      repo: repo2, dedup: dedup2, writer: writer2,
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
    });
  injectDefaultAuth(q2);
    await q2.start();
    expect(q2.getStatus().paused).toBe(true);
    expect(q2.getStatus().pauseKind).toBe('risk_control');
    // 持久化控制状态要求显式恢复（内部断言）
    expect((q2.controlSnapshot()).requiresExplicitResume).toBe(true);
    // 启动后不 pump（保持暂停）
    await new Promise((r) => setTimeout(r, 150));
    expect(executed).toBe(0);
  });

  it('risk_control 未经用户显式恢复不会 pump；login_restored 不生效，user 才恢复', async () => {
    const backend = inMemoryBackend({
      'bb.settings': verifiedSettings(),
      'bb.queueControl': control({ paused: true, pauseKind: 'risk_control', pauseReason: '风控', requiresExplicitResume: true }),
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    let executed = 0;
    const q = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
    });
  injectDefaultAuth(q);
    await q.start();
    // 尝试 login_restored 恢复：risk_control 必须拒绝
    await q.resume('login_restored');
    expect(q.getStatus().paused).toBe(true);
    await q.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(executed).toBe(0);
    // 用户显式恢复才生效
    await q.resume('user');
    expect(q.getStatus().paused).toBe(false);
  });

  it('最近一分钟 report 尝试预算在重启后保持（跨 SW 重启不归零）', async () => {
    const backend = inMemoryBackend({
      'bb.settings': verifiedSettings(),
      'bb.queueControl': control({
        paused: false,
        recentAttempts: { block: [], report: Array.from({ length: QUEUE.MAX_REPORT_PER_MINUTE }, (_, i) => Date.now() - i * 1000), unblock: [] },
      }),
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    let executed = 0;
    const q = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
    });
  injectDefaultAuth(q);
    await q.start();
    await q.enqueue(
      [{ type: 'report', uid: 9001, contentType: 'video_comment', contentId: 'rpid-r', reasonId: 1, source: 'manual' }],
      {},
      { epoch: 0, settingsRevision: 0, reasonId: 1, capabilityKey: 'reportVideoComment', contentType: 'video_comment', source: 'manual', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 },
    );
    // 预算已满 → 任务被推迟，executor 不被调用
    await new Promise((r) => setTimeout(r, 300));
    expect(executed).toBe(0);
    // 重启后（新实例）预算仍然保持：再次入队仍被限流
    const repo2 = new StorageRepository(backend);
    const writer2 = directWriter(repo2);
    const dedup2 = new DeduplicationRegistry(repo2, writer2);
    const q2 = new ActionQueue({
      repo: repo2, dedup: dedup2, writer: writer2,
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
    });
  injectDefaultAuth(q2);
    await q2.start();
    await q2.enqueue(
      [{ type: 'report', uid: 9002, contentType: 'video_comment', contentId: 'rpid-r2', reasonId: 1, source: 'manual' }],
      {},
      { epoch: 0, settingsRevision: 0, reasonId: 1, capabilityKey: 'reportVideoComment', contentType: 'video_comment', source: 'manual', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(executed).toBe(0); // 预算从 storage 恢复，未归零
  });

  it('SW 在 UI 倒计时中重启：不产生无归属事务（无 beginTx/rollbackTx 消息、无 shortId(tx) 降级）', async () => {
    // 生产代码中 beginTx/commitTx/rollbackTx 消息类型与事务 Map 已删除：
    // 内容脚本只发 BB_COMMIT_ACTION（单次原子提交），倒计时只是 UI。
    // 断言消息协议源码与内容脚本源码中不存在旧事务路径。
    const messagesSrc = readFileSync(resolve(ROOT, 'src/shared/messages.ts'), 'utf8');
    expect(messagesSrc).not.toContain('beginTx');
    expect(messagesSrc).not.toContain('commitTx');
    expect(messagesSrc).not.toContain('rollbackTx');
    expect(messagesSrc).toContain('BB_COMMIT_ACTION');
    const contentSrc = readFileSync(resolve(ROOT, 'src/entrypoints/content/app.ts'), 'utf8');
    expect(contentSrc).not.toContain("shortId('tx')");
    expect(contentSrc).not.toContain('beginTransaction');
    expect(contentSrc).not.toContain('rollbackTx');
    // 仓库不再暴露 beginTransaction（删除长生命周期事务）
    const repoProto = StorageRepository.prototype as unknown as Record<string, unknown>;
    expect(repoProto.beginTransaction).toBeUndefined();
    expect(repoProto.rollbackTransaction).toBeUndefined();
  });

  it('unknown_outcome 永不自动重发（SW 恢复后 kick 不触发执行）', async () => {
    const now = Date.now();
    let executed = 0;
    const backend = inMemoryBackend({
      'bb.settings': verifiedSettings(),
      'bb.queue': [
        { id: 'unk', groupId: 'g', type: 'report', uid: 42, contentType: 'video_comment', contentId: 'r', reasonId: 1, source: 'manual', createdAt: now, attempts: 1, maxAttempts: 1, nextAttemptAt: now, status: 'unknown_outcome' },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const q = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
    });
  injectDefaultAuth(q);
    await q.start();
    await q.kick();
    await new Promise((r) => setTimeout(r, 200));
    expect(executed).toBe(0); // unknown_outcome 不进入 pump
  });
});

/** P0-2（v0.1.4）：行为测试默认注入完整授权快照（派发门禁本身由专用 v014 用例覆盖） */
function injectDefaultAuth(queue: ActionQueue): void {
  const orig = queue.enqueue.bind(queue);
  queue.enqueue = ((inputs: TaskInput[], origin: { tabId?: number; frameId?: number; frameNonce?: string } = {}, auth?: AuthorizationSnapshot) =>
    orig(inputs, origin, auth ?? defaultAuthFor(inputs[0]))) as typeof queue.enqueue;
}

function defaultAuthFor(input?: TaskInput): AuthorizationSnapshot | undefined {
  if (!input) return undefined;
  return {
    epoch: 0,
    settingsRevision: 0,
    reasonId: input.type === 'report' ? (input.reasonId ?? 1) : null,
    capabilityKey: input.type === 'block' ? 'blockUser' : input.type === 'unblock' ? 'unblockUser' : 'reportVideoComment',
    contentType: input.contentType,
    source: input.source,
    autoProcessAuthorized: true,
    reportAuthorized: true,
    createdAt: 0,
  };
}


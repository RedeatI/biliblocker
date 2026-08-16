/**
 * P0-3/P0-5（v0.1.3）队列撤权与取消测试（10.2）：
 * - queued report 在撤销授权后 executor 调用次数为 0；
 * - queued report 在关闭总开关后取消；
 * - reset/clear 后 queue 内存与 storage 同时为空，之后不会回写旧任务；
 * - in-flight report 被取消后状态为 unknown_outcome；
 * - in-flight block/unblock 无幂等证明时同样为 unknown_outcome（SW 恢复路径）；
 * - 派发前 reason 失效，任务 skipped，不调用适配器；
 * - authorizationEpoch 变化后旧任务不执行；
 * - 用户白名单变化后旧任务不执行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionQueue, type QueueDeps, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { StorageRepository } from '@/storage/repository';
import { StorageCoordinator } from '@/storage/coordinator';
import { inMemoryBackend } from '@/storage/backend';
import { DEFAULT_SETTINGS } from '@/shared/constants/defaults';
import type { ActionTask, AuthorizationSnapshot, TaskResult } from '@/shared/types';
import type { TaskInput } from '@/shared/messages';

/**
 * 派发前重新验证（P0-5）要求「已验证」环境（能力/理由枚举已验证）。
 * 本文件用真实常量验证撤权/epoch/白名单语义（10.2 专用）。
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

function verifiedSettings() {
  return {
    ...DEFAULT_SETTINGS,
    autoReportAuthorized: true,
    defaultReportReason: 1,
    autoProcessVerified: true,
  };
}

function makeQueue(
  executor: { execute: (t: ActionTask) => Promise<TaskResult> },
  deps: Partial<QueueDeps> = {},
  initial: Record<string, unknown> = {},
) {
  const backend = inMemoryBackend({
    ...initial,
    ...(initial['bb.settings'] === undefined ? { 'bb.settings': verifiedSettings() } : {}),
  });
  const repo = new StorageRepository(backend);
  const writer = directWriter(repo);
  const dedup = new DeduplicationRegistry(repo, writer);
  const queue = new ActionQueue({ repo, dedup, writer, executor, ...deps });
  injectDefaultAuth(queue);
  return { backend, repo, writer, dedup, queue };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => {
  vi.useRealTimers();
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

const AUTH_EPOCH_0: AuthorizationSnapshot = {
  epoch: 0, settingsRevision: 0, reasonId: 1, capabilityKey: 'reportVideoComment', contentType: 'video_comment', source: 'one_click',
  autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0,
};

describe('10.2 队列撤权与取消', () => {
  it('queued report 在撤销授权后 executor 调用次数为 0', async () => {
    let executed = 0;
    const done: ActionTask[] = [];
    // 可控时钟 + 预设未到期（nextAttemptAt 在未来）的 queued report：确保撤销发生在派发前
    let fakeNow = Date.now();
    const backend = inMemoryBackend({
      'bb.settings': verifiedSettings(),
      'bb.queueControl': { paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } },
      'bb.queue': [
        { id: 'queued-rep', groupId: 'g1', type: 'report', uid: 10001, contentType: 'video_comment', contentId: 'rpid-1', reasonId: 1, source: 'one_click', createdAt: fakeNow, attempts: 0, maxAttempts: 1, nextAttemptAt: fakeNow + 60_000, status: 'queued', authorization: AUTH_EPOCH_0 },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
      onTaskDone: (t) => done.push(t),
      now: () => fakeNow,
    });
    await queue.start(); // 任务未到期 → pump 等待，保持 queued
    // 撤销自动举报授权（reportOnly 撤权）
    await queue.revoke('自动举报授权已撤销', { reportOnly: true });
    fakeNow += 120_000; // 即使到期，pump 也不得再派发（已取消）
    await new Promise((r) => setTimeout(r, 200));
    // queued report 被取消：executor（适配器）从未被调用
    expect(executed).toBe(0);
    // 任务记录携带具体原因落盘（「记录具体原因」）
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    const t = stored.find((x) => x.id === 'queued-rep');
    expect(t?.status).toBe('cancelled');
    expect(t?.skipReason).toContain('自动举报授权已撤销');
  });

  it('queued report 在关闭总开关后取消（且队列暂停）', async () => {
    let executed = 0;
    const { queue } = makeQueue({
      execute: async () => {
        executed++;
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    await queue.enqueue(
      [{ type: 'report', uid: 10002, contentType: 'video_comment', contentId: 'rpid-2', reasonId: 1, source: 'one_click' }],
      {},
      AUTH_EPOCH_0,
    );
    await queue.revoke('总开关已关闭', { pause: true, pauseKind: 'authorization_revoked' });
    await new Promise((r) => setTimeout(r, 200));
    expect(executed).toBe(0);
    const status = queue.getStatus();
    expect(status.paused).toBe(true);
    expect(status.pauseKind).toBe('authorization_revoked');
    expect(queue.getActiveTaskCount()).toBe(0);
  });

  it('reset/clear 后 queue 内存与 storage 同时为空，之后不会回写旧任务', async () => {
    const { backend, repo, writer, dedup, queue } = makeQueue({
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    await queue.enqueue(
      [{ type: 'block', uid: 20001, source: 'one_click' }],
      {},
      { epoch: 0, settingsRevision: 0, reasonId: null, capabilityKey: 'blockUser', source: 'one_click', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 },
    );
    await waitFor(() => queue.getStatus().inFlight === 1);
    // 执行中 clearAll：in_flight → unknown_outcome（证据保留）+ 显式暂停 + epoch 单调
    const coordinator = new StorageCoordinator(repo, queue, dedup);
    await coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } });
    await new Promise((r) => setTimeout(r, 150));
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[] | undefined;
    // P0-4：结果未知任务作为持久证据保留（普通 queued 任务已清空，不复活）
    expect(stored === undefined || stored.every((t) => t.status === 'unknown_outcome')).toBe(true);
    expect(queue.pendingTasks().every((t) => t.status === 'unknown_outcome')).toBe(true);
    // 后续 kick/触发 pump 不得复活普通任务
    queue.kick();
    await new Promise((r) => setTimeout(r, 100));
    const after = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[] | undefined;
    expect(after === undefined || after.every((t) => t.status === 'unknown_outcome')).toBe(true);
    // P0-3：clear 后显式暂停、epoch 单调递增（不回 0）
    const control = await repo.getQueueControl();
    expect(control.paused).toBe(true);
    expect(control.requiresExplicitResume).toBe(true);
    expect(control.authorizationEpoch).toBeGreaterThanOrEqual(1);
    // 未知结果持久证据存在（bb.unknownOutcomes 不随 clear 删除）
    const recs = (await backend.get(['bb.unknownOutcomes']))['bb.unknownOutcomes'] as { taskId: string }[] | undefined;
    expect(recs !== undefined && recs.length > 0).toBe(true);
    void writer;
  });

  it('in-flight report 被取消后状态为 unknown_outcome（真实结果保留）', async () => {
    const { queue, backend } = makeQueue({
      execute: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    const created = await queue.enqueue(
      [{ type: 'report', uid: 30001, contentType: 'video_comment', contentId: 'rpid-3', reasonId: 1, source: 'one_click' }],
      {},
      AUTH_EPOCH_0,
    );
    await waitFor(() => queue.getStatus().inFlight === 1);
    await queue.cancel(created.map((t) => t.id));
    await new Promise((r) => setTimeout(r, 250));
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    const t = stored.find((x) => x.id === created[0]?.id);
    expect(t?.status).toBe('unknown_outcome'); // 绝不显示为已取消
    expect(t?.result?.ok).toBe(true); // 真实结果保留
  });

  it('in-flight block 无幂等证明时（SW 恢复）→ unknown_outcome 且不重发', async () => {
    const now = Date.now();
    const executed: string[] = [];
    const backend = inMemoryBackend({
      'bb.queue': [
        { id: 'inflight-block', groupId: 'g', type: 'block', uid: 40001, source: 'manual', createdAt: now, attempts: 1, maxAttempts: 3, nextAttemptAt: now, status: 'in_flight' },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async (t) => { executed.push(t.id); return { ok: true, status: 'ok' }; } },
    });
    await queue.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(executed).toHaveLength(0); // 不自动重发
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    expect(stored.find((t) => t.id === 'inflight-block')?.status).toBe('unknown_outcome');
  });

  it('派发前 reason 失效：任务 skipped，不调用适配器', async () => {
    let executed = 0;
    const done: ActionTask[] = [];
    const { queue } = makeQueue(
      {
        execute: async () => {
          executed++;
          return { ok: true, status: 'ok' };
        },
      },
      { onTaskDone: (t) => done.push(t) },
    );
    await queue.start();
    await queue.enqueue(
      [{ type: 'report', uid: 50001, contentType: 'video_comment', contentId: 'rpid-5', reasonId: 999, source: 'one_click' }],
      {},
      { ...AUTH_EPOCH_0, reasonId: 999 },
    );
    await waitFor(() => done.length === 1);
    expect(executed).toBe(0);
    void executed;
    expect(done[0]?.status).toBe('skipped');
    expect(done[0]?.skipReason).toContain('举报理由已失效');
  });

  it('authorizationEpoch 变化后旧任务不执行（epoch 不匹配 → skipped）', async () => {
    const now = Date.now();
    let executed = 0;
    const done: ActionTask[] = [];
    const backend = inMemoryBackend({
      'bb.queueControl': { paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 7, recentAttempts: { block: [], report: [], unblock: [] } },
      'bb.queue': [
        { id: 'old-epoch', groupId: 'g', type: 'report', uid: 60001, contentType: 'video_comment', contentId: 'rpid-6', reasonId: 1, source: 'one_click', createdAt: now, attempts: 0, maxAttempts: 1, nextAttemptAt: now, status: 'queued', authorization: { ...AUTH_EPOCH_0, epoch: 3 } },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
      onTaskDone: (t) => done.push(t),
    });
    await queue.start();
    await waitFor(() => done.length === 1);
    expect(executed).toBe(0); // 旧纪元任务不执行
    expect(done[0]?.status).toBe('skipped');
    expect(done[0]?.skipReason).toContain('epoch');
  });

  it('用户白名单变化后旧任务不执行（whitelisted → skipped）', async () => {
    const now = Date.now();
    let executed = 0;
    const done: ActionTask[] = [];
    const backend = inMemoryBackend({
      'bb.whitelist': [{ uid: 70001, addedAt: now }],
      'bb.queue': [
        { id: 'wl-task', groupId: 'g', type: 'block', uid: 70001, source: 'manual', createdAt: now, attempts: 0, maxAttempts: 3, nextAttemptAt: now, status: 'queued', authorization: { epoch: 0, settingsRevision: 0, reasonId: null, capabilityKey: 'blockUser', source: 'manual' } },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
      onTaskDone: (t) => done.push(t),
    });
    await queue.start();
    await waitFor(() => done.length === 1);
    expect(executed).toBe(0);
    expect(done[0]?.status).toBe('skipped');
    expect(done[0]?.skipReason).toContain('白名单');
  });
});

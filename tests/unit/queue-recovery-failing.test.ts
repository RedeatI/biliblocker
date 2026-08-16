/**
 * P0-3 失败测试（阶段 A 复现）：不可逆举报的 SW 恢复必须 unknown_outcome。
 *
 * 旧实现缺陷（本文件证明其失败）：
 * - ActionQueue.start() 把所有 in_flight 任务重新置为 queued 并重新执行；
 *   举报任务在 SW 崩溃前可能已发送到服务端，重启后会被重复提交。
 * - onTaskDone 在每次执行结束（含网络错误重试的中间态）都会被调用。
 *
 * 新语义断言（阶段 B 实现后本文件必须全绿）：
 * - in_flight + report 恢复 → unknown_outcome，绝不自动重发，executor 不被再次调用。
 * - unknown_outcome 不进入 pump（不执行）。
 * - 网络重试 onTaskDone 只在终态调用一次。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionQueue, type QueueDeps, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { DEFAULT_SETTINGS } from '@/shared/constants/defaults';
import type { ActionTask, AuthorizationSnapshot, TaskResult } from '@/shared/types';
import type { TaskInput } from '@/shared/messages';

/**
 * P0-5（v0.1.3）：派发前重新验证要求「已验证」环境。
 * 本文件验证 unknown_outcome 恢复语义，模拟能力/理由枚举已验证。
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

function verifiedSettings() {
  return {
    ...DEFAULT_SETTINGS,
    autoReportAuthorized: true,
    defaultReportReason: 1,
    autoProcessVerified: true,
  };
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

function makeRecovered(
  stored: Record<string, unknown>,
  execute: (t: ActionTask) => Promise<TaskResult>,
  deps: Partial<QueueDeps> = {},
) {
  const backend = inMemoryBackend({
    ...stored,
    ...(stored['bb.settings'] === undefined ? { 'bb.settings': verifiedSettings() } : {}),
  });
  const repo = new StorageRepository(backend);
  const writer: QueueWriter = {
    saveTasks: (tasks) => repo.saveQueueTasks(tasks),
    saveControl: (state) => repo.saveQueueControl(state),
    markDedup: (key, ttl) => repo.markDedup(key, ttl),
    clearDedup: (key) => repo.clearDedup(key),
    recordUnknownOutcome: (record) => repo.recordUnknownOutcome(record),
  };
  const dedup = new DeduplicationRegistry(repo, writer);
  const queue = new ActionQueue({ repo, dedup, writer, executor: { execute }, ...deps });
  injectDefaultAuth(queue);
  return { backend, repo, queue };
}

describe('P0-3 unknown_outcome 恢复（阶段 A 失败测试）', () => {
  it('SW 崩溃前服务端可能已接收举报：重启后 in_flight report 不得再次调用 executor（执行次数保持 0）', async () => {
    const now = Date.now();
    const executed: string[] = [];
    const { backend, queue } = makeRecovered(
      {
        'bb.queue': [
          { id: 'r1', groupId: 'g1', type: 'report', uid: 8, source: 'manual', contentType: 'video_comment', contentId: 'rpid-x', reasonId: 1, createdAt: now, attempts: 1, maxAttempts: 1, nextAttemptAt: now, status: 'in_flight' },
        ],
      },
      async (t) => {
        executed.push(`${t.type}:${t.uid}`);
        return { ok: true, status: 'ok' };
      },
    );
    await queue.start();
    // 旧实现：in_flight → queued → 重新执行 → executed 含 report → 本断言失败
    await new Promise((r) => setTimeout(r, 300));
    expect(executed).toHaveLength(0);

    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    // 旧实现：任务被重新执行 → status 变为 succeeded → 本断言失败
    expect(stored[0]?.status).toBe('unknown_outcome');
  });

  it('unknown_outcome 不进入 pump：只执行恢复的 queued 任务，不执行 unknown_outcome 任务', async () => {
    const now = Date.now();
    const executed: string[] = [];
    const { queue } = makeRecovered(
      {
        'bb.queue': [
          // in_flight report → 新实现转 unknown_outcome，不得执行
          { id: 'r2', groupId: 'g2', type: 'report', uid: 9, source: 'manual', contentType: 'video_comment', contentId: 'rpid-y', reasonId: 1, createdAt: now, attempts: 1, maxAttempts: 1, nextAttemptAt: now, status: 'in_flight' },
          // 正常 queued block → 应执行
          { id: 'b1', groupId: 'g3', type: 'block', uid: 7, source: 'manual', createdAt: now, attempts: 0, maxAttempts: 3, nextAttemptAt: now, status: 'queued', authorization: { epoch: 0, settingsRevision: 0, reasonId: null, capabilityKey: 'blockUser', source: 'manual', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 } },
        ],
      },
      async (t) => {
        executed.push(`${t.type}:${t.uid}`);
        return { ok: true, status: 'ok' };
      },
    );
    await queue.start();
    await waitFor(() => executed.includes('block:7'));
    await new Promise((r) => setTimeout(r, 200));
    // 旧实现：in_flight report 也被重新执行 → executed 含 report:9 → 本断言失败
    expect(executed).toEqual(['block:7']);
  });

  it('网络重试 onTaskDone 仅在终态调用一次（不写 retry 中间态审计）', async () => {
    let attempts = 0;
    const done: ActionTask[] = [];
    const { queue } = makeRecovered(
      {},
      async () => {
        attempts++;
        if (attempts === 1) return { ok: false, status: '网络错误', errorType: 'network' };
        return { ok: true, status: 'ok' };
      },
      { onTaskDone: (t) => done.push(t) },
    );
    await queue.start();
    await queue.enqueue([{ type: 'block', uid: 9001, source: 'manual' }]);
    await waitFor(() => done.length === 1, 10_000);
    // 旧实现：每次执行结束（含网络错误重试中间态）都调用 onTaskDone → done.length=2 → 本断言失败
    expect(done).toHaveLength(1);
    expect(done[0]?.status).toBe('succeeded');
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

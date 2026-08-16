/**
 * 队列测试：串行执行、去重（不重复拉黑/举报）、网络错误重试、
 * 服务端拒绝不重试、登录失效/风控暂停、取消、SW 回收恢复、限流。
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
 * 队列行为测试（串行/重试/取消/恢复/限流）模拟能力与举报理由枚举已通过真实验证；
 * 派发前验证本身由专用测试用例（queue-revoke-cancel.test.ts）用真实常量覆盖。
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

/** 测试直写 writer（生产环境由 background 的 StorageCoordinator 注入） */
function directWriter(repo: StorageRepository): QueueWriter {
  return {
    saveTasks: (tasks) => repo.saveQueueTasks(tasks),
    saveControl: (state) => repo.saveQueueControl(state),
    markDedup: (key, ttl) => repo.markDedup(key, ttl),
    clearDedup: (key) => repo.clearDedup(key),
    recordUnknownOutcome: (record) => repo.recordUnknownOutcome(record),
  };
}

/** 已验证环境：默认开启自动举报授权与有效默认理由（report 任务派发前验证所需） */
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
  return { backend, repo, dedup, queue };
}
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

describe('串行与去重', () => {
  it('block 任务执行一次；同批/重复入队被去重', async () => {
    const calls: string[] = [];
    const { queue } = makeQueue({
      execute: async (t) => {
        calls.push(`${t.type}:${t.uid}`);
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    const input: TaskInput = { type: 'block', uid: 10086, source: 'manual' };
    const created = await queue.enqueue([input, input, input]);
    await waitFor(() => calls.length === 1);
    expect(calls).toEqual(['block:10086']);
    expect(created).toHaveLength(1);
  });

  it('同一内容同一理由不重复举报', async () => {
    const calls: string[] = [];
    const { queue } = makeQueue({
      execute: async (t) => {
        calls.push(`${t.type}:${t.uid}:${t.contentId}`);
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    const mk = (): TaskInput => ({
      type: 'report',
      uid: 10086,
      contentType: 'video_comment',
      contentId: 'rpid-1',
      reasonId: 1,
      source: 'manual',
    });
    await queue.enqueue([mk()]);
    await waitFor(() => calls.length === 1);
    await queue.enqueue([mk()]);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.length).toBe(1); // 第二次被去重跳过
  });

  it('同 UID 因重复渲染不会重复拉黑', async () => {
    const calls: number[] = [];
    const { queue } = makeQueue({
      execute: async (t) => {
        calls.push(t.uid);
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    for (let i = 0; i < 5; i++) {
      await queue.enqueue([{ type: 'block', uid: 42, source: 'manual' }]);
    }
    await waitFor(() => calls.length === 1);
    expect(calls).toEqual([42]);
  });
});

describe('失败与重试', () => {
  it('网络错误：有限重试后成功', async () => {
    let attempts = 0;
    const { queue } = makeQueue({
      execute: async () => {
        attempts++;
        if (attempts < 3) return { ok: false, status: '网络错误', errorType: 'network' };
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    await queue.enqueue([{ type: 'block', uid: 1, source: 'manual' }]);
    await waitFor(() => attempts >= 3, 15_000);
    expect(attempts).toBe(3);
  });

  it('服务端明确拒绝：不重试', async () => {
    let attempts = 0;
    const done: ActionTask[] = [];
    const { queue } = makeQueue(
      {
        execute: async () => {
          attempts++;
          return { ok: false, status: '拒绝', errorType: 'risk_control', message: '风控' };
        },
      },
      { onTaskDone: (t) => done.push(t) },
    );
    await queue.start();
    await queue.enqueue([{ type: 'block', uid: 2, source: 'manual' }]);
    await waitFor(() => done.length === 1);
    expect(attempts).toBe(1);
    expect(done[0]!.status).toBe('failed');
  });

  it('登录失效：任务失败且队列暂停', async () => {
    const done: ActionTask[] = [];
    const { queue } = makeQueue(
      {
        execute: async () => ({ ok: false, status: '未登录', errorType: 'login_invalid' }),
      },
      { onTaskDone: (t) => done.push(t) },
    );
    await queue.start();
    await queue.enqueue([{ type: 'block', uid: 3, source: 'manual' }]);
    await waitFor(() => done.length === 1);
    const status = queue.getStatus();
    expect(status.paused).toBe(true);
    expect(status.pausedReason).toContain('登录');
  });

  it('风控：任务失败且队列暂停', async () => {
    const { queue } = makeQueue({
      execute: async () => ({ ok: false, status: '风控', errorType: 'risk_control' }),
    });
    await queue.start();
    await queue.enqueue([{ type: 'block', uid: 4, source: 'manual' }]);
    await waitFor(() => queue.getStatus().paused === true);
  });

  it('举报理由失效：派发前被跳过，不调用适配器（P0-5 5.3）', async () => {
    const done: ActionTask[] = [];
    let executed = 0;
    const { queue } = makeQueue(
      {
        execute: async () => {
          executed++;
          return { ok: false, status: '理由失效', errorType: 'invalid_reason' };
        },
      },
      { onTaskDone: (t) => done.push(t) },
    );
    await queue.start();
    await queue.enqueue([
      { type: 'report', uid: 5, contentType: 'video_comment', contentId: 'x', reasonId: 999, source: 'manual' },
    ]);
    await waitFor(() => done.length === 1);
    // 派发前 reason 失效 → skipped，executor（适配器）不被调用
    expect(done[0]!.status).toBe('skipped');
    expect(executed).toBe(0);
  });
});

describe('取消', () => {
  it('倒计时取消：已排队任务被取消（确认未发送，executor 从未被调用）', async () => {
    // 预设一个尚未到期（nextAttemptAt 在未来）的 queued 任务，模拟倒计时窗口内取消
    const now = Date.now();
    const executed: string[] = [];
    const backend = inMemoryBackend({
      'bb.queue': [
        { id: 'q1', groupId: 'g1', type: 'block', uid: 6, source: 'manual', createdAt: now, attempts: 0, maxAttempts: 3, nextAttemptAt: now + 60_000, status: 'queued', authorization: { epoch: 0, settingsRevision: 0, reasonId: null, capabilityKey: 'blockUser', source: 'manual', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 } },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo,
      dedup,
      writer,
      executor: {
        execute: async (t) => {
          executed.push(t.id);
          return { ok: true, status: 'ok' };
        },
      },
    });
    await queue.start();
    await queue.cancel(['q1']);
    await new Promise((r) => setTimeout(r, 50));
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    const cancelled = stored.find((t) => t.id === 'q1');
    expect(cancelled?.status).toBe('cancelled');
    expect(executed).toHaveLength(0); // queued + cancel → executor 从未被调用
  });

  it('in_flight + cancel → unknown_outcome，真实结果保留（P0-3）', async () => {
    const { queue, backend } = makeQueue({
      execute: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    const created = await queue.enqueue([{ type: 'block', uid: 66, source: 'manual' }]);
    // 等待任务进入 in_flight（执行器已启动，请求可能已发送）
    await waitFor(() => queue.getStatus().inFlight === 1);
    await queue.cancel(created.map((t) => t.id));
    await new Promise((r) => setTimeout(r, 250));
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    const t = stored.find((x) => x.id === created[0]?.id);
    // in_flight + cancel → unknown_outcome（绝不显示为「已取消成功」）
    expect(t?.status).toBe('unknown_outcome');
    // 真实结果被保留（executor 的 ok:true 不丢失、不覆盖）
    expect(t?.result?.ok).toBe(true);
  });
});

describe('SW 回收恢复', () => {
  it('重启后恢复：queued 任务继续执行；in_flight 任务转 unknown_outcome 且不重新执行（P0-3）', async () => {
    // 模拟 SW 被回收时的持久化状态：storage 中残留 queued / in_flight 任务
    const backend = inMemoryBackend();
    const now = Date.now();
    await backend.set({
      'bb.queue': [
        { id: 't1', groupId: 'g1', type: 'block', uid: 7, source: 'manual', createdAt: now, attempts: 0, maxAttempts: 3, nextAttemptAt: now, status: 'queued', authorization: { epoch: 0, settingsRevision: 0, reasonId: null, capabilityKey: 'blockUser', source: 'manual', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 } },
        { id: 't2', groupId: 'g2', type: 'report', uid: 8, source: 'manual', contentType: 'video_comment', contentId: 'r1', reasonId: 1, createdAt: now, attempts: 1, maxAttempts: 1, nextAttemptAt: now, status: 'in_flight' },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const executed: string[] = [];
    const done: ActionTask[] = [];
    const recovered = new ActionQueue({
      repo,
      dedup,
      writer,
      executor: {
        execute: async (t) => {
          executed.push(`${t.type}:${t.uid}`);
          return { ok: true, status: 'ok' };
        },
      },
      onTaskDone: (t) => done.push(t),
    });
    await recovered.start();
    await waitFor(() => executed.includes('block:7'), 5000);
    // queued block 恢复执行；in_flight report 转 unknown_outcome 绝不重发（P0-3）
    expect(executed).toEqual(['block:7']);
    expect(done.some((t) => t.id === 't2' && t.status === 'unknown_outcome')).toBe(true);
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    expect(stored.find((t) => t.id === 't2')?.status).toBe('unknown_outcome');
  });
});

describe('限流', () => {
  it('每分钟拉黑上限：首批最多 15 个，时钟推进后继续', async () => {
    vi.useFakeTimers();
    const executions: number[] = [];
    const { queue } = makeQueue({
      execute: async (t) => {
        executions.push(t.uid);
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    const inputs: TaskInput[] = Array.from({ length: 20 }, (_, i) => ({
      type: 'block' as const,
      uid: 1000 + i,
      source: 'manual' as const,
    }));
    await queue.enqueue(inputs);
    await vi.advanceTimersByTimeAsync(2000);
    expect(executions.length).toBeLessThanOrEqual(15);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(executions.length).toBe(20);
    vi.useRealTimers();
  });
});

describe('P1-6 队列语义', () => {
  it('maxAttempts 为总执行次数：block 网络错误最多执行 3 次；onTaskDone 仅终态调用一次（P0-3/P1-8）', async () => {
    let attempts = 0;
    const done: ActionTask[] = [];
    const { queue } = makeQueue(
      {
        execute: async () => {
          attempts++;
          return { ok: false, status: '网络错误', errorType: 'network' };
        },
      },
      { onTaskDone: (t) => done.push(t) },
    );
    await queue.start();
    await queue.enqueue([{ type: 'block', uid: 9001, source: 'manual' }]);
    // P0-3：网络重试中间态不触发「任务完成」；仅最终 failed 调用一次
    await waitFor(() => attempts === 3, 15_000);
    expect(attempts).toBe(3); // maxAttempts = MAX_NETWORK_RETRIES + 1 = 3，无 off-by-one
    await waitFor(() => done.length === 1, 5000);
    expect(done).toHaveLength(1);
    expect(done[0]?.attempts).toBe(3);
    expect(done[0]?.status).toBe('failed');
  });

  it('report 默认不做网络自动重试（maxAttempts=1，最多执行 1 次）', async () => {
    let attempts = 0;
    const done: ActionTask[] = [];
    const { queue } = makeQueue(
      {
        execute: async () => {
          attempts++;
          return { ok: false, status: '网络错误', errorType: 'network' };
        },
      },
      { onTaskDone: (t) => done.push(t) },
    );
    await queue.start();
    await queue.enqueue([
      { type: 'report', uid: 9002, contentType: 'video_comment', contentId: 'c1', reasonId: 1, source: 'manual' },
    ]);
    await waitFor(() => done.length === 1, 10_000);
    expect(attempts).toBe(1);
  });

  it('failed/cancelled 终态任务按 TTL 清理，不永久留在活动队列', async () => {
    const backend = inMemoryBackend();
    const now = Date.now();
    await backend.set({
      'bb.queue': [
        { id: 'old_failed', groupId: 'g', type: 'block', uid: 1, source: 'manual', createdAt: now, attempts: 1, maxAttempts: 3, nextAttemptAt: now, status: 'failed', result: { ok: false, status: 'x', errorType: 'unknown', attemptedAt: now - 8 * 24 * 3600 * 1000 } },
        { id: 'old_cancelled', groupId: 'g', type: 'block', uid: 2, source: 'manual', createdAt: now, attempts: 0, maxAttempts: 3, nextAttemptAt: now, status: 'cancelled', result: { ok: false, status: 'c', errorType: 'cancelled', attemptedAt: now - 30 * 24 * 3600 * 1000 } },
        { id: 'fresh_failed', groupId: 'g', type: 'block', uid: 3, source: 'manual', createdAt: now, attempts: 1, maxAttempts: 3, nextAttemptAt: now, status: 'failed', result: { ok: false, status: 'x', errorType: 'unknown', attemptedAt: now } },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo,
      dedup,
      writer,
      executor: { execute: async () => ({ ok: true, status: 'ok' }) },
    });
    await queue.start();
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    expect(stored.some((t) => t.id === 'old_failed')).toBe(false);
    expect(stored.some((t) => t.id === 'old_cancelled')).toBe(false);
    expect(stored.some((t) => t.id === 'fresh_failed')).toBe(true); // TTL 内保留（供审计）
  });

  it('kick() 公开方法可推进到期任务（alarm 调用入口）', async () => {
    const executed: string[] = [];
    const { queue } = makeQueue({
      execute: async (t) => {
        executed.push(t.uid.toString());
        return { ok: true, status: 'ok' };
      },
    });
    await queue.start();
    await queue.enqueue([{ type: 'block', uid: 7001, source: 'manual' }]);
    await waitFor(() => executed.includes('7001'));
    // 再次 kick 不应重复执行已完成任务
    queue.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(executed.filter((x) => x === '7001')).toHaveLength(1);
  });

  it('SW 恢复：in_flight block 转 unknown_outcome 且绝不重发（P0-3，无幂等证明不自动恢复）', async () => {
    const backend = inMemoryBackend();
    const now = Date.now();
    await backend.set({
      'bb.queue': [
        { id: 't9', groupId: 'g', type: 'block', uid: 9, source: 'manual', createdAt: now, attempts: 3, maxAttempts: 3, nextAttemptAt: now, status: 'in_flight' },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const executed: string[] = [];
    const done: ActionTask[] = [];
    const queue = new ActionQueue({
      repo,
      dedup,
      writer,
      executor: {
        execute: async (t) => {
          executed.push(`${t.id}:${t.attempts}`);
          return { ok: true, status: 'ok' };
        },
      },
      onTaskDone: (t) => done.push(t),
    });
    await queue.start();
    await new Promise((r) => setTimeout(r, 300));
    // 无法证明接口幂等 → 不自动重发（P0-3）
    expect(executed).toHaveLength(0);
    expect(done.some((t) => t.id === 't9' && t.status === 'unknown_outcome')).toBe(true);
    const stored = (await backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    expect(stored.find((t) => t.id === 't9')?.status).toBe('unknown_outcome');
  });

  it('空任务队列 kick 安全（alarm 在无任务时调用不抛错）', async () => {
    const { queue } = makeQueue({ execute: async () => ({ ok: true, status: 'ok' }) });
    await queue.start();
    expect(() => queue.kick()).not.toThrow();
    expect(queue.getActiveTaskCount()).toBe(0);
  });
});

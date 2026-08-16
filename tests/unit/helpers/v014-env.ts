/**
 * v0.1.4 测试共享辅助：生产接线环境（真实 StorageCoordinator + 真实 writer 接线）、
 * 授权快照构造、延迟/失败 backend 注入、并发追踪。
 *
 * 注意：能力/理由枚举 mock 必须留在各测试文件内（vi.mock 提升）；本模块只放无副作用工具。
 */
import { ActionQueue, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { StorageCoordinator, type CommitActionRequest, type CommitActionResult } from '@/storage/coordinator';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend, type StorageBackend } from '@/storage/backend';
import { DEFAULT_SETTINGS } from '@/shared/constants/defaults';
import type { ActionTask, AuthorizationSnapshot, TaskResult, UnknownOutcomeRecord } from '@/shared/types';
import type { TaskInput } from '@/shared/messages';

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 已验证环境的设置（举报授权/默认理由/自动处理全开） */
export function verifiedSettings(): ReturnType<typeof makeSettings> {
  return makeSettings({ autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true });
}

export function makeSettings(patch: Record<string, unknown> = {}) {
  return { ...DEFAULT_SETTINGS, ...patch } as typeof DEFAULT_SETTINGS & Record<string, unknown>;
}

/** 完整授权快照（P0-2 v0.1.4：8 字段必填） */
export function makeAuth(
  input: { type: 'block' | 'unblock' | 'report'; contentType?: 'video_comment' | 'video_reply' | 'dynamic' | 'dynamic_comment'; source?: string; reasonId?: number },
  overrides: Partial<AuthorizationSnapshot> = {},
): AuthorizationSnapshot {
  const cap =
    input.type === 'block' ? 'blockUser'
    : input.type === 'unblock' ? 'unblockUser'
    : input.contentType === 'video_reply' ? 'reportVideoReply'
    : input.contentType === 'dynamic' ? 'reportDynamic'
    : input.contentType === 'dynamic_comment' ? 'reportDynamicComment'
    : 'reportVideoComment';
  return {
    epoch: 0,
    settingsRevision: 0,
    reasonId: input.type === 'report' ? (input.reasonId ?? 1) : null,
    capabilityKey: cap,
    contentType: input.contentType,
    source: (input.source ?? 'one_click') as AuthorizationSnapshot['source'],
    autoProcessAuthorized: true,
    reportAuthorized: true,
    createdAt: 0,
    ...overrides,
  };
}

/** 测试直写 writer（含 unknown 证据；生产由 coordinator.writer 提供） */
export function directWriter(repo: StorageRepository): QueueWriter {
  return {
    saveTasks: (tasks) => repo.saveQueueTasks(tasks),
    saveControl: (state) => repo.saveQueueControl(state),
    markDedup: (key, ttl) => repo.markDedup(key, ttl),
    clearDedup: (key) => repo.clearDedup(key),
    recordUnknownOutcome: (record) => repo.recordUnknownOutcome(record),
  };
}

export interface RealEnv {
  backend: StorageBackend;
  repo: StorageRepository;
  dedup: DeduplicationRegistry;
  queue: ActionQueue;
  coordinator: StorageCoordinator;
}

/**
 * 生产接线环境：真实 StorageRepository + 真实 StorageCoordinator（writer 由协调器注入）
 * + 真实 ActionQueue。核心事务测试必须走本环境（禁止只用 directWriter 绕过生产路径）。
 */
export async function makeRealEnv(
  initial: Record<string, unknown> = {},
  executor?: { execute: (t: ActionTask) => Promise<TaskResult> },
): Promise<RealEnv> {
  const seed = { ...initial };
  if (seed['bb.settings'] === undefined) {
    seed['bb.settings'] = verifiedSettings();
  }
  const backend = inMemoryBackend(seed);
  const repo = new StorageRepository(backend);
  await repo.init();
  const coordinator = new StorageCoordinator(repo, null, null);
  const dedup = new DeduplicationRegistry(repo, coordinator.writer);
  const queue = new ActionQueue({
    repo,
    dedup,
    writer: coordinator.writer,
    executor: executor ?? { execute: async () => ({ ok: true, status: 'ok' }) },
  });
  coordinator.attachQueue(queue);
  await queue.start();
  return { backend, repo, dedup, queue, coordinator };
}

/** 构造 BB_COMMIT_ACTION 请求（缺省全字段；可覆盖） */
export function commitRequest(
  partial: Partial<CommitActionRequest> = {},
): CommitActionRequest {
  return {
    operationId: 'op-v014',
    uid: 10086,
    username: 'bot',
    contentType: 'video_comment',
    contentId: 'rpid-1',
    rootContentId: 'rpid-1',
    oid: '123456',
    contentHash: 'hash-v014',
    source: 'one_click',
    localActions: { commitLocalBlock: true, commitVerified: false },
    officialTasks: [],
    skipOfficial: false,
    authorization: makeAuth({ type: 'block', contentType: 'video_comment' }),
    frameNonce: 'nonce-v014',
    loginOk: true,
    currentMid: 999,
    ...partial,
  };
}

/** 追踪 backend 并发活跃写入数（最大活跃数断言用） */
export function trackConcurrency(inner: StorageBackend): StorageBackend & { maxActive: () => number } {
  let active = 0;
  let max = 0;
  return {
    get: (keys) => inner.get(keys),
    set: async (items) => {
      active++;
      if (active > max) max = active;
      try {
        await inner.set(items);
      } finally {
        active--;
      }
    },
    remove: (keys) => inner.remove(keys),
    maxActive: () => max,
  };
}

export type { CommitActionResult, UnknownOutcomeRecord, TaskInput };

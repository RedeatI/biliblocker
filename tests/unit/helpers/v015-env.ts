/**
 * v0.1.5 测试共享辅助：结构化克隆 backend（模拟真实 WebExtension storage 语义）、
 * 可注入失败的 backend、backend 写事件追踪、SW 重启重建环境。
 *
 * 注意：
 * - cloneBackend 的 initial/set/get 全部 structuredClone（P1-2 要求），
 *   与真实 chrome.storage.local 语义一致；不依赖 inMemoryBackend 内部实现。
 * - delayedSetBackend / failingSetBackend 用于注入写延迟与写失败。
 * - 能力/理由枚举 mock 必须留在各测试文件内（vi.mock 提升）；本模块无副作用。
 */
import { ActionQueue, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { StorageCoordinator } from '@/storage/coordinator';
import { StorageRepository } from '@/storage/repository';
import type { StorageBackend } from '@/storage/backend';
import { inMemoryBackend } from '@/storage/backend';
import { verifiedSettings } from './v014-env';
import type { ActionTask, QueueControlState, TaskResult, UnknownOutcomeRecord } from '@/shared/types';

/** 结构化克隆内存后端（模拟真实 WebExtension storage：读写都克隆） */
export function cloneBackend(initial: Record<string, unknown> = {}): StorageBackend {
  const store = new Map<string, unknown>();
  for (const [k, v] of Object.entries(initial)) store.set(k, structuredClone(v));
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of keys) store.delete(k);
    },
  };
}

/** 内存 safety latch（模拟 chrome.storage.session 的 fail-closed latch；浏览器重启清空） */
export function memoryLatch(initial = false) {
  let value = initial;
  return {
    value,
    async isSet() { return value; },
    async set() { value = true; },
    async clear() { value = false; },
  };
}

export type Latch = ReturnType<typeof memoryLatch>;

/** 任意 SafetyLatch（内存实现或 composite 组合均可注入 queue） */
export type AnyLatch = ReturnType<typeof memoryLatch> | { isSet(): Promise<boolean>; set(): Promise<void>; clear(): Promise<void> };

/**
 * 可模拟「浏览器完全重启清空 session storage」的 latch（复验 P0-3）。
 * 真实 chrome.storage.session 在浏览器完全重启时被清空；local 持久通道不清空。
 */
export function restartableLatch(initial = false) {
  let value = initial;
  return {
    value,
    async isSet() { return value; },
    async set() { value = true; },
    async clear() { value = false; },
    /** 模拟浏览器完全重启：session 通道被清空（local 持久通道不受影响） */
    browserRestart() { value = false; },
  };
}

export interface TrackedBackend extends StorageBackend {
  maxActive: () => number;
  activeNow: () => number;
}

/** 追踪 backend.set 活跃数（最大活跃写入数断言用） */
export function trackActive(inner: StorageBackend): TrackedBackend {
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
    activeNow: () => active,
  };
}

/**
 * 延迟+计数 backend（P0-1 探针核心）：
 * 对 predicate(items) 为真的 set，在「已进入写（active 计数内）」状态下挂起直到 gate 释放，
 * 并记录 `start:<keys>` / `end:<keys>` 事件。
 * 这样能真实测出两个 backend.set 是否重叠（active>1 即并发写），
 * 而不是像 v014 探针那样挂起在写调用之前（测不出重叠）。
 */
export function hangingBackend(
  inner: StorageBackend,
  predicate: (items: Record<string, unknown>) => boolean,
  gate: { promise: Promise<unknown> },
  events: string[] = [],
): StorageBackend & { maxActive: () => number; activeNow: () => number } {
  let active = 0;
  let max = 0;
  return {
    get: (keys) => inner.get(keys),
    set: async (items) => {
      const label = Object.keys(items).join(',');
      active++;
      if (active > max) max = active;
      events.push(`start:${label}`);
      if (predicate(items)) await gate.promise; // 挂起在 active 计数内（真实 backend 写等待）
      try {
        await inner.set(items);
      } finally {
        active--;
        events.push(`end:${label}`);
      }
    },
    remove: (keys) => inner.remove(keys),
    maxActive: () => max,
    activeNow: () => active,
  };
}

/** 失败 backend：当 predicate(items) 为真时 set 抛错（其余透传） */
export function failingBackend(
  inner: StorageBackend,
  predicate: (items: Record<string, unknown>) => boolean,
  error = new Error('storage unavailable'),
): StorageBackend {
  return {
    get: (keys) => inner.get(keys),
    set: async (items) => {
      if (predicate(items)) throw error;
      await inner.set(items);
    },
    remove: (keys) => inner.remove(keys),
  };
}

export interface RealEnv015 {
  backend: StorageBackend;
  repo: StorageRepository;
  dedup: DeduplicationRegistry;
  queue: ActionQueue;
  coordinator: StorageCoordinator;
  latch: AnyLatch;
}

/**
 * 真实生产接线环境（v0.1.5 专用）：
 * cloneBackend（structured-clone 语义）+ StorageRepository + StorageCoordinator
 * + coordinator.writer + ActionQueue（带 memoryLatch）。
 * 核心并发/原子测试必须走本环境。
 */
export async function makeRealEnv015(
  initial: Record<string, unknown> = {},
  executor?: { execute: (t: ActionTask) => Promise<TaskResult> },
  opts: { latch?: AnyLatch; backend?: StorageBackend } = {},
): Promise<RealEnv015> {
  const seed = { ...initial };
  if (seed['bb.settings'] === undefined) seed['bb.settings'] = verifiedSettings();
  const backend = opts.backend ?? cloneBackend(seed);
  const repo = new StorageRepository(backend);
  await repo.init();
  const coordinator = new StorageCoordinator(repo, null, null);
  const dedup = new DeduplicationRegistry(repo, coordinator.writer);
  const latch = opts.latch ?? memoryLatch();
  // 注意：latch 为 v0.1.5 新增依赖；v0.1.4 的 QueueDeps 无此字段。
  // 用类型断言保持 v0.1.4 可编译（运行时多余字段被忽略，行为与 v0.1.4 一致），
  // 使红测失败在运行时断言层（真正逻辑失败）而非编译层。
  const queue = new ActionQueue({
    repo,
    dedup,
    writer: coordinator.writer,
    latch,
    executor: executor ?? { execute: async () => ({ ok: true, status: 'ok' }) },
  } as unknown as ConstructorParameters<typeof ActionQueue>[0]);
  coordinator.attachQueue(queue);
  await queue.start();
  return { backend, repo, dedup, queue, coordinator, latch };
}

/** 构造最小合法 ActionTask（v015 探针用；authorization 由调用方决定） */
export function mkTask(id: string, uid: number, patch: Partial<ActionTask> = {}): ActionTask {
  const now = Date.now();
  return {
    id,
    groupId: `g-${id}`,
    type: 'block',
    uid,
    username: `user-${uid}`,
    source: 'one_click',
    createdAt: now,
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: now,
    status: 'queued',
    ...patch,
  } as ActionTask;
}

/** 构造队列控制状态（风控暂停/普通暂停/未暂停） */
export function controlState(patch: Partial<QueueControlState> = {}): QueueControlState {
  return {
    paused: false,
    pauseReason: null,
    pauseKind: 'none',
    pausedAt: null,
    requiresExplicitResume: false,
    authorizationEpoch: 0,
    recentAttempts: { block: [], report: [], unblock: [] },
    ...patch,
  } as QueueControlState;
}

/** 直写 writer（供不需要 coordinator 的 queue 场景使用；经 repo 真实落盘） */
export function directWriter(repo: StorageRepository): QueueWriter {
  return {
    saveTasks: (tasks) => repo.saveQueueTasks(tasks),
    saveControl: (state) => repo.saveQueueControl(state),
    markDedup: (key, ttl) => repo.markDedup(key, ttl),
    clearDedup: (key) => repo.clearDedup(key),
    recordUnknownOutcome: (record: UnknownOutcomeRecord) => repo.recordUnknownOutcome(record),
    saveQueueSnapshot: (tasks, state) =>
      repo.commitSnapshot({
        'bb.queue': tasks,
        'bb.queueControl': state,
      }),
  };
}

export { inMemoryBackend };

/** async 版 waitFor（同步 waitFor 无法等待 backend.get 等异步条件） */
export async function waitForAsync(
  condition: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitForAsync 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

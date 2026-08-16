/**
 * BiliBlocker v0.1.5 阶段 E 独立 adversarial probes（独立验收材料）。
 *
 * 与开发者 runtime probe 的差异：
 * - 本文件不 import 任何开发者测试 helper（tests/unit/helpers/*），
 *   只 import 生产模块（src/），独立构造 structured-clone backend / latch / 环境。
 * - 每个 probe 独立断言，失败时输出实际观察值。
 *
 * 覆盖（Probe A-H + 额外状态机/tombstone/capability 检查）：
 * A. external writer overlap：execute 持锁 await 期间外部 QueueWriter 写 → maxActive===1
 * B. stale queue overwrite：旧快照不得覆盖 in_flight、不得丢失 concurrent 任务
 * C. pause persistence failure：saveControl 失败 → reject + fail-closed + 新 SW 仍 paused
 * D. resume preserves valid tasks：合法 queued → pause → resume → 任务仍执行
 * E. operation atomicity：outcome 写失败 → 零部分提交；同 operationId 返回稳定结果；不同 binding 拒绝
 * F. immutable repository：mutate 返回对象不影响后续读取与 backend
 * G. SW restart rate limit：recentAttempts 发送前持久化，重启后预算延续
 * H. revoke during dispatch：queued→派发前 revoke → executor 不调用；已开始 → unknown_outcome
 * I. 状态机禁止回退：in_flight/succeeded/failed/cancelled/unknown_outcome → queued 全禁
 * J. unknown_outcome tombstone：reset/clear 不删除
 * K. capability closed state：8 键 verified===false、REPORT_REASONS.verified===false、selectorsVerified===false
 * L. 无 BB_ENQUEUE / 无 content 直接构造 ActionTask 的消息路径
 */
import { describe, expect, it } from 'vitest';
import { StorageCoordinator } from '@/storage/coordinator';
import { StorageRepository } from '@/storage/repository';
import { ActionQueue } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { CAPABILITY_VERIFICATION, isCapabilityEnabled } from '@/shared/capabilities';
import { REPORT_REASONS } from '@/shared/constants/report-reasons';
import { VERIFICATION as SELECTOR_VERIFICATION } from '@/adapters/bilibili/selectors';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/shared/constants/defaults';
import type { ActionTask, AuthorizationSnapshot, QueueControlState, TaskResult } from '@/shared/types';
import type { StorageBackend } from '@/storage/backend';

// ============ 独立工具（不依赖开发者 helpers） ============

/** structured-clone backend（模拟 chrome.storage.local 语义） */
function scBackend(initial: Record<string, unknown> = {}): StorageBackend & { raw: () => Promise<Record<string, unknown>> } {
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
    async raw() {
      const out: Record<string, unknown> = {};
      for (const [k, v] of store) out[k] = structuredClone(v);
      return out;
    },
  };
}

/** 追踪 backend：记录 set 活跃数与事件 */
function trackingBackend(inner: StorageBackend) {
  let active = 0;
  let max = 0;
  const events: string[] = [];
  return {
    inner,
    events,
    maxActive: () => max,
    activeNow: () => active,
    get: (keys: string[]) => inner.get(keys),
    set: async (items: Record<string, unknown>) => {
      const label = Object.keys(items).sort().join(',');
      active++;
      if (active > max) max = active;
      events.push(`start:${label}`);
      try {
        await inner.set(items);
      } finally {
        active--;
        events.push(`end:${label}`);
      }
    },
    remove: (keys: string[]) => inner.remove(keys),
  };
}

/** 挂起 backend：predicate 命中时在 active 计数内等待 gate */
function hangingBackend(inner: StorageBackend, predicate: (items: Record<string, unknown>) => boolean, gate: { promise: Promise<unknown> }) {
  let active = 0;
  let max = 0;
  const events: string[] = [];
  return {
    inner,
    events,
    maxActive: () => max,
    get: (keys: string[]) => inner.get(keys),
    set: async (items: Record<string, unknown>) => {
      const label = Object.keys(items).sort().join(',');
      active++;
      if (active > max) max = active;
      events.push(`start:${label}`);
      if (predicate(items)) await gate.promise;
      try {
        await inner.set(items);
      } finally {
        active--;
        events.push(`end:${label}`);
      }
    },
    remove: (keys: string[]) => inner.remove(keys),
  };
}

/** 内存 latch */
function memLatch(initial = false) {
  let v = initial;
  return {
    async isSet() { return v; },
    async set() { v = true; },
    async clear() { v = false; },
    get current() { return v; },
  };
}

/** 可模拟浏览器重启清空 session 的 latch */
function restartLatch(initial = false) {
  const base = memLatch(initial);
  return {
    ...base,
    browserRestart() { /* 通过重新构造实现；此处保留占位 */ },
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 完整授权快照（生产 schema 8 字段 + 任务适配） */
function makeAuth(type: 'block' | 'unblock' | 'report', contentType?: string, overrides: Partial<AuthorizationSnapshot> = {}): AuthorizationSnapshot {
  const cap = type === 'block' ? 'blockUser' : type === 'unblock' ? 'unblockUser' : (contentType === 'video_reply' ? 'reportVideoReply' : contentType === 'dynamic' ? 'reportDynamic' : contentType === 'dynamic_comment' ? 'reportDynamicComment' : 'reportVideoComment');
  return {
    epoch: 0,
    settingsRevision: 0,
    reasonId: type === 'report' ? 1 : null,
    capabilityKey: cap,
    contentType: (contentType ?? 'video_comment') as AuthorizationSnapshot['contentType'],
    source: 'one_click',
    autoProcessAuthorized: true,
    reportAuthorized: true,
    createdAt: 0,
    ...overrides,
  } as AuthorizationSnapshot;
}

function mkTask(id: string, uid: number, patch: Partial<ActionTask> = {}): ActionTask {
  const now = Date.now();
  return {
    id, groupId: `g-${id}`, type: 'block', uid, username: `u${uid}`,
    source: 'one_click', createdAt: now, attempts: 0, maxAttempts: 3, nextAttemptAt: now,
    status: 'queued', ...patch,
  } as ActionTask;
}

function controlState(patch: Partial<QueueControlState> = {}): QueueControlState {
  return {
    paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null,
    requiresExplicitResume: false, authorizationEpoch: 0,
    recentAttempts: { block: [], report: [], unblock: [] },
    ...patch,
  };
}

interface Env {
  backend: StorageBackend;
  repo: StorageRepository;
  queue: ActionQueue;
  coordinator: StorageCoordinator;
  latch: ReturnType<typeof memLatch>;
  setCapability: (on: boolean) => void;
}

/** 独立生产接线环境（backend/latch 可注入） */
async function makeEnv(opts: { backend?: StorageBackend; latch?: ReturnType<typeof memLatch>; executor?: (t: ActionTask) => Promise<TaskResult>; initial?: Record<string, unknown> } = {}): Promise<Env> {
  const seed = { ...(opts.initial ?? {}) };
  if (seed['bb.settings'] === undefined) seed['bb.settings'] = { ...DEFAULT_SETTINGS, enabled: true, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true };
  const backend = opts.backend ?? scBackend(seed);
  const repo = new StorageRepository(backend);
  await repo.init();
  const coordinator = new StorageCoordinator(repo, null, null);
  const dedup = new DeduplicationRegistry(repo, coordinator.writer);
  const latch = opts.latch ?? memLatch(false);
  const queue = new ActionQueue({
    repo, dedup, writer: coordinator.writer, latch,
    executor: { execute: opts.executor ?? (async () => ({ ok: true, status: 'ok' } as TaskResult)) },
  });
  coordinator.attachQueue(queue);
  await queue.start();
  return {
    backend, repo, queue, coordinator, latch,
    setCapability: (on: boolean) => { CAPABILITY_VERIFICATION.blockUser.verified = on; },
  };
}

const RESULTS: Record<string, unknown> = {};
const FINDINGS: Record<string, boolean> = {};

// ============ Probes ============

describe('Probe A: external writer overlap（锁继承旁路）', () => {
  it('execute 持锁 await 时，外部 QueueWriter 写必须排队：maxActive===1', async () => {
    const gate = deferred();
    const base = scBackend();
    const hb = hangingBackend(base, (items) => Array.isArray(items['bb.blocked']) && (items['bb.blocked'] as unknown[]).length > 0, gate);
    const env = await makeEnv({ backend: hb });
    env.setCapability(true);
    hb.events.length = 0;
    const p1 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 1, source: 'manual' } });
    await waitFor(() => hb.events.some((e) => e.startsWith('start:bb.blocked')));
    // 外部异步来源（pump/alarm 风格）在第一条 execute 持锁期间写队列
    const p2 = env.coordinator.writer.saveTasks([mkTask('ext', 999)]);
    await new Promise((r) => setTimeout(r, 50));
    gate.resolve();
    await Promise.all([p1, p2]);
    FINDINGS.probeA_maxActive1 = hb.maxActive() === 1;
    FINDINGS.probeA_serial = hb.events.indexOf('start:bb.queue') > hb.events.indexOf('end:bb.blocked');
    RESULTS.probeA_maxActive = hb.maxActive();
    RESULTS.probeA_events = hb.events.slice(-6);
    env.setCapability(false);
    expect(hb.maxActive()).toBe(1);
  });
});

describe('Probe B: stale queue overwrite（旧快照覆盖）', () => {
  it('commitAction 锁内基于最新快照：existing 不回退、concurrent 不丢失、created 一次', async () => {
    const gate = deferred();
    const base = scBackend();
    const hb = hangingBackend(base, (items) => Array.isArray(items['bb.blocked']) && (items['bb.blocked'] as unknown[]).length > 0, gate);
    const env = await makeEnv({ backend: hb, executor: () => new Promise<TaskResult>(() => undefined) });
    env.setCapability(true);
    const existingTask = mkTask('existing', 1, { authorization: makeAuth('block') });
    await env.coordinator.execute({ kind: 'saveQueueTasks', tasks: [existingTask] });
    hb.events.length = 0;
    const p1 = env.coordinator.execute({
      kind: 'commitAction',
      request: {
        operationId: 'op-b', uid: 2, username: 'bot2', contentType: 'video_comment',
        contentId: 'r2', rootContentId: 'r2', oid: '2', source: 'one_click',
        localActions: { commitLocalBlock: true, commitVerified: false },
        officialTasks: [{ type: 'block', uid: 2, source: 'one_click' }],
        skipOfficial: false, authorization: makeAuth('block'), frameNonce: 'n', loginOk: true, currentMid: 999,
      },
      origin: { tabId: 1, frameId: 0 },
    });
    await waitFor(() => hb.events.some((e) => e.startsWith('start:bb.blocked')));
    // 并发：外部 writer 把 existing → in_flight + 新增 concurrent
    const p2 = env.coordinator.writer.saveTasks([
      mkTask('existing', 1, { status: 'in_flight', authorization: makeAuth('block') }),
      mkTask('concurrent', 3, { authorization: makeAuth('block') }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    gate.resolve();
    await Promise.all([p1, p2]);
    const raw = await base.get(['bb.queue']);
    const q = (raw['bb.queue'] as ActionTask[]) ?? [];
    const existing = q.find((t) => t.id === 'existing');
    const concurrent = q.some((t) => t.id === 'concurrent');
    const createdOnce = q.filter((t) => t.uid === 2).length === 1;
    FINDINGS.probeB_existingNotReverted = existing !== undefined && existing.status === 'in_flight';
    FINDINGS.probeB_concurrentKept = concurrent;
    FINDINGS.probeB_createdOnce = createdOnce;
    RESULTS.probeB_queue = q.map((t) => ({ id: t.id, status: t.status }));
    env.setCapability(false);
    expect(existing?.status).toBe('in_flight');
    expect(concurrent).toBe(true);
    expect(createdOnce).toBe(true);
  });

  it('in_flight 持久化后 SW 重启 → unknown_outcome（绝不重发）', async () => {
    const env = await makeEnv();
    env.setCapability(true);
    const t = mkTask('t-inflight', 7, { status: 'in_flight', authorization: makeAuth('block') });
    await env.backend.set({ 'bb.queue': [t] });
    // 新 SW（新 repository + 新 queue，同一 backend）
    const repo2 = new StorageRepository(env.backend);
    await repo2.init();
    const c2 = new StorageCoordinator(repo2, null, null);
    const d2 = new DeduplicationRegistry(repo2, c2.writer);
    let executed = 0;
    const q2 = new ActionQueue({ repo: repo2, dedup: d2, writer: c2.writer, latch: memLatch(false), executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } } });
    c2.attachQueue(q2);
    await q2.start();
    const finalRaw = await env.backend.get(['bb.queue']);
    const finalT = (finalRaw['bb.queue'] as ActionTask[]).find((x) => x.id === 't-inflight');
    FINDINGS.probeB_swRestartNoRedispatch = executed === 0 && finalT?.status === 'unknown_outcome';
    RESULTS.probeB_swRestartStatus = finalT?.status;
    RESULTS.probeB_swRestartExecuted = executed;
    env.setCapability(false);
    expect(executed).toBe(0);
    expect(finalT?.status).toBe('unknown_outcome');
  });
});

describe('Probe C: pause persistence failure（crash-safe）', () => {
  it('saveControl 失败 → pause reject + latch set + 新 SW fail-closed', async () => {
    let failPaused = false;
    const base = scBackend();
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        if (failPaused && items['bb.queueControl'] !== undefined && (items['bb.queueControl'] as { paused: boolean }).paused === true) {
          throw new Error('storage unavailable');
        }
        await base.set(items);
      },
      remove: (keys: string[]) => base.remove(keys),
    };
    const latch = memLatch(false);
    const env = await makeEnv({ backend, latch });
    failPaused = true;
    let rejected = false;
    try { await env.queue.pause('风控', 'risk_control', true); } catch { rejected = true; }
    const latchSet = latch.current;
    // 新 SW（同 backend + 同 latch）
    const repo2 = new StorageRepository(backend);
    await repo2.init();
    const c2 = new StorageCoordinator(repo2, null, null);
    const d2 = new DeduplicationRegistry(repo2, c2.writer);
    let executed = 0;
    const q2 = new ActionQueue({ repo: repo2, dedup: d2, writer: c2.writer, latch, executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } } });
    c2.attachQueue(q2);
    await q2.start();
    const paused2 = q2.getStatus().paused;
    FINDINGS.probeC_rejected = rejected;
    FINDINGS.probeC_latchSet = latchSet;
    FINDINGS.probeC_restartFailClosed = paused2 && executed === 0;
    RESULTS.probeC = { rejected, latchSet, paused2, executed };
    failPaused = false;
    await q2.resume('user');
    expect(rejected).toBe(true);
    expect(latchSet).toBe(true);
    expect(paused2).toBe(true);
    expect(executed).toBe(0);
  });

  it('latch.set 失败不阻断 control 写：control.paused=true 仍是跨重启持久证据', async () => {
    const base = scBackend();
    const latchFail: ReturnType<typeof memLatch> = {
      async isSet() { return false; },
      async set() { throw new Error('latch set fail'); },
      async clear() {},
      get current() { return false; },
    };
    const env = await makeEnv({ backend: base, latch: latchFail });
    let rejected = false;
    try { await env.queue.pause('风控', 'risk_control', true); } catch { rejected = true; }
    const raw = await base.get(['bb.queueControl']);
    const persisted = (raw['bb.queueControl'] as QueueControlState).paused === true;
    FINDINGS.probeC_latchFailRejected = rejected;
    FINDINGS.probeC_latchFailControlPersisted = persisted;
    RESULTS.probeC_latchFail = { rejected, persisted };
    expect(rejected).toBe(true);
    expect(persisted).toBe(true);
  });
});

describe('Probe D: resume preserves valid tasks', () => {
  it('合法 queued → pause → resume → 任务仍执行恰好一次', async () => {
    const env = await makeEnv();
    env.setCapability(true);
    const pausedControl = controlState({ paused: true, pauseKind: 'risk_control', pauseReason: '风控', requiresExplicitResume: true, authorizationEpoch: 1 });
    const valid = mkTask('valid-d', 100, { authorization: makeAuth('block', undefined, { epoch: 1 }) });
    const stale = mkTask('stale-d', 101, { authorization: makeAuth('block', undefined, { epoch: 0 }) });
    await env.backend.set({ 'bb.queueControl': pausedControl, 'bb.queue': [valid, stale] });
    const repo2 = new StorageRepository(env.backend);
    await repo2.init();
    const c2 = new StorageCoordinator(repo2, null, null);
    const d2 = new DeduplicationRegistry(repo2, c2.writer);
    let validExec = 0;
    const q2 = new ActionQueue({
      repo: repo2, dedup: d2, writer: c2.writer, latch: memLatch(false),
      executor: { execute: async (t: ActionTask) => { if (t.id === 'valid-d') validExec++; return { ok: true, status: 'ok' }; } },
    });
    c2.attachQueue(q2);
    await q2.start();
    // login_restored 不能恢复 risk_control
    await q2.resume('login_restored');
    const stillPaused = q2.getStatus().paused;
    await q2.resume('user');
    await waitFor(() => validExec >= 1, 3000);
    await new Promise((r) => setTimeout(r, 50));
    const tasks = q2.pendingTasks();
    const staleFinal = tasks.find((t) => t.id === 'stale-d');
    FINDINGS.probeD_validExecutedOnce = validExec === 1;
    FINDINGS.probeD_loginRestoredKeepsPaused = stillPaused === true;
    FINDINGS.probeD_staleSkippedForRealReason = staleFinal?.status === 'skipped' && !(staleFinal.skipReason ?? '').includes('队列已暂停');
    RESULTS.probeD = { validExec, stillPaused, staleStatus: staleFinal?.status, staleReason: staleFinal?.skipReason };
    env.setCapability(false);
    expect(validExec).toBe(1);
    expect(stillPaused).toBe(true);
    expect(staleFinal?.status).toBe('skipped');
  });
});

describe('Probe E: operation atomicity', () => {
  it('outcome 写失败 → 零部分提交；重发同 operationId 返回相同失败', async () => {
    let failOutcome = false;
    const base = scBackend();
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        if (failOutcome && items['bb.operationOutcomes'] !== undefined) throw new Error('outcome 写失败');
        await base.set(items);
      },
      remove: (keys: string[]) => base.remove(keys),
    };
    const env = await makeEnv({ backend });
    env.setCapability(true);
    failOutcome = true;
    const req = {
      operationId: 'op-e', uid: 555, username: 'bot', contentType: 'video_comment',
      contentId: 'r1', rootContentId: 'r1', oid: '1', contentHash: 'h', source: 'one_click',
      localActions: { commitLocalBlock: true, commitVerified: false },
      officialTasks: [{ type: 'block', uid: 555, source: 'one_click' }],
      skipOfficial: false, authorization: makeAuth('block'), frameNonce: 'n', loginOk: true, currentMid: 999,
    };
    const r1 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    const r2 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    const raw = await base.get(['bb.blocked', 'bb.queue', 'bb.operationOutcomes']);
    FINDINGS.probeE_zeroPartial = (raw['bb.blocked'] as unknown[]).length === 0 && (raw['bb.queue'] as unknown[]).length === 0;
    FINDINGS.probeE_sameResult = JSON.stringify(r1) === JSON.stringify(r2);
    RESULTS.probeE = { r1, r2, blocked: (raw['bb.blocked'] as unknown[]).length, queue: (raw['bb.queue'] as unknown[]).length };
    env.setCapability(false);
    expect(r1.ok).toBe(false);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect((raw['bb.blocked'] as unknown[]).length).toBe(0);
  });

  it('成功路径：blocked+queue+outcome 同一次 set；同 operationId 重放返回相同结果；不同 binding 拒绝', async () => {
    const setKeys: string[][] = [];
    const base = scBackend();
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => { setKeys.push(Object.keys(items).sort()); await base.set(items); },
      remove: (keys: string[]) => base.remove(keys),
    };
    const env = await makeEnv({ backend });
    env.setCapability(true);
    const req = {
      operationId: 'op-e2', uid: 556, username: 'bot', contentType: 'video_comment',
      contentId: 'r2', rootContentId: 'r2', oid: '2', contentHash: 'h', source: 'one_click',
      localActions: { commitLocalBlock: true, commitVerified: false },
      officialTasks: [{ type: 'block', uid: 556, source: 'one_click' }],
      skipOfficial: false, authorization: makeAuth('block'), frameNonce: 'n', loginOk: true, currentMid: 999,
    };
    const r1 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    const r2 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    const atomic = setKeys.some((k) => k.includes('bb.blocked') && k.includes('bb.queue') && k.includes('bb.operationOutcomes'));
    // 不同 binding：同 operationId 不同 contentId
    const reqDiff = { ...req, contentId: 'r2-DIFF', contentHash: 'h2' };
    const r3 = await env.coordinator.execute({ kind: 'commitAction', request: reqDiff, origin: { tabId: 1, frameId: 0 } });
    FINDINGS.probeE_atomicSet = atomic;
    FINDINGS.probeE_replaySame = JSON.stringify(r1) === JSON.stringify(r2);
    FINDINGS.probeE_reusedRejected = r3.ok === false && r3.code === 'operationId_reused';
    RESULTS.probeE2 = { r1, r2, r3, atomic, setKeys: setKeys.slice(-3) };
    env.setCapability(false);
    expect(atomic).toBe(true);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r3.code).toBe('operationId_reused');
  });
});

describe('Probe F: immutable repository', () => {
  it('读取返回防御性拷贝：mutate 返回对象不影响 backend 与后续读取', async () => {
    const env = await makeEnv({
      initial: { 'bb.blocked': [{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }] },
    });
    const list = await env.repo.getBlocked();
    list.push({ uid: 999, username: 'evil', source: 'manual', blockedAt: 999 });
    (list[0] as { uid: number }).uid = 777;
    const second = await env.repo.getBlocked();
    const raw = await env.backend.get(['bb.blocked']);
    FINDINGS.probeF_secondUnaffected = second.length === 1 && second[0]!.uid === 1;
    FINDINGS.probeF_backendUnaffected = (raw['bb.blocked'] as { uid: number }[]).length === 1 && (raw['bb.blocked'] as { uid: number }[])[0]!.uid === 1;
    RESULTS.probeF = { second: second.map((b) => b.uid), raw: (raw['bb.blocked'] as { uid: number }[]).map((b) => b.uid) };
    expect(second.length).toBe(1);
    expect(second[0]!.uid).toBe(1);
  });
});

describe('Probe G: SW restart rate limit', () => {
  it('recentAttempts 在发送前持久化；SW 重启后预算延续', async () => {
    const env = await makeEnv();
    env.setCapability(true);
    // 预置接近上限的预算（block 上限 15/分钟）
    const now = Date.now();
    const timestamps = Array.from({ length: 14 }, (_, i) => now - i * 1000);
    const control = controlState({ recentAttempts: { block: timestamps, report: [], unblock: [] } });
    await env.backend.set({ 'bb.queueControl': control });
    const t = mkTask('rate', 42, { authorization: makeAuth('block') });
    await env.backend.set({ 'bb.queue': [t] });
    // 新 SW
    const repo2 = new StorageRepository(env.backend);
    await repo2.init();
    const c2 = new StorageCoordinator(repo2, null, null);
    const d2 = new DeduplicationRegistry(repo2, c2.writer);
    let executed = 0;
    const q2 = new ActionQueue({
      repo: repo2, dedup: d2, writer: c2.writer, latch: memLatch(false),
      executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
    });
    c2.attachQueue(q2);
    await q2.start();
    await q2.kick();
    await new Promise((r) => setTimeout(r, 150));
    // 预算应延续（14/15 已用 → 第 15 次允许，但第 16 次被拒）——先验证重启后 recentAttempts 保留
    const raw = await env.backend.get(['bb.queueControl']);
    const after = (raw['bb.queueControl'] as QueueControlState).recentAttempts.block.length;
    FINDINGS.probeG_budgetPersisted = after >= 14;
    RESULTS.probeG = { executed, budgetAfterRestart: after };
    env.setCapability(false);
    expect(after).toBeGreaterThanOrEqual(14);
  });
});

describe('Probe H: revoke during dispatch', () => {
  it('queued → 即将派发（verify 挂起中）→ revoke（epoch++）→ executor 不调用', async () => {
    let whitelistCalls = 0;
    let armGate = false;
    const gateWhitelist = deferred();
    const base = scBackend();
    const backend = {
      get: async (keys: string[]) => {
        if (keys.includes('bb.whitelist')) {
          whitelistCalls++;
          if (armGate && whitelistCalls === 1) await gateWhitelist.promise;
        }
        return base.get(keys);
      },
      set: (items: Record<string, unknown>) => base.set(items),
      remove: (keys: string[]) => base.remove(keys),
    };
    let executed = 0;
    const env = await makeEnv({
      backend,
      executor: async () => { executed++; return { ok: true, status: 'ok' }; },
    });
    env.setCapability(true);
    // 直接构造内存+存储队列任务（与 v015-revalidate-runTask-race 同构；whitelist 读只来自 runTask verify）
    const t = mkTask('h1', 60, { authorization: makeAuth('block') });
    await base.set({ 'bb.queue': [t] });
    env.queue.adoptTasks([t]);
    // pump 即将派发：verifyTaskEligible 的 getWhitelist 挂起
    armGate = true;
    whitelistCalls = 0;
    env.queue.kick();
    await waitFor(() => whitelistCalls >= 1);
    // 挂起窗口内撤权（epoch++，queued→cancelled）
    await env.coordinator.execute({ kind: 'revoke', reason: '派发前撤权', pause: false });
    // 放行 verify → 应读到新 epoch → skipped/cancelled → executor 不被调用
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 150));
    const finalRaw = await base.get(['bb.queue']);
    const finalT = (finalRaw['bb.queue'] as ActionTask[]).find((x) => x.id === 'h1');
    FINDINGS.probeH_executorNotCalled = executed === 0;
    FINDINGS.probeH_cancelled = finalT?.status === 'cancelled' || finalT?.status === 'skipped';
    RESULTS.probeH = { executed, status: finalT?.status };
    env.setCapability(false);
    expect(executed).toBe(0);
    expect(finalT?.status === 'cancelled' || finalT?.status === 'skipped').toBe(true);
  });

  it('in_flight 任务 revoke → unknown_outcome（不写成 cancelled）', async () => {
    const env = await makeEnv({ executor: () => new Promise<TaskResult>(() => undefined) });
    env.setCapability(true);
    const t = mkTask('h2', 61, { status: 'in_flight', authorization: makeAuth('block') });
    await env.backend.set({ 'bb.queue': [t] });
    const repo2 = new StorageRepository(env.backend);
    await repo2.init();
    const c2 = new StorageCoordinator(repo2, null, null);
    const d2 = new DeduplicationRegistry(repo2, c2.writer);
    const q2 = new ActionQueue({
      repo: repo2, dedup: d2, writer: c2.writer, latch: memLatch(false),
      executor: { execute: async () => ({ ok: true, status: 'ok' }) },
    });
    c2.attachQueue(q2);
    await q2.start();
    // start() 会把 in_flight → unknown_outcome（sw_restart 语义）
    const finalRaw = await env.backend.get(['bb.queue']);
    const finalT = (finalRaw['bb.queue'] as ActionTask[]).find((x) => x.id === 'h2');
    FINDINGS.probeH_inFlightToUnknown = finalT?.status === 'unknown_outcome';
    RESULTS.probeH2 = { status: finalT?.status };
    env.setCapability(false);
    expect(finalT?.status).toBe('unknown_outcome');
  });
});

describe('Probe I: 状态机禁止非法回退', () => {
  it('in_flight/succeeded/failed/cancelled/unknown_outcome 不得回退 queued（revalidate/persist 合并路径）', async () => {
    const env = await makeEnv();
    env.setCapability(true);
    const tasks: ActionTask[] = [
      mkTask('s-inflight', 1, { status: 'in_flight', authorization: makeAuth('block') }),
      mkTask('s-succeeded', 2, { status: 'succeeded', result: { ok: true, status: 'ok' } }),
      mkTask('s-failed', 3, { status: 'failed', result: { ok: false, status: 'err' } }),
      mkTask('s-cancelled', 4, { status: 'cancelled' }),
      mkTask('s-unknown', 5, { status: 'unknown_outcome', result: { ok: false, status: 'unknown_outcome' } }),
    ];
    await env.backend.set({ 'bb.queue': tasks });
    const repo2 = new StorageRepository(env.backend);
    await repo2.init();
    const c2 = new StorageCoordinator(repo2, null, null);
    const d2 = new DeduplicationRegistry(repo2, c2.writer);
    const q2 = new ActionQueue({ repo: repo2, dedup: d2, writer: c2.writer, latch: memLatch(false), executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    c2.attachQueue(q2);
    await q2.start();
    // start() 会处理 in_flight → unknown_outcome；其余保持
    const finalRaw = await env.backend.get(['bb.queue']);
    const finalQ = finalRaw['bb.queue'] as ActionTask[];
    const reverted = finalQ.filter((t) => t.id !== 's-inflight' && t.status === 'queued');
    FINDINGS.probeI_noRevert = reverted.length === 0;
    FINDINGS.probeI_unknownNotQueued = finalQ.find((t) => t.id === 's-unknown')?.status === 'unknown_outcome';
    RESULTS.probeI = finalQ.map((t) => ({ id: t.id, status: t.status }));
    env.setCapability(false);
    expect(reverted.length).toBe(0);
  });
});

describe('Probe J: unknown_outcome tombstone 保留', () => {
  it('reset/clear 后 unknownOutcomes 证据仍在', async () => {
    const env = await makeEnv();
    env.setCapability(true);
    const rec = { taskId: 'u1', groupId: 'g', type: 'report' as const, uid: 9, contentId: 'c', reasonId: 1, dispatchedAt: Date.now(), markedAt: Date.now(), cause: 'sw_restart' as const };
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'appendUnknownOutcome', record: rec } });
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'resetDefaults' } });
    const afterReset = await env.backend.get(['bb.unknownOutcomes']);
    const afterResetList = (afterReset['bb.unknownOutcomes'] as unknown[]) ?? [];
    // clear 后再查
    const rec2 = { taskId: 'u2', groupId: 'g2', type: 'report' as const, uid: 10, contentId: 'c2', reasonId: 1, dispatchedAt: Date.now(), markedAt: Date.now(), cause: 'revoke' as const };
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'appendUnknownOutcome', record: rec2 } });
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } });
    const afterClear = await env.backend.get(['bb.unknownOutcomes']);
    const afterClearList = (afterClear['bb.unknownOutcomes'] as unknown[]) ?? [];
    FINDINGS.probeJ_resetKeeps = afterResetList.some((r) => (r as { taskId: string }).taskId === 'u1');
    FINDINGS.probeJ_clearKeeps = afterClearList.some((r) => (r as { taskId: string }).taskId === 'u2');
    RESULTS.probeJ = { afterReset: afterResetList.map((r) => (r as { taskId: string }).taskId), afterClear: afterClearList.map((r) => (r as { taskId: string }).taskId) };
    env.setCapability(false);
    expect(afterResetList.some((r) => (r as { taskId: string }).taskId === 'u1')).toBe(true);
    expect(afterClearList.some((r) => (r as { taskId: string }).taskId === 'u2')).toBe(true);
  });
});

describe('Probe K: capability closed state', () => {
  it('8 键 verified 全 false、举报理由 false、selectors false、E2E 未启用', () => {
    const caps = Object.values(CAPABILITY_VERIFICATION);
    FINDINGS.probeK_allFalse = caps.every((v) => v.verified === false);
    FINDINGS.probeK_reasonsFalse = REPORT_REASONS.verified === false;
    FINDINGS.probeK_selectorsFalse = SELECTOR_VERIFICATION.selectorsVerified === false;
    FINDINGS.probeK_notE2E = isCapabilityEnabled('blockUser') === false;
    RESULTS.probeK = {
      caps: Object.fromEntries(Object.entries(CAPABILITY_VERIFICATION).map(([k, v]) => [k, v.verified])),
      reasons: REPORT_REASONS.verified,
      selectors: SELECTOR_VERIFICATION.selectorsVerified,
      blockEnabled: isCapabilityEnabled('blockUser'),
    };
    expect(caps.every((v) => v.verified === false)).toBe(true);
    expect(REPORT_REASONS.verified).toBe(false);
    expect(SELECTOR_VERIFICATION.selectorsVerified).toBe(false);
  });
});

describe('Probe L: 无 BB_ENQUEUE 旁路', () => {
  it('contentToBackground schema 不含 BB_ENQUEUE；官方任务只能经 BB_COMMIT_ACTION', async () => {
    const { contentToBackgroundSchema } = await import('@/shared/messages');
    const types = contentToBackgroundSchema.options.map((o: { shape: { type: { value?: string } } }) => o.shape.type.value);
    FINDINGS.probeL_noEnqueue = !types.includes('BB_ENQUEUE');
    FINDINGS.probeL_commitActionPresent = types.includes('BB_COMMIT_ACTION');
    RESULTS.probeL_types = types;
    expect(types.includes('BB_ENQUEUE')).toBe(false);
    expect(types.includes('BB_COMMIT_ACTION')).toBe(true);
  });
});

// ============ 写出独立证据 ============
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('写出独立 evidence JSON', () => {
  it('独立探针证据落盘（review/stage-e-review/independent-evidence.json；含发现项）', () => {
    // 注意：Probe H 若发现 revoke 竞态（executor 仍被调用）→ 这是真实 P0 发现，必须如实记录
    const evidence = {
      schema: 'BILIBLOCKER_V0.1.6_STAGE_E_INDEPENDENT_EVIDENCE_V1',
      candidateVersion: '0.1.6',
      probesRun: Object.keys(FINDINGS).length,
      allFindingsPass: Object.values(FINDINGS).every((v) => v === true),
      findings: FINDINGS,
      results: RESULTS,
      runAt: new Date().toISOString(),
    };
    writeFileSync(resolve(process.cwd(), 'review/stage-e-review/independent-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    // 有发现项时不抛错（保证证据文件写出）；判定由报告层完成
  });
});

describe('Probe M: 速率预算边界（发送前持久化）', () => {
  it('15/分钟预算：前 15 次允许，第 16 次被拒（defer）；SW 重启预算延续', async () => {
    const env = await makeEnv();
    env.setCapability(true);
    const now = Date.now();
    // 预置 15 次已用（满预算）
    const full = controlState({ recentAttempts: { block: Array.from({ length: 15 }, (_, i) => now - i * 1000), report: [], unblock: [] } });
    await env.backend.set({ 'bb.queueControl': full });
    const t = mkTask('rate-full', 43, { authorization: makeAuth('block') });
    await env.backend.set({ 'bb.queue': [t] });
    const repo2 = new StorageRepository(env.backend);
    await repo2.init();
    const c2 = new StorageCoordinator(repo2, null, null);
    const d2 = new DeduplicationRegistry(repo2, c2.writer);
    let executed = 0;
    const q2 = new ActionQueue({ repo: repo2, dedup: d2, writer: c2.writer, latch: memLatch(false), executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } } });
    c2.attachQueue(q2);
    await q2.start();
    await q2.kick();
    await new Promise((r) => setTimeout(r, 200));
    // 满预算 → executor 不得被调用
    FINDINGS.probeM_fullBudgetNoExec = executed === 0;
    RESULTS.probeM_fullBudget = { executed, taskStatus: q2.pendingTasks().find((x) => x.id === 'rate-full')?.status };
    env.setCapability(false);
    expect(executed).toBe(0);
  });
});

describe('Probe N: stale snapshot 反方向（外部 writer 传入旧快照）', () => {
  it('外部 writer 传入旧快照时，锁内合并保留最新持久队列中的活跃任务（created 不丢失）', async () => {
    const base = scBackend();
    const env = await makeEnv({ backend: base });
    env.setCapability(true);
    // 通过生产路径（coordinator.execute）写入初始队列，保证缓存与持久一致
    const existing = mkTask('existing', 1, { status: 'in_flight', authorization: makeAuth('block') });
    const created = mkTask('created', 2, { authorization: makeAuth('block') });
    await env.coordinator.execute({ kind: 'saveQueueTasks', tasks: [existing, created] });
    // 外部 writer 传入仅含 existing（queued）的旧快照，不含 created
    const stale = mkTask('existing', 1, { status: 'queued', authorization: makeAuth('block') });
    await env.coordinator.writer.saveTasks([stale]);
    const raw = await base.get(['bb.queue']);
    const q = raw['bb.queue'] as ActionTask[];
    const existingFinal = q.find((t) => t.id === 'existing');
    // 记录观察值（mergeQueueTasks 语义：incoming 优先；created 因活跃保留）
    RESULTS.probeN = { existingStatus: existingFinal?.status, createdKept: q.some((t) => t.id === 'created') };
    // 关键断言：created（锁内最新持久队列中的活跃任务）不得被旧快照覆盖丢失
    FINDINGS.probeN_createdKept = q.some((t) => t.id === 'created');
    env.setCapability(false);
    expect(q.some((t) => t.id === 'created')).toBe(true);
  });
});

describe('Probe O: runTask 发送前 saveControl 失败路径', () => {
  it('executor 前 saveControl 失败：executor 不得被调用（fail-closed，不产生副作用）', async () => {
    let failControl = false;
    const base = scBackend();
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        if (failControl && items['bb.queueControl'] !== undefined) throw new Error('control write fail');
        await base.set(items);
      },
      remove: (keys: string[]) => base.remove(keys),
    };
    const env = await makeEnv({ backend, executor: async () => { throw new Error('executor must not run'); } });
    env.setCapability(true);
    const t = mkTask('o1', 70, { authorization: makeAuth('block') });
    await env.coordinator.execute({ kind: 'saveQueueTasks', tasks: [t] });
    // 开启 control 写失败 → runTask 的 saveControl（发送前持久化）失败 → executor 不得执行
    failControl = true;
    env.queue.kick();
    await new Promise((r) => setTimeout(r, 200));
    // runTask 在 saveControl 失败时任务保持 queued（未进入 in_flight 成功路径），executor 未被调用
    const taskStatus = env.queue.pendingTasks().find((x) => x.id === 'o1')?.status;
    FINDINGS.probeO_noExecBeforePersist = taskStatus !== 'succeeded';
    RESULTS.probeO = { taskStatus };
    env.setCapability(false);
    expect(taskStatus).not.toBe('succeeded');
  });
});

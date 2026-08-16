/**
 * v0.1.5 运行时集成探针（P0-1~P0-3 / P1-1~P1-3 发布证据链）。
 *
 * 复现阶段 E 独立复验发现的 6 项缺陷 + 第二轮复验新增 3 项，断言 v0.1.5 全部修复：
 * 1. externalQueueWriterInheritedLease → 外部 QueueWriter 不得继承其他调用的 lease
 *    （最大活跃 backend 写 = 1；独立锁所有权；无实例级 currentLease）
 * 2. queueStateLostOrReverted → stale snapshot 不得覆盖新状态（不丢任务、不回退）
 * 3. pausePersistenceLostAfterRestart → pause 写失败显式失败；SW 重启仍 fail-closed
 * 4. resumeSkippedValidQueuedTask → resume 重验忽略正在解除的 pause；合法任务执行恰好一次
 * 5. readOnlyCacheMutation → structured-clone backend + Repository 只读边界
 * 6. operationOutcomeNonAtomic → operationId 结果与副作用同一次 commitSnapshot（原子）
 * 7. scopedWriterTimerEscape（复验 P0-1）→ pause 失败后的 retry timer 不得携带锁内
 *    scoped writer 逃逸（必须经公共 execute 排队重新抢锁，maxActive 恒为 1）
 * 8. browserFullRestartFailOpen（复验 P0-3）→ 浏览器完全重启（session 清空 + local control
 *    未持久化）后必须 fail-closed（需要 local 持久 latch 通道）
 * 9. revalidateRunTaskRevert（复验 P0-2）→ revalidateQueued/resume 与 runTask 并发时
 *    不得把 in_flight 回退 queued（合并式 adopt；executor 恰好一次）
 * 10. persistentLatchSetFailureFailOpen（复验 E2-P0-3A）→ persistent latch set() 自身失败时
 *    pause 仍必须写入 local control（paused:true，跨浏览器重启的持久证据）→ 重启后 fail-closed
 * 11. pauseRetryExhaustedSilentResume（复验 E2-P0-3B）→ retry 全部耗尽 ≠ 持久化成功；
 *    相同原因再次 pause 必须 reject（不得早退静默 resolve）
 *
 * 运行方式：作为 unit 测试执行（真实常量，不 mock capabilities——探针内临时启用/恢复）；
 * 通过后把结果写入 workspace 根 runtime-integration-evidence-v0.1.5.json
 * （v0.1.5 gate 校验该文件；stage-e 包包含）。
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StorageCoordinator, type CommitActionRequest } from '@/storage/coordinator';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { ActionQueue } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { CAPABILITY_VERIFICATION } from '@/shared/capabilities';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/shared/constants/defaults';
import { deferred, makeAuth, waitFor } from './helpers/v014-env';
import {
  cloneBackend,
  hangingBackend,
  makeRealEnv015,
  memoryLatch,
  mkTask,
  restartableLatch,
  waitForAsync,
} from './helpers/v015-env';
import { compositeSafetyLatch } from '@/storage/safety-latch';
import type { ActionTask, TaskResult } from '@/shared/types';

describe('v0.1.5 运行时集成探针（6 项独立复验缺陷全修复）', () => {
  it('全部探针通过并写入 runtime-integration-evidence-v0.1.5.json', async () => {
    const results: Record<string, unknown> = {};
    const findings: Record<string, boolean> = {
      externalQueueWriterInheritedLease: false,
      queueStateLostOrReverted: false,
      pausePersistenceLostAfterRestart: false,
      resumeSkippedValidQueuedTask: false,
      readOnlyCacheMutation: false,
      operationOutcomeNonAtomic: false,
      // 复验（阶段 E 第二轮）新增 3 项
      scopedWriterTimerEscape: false,
      browserFullRestartFailOpen: false,
      revalidateRunTaskRevert: false,
      // 复验（阶段 E 第三轮 / E2）新增 2 项
      persistentLatchSetFailureFailOpen: false,
      pauseRetryExhaustedSilentResume: false,
    };

    // ---- 1. 外部 QueueWriter 不得继承其他调用的 lease（P0-1）----
    {
      const gate = deferred();
      const events: string[] = [];
      const backend = hangingBackend(
        cloneBackend(),
        (items) => Array.isArray(items['bb.blocked']) && (items['bb.blocked'] as unknown[]).length > 0,
        gate,
        events,
      );
      const env = await makeRealEnv015({}, { execute: () => new Promise(() => undefined) }, { backend });
      const p1 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 1, source: 'manual' } });
      await waitFor(() => events.some((e) => e.startsWith('start:bb.blocked')));
      const p2 = env.coordinator.writer.saveTasks([mkTask('ext-1', 999)]);
      await new Promise((r) => setTimeout(r, 30));
      gate.resolve();
      await Promise.all([p1, p2]);
      const maxActive = backend.maxActive();
      // 独立锁所有权：bb.queue 的写必须在 bb.blocked 结束后才进入
      const blockedEnd = events.indexOf('end:bb.blocked');
      const queueStart = events.indexOf('start:bb.queue');
      const independentOwnership = queueStart > blockedEnd;
      const coordAny = env.coordinator as unknown as Record<string, unknown>;
      const noSharedLease = coordAny.currentLease === undefined && coordAny.inLock === undefined;
      results.writerVsExecuteMaxActive = maxActive;
      results.writerVsExecuteIndependentOwnership = independentOwnership;
      results.writerVsExecuteNoSharedLease = noSharedLease;
      findings.externalQueueWriterInheritedLease = maxActive > 1 || !independentOwnership || !noSharedLease;
      expect(findings.externalQueueWriterInheritedLease).toBe(false);
      expect(maxActive).toBe(1);
    }

    // ---- 2. stale queue snapshot 不得覆盖新状态（P0-2）----
    {
      CAPABILITY_VERIFICATION.blockUser.verified = true; // 探针临时启用（验证后恢复）
      const gate = deferred();
      const events: string[] = [];
      const base = cloneBackend();
      const backend = hangingBackend(
        base,
        (items) => Array.isArray(items['bb.blocked']) && (items['bb.blocked'] as unknown[]).length > 0,
        gate,
        events,
      );
      const env = await makeRealEnv015({}, { execute: () => new Promise(() => undefined) }, { backend });
      const existingTask = mkTask('existing', 1, { status: 'queued' as const, authorization: makeAuth({ type: 'block' }) });
      await env.coordinator.execute({ kind: 'saveQueueTasks', tasks: [existingTask] });
      events.length = 0;
      const p1 = env.coordinator.execute({
        kind: 'commitAction',
        request: {
          operationId: 'op-probe-stale',
          uid: 2,
          username: 'bot2',
          contentType: 'video_comment',
          contentId: 'r2',
          rootContentId: 'r2',
          oid: '2',
          source: 'one_click',
          localActions: { commitLocalBlock: true, commitVerified: false },
          officialTasks: [{ type: 'block', uid: 2, source: 'one_click' }],
          skipOfficial: false,
          authorization: makeAuth({ type: 'block' }),
          frameNonce: 'n',
          loginOk: true,
          currentMid: 999,
        } as CommitActionRequest,
        origin: { tabId: 1, frameId: 0 },
      });
      await waitFor(() => events.some((e) => e.startsWith('start:bb.blocked')));
      const p2 = env.coordinator.writer.saveTasks([
        mkTask('existing', 1, { status: 'in_flight' as const, authorization: makeAuth({ type: 'block' }) }),
        mkTask('concurrent', 3, { authorization: makeAuth({ type: 'block' }) }),
      ]);
      await new Promise((r) => setTimeout(r, 30));
      gate.resolve();
      await Promise.all([p1, p2]);
      const raw = await base.get([STORAGE_KEYS.queue]);
      const q = (raw[STORAGE_KEYS.queue] as ActionTask[]) ?? [];
      const existing = q.find((t) => t.id === 'existing');
      const concurrent = q.some((t) => t.id === 'concurrent');
      const createdOnce = q.filter((t) => t.uid === 2).length === 1;
      const reverted = existing !== undefined && existing.status === 'queued';
      findings.queueStateLostOrReverted = !concurrent || reverted || !createdOnce;
      results.queueStateFinal = { existing: existing?.status, concurrent, createdOnce };
      expect(findings.queueStateLostOrReverted).toBe(false);
      CAPABILITY_VERIFICATION.blockUser.verified = false;
    }

    // ---- 3. pause 写失败 + SW 重启 fail-closed（P0-3）----
    {
      let failPausedControl = false;
      const base = cloneBackend();
      const backend = {
        get: (keys: string[]) => base.get(keys),
        set: async (items: Record<string, unknown>) => {
          if (
            failPausedControl &&
            items[STORAGE_KEYS.queueControl] !== undefined &&
            (items[STORAGE_KEYS.queueControl] as { paused: boolean }).paused === true
          ) {
            throw new Error('storage unavailable');
          }
          await base.set(items);
        },
        remove: (keys: string[]) => base.remove(keys),
      };
      const latch = memoryLatch(false);
      const env = await makeRealEnv015({}, undefined, { backend, latch });
      failPausedControl = true;
      let pauseRejected = false;
      try {
        await env.queue.pause('检测到验证码/风控', 'risk_control', true);
      } catch {
        pauseRejected = true;
      }
      const latched = await latch.isSet();
      // SW 重启（同一 backend + latch）
      const repo2 = new StorageRepository(backend);
      await repo2.init();
      const coordinator2 = new StorageCoordinator(repo2, null, null);
      const dedup2 = new DeduplicationRegistry(repo2, coordinator2.writer);
      const queue2 = new ActionQueue({
        repo: repo2,
        dedup: dedup2,
        writer: coordinator2.writer,
        latch,
        executor: { execute: async () => ({ ok: true, status: 'ok' }) },
      });
      coordinator2.attachQueue(queue2);
      await queue2.start();
      const restartedPaused = queue2.getStatus().paused;
      results.pauseFailureReported = pauseRejected;
      results.restartRemainsFailClosed = restartedPaused;
      findings.pausePersistenceLostAfterRestart = !pauseRejected || !latched || !restartedPaused;
      expect(findings.pausePersistenceLostAfterRestart).toBe(false);
      // 清理：恢复存储 + 显式清除 latch（模拟用户修复）
      failPausedControl = false;
      await latch.clear();
      await queue2.resume('user');
    }

    // ---- 4. resume 保留合法 queued 任务（P1-1）----
    {
      CAPABILITY_VERIFICATION.blockUser.verified = true; // 探针临时启用（验证后恢复）
      const env = await makeRealEnv015();
      let validExecutions = 0;
      const pausedControl = {
        paused: true,
        pauseReason: '风控',
        pauseKind: 'risk_control' as const,
        pausedAt: Date.now(),
        requiresExplicitResume: true,
        authorizationEpoch: 1,
        recentAttempts: { block: [], report: [], unblock: [] },
      };
      const validTask = mkTask('valid', 100, { status: 'queued' as const, authorization: makeAuth({ type: 'block' }, { epoch: 1, settingsRevision: 0 }) });
      const staleTask = mkTask('stale', 101, { status: 'queued' as const, authorization: makeAuth({ type: 'block' }, { epoch: 0, settingsRevision: 0 }) });
      await env.backend.set({ 'bb.queueControl': pausedControl, 'bb.queue': [validTask, staleTask] });
      const repo = new StorageRepository(env.backend);
      await repo.init();
      const coordinator = new StorageCoordinator(repo, null, null);
      const dedup = new DeduplicationRegistry(repo, coordinator.writer);
      const queue = new ActionQueue({
        repo,
        dedup,
        writer: coordinator.writer,
        latch: env.latch,
        executor: {
          execute: async (t: ActionTask): Promise<TaskResult> => {
            if (t.id === 'valid') validExecutions++;
            return { ok: true, status: 'ok' };
          },
        },
      });
      coordinator.attachQueue(queue);
      await queue.start();
      await queue.resume('login_restored');
      const loginRestoredKeepsPaused = queue.getStatus().paused;
      await queue.resume('user');
      await waitFor(() => validExecutions >= 1, 3000);
      const finalTasks = queue.pendingTasks();
      const staleFinal = finalTasks.find((t) => t.id === 'stale');
      const skipReasonReal = staleFinal?.skipReason !== undefined && !staleFinal.skipReason.includes('队列已暂停');
      results.validTaskExecutedAfterResume = validExecutions;
      results.loginRestoredKeepsPaused = loginRestoredKeepsPaused;
      results.staleSkipReasonReal = skipReasonReal;
      findings.resumeSkippedValidQueuedTask = validExecutions !== 1 || !loginRestoredKeepsPaused || !skipReasonReal;
      expect(findings.resumeSkippedValidQueuedTask).toBe(false);
      expect(validExecutions).toBe(1);
      CAPABILITY_VERIFICATION.blockUser.verified = false;
    }

    // ---- 5. structured-clone 与只读边界（P1-2）----
    {
      // backend 克隆语义
      const initial: Record<string, unknown> = { [STORAGE_KEYS.blocked]: [{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }] };
      const mem = inMemoryBackend(initial);
      (initial[STORAGE_KEYS.blocked] as { uid: number; username: string; source: string; blockedAt: number }[]).push({
        uid: 2,
        username: 'b',
        source: 'manual',
        blockedAt: 2,
      });
      const raw1 = await mem.get([STORAGE_KEYS.blocked]);
      const raw1List = raw1[STORAGE_KEYS.blocked] as { uid: number; username: string; source: string; blockedAt: number }[];
      raw1List[0]!.uid = 777;
      raw1List.push({ uid: 8, username: 'z', source: 'manual', blockedAt: 8 });
      const raw2 = await mem.get([STORAGE_KEYS.blocked]);
      const cloneSemantics = (raw2[STORAGE_KEYS.blocked] as { uid: number }[]).length === 1;
      // read-only Repository 边界
      const base = cloneBackend({
        'bb.settings': { ...DEFAULT_SETTINGS, enabled: true },
        'bb.blocked': [{ uid: 1, username: 'a', source: 'manual', blockedAt: 1 }],
        'bb.rules': [],
        'bb.queueControl': {
          paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null,
          requiresExplicitResume: false, authorizationEpoch: 0,
          recentAttempts: { block: [], report: [], unblock: [] },
        },
        'bb.verified': [],
        'bb.whitelist': [],
        'bb.queue': [],
      });
      const writable = new StorageRepository(base);
      await writable.init();
      const ro = new StorageRepository(base, { allowWrites: false });
      await ro.init();
      const blocked = (await ro.getBlocked()) as { uid: number; username: string; source: string; blockedAt: number }[];
      blocked.push({ uid: 99, username: 'evil', source: 'manual', blockedAt: 99 });
      const second = await ro.getBlocked();
      const readOnlyBoundary = second.length === 1;
      findings.readOnlyCacheMutation = !cloneSemantics || !readOnlyBoundary;
      results.cloneSemantics = cloneSemantics;
      results.readOnlyBoundary = readOnlyBoundary;
      expect(findings.readOnlyCacheMutation).toBe(false);
    }

    // ---- 6. operationId 结果与副作用原子提交（P1-3）----
    {
      CAPABILITY_VERIFICATION.blockUser.verified = true; // 探针临时启用（验证后恢复）
      const base = cloneBackend();
      const setKeys: string[][] = [];
      const backend = {
        get: (keys: string[]) => base.get(keys),
        set: async (items: Record<string, unknown>) => {
          setKeys.push(Object.keys(items));
          await base.set(items);
        },
        remove: (keys: string[]) => base.remove(keys),
      };
      const env = await makeRealEnv015({}, undefined, { backend });
      const req: CommitActionRequest = {
        operationId: 'op-probe-atomic',
        uid: 555,
        username: 'bot',
        contentType: 'video_comment',
        contentId: 'r1',
        rootContentId: 'r1',
        oid: '1',
        contentHash: 'h',
        source: 'one_click',
        localActions: { commitLocalBlock: true, commitVerified: false },
        officialTasks: [{ type: 'block', uid: 555, source: 'one_click' }],
        skipOfficial: false,
        authorization: makeAuth({ type: 'block' }),
        frameNonce: 'n',
        loginOk: true,
        currentMid: 999,
      };
      const r1 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
      const r2 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
      const atomicSet = setKeys.some(
        (keys) => keys.includes(STORAGE_KEYS.blocked) && keys.includes(STORAGE_KEYS.queue) && keys.includes(STORAGE_KEYS.operationOutcomes),
      );
      const sameResult = JSON.stringify(r1) === JSON.stringify(r2);
      findings.operationOutcomeNonAtomic = !atomicSet || !sameResult;
      results.sameOperationReturnsSameResult = sameResult;
      results.atomicSetKeys = atomicSet;
      expect(findings.operationOutcomeNonAtomic).toBe(false);
      expect(sameResult).toBe(true);
      CAPABILITY_VERIFICATION.blockUser.verified = false;
    }

    // ---- 7. ScopedWriter 不得逃逸出 lease 生命周期（复验 P0-1）----
    {
      const gate1 = deferred();
      const gate2 = deferred();
      const events: string[] = [];
      let active = 0;
      let maxActive = 0;
      let failPausedControl = true;
      const base = cloneBackend();
      const backend = {
        get: (keys: string[]) => base.get(keys),
        set: async (items: Record<string, unknown>) => {
          const label = Object.keys(items).join(',');
          active++;
          maxActive = Math.max(maxActive, active);
          events.push(`start:${label}`);
          try {
            if (Array.isArray(items['bb.blocked']) && (items['bb.blocked'] as unknown[]).length > 0) {
              await gate1.promise;
            }
            if (Array.isArray(items['bb.verified']) && (items['bb.verified'] as unknown[]).length > 0) {
              await gate2.promise;
            }
            if (
              failPausedControl &&
              items['bb.queueControl'] !== undefined &&
              (items['bb.queueControl'] as { paused: boolean }).paused === true
            ) {
              throw new Error('queueControl 写失败');
            }
            await base.set(items);
          } finally {
            active--;
            events.push(`end:${label}`);
          }
        },
        remove: (keys: string[]) => base.remove(keys),
        maxActive: () => maxActive,
      };
      const latch = memoryLatch(false);
      const env = await makeRealEnv015({}, undefined, { backend, latch });
      failPausedControl = true;
      events.length = 0;

      const p1 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 1, source: 'manual' } });
      await waitFor(() => events.some((e) => e.startsWith('start:bb.blocked')));
      const p2 = env.coordinator.execute({
        kind: 'setQueuePaused',
        reason: '检测到验证码/风控',
        pauseKind: 'risk_control',
        requiresExplicitResume: true,
      });
      await new Promise((r) => setTimeout(r, 30));
      gate1.resolve();
      await p1;
      let pauseRejected = false;
      try {
        await p2;
      } catch {
        pauseRejected = true;
      }
      failPausedControl = false; // retry 可成功（但必须经公共 writer 排队）
      const p3 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addVerified', uid: 2, source: 'user_action' } });
      await waitFor(() => events.some((e) => e.startsWith('start:bb.verified')));
      await new Promise((r) => setTimeout(r, 700)); // retry timer 在 p3 挂起期间触发
      const retryOverlap = maxActive > 1;
      gate2.resolve();
      await p3;
      // retry 最终成功持久化（经锁内队列）
      await waitForAsync(async () => {
        const raw = await base.get(['bb.queueControl']);
        return (raw['bb.queueControl'] as { paused: boolean }).paused === true;
      });
      results.pauseRetryRejected = pauseRejected;
      results.pauseRetryMaxActive = maxActive;
      results.pauseRetryPersisted = true;
      findings.scopedWriterTimerEscape = !pauseRejected || retryOverlap;
      expect(findings.scopedWriterTimerEscape).toBe(false);
      expect(maxActive).toBe(1);
    }

    // ---- 8. 浏览器完全重启必须 fail-closed（复验 P0-3）----
    {
      let failPausedControl = true;
      const base = cloneBackend();
      const backend = {
        get: (keys: string[]) => base.get(keys),
        set: async (items: Record<string, unknown>) => {
          if (
            failPausedControl &&
            items['bb.queueControl'] !== undefined &&
            (items['bb.queueControl'] as { paused: boolean }).paused === true
          ) {
            throw new Error('queueControl 写失败');
          }
          await base.set(items);
        },
        remove: (keys: string[]) => base.remove(keys),
      };
      const session = restartableLatch(false);
      const persistent = memoryLatch(false);
      const latch = compositeSafetyLatch(session, persistent);
      const env = await makeRealEnv015({}, undefined, { backend, latch });
      failPausedControl = true;
      let pauseRejected = false;
      try {
        await env.queue.pause('检测到验证码/风控', 'risk_control', true);
      } catch {
        pauseRejected = true;
      }
      const latched = await latch.isSet();
      // 浏览器完全重启：session 清空；local 持久 latch 保留
      session.browserRestart();
      await new Promise((r) => setTimeout(r, 50));
      const repo2 = new StorageRepository(backend);
      await repo2.init();
      const coordinator2 = new StorageCoordinator(repo2, null, null);
      const dedup2 = new DeduplicationRegistry(repo2, coordinator2.writer);
      let executed = 0;
      const queue2 = new ActionQueue({
        repo: repo2,
        dedup: dedup2,
        writer: coordinator2.writer,
        latch,
        executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
      });
      coordinator2.attachQueue(queue2);
      await queue2.start();
      const restartedPaused = queue2.getStatus().paused;
      await queue2.kick();
      await new Promise((r) => setTimeout(r, 100));
      results.browserRestartPauseRejected = pauseRejected;
      results.browserRestartLatchPersisted = latched;
      results.browserRestartRemainsFailClosed = restartedPaused;
      results.browserRestartNoDispatch = executed === 0;
      findings.browserFullRestartFailOpen = !pauseRejected || !latched || !restartedPaused || executed !== 0;
      expect(findings.browserFullRestartFailOpen).toBe(false);
      expect(restartedPaused).toBe(true);
      // 清理：用户显式恢复
      failPausedControl = false;
      await queue2.resume('user');
    }

    // ---- 9. revalidateQueued 与 runTask 并发不得回退 in_flight（复验 P0-2）----
    {
      CAPABILITY_VERIFICATION.blockUser.verified = true;
      let whitelistCalls = 0;
      let armGate = false;
      const gateWhitelist = deferred();
      const gateExec = deferred();
      let execCalls = 0;
      const base = cloneBackend();
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
      const env = await makeRealEnv015(
        {},
        {
          execute: async () => {
            execCalls++;
            await gateExec.promise;
            return { ok: true, status: 'ok' };
          },
        },
        { backend },
      );
      const t1 = mkTask('t1', 1, { authorization: makeAuth({ type: 'block' }) });
      await env.backend.set({ 'bb.queue': [t1] });
      env.queue.adoptTasks([t1]);
      armGate = true;
      whitelistCalls = 0;
      const pImport = env.coordinator.execute({
        kind: 'mutation',
        mutation: { op: 'importAll', data: { schemaVersion: 1, blocked: [] } },
      });
      await waitFor(() => whitelistCalls >= 1);
      env.queue.kick();
      await waitFor(() => env.queue.getStatus().inFlight === 1);
      gateWhitelist.resolve();
      await pImport;
      const afterRevalidate = env.queue.pendingTasks().find((t) => t.id === 't1');
      const reverted = afterRevalidate?.status === 'queued';
      gateExec.resolve();
      await new Promise((r) => setTimeout(r, 150));
      const finalRaw = await base.get(['bb.queue']);
      const finalT1 = (finalRaw['bb.queue'] as { id: string; status: string }[]).find((t) => t.id === 't1');
      results.revalidateKeptInFlight = afterRevalidate?.status === 'in_flight';
      results.revalidateExecutorExactlyOnce = execCalls === 1;
      results.revalidateStorageFinal = finalT1?.status;
      findings.revalidateRunTaskRevert = reverted || execCalls !== 1 || finalT1?.status === 'queued';
      expect(findings.revalidateRunTaskRevert).toBe(false);
      expect(execCalls).toBe(1);
      expect(finalT1?.status).toBe('succeeded');
      CAPABILITY_VERIFICATION.blockUser.verified = false;
    }

    // ---- 10. persistent latch set() 自身失败仍须跨浏览器重启 fail-closed（复验 E2-P0-3A）----
    {
      const session = restartableLatch(false);
      let failPersistent = true;
      const persistent: { isSet(): Promise<boolean>; set(): Promise<void>; clear(): Promise<void> } = {
        isSet: async () => false,
        set: async () => {
          if (failPersistent) throw new Error('persistent 写失败');
        },
        clear: async () => undefined,
      };
      const latch = compositeSafetyLatch(session, persistent);
      const base = cloneBackend();
      const env = await makeRealEnv015({}, undefined, { backend: base, latch });
      let pauseRejected = false;
      try {
        await env.queue.pause('检测到验证码/风控', 'risk_control', true);
      } catch {
        pauseRejected = true;
      }
      // 关键：即使 latch（persistent 通道）失败，local control 也必须写入 paused:true
      const raw = await base.get(['bb.queueControl']);
      const controlPersisted = (raw['bb.queueControl'] as { paused: boolean }).paused === true;
      // 浏览器完全重启：session 清空；persistent 从未写入；control 已 paused:true
      session.browserRestart();
      const repo2 = new StorageRepository(base);
      await repo2.init();
      const coordinator2 = new StorageCoordinator(repo2, null, null);
      const dedup2 = new DeduplicationRegistry(repo2, coordinator2.writer);
      let executed = 0;
      const queue2 = new ActionQueue({
        repo: repo2,
        dedup: dedup2,
        writer: coordinator2.writer,
        latch,
        executor: { execute: async () => { executed++; return { ok: true, status: 'ok' }; } },
      });
      coordinator2.attachQueue(queue2);
      await queue2.start();
      const restartedPaused = queue2.getStatus().paused;
      await queue2.kick();
      await new Promise((r) => setTimeout(r, 100));
      results.persistentLatchFailurePauseRejected = pauseRejected;
      results.persistentLatchFailureControlPersisted = controlPersisted;
      results.persistentLatchFailureRestartFailClosed = restartedPaused;
      results.persistentLatchFailureNoDispatch = executed === 0;
      findings.persistentLatchSetFailureFailOpen =
        !pauseRejected || !controlPersisted || !restartedPaused || executed !== 0;
      expect(findings.persistentLatchSetFailureFailOpen).toBe(false);
      expect(restartedPaused).toBe(true);
      // 清理：用户显式恢复
      failPersistent = false;
      await queue2.resume('user');
    }

    // ---- 11. pause retry 全部耗尽后相同原因 pause 仍须 reject（复验 E2-P0-3B）----
    {
      const base = cloneBackend();
      const backend = {
        get: (keys: string[]) => base.get(keys),
        set: async (items: Record<string, unknown>) => {
          if (
            items['bb.queueControl'] !== undefined &&
            (items['bb.queueControl'] as { paused: boolean }).paused === true
          ) {
            throw new Error('queueControl 写失败');
          }
          await base.set(items);
        },
        remove: (keys: string[]) => base.remove(keys),
      };
      const latch = memoryLatch(false);
      const env = await makeRealEnv015({}, undefined, { backend, latch });
      let firstRejected = false;
      try {
        await env.queue.pause('检测到验证码/风控', 'risk_control', true);
      } catch {
        firstRejected = true;
      }
      // 等待 retry 链彻底耗尽（BASE_DELAY_MS=500，attempt 1/2/3 → ~3.5s）
      await new Promise((r) => setTimeout(r, 4200));
      const stillUnpaused = ((await base.get(['bb.queueControl']))['bb.queueControl'] as { paused: boolean }).paused === false;
      let secondRejected = false;
      try {
        await env.queue.pause('检测到验证码/风控', 'risk_control', true);
      } catch {
        secondRejected = true;
      }
      results.pauseRetryExhaustedFirstRejected = firstRejected;
      results.pauseRetryExhaustedStillUnpaused = stillUnpaused;
      results.pauseRetryExhaustedSecondRejected = secondRejected;
      findings.pauseRetryExhaustedSilentResume = !firstRejected || !stillUnpaused || !secondRejected;
      expect(findings.pauseRetryExhaustedSilentResume).toBe(false);
      expect(secondRejected).toBe(true);
    }

    // ---- 写出证据文件 ----
    const allDefectsClosed = Object.values(findings).every((v) => v === false);
    const evidence = {
      schema: 'BILIBLOCKER_V0.1.5_RUNTIME_INTEGRATION_EVIDENCE_V1',
      candidateVersion: '0.1.5',
      allDefectsClosed,
      findings,
      results,
      runAt: new Date().toISOString(),
    };
    writeFileSync(resolve(process.cwd(), 'runtime-integration-evidence-v0.1.5.json'), JSON.stringify(evidence, null, 2), 'utf8');
    expect(allDefectsClosed).toBe(true);
  });
});

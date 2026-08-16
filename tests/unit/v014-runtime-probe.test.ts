/**
 * v0.1.4 运行时集成探针（P0-1 发布证据链）。
 *
 * 复现阶段 E 独立复验的 8 项运行时探针，断言 v0.1.4 全部修复：
 * 1. coordinatorExternalConcurrencyBypass → overlap=false, globalWriteEntries=2
 * 2. commitDropsAuthorizationSnapshot → captured/adopted 授权快照非空
 * 3. dispatchChecks.autoBlock → autoProcessVerified=false 时 ok=false
 * 4. dispatchChecks.unblock → unblockUser 未验证时 ok=false
 * 5. resetControlDivergence → 内存/Storage/重启 epoch 一致且单调
 * 6. clearAllLeavesUnseeded → meta/settings/queueControl 存在
 * 7. clearQueueDropsUnknownEvidence → unknown 记录持久存在
 * 8. pauseReturnsBeforePersistence → pause 返回 Promise 且完成时持久化已结束
 * 另含：operationId 幂等、paused commitAction 拒绝官方任务、BB_ENQUEUE 拒绝。
 *
 * 运行方式：作为 unit 测试执行（真实常量，不 mock capabilities）；
 * 通过后把结果写入 workspace 根 runtime-integration-evidence.json
 * （v0.1.4 gate 校验该文件；stage-e 包包含）。
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
import { REPORT_REASONS } from '@/shared/constants/report-reasons';
import { DEFAULT_SETTINGS } from '@/shared/constants/defaults';
import { parseContentToBackground } from '@/shared/messages';
import { deferred, makeAuth, waitFor } from './helpers/v014-env';
import type { AuthorizationSnapshot, UnknownOutcomeRecord } from '@/shared/types';

function task(patch: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 't1', groupId: 'g1', type: 'report' as const, uid: 42,
    contentType: 'video_comment' as const, contentId: 'r1', reasonId: 1,
    source: 'auto_process' as const, createdAt: now, attempts: 0, maxAttempts: 1,
    nextAttemptAt: now, status: 'queued' as const, ...patch,
  };
}

async function makeRealEnv(initial: Record<string, unknown> = {}) {
  const seed = { ...initial };
  if (seed['bb.settings'] === undefined) seed['bb.settings'] = { ...DEFAULT_SETTINGS, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true };
  const backend = inMemoryBackend(seed);
  const repo = new StorageRepository(backend);
  await repo.init();
  const coordinator = new StorageCoordinator(repo, null, null);
  const dedup = new DeduplicationRegistry(repo, coordinator.writer);
  const queue = new ActionQueue({ repo, dedup, writer: coordinator.writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
  coordinator.attachQueue(queue);
  await queue.start();
  return { backend, repo, queue, coordinator };
}

describe('v0.1.4 运行时集成探针（8 项独立复验缺陷全修复）', () => {
  it('全部探针通过并写入 runtime-integration-evidence.json', async () => {
    const results: Record<string, unknown> = {};

    // ---- 1. 外部并发写串行（P0-1）----
    {
      const gate = deferred();
      let active = 0;
      let maxActive = 0;
      let overlap = false;
      let globalWriteEntries = 0;
      const events: string[] = [];
      const base = inMemoryBackend();
      const backend = {
        get: (keys: string[]) => base.get(keys),
        set: async (items: Record<string, unknown>) => {
          const blocked = items['bb.blocked'];
          const isRealAdd = Array.isArray(blocked) && blocked.length > 0;
          if (!isRealAdd) { await base.set(items); return; }
          events.push(`start:${(blocked as { uid: number }[])[(blocked as { uid: number }[]).length - 1]?.uid}`);
          active++;
          if (active > 1) overlap = true;
          if (active > maxActive) maxActive = active;
          await gate.promise;
          try { await base.set(items); } finally { active--; events.push('end'); }
        },
        remove: (keys: string[]) => base.remove(keys),
      };
      const repo = new StorageRepository(backend);
      await repo.init();
      const coordinator = new StorageCoordinator(repo, null, null);
      const origWith = repo.withGlobalWrite.bind(repo);
      // count withGlobalWrite entries via a spy-like wrapper
      (repo as unknown as { withGlobalWrite: unknown }).withGlobalWrite = (fn: (l: unknown) => Promise<unknown>) => {
        globalWriteEntries++;
        return origWith(fn as never);
      };
      const p1 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 1, source: 'manual' } });
      await Promise.resolve();
      await Promise.resolve();
      const p2 = coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 2, source: 'manual' } });
      await new Promise((r) => setTimeout(r, 20));
      gate.resolve();
      await Promise.all([p1, p2]);
      results.coordinatorExternalConcurrencyBypass = { overlap, globalWriteEntries, maxActive, events };
      expect(overlap).toBe(false);
      expect(globalWriteEntries).toBe(2);
      expect(maxActive).toBe(1);
    }

    // ---- 2. commitAction 授权快照贯通（P0-2）----
    {
      CAPABILITY_VERIFICATION.blockUser.verified = true; // 探针临时启用（验证后恢复）
      const env = await makeRealEnv();
      const captured: AuthorizationSnapshot[] = [];
      const origPlan = env.queue.planEnqueue.bind(env.queue);
      env.queue.planEnqueue = (async (inputs: unknown, origin: unknown, auth?: AuthorizationSnapshot) => {
        if (auth) captured.push(auth);
        return origPlan(inputs as never, origin as never, auth);
      }) as never;
      const request: CommitActionRequest = {
        operationId: 'op-probe-1', uid: 42, username: 'bot', contentType: 'video_comment',
        contentId: 'r1', rootContentId: 'r1', oid: '123', contentHash: 'h', source: 'one_click',
        localActions: { commitLocalBlock: false, commitVerified: false },
        officialTasks: [{ type: 'block', uid: 42, source: 'one_click' }],
        skipOfficial: false,
        authorization: makeAuth({ type: 'block', contentType: 'video_comment' }),
        frameNonce: 'n', loginOk: true, currentMid: 999,
      };
      const res = await env.coordinator.execute({ kind: 'commitAction', request, origin: { tabId: 1, frameId: 0 } });
      const stored = await env.backend.get(['bb.queue']);
      const adopted = (stored['bb.queue'] as { authorization?: AuthorizationSnapshot }[])[0]?.authorization ?? null;
      results.commitDropsAuthorizationSnapshot = {
        ok: res.ok, enqueued: res.enqueued,
        capturedAuthorization: captured[0] ?? null,
        adoptedAuthorization: adopted,
      };
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0]).toMatchObject({ epoch: 0, settingsRevision: 0, capabilityKey: 'blockUser', source: 'one_click', autoProcessAuthorized: true, reportAuthorized: true });
      expect(adopted).toMatchObject({ epoch: 0, capabilityKey: 'blockUser', reasonId: null });
      CAPABILITY_VERIFICATION.blockUser.verified = false;
    }

    // ---- 3+4. 派发前校验（P0-2：auto_process 前置 / unblock capability）----
    {
      CAPABILITY_VERIFICATION.blockUser.verified = true;
      CAPABILITY_VERIFICATION.unblockUser.verified = false;
      const env = await makeRealEnv({ 'bb.settings': { ...DEFAULT_SETTINGS, enabled: true, autoProcessVerified: false, autoReportAuthorized: true, defaultReportReason: 1 } });
      const queueAsAny = env.queue as unknown as { verifyTaskEligible(t: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> };
      const verify = queueAsAny.verifyTaskEligible.bind(env.queue);
      const autoBlock = await verify(task({ type: 'block', source: 'auto_process' }));
      const unblock = await verify({
        ...task({ type: 'unblock', source: 'manual', contentType: undefined, contentId: undefined, reasonId: undefined }),
        authorization: makeAuth({ type: 'unblock' }),
      });
      CAPABILITY_VERIFICATION.blockUser.verified = false;
      results.dispatchChecks = { autoBlock, unblock };
      expect(autoBlock.ok).toBe(false);
      expect(unblock.ok).toBe(false);
    }

    // ---- 5. reset 内存/Storage 一致（P0-3）----
    {
      const env = await makeRealEnv();
      const oldEpoch = env.queue.controlSnapshot().authorizationEpoch;
      await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'resetDefaults' } });
      const memory = env.queue.controlSnapshot();
      const storage = await env.repo.getQueueControl();
      results.resetControlDivergence = { memory: memory.authorizationEpoch, storage: storage.authorizationEpoch, memoryPaused: memory.paused, storagePaused: storage.paused };
      expect(memory).toEqual(storage);
      expect(memory.authorizationEpoch).toBe(oldEpoch + 1);
      expect(memory.paused).toBe(true);
    }

    // ---- 6. clear 后最小种子（P0-3）----
    {
      const env = await makeRealEnv();
      await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } });
      const raw = await env.backend.get(['bb.meta', 'bb.settings', 'bb.queueControl']);
      results.clearAllLeavesUnseeded = { meta: raw['bb.meta'] !== undefined, settings: raw['bb.settings'] !== undefined, queueControl: raw['bb.queueControl'] !== undefined };
      expect(raw['bb.meta']).toBeDefined();
      expect(raw['bb.settings']).toBeDefined();
      expect(raw['bb.queueControl']).toBeDefined();
    }

    // ---- 7. clearQueue 不丢 unknown 证据（P0-4）----
    {
      CAPABILITY_VERIFICATION.reportVideoComment.verified = true; // 探针临时启用（验证后恢复）
      (REPORT_REASONS as unknown as { verified: boolean }).verified = true;
      const backend = inMemoryBackend({ 'bb.settings': { ...DEFAULT_SETTINGS, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true } });
      const repo = new StorageRepository(backend);
      const coordinator = new StorageCoordinator(repo, null, null);
      const dedup = new DeduplicationRegistry(repo, coordinator.writer);
      const hangGate = deferred();
      const queue = new ActionQueue({
        repo, dedup, writer: coordinator.writer,
        executor: { execute: async () => { await hangGate.promise; return { ok: true, status: 'ok' }; } },
      });
      coordinator.attachQueue(queue);
      await queue.start();
      await queue.enqueue(
        [{ type: 'report', uid: 42, contentType: 'video_comment', contentId: 'r1', reasonId: 1, source: 'one_click' }],
        {},
        makeAuth({ type: 'report', contentType: 'video_comment' }),
      );
      await waitFor(() => queue.getStatus().inFlight === 1);
      const taskId = queue.pendingTasks()[0]?.id as string;
      await queue.revoke('probe clear', { pause: true, pauseKind: 'authorization_revoked', clearQueue: true, cause: 'clear' });
      hangGate.resolve();
      await new Promise((r) => setTimeout(r, 50));
      const recs = await backend.get(['bb.unknownOutcomes']);
      const records = (recs['bb.unknownOutcomes'] as UnknownOutcomeRecord[]) ?? [];
      results.clearQueueDropsUnknownEvidence = {
        pendingCount: queue.pendingTasks().length,
        recordCount: records.length,
        hasTask: records.some((r) => r.taskId === taskId),
        taskStatus: queue.pendingTasks().map((t) => t.status),
      };
      expect(records.some((r) => r.taskId === taskId)).toBe(true);
      expect(queue.pendingTasks().every((t) => t.status === 'unknown_outcome')).toBe(true);
      CAPABILITY_VERIFICATION.reportVideoComment.verified = false;
      (REPORT_REASONS as unknown as { verified: boolean }).verified = false;
    }

    // ---- 8. pause 可 await / 返回前持久化完成（P0-5）----
    {
      const gate = deferred();
      let started = false;
      let finished = false;
      const writer = {
        saveTasks: async () => undefined,
        saveControl: async () => { started = true; await gate.promise; finished = true; },
        markDedup: async () => undefined,
        clearDedup: async () => undefined,
        recordUnknownOutcome: async () => undefined,
      };
      const q = new ActionQueue({ repo: {} as never, dedup: {} as never, writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
      const ret = q.pause('风控', 'risk_control', true);
      const beforeRelease = { retType: typeof ret, started, finished };
      gate.resolve();
      await ret;
      results.pauseReturnsBeforePersistence = { beforeRelease, afterRelease: { started, finished } };
      expect(typeof ret).toBe('object'); // Promise（可 await）
      expect(finished).toBe(true);
    }

    // ---- 附加：operationId 幂等 / paused commitAction 拒绝 / BB_ENQUEUE 拒绝 ----
    {
      CAPABILITY_VERIFICATION.blockUser.verified = true; // 探针临时启用（验证后恢复）
      const env = await makeRealEnv();
      const request: CommitActionRequest = {
        operationId: 'op-probe-2', uid: 42, contentType: 'video_comment', contentId: 'r1',
        rootContentId: 'r1', oid: '1', contentHash: 'h', source: 'one_click',
        localActions: { commitLocalBlock: true, commitVerified: false },
        officialTasks: [{ type: 'block', uid: 42, source: 'one_click' }],
        skipOfficial: false, authorization: makeAuth({ type: 'block', contentType: 'video_comment' }),
        frameNonce: 'n', loginOk: true, currentMid: 999,
      };
      const r1 = await env.coordinator.execute({ kind: 'commitAction', request, origin: { tabId: 1, frameId: 0 } });
      const r2 = await env.coordinator.execute({ kind: 'commitAction', request, origin: { tabId: 1, frameId: 0 } });
      const queueLen = ((await env.backend.get(['bb.queue']))['bb.queue'] as unknown[]).length;
      results.operationIdIdempotent = { r1Enqueued: r1.enqueued, r2Enqueued: r2.enqueued, queueLen };
      expect(r1.enqueued).toBe(1);
      expect(r2.enqueued).toBe(1);
      expect(queueLen).toBe(1);

      // paused（风控）commitAction 不创建官方任务（5.1）
      await env.queue.pause('风控', 'risk_control', true);
      const pRes = await env.coordinator.execute({
        kind: 'commitAction',
        request: { ...request, operationId: 'op-probe-3', officialTasks: [{ type: 'block', uid: 43, source: 'one_click' }] },
        origin: { tabId: 1, frameId: 0 },
      });
      results.pausedCommitRejectsOfficial = { enqueued: pRes.enqueued ?? 0, ok: pRes.ok };
      expect(pRes.enqueued ?? 0).toBe(0);

      // BB_ENQUEUE 拒绝（5.3）
      const enqueueParsed = parseContentToBackground(
        { type: 'BB_ENQUEUE', tasks: [{ type: 'block', uid: 1, source: 'manual' }], frameNonce: 'n' },
        { tab: { id: 1 }, frameId: 0 },
      );
      results.bbEnqueueRejected = { ok: enqueueParsed.ok };
      expect(enqueueParsed.ok).toBe(false);
      CAPABILITY_VERIFICATION.blockUser.verified = false;
    }

    // ---- 写出证据文件 ----
    const evidence = {
      schema: 'BILIBLOCKER_V0.1.4_RUNTIME_INTEGRATION_EVIDENCE_V1',
      candidateVersion: '0.1.4',
      allDefectsClosed: true,
      findings: {
        externalWriteOverlap: false,
        authSnapshotDropped: false,
        autoProcessDisableNotEnforcedAtDispatch: false,
        unblockCapabilityNotEnforcedAtDispatch: false,
        resetControlDiverges: false,
        clearAllUnseeded: false,
        clearQueueLosesUnknownOutcome: false,
        pauseNotAwaitable: false,
      },
      results,
      runAt: new Date().toISOString(),
    };
    writeFileSync(resolve(process.cwd(), 'runtime-integration-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  });
});

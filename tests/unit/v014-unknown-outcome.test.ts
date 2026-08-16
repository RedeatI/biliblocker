/**
 * 1.5（P0-4 v0.1.4）：unknown_outcome 持久证据模型（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-4）：in_flight 任务被 revoke(clearQueue=true) 后
 * pending/lastSaved/done 全空——唯一证据消失。
 * 修复要求（对 in-flight report 依次执行 cancel/revoke/reset/clear）：
 * - 任务不显示 cancelled；结果为 unknown_outcome；不自动重发；
 * - 先原子写入 UnknownOutcomeRecord + 审计；普通队列随后可清理但证据保留；
 * - SW 重启后仍能看到结果未知记录（幂等：不重复、不丢失）；
 * - 同一 task 的 unknown 证据幂等（多路径不重复）；
 * - 只能用户显式「已人工核对/已知晓」，不能改写成 cancelled/succeeded。
 */
import { describe, expect, it, vi } from 'vitest';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { ActionQueue } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { makeRealEnv, makeAuth, waitFor, deferred } from './helpers/v014-env';
import type { ActionTask } from '@/shared/types';

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
  return { enabled: true, videoCommentsEnabled: true, dynamicsEnabled: true, suspiciousHandling: 'collapse' as const, quickActionDisplay: 'hover' as const, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true, operationDelayMs: 3000 };
}

/** 构造 in_flight report（真实派发：executor 挂起以保持 in_flight） */
async function makeInFlightReport(initial: Record<string, unknown> = {}) {
  const backend = inMemoryBackend({
    'bb.settings': verifiedSettings(),
    'bb.queueControl': { paused: false, pauseReason: null, pauseKind: 'none' as const, pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } },
    ...initial,
  });
  const repo = new StorageRepository(backend);
  const coordinator = new (await import('@/storage/coordinator')).StorageCoordinator(repo, null, null);
  const dedup = new DeduplicationRegistry(repo, coordinator.writer);
  const gate = deferred();
  const queue = new ActionQueue({
    repo, dedup, writer: coordinator.writer,
    executor: { execute: async () => { await gate.promise; return { ok: true, status: 'ok' }; } },
  });
  coordinator.attachQueue(queue);
  await queue.start();
  await queue.enqueue(
    [{ type: 'report', uid: 42, contentType: 'video_comment', contentId: 'r1', reasonId: 1, source: 'one_click' }],
    {},
    makeAuth({ type: 'report', contentType: 'video_comment' }),
  );
  await waitFor(() => queue.getStatus().inFlight === 1);
  const taskId = queue.pendingTasks().find((t) => t.type === 'report')?.id;
  if (!taskId) throw new Error('report task not dispatched');
  return { backend, repo, queue, coordinator, gate, taskId };
}
describe('1.5 unknown_outcome 持久证据（P0-4）', () => {
  it('in-flight report + cancel → unknown_outcome（非 cancelled）+ 持久记录（cause=cancel_in_flight）', async () => {
    const { backend, queue, taskId } = await makeInFlightReport();
    await queue.cancel([taskId]);
    const tasks = await backend.get(['bb.queue']);
    const t = (tasks['bb.queue'] as ActionTask[]).find((x) => x.id === taskId);
    expect(t?.status).toBe('unknown_outcome');
    expect(t?.status).not.toBe('cancelled');
    const recs = await backend.get(['bb.unknownOutcomes']);
    const records = (recs['bb.unknownOutcomes'] as { taskId: string; cause: string }[]) ?? [];
    const rec = records.find((r) => r.taskId === taskId);
    expect(rec).toBeDefined();
    expect(rec!.cause).toBe('cancel_in_flight');
  });

  it('in-flight report + revoke(clearQueue=true) → 证据不消失（pending 清空但 tombstone 保留）', async () => {
    const { backend, queue, taskId } = await makeInFlightReport();
    await queue.revoke('clear 测试', { pause: true, pauseKind: 'authorization_revoked', clearQueue: true, cause: 'revoke' });
    // 普通队列可清空（只保留 unknown 证据任务）
    expect(queue.pendingTasks().every((t) => t.status === 'unknown_outcome')).toBe(true);
    const recs = await backend.get(['bb.unknownOutcomes']);
    const records = (recs['bb.unknownOutcomes'] as { taskId: string; cause: string }[]) ?? [];
    expect(records.some((r) => r.taskId === taskId && r.cause === 'revoke')).toBe(true);
  });

  it('in-flight report + clear（经 coordinator 原子快照）→ 证据保留且 epoch 单调', async () => {
    const now = Date.now();
    const env = await makeRealEnv({
      'bb.queue': [{
        id: 'if-r2', groupId: 'g', type: 'report' as const, uid: 43, contentType: 'video_comment' as const,
        contentId: 'r2', reasonId: 1, source: 'one_click' as const, createdAt: now, attempts: 1, maxAttempts: 1,
        nextAttemptAt: now, status: 'in_flight' as const, authorization: makeAuth({ type: 'report', contentType: 'video_comment' }),
      }],
    });
    // in_flight 恢复时（start）已写 sw_restart 证据
    const recs1 = await env.backend.get(['bb.unknownOutcomes']);
    expect(((recs1['bb.unknownOutcomes'] as { taskId: string }[]) ?? []).some((r) => r.taskId === 'if-r2')).toBe(true);
    // clear 后证据仍在
    const oldEpoch = env.queue.controlSnapshot().authorizationEpoch;
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } });
    const recs2 = await env.backend.get(['bb.unknownOutcomes']);
    const afterClear = (recs2['bb.unknownOutcomes'] as { taskId: string }[]) ?? [];
    expect(afterClear.some((r) => r.taskId === 'if-r2')).toBe(true);
    expect(env.queue.controlSnapshot().authorizationEpoch).toBe(oldEpoch + 1);
    // 审计保留 outcomeUnknown 条目（不可逆操作证据不随 clear 删除；普通审计被清空）
    await env.coordinator.execute({
      kind: 'mutation',
      mutation: { op: 'appendAudit', entry: { uid: 43, trigger: 'system', matchedRuleIds: [], localHidden: false, outcomeUnknown: true } },
    });
    const beforeClear = await env.repo.getAuditLogs();
    expect(beforeClear.some((e) => e.outcomeUnknown === true)).toBe(true);
    await env.coordinator.execute({ kind: 'mutation', mutation: { op: 'clearAll' } });
    const audit = await env.repo.getAuditLogs();
    expect(audit.some((e) => e.outcomeUnknown === true)).toBe(true); // 结果未知条目保留
    expect(audit.some((e) => e.outcomeUnknown !== true)).toBe(false); // 普通条目被清空
  });

  it('SW 重启幂等：同一 task 多次 start 只产生一条记录（不重复、不丢失）', async () => {
    const { backend, queue, gate, taskId } = await makeInFlightReport();
    await queue.cancel([taskId]); // in_flight + cancel → unknown + 记录
    gate.resolve();
    await new Promise((r) => setTimeout(r, 30));
    // 之后多次重启不再重复写记录
    for (let i = 0; i < 3; i++) {
      const repo = new StorageRepository(backend);
      const coordinator = new (await import('@/storage/coordinator')).StorageCoordinator(repo, null, null);
      const dedup = new DeduplicationRegistry(repo, coordinator.writer);
      const queue = new ActionQueue({
        repo, dedup, writer: coordinator.writer,
        executor: { execute: async () => ({ ok: true, status: 'ok' }) },
      });
      coordinator.attachQueue(queue);
      await queue.start();
      await new Promise((r) => setTimeout(r, 30));
    }
    const recs = await backend.get(['bb.unknownOutcomes']);
    const records = (recs['bb.unknownOutcomes'] as { taskId: string }[]) ?? [];
    expect(records.filter((r) => r.taskId === taskId)).toHaveLength(1); // 幂等 upsert
    // 任务永不自动重发（unknown_outcome 不进入 pump）
    const tasks = await backend.get(['bb.queue']);
    const t = (tasks['bb.queue'] as ActionTask[]).find((x) => x.id === taskId);
    expect(t?.status).toBe('unknown_outcome');
    // 真实结果被保留（不覆盖为 cancelled/succeeded），但绝不自动重发（attempts 不增长）
    expect(t?.result?.ok).toBe(true);
    expect(t?.attempts).toBe(1);
  });

  it('用户显式「已人工核对」：只标记 acknowledgedAt，绝不改写成 cancelled/succeeded', async () => {
    const { backend, coordinator, queue, taskId } = await makeInFlightReport();
    await queue.cancel([taskId]);
    await coordinator.execute({ kind: 'acknowledgeUnknownOutcome', taskId });
    const recs = await backend.get(['bb.unknownOutcomes']);
    const records = (recs['bb.unknownOutcomes'] as { acknowledgedAt?: number; taskId: string }[]) ?? [];
    const rec = records.find((r) => r.taskId === taskId);
    expect(typeof rec?.acknowledgedAt).toBe('number');
    const tasks = await backend.get(['bb.queue']);
    const t = (tasks['bb.queue'] as ActionTask[]).find((x) => x.id === taskId);
    expect(t?.status).not.toBe('cancelled');
    expect(t?.status).not.toBe('succeeded');
  });

  it('unknown_outcome 任务不自动重发（executor 不被再次调用）', async () => {
    let executed = 0;
    const hangGate = deferred();
    const backend = inMemoryBackend({
      'bb.settings': verifiedSettings(),
      'bb.queueControl': { paused: false, pauseReason: null, pauseKind: 'none' as const, pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } },
    });
    const repo = new StorageRepository(backend);
    const coordinator = new (await import('@/storage/coordinator')).StorageCoordinator(repo, null, null);
    const dedup = new DeduplicationRegistry(repo, coordinator.writer);
    const queue = new ActionQueue({
      repo, dedup, writer: coordinator.writer,
      executor: { execute: async () => { executed++; await hangGate.promise; return { ok: true, status: 'ok' }; } },
    });
    coordinator.attachQueue(queue);
    await queue.start();
    // 派发后在 in_flight 期间撤销 → unknown_outcome（executor 已调用一次，绝不自动重发）
    await queue.enqueue(
      [{ type: 'report', uid: 44, contentType: 'video_comment', contentId: 'r3', reasonId: 1, source: 'one_click' }],
      {},
      makeAuth({ type: 'report', contentType: 'video_comment' }),
    );
    await waitFor(() => queue.getStatus().inFlight === 1);
    expect(executed).toBe(1);
    await queue.revoke('撤销', { pause: false });
    hangGate.resolve();
    await new Promise((r) => setTimeout(r, 100));
    expect(executed).toBe(1); // unknown_outcome 不自动重发
    const tasks = await repo.getQueueTasks();
    const t = tasks.find((x) => x.type === 'report');
    expect(t?.status).toBe('unknown_outcome');
  });
});

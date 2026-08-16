/**
 * 1.9（5.5 v0.1.4）：operationId 幂等（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE 5.5）：operationId 未作为幂等键——消息重发/响应丢失时
 * 同一 BB_COMMIT_ACTION 可能重复写名单/入队。
 * 修复要求：
 * - 相同 operationId：首次响应丢失后重发不重复写名单、不重复创建 queue task、
 *   返回与第一次相同的确定结果；
 * - operationId 绑定 tab/frame/frameNonce/uid/contentId/hash；
 * - 不同请求复用同一 operationId 时拒绝；
 * - 幂等记录有 TTL 和容量上限。
 */
import { describe, expect, it, vi } from 'vitest';
import { OPERATION_OUTCOME, STORAGE_KEYS } from '@/shared/constants/defaults';
import { commitRequest, makeRealEnv } from './helpers/v014-env';

vi.mock('@/shared/capabilities', () => ({
  isCapabilityEnabled: () => true,
  canReportContentType: () => true,
  capabilityDenyReason: () => null,
  selectorCapabilityFor: () => 'selectorsVideo',
  areSelectorsVerified: () => true,
  capabilityForTaskType: (type: string) => (type === 'report' ? 'reportVideoComment' : type === 'unblock' ? 'unblockUser' : 'blockUser'),
}));
vi.mock('@/shared/constants/report-reasons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/constants/report-reasons')>();
  return { ...actual, REPORT_REASONS: { ...actual.REPORT_REASONS, verified: true } };
});

describe('1.9 operationId 幂等（5.5）', () => {
  it('相同 operationId 重发：不重复写名单、不重复创建 queue task、返回相同确定结果', async () => {
    const env = await makeRealEnv();
    const request = commitRequest({
      operationId: 'op-idem-1',
      officialTasks: [{ type: 'block', uid: 10001, source: 'one_click' }],
    });
    const r1 = await env.coordinator.execute({ kind: 'commitAction', request, origin: { tabId: 1, frameId: 0 } });
    const r2 = await env.coordinator.execute({ kind: 'commitAction', request, origin: { tabId: 1, frameId: 0 } });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.enqueued).toBe(r1.enqueued); // 相同确定结果
    const raw = await env.backend.get(['bb.queue', 'bb.blocked']);
    expect((raw['bb.queue'] as unknown[]).length).toBe(1); // 不重复创建
    expect((raw['bb.blocked'] as unknown[]).length).toBe(1); // 不重复写名单
  });

  it('不同请求复用同一 operationId → 拒绝（operationId_reused）', async () => {
    const env = await makeRealEnv();
    const first = commitRequest({ operationId: 'op-idem-2', contentId: 'rpid-A' });
    await env.coordinator.execute({ kind: 'commitAction', request: first, origin: { tabId: 1, frameId: 0 } });
    // 同一 operationId、不同 contentId（不同绑定指纹）
    const second = commitRequest({ operationId: 'op-idem-2', contentId: 'rpid-B' });
    const res = await env.coordinator.execute({ kind: 'commitAction', request: second, origin: { tabId: 1, frameId: 0 } });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('operationId_reused');
    // 不同 frameNonce 也视为不同绑定
    const third = commitRequest({ operationId: 'op-idem-2', frameNonce: 'other-nonce' });
    const res3 = await env.coordinator.execute({ kind: 'commitAction', request: third, origin: { tabId: 1, frameId: 0 } });
    expect(res3.ok).toBe(false);
    expect(res3.code).toBe('operationId_reused');
  });

  it('幂等结果持久化：重建协调器（SW 重启）后相同 operationId 仍返回已保存结果', async () => {
    const env = await makeRealEnv();
    const request = commitRequest({
      operationId: 'op-idem-3',
      officialTasks: [{ type: 'block', uid: 10002, source: 'one_click' }],
    });
    await env.coordinator.execute({ kind: 'commitAction', request, origin: { tabId: 1, frameId: 0 } });
    const raw = await env.backend.get(['bb.queue']);
    const queueLen1 = (raw['bb.queue'] as unknown[]).length;

    // 重建协调器（同一 backend）
    const { StorageRepository } = await import('@/storage/repository');
    const { StorageCoordinator } = await import('@/storage/coordinator');
    const { ActionQueue } = await import('@/actions/queue');
    const { DeduplicationRegistry } = await import('@/actions/dedup');
    const repo2 = new StorageRepository(env.backend as never);
    await repo2.init();
    const coordinator2 = new StorageCoordinator(repo2, null, null);
    const queue2 = new ActionQueue({ repo: repo2, dedup: new DeduplicationRegistry(repo2, coordinator2.writer), writer: coordinator2.writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    coordinator2.attachQueue(queue2);
    await queue2.start();
    const r2 = await coordinator2.execute({ kind: 'commitAction', request, origin: { tabId: 1, frameId: 0 } });
    expect(r2.ok).toBe(true);
    expect(r2.enqueued).toBe(1); // 与首次相同
    const raw2 = await env.backend.get(['bb.queue']);
    expect((raw2['bb.queue'] as unknown[]).length).toBe(queueLen1); // 不重复入队
  });

  it('幂等记录有 TTL 与容量上限（常量存在；过期记录读取时清理）', async () => {
    expect(OPERATION_OUTCOME.TTL_MS).toBeGreaterThan(0);
    expect(OPERATION_OUTCOME.MAX_RECORDS).toBeGreaterThan(0);
    const env = await makeRealEnv();
    // 写入一条已过期的记录 → 读取时视为不存在（可重新执行）
    const stale = {
      binding: 'stale-binding',
      result: { ok: true },
      ts: Date.now() - OPERATION_OUTCOME.TTL_MS - 1000,
    };
    const backend = env.backend;
    await backend.set({ [STORAGE_KEYS.operationOutcomes]: { 'op-stale': stale } });
    const repo = await import('@/storage/repository');
    const repo2 = new repo.StorageRepository(backend);
    const outcome = await repo2.getOperationOutcome('op-stale');
    expect(outcome).toBeNull(); // 过期清理
  });
});

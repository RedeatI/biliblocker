/**
 * 1.6（P1-3 v0.1.5）：operationId 结果必须与副作用原子提交（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P1-3）：commitAction 先 commitSnapshot(名单/队列)，再单独
 * saveOperationOutcome；第二次写失败时异常被吞掉并注释「可接受降级」→ 同一 operationId
 * 重放不能返回第一次的确定结果；不同 binding 在结果记录缺失窗口内无法得到承诺的拒绝。
 *
 * 修复要求（成功路径单次 commitSnapshot 原子包含全部副作用）：
 * - blocked/verified delta、queue delta、queue revision/control、bb.operationOutcomes
 *   在同一次 backend.set 中；
 * - 原子写失败时全部不落盘（不得先落盘名单再丢 outcome）；
 * - 响应丢失后相同 operationId 返回完全相同结果；
 * - 不同 binding 复用同一 operationId 必须拒绝；
 * - 不得用 catch 吞掉 outcome 持久化错误；
 * - TTL/容量清理仍然有效。
 */
import { describe, expect, it, vi } from 'vitest';
import { cloneBackend, makeRealEnv015 } from './helpers/v015-env';
import { commitRequest } from './helpers/v014-env';
import { OPERATION_OUTCOME, STORAGE_KEYS } from '@/shared/constants/defaults';

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

describe('1.6 operationId 结果必须与副作用原子提交（P1-3）', () => {
  it('成功路径：blocked/verified/queue 与 operationOutcomes 在同一次 backend.set 中（无独立 outcome 写窗口）', async () => {
    const base = cloneBackend();
    const setCalls: string[][] = [];
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        setCalls.push(Object.keys(items));
        await base.set(items);
      },
      remove: (keys: string[]) => base.remove(keys),
    };
    const env = await makeRealEnv015({}, undefined, { backend });
    const req = commitRequest({
      operationId: 'op-atomic-1',
      uid: 555,
      officialTasks: [{ type: 'block', uid: 555, source: 'one_click' }],
    });
    const r1 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    expect(r1.ok).toBe(true);

    // 存在一次同时含 blocked + queue + operationOutcomes 的 set（原子提交）
    const atomic = setCalls.find(
      (keys) =>
        keys.includes(STORAGE_KEYS.blocked) &&
        keys.includes(STORAGE_KEYS.queue) &&
        keys.includes(STORAGE_KEYS.operationOutcomes),
    );
    expect(atomic).toBeDefined();
  });

  it('「outcome 单独写失败」的旧场景已不存在：注入 outcome 写失败 → 原子失败，全部不落盘', async () => {
    const base = cloneBackend();
    // 旧缺陷：主要副作用可以写（bb.blocked 可写），outcome 单独写失败（bb.operationOutcomes 不可写）
    // 注意：init 播种也会写 operationOutcomes（空对象），因此用开关在 init 完成后才开启失败
    let failOutcome = false;
    let outcomeWriteAttempts = 0;
    const backend = {
      get: (keys: string[]) => base.get(keys),
      set: async (items: Record<string, unknown>) => {
        if (failOutcome && items[STORAGE_KEYS.operationOutcomes] !== undefined) {
          outcomeWriteAttempts++;
          throw new Error('outcome 写失败');
        }
        await base.set(items);
      },
      remove: (keys: string[]) => base.remove(keys),
    };
    const env = await makeRealEnv015({}, undefined, { backend });
    failOutcome = true;
    const req = commitRequest({
      operationId: 'op-atomic-2',
      uid: 556,
      officialTasks: [{ type: 'block', uid: 556, source: 'one_click' }],
    });
    const r1 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    // 修复后：outcome 与 blocked/queue 原子提交 → 该次 set 失败 → 整个操作失败
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe('storage_failed');
    // 全部不落盘：blocked 为空、queue 为空、无 outcome
    const raw = await base.get([STORAGE_KEYS.blocked, STORAGE_KEYS.queue, STORAGE_KEYS.operationOutcomes]);
    expect(raw[STORAGE_KEYS.blocked]).toEqual([]);
    expect(raw[STORAGE_KEYS.queue]).toEqual([]);
    expect(raw[STORAGE_KEYS.operationOutcomes]).toEqual({});
    // 同一 operationId 重放：返回相同结果（仍失败、仍不落盘）——绝不出现「第一次成功第二次不同」
    const r2 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('storage_failed');
    const raw2 = await base.get([STORAGE_KEYS.blocked, STORAGE_KEYS.queue, STORAGE_KEYS.operationOutcomes]);
    expect(raw2[STORAGE_KEYS.blocked]).toEqual([]);
    expect(raw2[STORAGE_KEYS.queue]).toEqual([]);
    // 不得用 catch 吞掉 outcome 持久化错误：outcome 写失败导致整个操作显式失败（上面 code 已证明）
    expect(outcomeWriteAttempts).toBeGreaterThanOrEqual(1);
  });

  it('成功提交后：响应丢失重发返回完全相同结果（同 operationId 幂等）', async () => {
    const env = await makeRealEnv015();
    const req = commitRequest({
      operationId: 'op-atomic-3',
      uid: 557,
      officialTasks: [{ type: 'block', uid: 557, source: 'one_click' }],
    });
    const r1 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    const r2 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    expect(r1).toEqual(r2); // 完全相同结果
    const raw = await env.backend.get([STORAGE_KEYS.blocked, STORAGE_KEYS.queue]);
    expect((raw[STORAGE_KEYS.blocked] as unknown[]).length).toBe(1); // 不重复写
    expect((raw[STORAGE_KEYS.queue] as unknown[]).length).toBe(1); // 不重复入队
  });

  it('不同 binding 复用同一 operationId 必须拒绝（原子绑定记录在 outcome 中）', async () => {
    const env = await makeRealEnv015();
    const first = commitRequest({ operationId: 'op-atomic-4', uid: 558, contentId: 'rpid-A' });
    await env.coordinator.execute({ kind: 'commitAction', request: first, origin: { tabId: 1, frameId: 0 } });
    const second = commitRequest({ operationId: 'op-atomic-4', uid: 558, contentId: 'rpid-B' });
    const res = await env.coordinator.execute({ kind: 'commitAction', request: second, origin: { tabId: 1, frameId: 0 } });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('operationId_reused');
  });

  it('TTL/容量清理仍然有效', async () => {
    expect(OPERATION_OUTCOME.TTL_MS).toBeGreaterThan(0);
    expect(OPERATION_OUTCOME.MAX_RECORDS).toBeGreaterThan(0);
    const env = await makeRealEnv015();
    // 写入一条已过期记录 → 读取时视为不存在（可重新执行）
    const stale = { binding: 'stale-binding', result: { ok: true }, ts: Date.now() - OPERATION_OUTCOME.TTL_MS - 1000 };
    await env.backend.set({ [STORAGE_KEYS.operationOutcomes]: { 'op-stale': stale } });
    const { StorageRepository } = await import('@/storage/repository');
    const repo2 = new StorageRepository(env.backend as never);
    expect(await repo2.getOperationOutcome('op-stale')).toBeNull();
  });
});

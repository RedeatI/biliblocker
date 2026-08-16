/**
 * 复验 P0-2（阶段 E 第二轮）：revalidateQueued() 与 runTask 并发时
 * 不得把已派发（in_flight）任务回退成 queued（先红后绿）。
 *
 * 反例路径（复验报告）：
 * importAll（锁内）→ queue.revalidateQueued('名单已导入', scopedWriter)：
 * - revalidateQueued 先 `const tasks = this.pendingTasks()`（克隆，t1=queued）；
 * - buildRevalidated 内部多个 await（verifyTaskEligible 读 settings/whitelist）；
 * - 期间 pump 的 runTask 把 t1 改为 in_flight（内存 + 尝试持久化）；
 * - revalidate 返回 → applyTasksIfChanged(next) 判定 changed →
 *   adoptTasks(next) 用旧克隆（queued）全量替换内存 → in_flight 回退 queued；
 * - runTask 持有的旧 task 对象脱离 this.tasks → 结果无法正确写回 →
 *   Storage 仍可能留下 queued → 后续再次派发（executor 第二次执行）。
 *
 * 断言（修复后）：
 * - revalidate 后 t1 不得回退 queued（保持 in_flight）；
 * - executor 恰好执行一次（不重复派发）；
 * - Storage 最终为 succeeded（结果正确写回）。
 */
import { describe, expect, it, vi } from 'vitest';
import { deferred, makeAuth, waitFor } from './helpers/v014-env';
import { cloneBackend, makeRealEnv015, mkTask } from './helpers/v015-env';

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

describe('复验 P0-2：revalidateQueued 与 runTask 并发不得回退 in_flight', () => {
  it('锁内 revalidateQueued 期间 pump 把任务改为 in_flight：revalidate 采用后不得回退 queued，executor 恰好一次', async () => {
    // 挂起 verifyTaskEligible 里第一次 getWhitelist 读取（revalidate 的 verify），
    // 放行第二次（runTask 的 verify），从而在「克隆之后、adopt 之前」插入 runTask 修改。
    let whitelistCalls = 0;
    let armGate = false; // 仅在 importAll 之后挂起第一次 whitelist 读（revalidate 的 verify）
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
    // 预置 queued 任务 t1（授权有效：epoch 0、settingsRevision 0、capabilityKey=blockUser）
    // 预置 queued 任务 t1（授权有效：epoch 0、settingsRevision 0、capabilityKey=blockUser）
    const t1 = mkTask('t1', 1, { authorization: makeAuth({ type: 'block' }) });
    await env.backend.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);

    // 锁内 importAll（无 settings → revalidateQueued('名单已导入', scopedWriter)）
    // 先启用 gate：之后第一次 getWhitelist（revalidate 的 verify）挂起，第二次（runTask 的 verify）放行
    armGate = true;
    whitelistCalls = 0;
    const pImport = env.coordinator.execute({
      kind: 'mutation',
      mutation: { op: 'importAll', data: { schemaVersion: 1, blocked: [] } },
    });
    // 等 revalidate 的 verify 挂起（第一次 getWhitelist 已进入）
    await waitFor(() => whitelistCalls >= 1);

    // pump 运行 runTask(t1)：verify（第二次 getWhitelist 放行）→ in_flight → executor 挂起
    env.queue.kick();
    await waitFor(() => env.queue.getStatus().inFlight === 1);

    // 释放 revalidate 的 verify → buildRevalidated 返回（t1 克隆仍 queued）→ 合并/采用
    gateWhitelist.resolve();
    await pImport;

    // ---- 断言 1：t1 不得回退 queued（当前代码 adoptTasks 全量替换 → queued → red）----
    const afterRevalidate = env.queue.pendingTasks().find((t) => t.id === 't1');
    expect(afterRevalidate?.status).not.toBe('queued');
    expect(afterRevalidate?.status).toBe('in_flight');

    // ---- 释放 executor → runTask 完成 succeeded；不得再次派发 ----
    gateExec.resolve();
    await new Promise((r) => setTimeout(r, 150));

    // ---- 断言 2：executor 恰好一次（当前代码回退 queued 后 pump 再次派发 → 2 次 → red）----
    expect(execCalls).toBe(1);
    // ---- 断言 3：Storage 最终为 succeeded（结果正确写回，不残留 queued）----
    const raw = await base.get(['bb.queue']);
    const finalT1 = (raw['bb.queue'] as { id: string; status: string }[]).find((t) => t.id === 't1');
    expect(finalT1?.status).toBe('succeeded');
  });
});

/**
 * 复验 P0-5b（v0.1.7）：revoke 的 saveControl in-flight 期间 verify 恢复 → 不得派发。
 *
 * 缺陷路径（独立复现 repro-p05-residual-window.ts / repro-p05-residual-report.ts）：
 * - pump → runTask → verifyTaskEligible 挂起在 getWhitelist（backend.get await）；
 * - 窗口内 revoke 开始（锁内）：`control.authorizationEpoch += 1`（**同步内存**修改）
 *   → `await w.saveControl(...)`（backend.set 挂起期间，repo cache 仍旧 epoch）；
 * - 放行 verify → check-latest-again 读 repo **cache**（旧 epoch）→ 返回 ok；
 * - runTask 二次确认（v0.1.6 只查 task.status）→ revoke 的 queued→cancelled 循环在
 *   saveControl await **之后**才执行，任务仍 queued → 通过 → executor 被调用（请求发出）；
 * - revoke 完成循环时任务已是 in_flight → unknown_outcome（请求已发出，不可逆）。
 *
 * 断言（修复后）：
 * - revoke/cancel 的存储写挂起窗口内 executor 调用恒为 0；
 * - 最终存储状态 cancelled/skipped（绝不 unknown_outcome/succeeded）；
 * - revoke 场景 authorizationEpoch === 1。
 *
 * 入口覆盖：kick → pump（场景 1-3、5）；resume 末尾 pump（场景 4）。
 *
 * 先红：本文件在 v0.1.6 生产代码上运行 → executor 调用 1 次 → 红。
 */
import { describe, expect, it, vi } from 'vitest';
import { deferred, makeAuth, verifiedSettings, waitFor } from './helpers/v014-env';
import { cloneBackend, makeRealEnv015, mkTask } from './helpers/v015-env';
import type { StorageRepository } from '@/storage/repository';
import type { ActionTask, TaskResult } from '@/shared/types';

vi.mock('@/shared/capabilities', () => ({
  isCapabilityEnabled: () => true,
  canReportContentType: () => true,
  capabilityDenyReason: () => null,
  selectorCapabilityFor: () => 'selectorsVideo',
  areSelectorsVerified: () => true,
  capabilityForTaskType: (type: string) =>
    type === 'report' ? 'reportVideoComment' : type === 'unblock' ? 'unblockUser' : 'blockUser',
}));
vi.mock('@/shared/constants/report-reasons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/constants/report-reasons')>();
  return { ...actual, REPORT_REASONS: { ...actual.REPORT_REASONS, verified: true } };
});

interface GatedEnv017 {
  env: Awaited<ReturnType<typeof makeRealEnv015>>;
  base: ReturnType<typeof cloneBackend>;
  gateWhitelist: { promise: Promise<void>; resolve: (v: void) => void; reject: (e: unknown) => void };
  gateControlWrite: { promise: Promise<void>; resolve: (v: void) => void; reject: (e: unknown) => void };
  arm: () => void;
  getWhitelistCalls: () => number;
  holdControlWrite: () => void;
  controlWriteHeld: () => boolean;
}

/**
 * 双 gate 环境：
 * - getWhitelist 读 gate（verify 挂起；第 gateAt 次读挂起）
 * - bb.queueControl 写 gate（revoke 的 saveControl 挂起；arm 后才生效，模拟存储慢写）
 */
async function makeGatedEnv017(
  executor: { execute: (t: ActionTask) => Promise<TaskResult> },
  gateAt = 1,
): Promise<GatedEnv017> {
  let whitelistCalls = 0;
  let armGate = false;
  let holdControl = false;
  let controlHeld = false;
  let repoRef: StorageRepository | null = null;
  const gateWhitelist = deferred();
  const gateControlWrite = deferred();
  const base = cloneBackend({ 'bb.settings': verifiedSettings() });
  const backend = {
    get: async (keys: string[]) => {
      if (keys.includes('bb.whitelist')) {
        whitelistCalls++;
        if (armGate && whitelistCalls === gateAt) await gateWhitelist.promise;
      }
      return base.get(keys);
    },
    set: async (items: Record<string, unknown>) => {
      // 模拟外部存储变化：写后失效缓存（否则 Repository.read 缓存让后续 verify 不读 backend）
      repoRef?.invalidate();
      if (holdControl && items['bb.queueControl'] !== undefined) {
        controlHeld = true;
        await gateControlWrite.promise; // revoke 的 saveControl 挂起（epoch 未落 cache/backend）
      }
      await base.set(items);
    },
    remove: (keys: string[]) => base.remove(keys),
  };
  const env = await makeRealEnv015({}, executor, { backend });
  repoRef = env.repo;
  return {
    env,
    base,
    gateWhitelist,
    gateControlWrite,
    arm: () => { armGate = true; whitelistCalls = 0; },
    getWhitelistCalls: () => whitelistCalls,
    holdControlWrite: () => { holdControl = true; controlHeld = false; },
    controlWriteHeld: () => controlHeld,
  };
}

function blockTask(id: string, uid: number): ActionTask {
  return mkTask(id, uid, { authorization: makeAuth({ type: 'block' }) });
}

function reportTask(id: string, uid: number): ActionTask {
  return mkTask(id, uid, {
    type: 'report' as const,
    maxAttempts: 1,
    contentType: 'video_comment' as const,
    contentId: `rpid-${uid}`,
    reasonId: 1,
    authorization: makeAuth({ type: 'report', contentType: 'video_comment', reasonId: 1 }),
  });
}

describe('复验 P0-5b：revoke/cancel 的存储写挂起窗口内不得派发（先红后绿）', () => {
  it('场景 1：block 任务 verify 挂起 + revoke 的 saveControl 挂起 → executor=0、cancelled、epoch=1', async () => {
    let execCalls = 0;
    const { env, base, gateWhitelist, gateControlWrite, arm, getWhitelistCalls, holdControlWrite, controlWriteHeld } =
      await makeGatedEnv017({ execute: async () => { execCalls++; return { ok: true, status: 'ok' }; } });
    const t1 = blockTask('w1', 70);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    arm();
    env.queue.kick(); // runTask → verify 挂起在 getWhitelist
    await waitFor(() => getWhitelistCalls() >= 1);
    // revoke 开始：epoch+1（内存）→ saveControl 写挂起（cache 仍旧 epoch）
    holdControlWrite();
    const pRevoke = env.coordinator.execute({ kind: 'revoke', reason: '窗口撤权', pause: false });
    await waitFor(() => controlWriteHeld());
    // 放行 verify → check-latest-again 读 cache 旧 epoch →（v0.1.6）二次确认通过 → executor
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 150));
    const midStatus = env.queue.pendingTasks().find((x) => x.id === 'w1')?.status;
    // 释放 revoke 的 saveControl → revoke 完成
    gateControlWrite.resolve();
    await pRevoke;
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue', 'bb.queueControl']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'w1');
    const epoch = (raw['bb.queueControl'] as { authorizationEpoch: number }).authorizationEpoch;
    expect(execCalls).toBe(0); // 修复前：1 次（red）
    expect(['cancelled', 'skipped']).toContain(finalT?.status); // 修复前：unknown_outcome（red）
    expect(epoch).toBe(1);
    // 修复后：二次确认（内存 epoch 不匹配）直接 return，executor=0；任务残留 queued →
    // pump 循环再次 runTask 时 verify 早期内存 epoch 检查捕获 → skipped（终态），不会重复派发
    expect(['cancelled', 'skipped']).toContain(midStatus);
  });

  it('场景 2：report 任务 verify 挂起 + revoke 的 saveControl 挂起 → executor=0（不可逆副作用路径）', async () => {
    let execCalls = 0;
    const { env, base, gateWhitelist, gateControlWrite, arm, getWhitelistCalls, holdControlWrite, controlWriteHeld } =
      await makeGatedEnv017({ execute: async () => { execCalls++; return { ok: true, status: 'ok' }; } });
    const t1 = reportTask('wr1', 71);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    arm();
    env.queue.kick();
    await waitFor(() => getWhitelistCalls() >= 1);
    holdControlWrite();
    const pRevoke = env.coordinator.execute({ kind: 'revoke', reason: '窗口撤权', pause: false });
    await waitFor(() => controlWriteHeld());
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 150));
    gateControlWrite.resolve();
    await pRevoke;
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'wr1');
    expect(execCalls).toBe(0); // 修复前：1 次（red）
    expect(['cancelled', 'skipped']).toContain(finalT?.status); // 修复前：unknown_outcome（red）
  });

  it('场景 3：block 任务 verify 挂起 + cancelTasks 的 persist 挂起 → executor=0（回归保护）', async () => {
    let execCalls = 0;
    let whitelistCalls = 0;
    let armGate = false;
    let holdQueueWrite = false;
    let queueWriteHeld = false;
    const gateWhitelist = deferred();
    const gateQueueWrite = deferred();
    const base = cloneBackend({ 'bb.settings': verifiedSettings() });
    const backend = {
      get: async (keys: string[]) => {
        if (keys.includes('bb.whitelist')) {
          whitelistCalls++;
          if (armGate && whitelistCalls === 1) await gateWhitelist.promise;
        }
        return base.get(keys);
      },
      set: async (items: Record<string, unknown>) => {
        if (holdQueueWrite && items['bb.queue'] !== undefined) {
          queueWriteHeld = true;
          await gateQueueWrite.promise;
        }
        await base.set(items);
      },
      remove: (keys: string[]) => base.remove(keys),
    };
    const env = await makeRealEnv015({}, { execute: async () => { execCalls++; return { ok: true, status: 'ok' }; } }, { backend });
    const t1 = blockTask('wc1', 72);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    armGate = true;
    whitelistCalls = 0;
    env.queue.kick();
    await waitFor(() => whitelistCalls >= 1);
    // cancel：queued→cancelled 是同步的；persist（bb.queue 写）挂起
    holdQueueWrite = true;
    const pCancel = env.coordinator.execute({ kind: 'cancelTasks', taskIds: ['wc1'] });
    await waitFor(() => queueWriteHeld);
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 100));
    gateQueueWrite.resolve();
    await pCancel;
    await new Promise((r) => setTimeout(r, 150));
    const raw = await base.get(['bb.queue']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'wc1');
    expect(execCalls).toBe(0); // cancel 同步改状态，v0.1.6 已防（回归保护）
    expect(['cancelled', 'skipped']).toContain(finalT?.status);
  });

  it('场景 4：resume 末尾 pump 触发 runTask 时，verify 挂起 + revoke saveControl 挂起 → executor=0', async () => {
    let execCalls = 0;
    // 第 1 次 whitelist 读 = resume 的 revalidation verify（放行）；第 2 次 = runTask 的 verify（挂起）
    const { env, base, gateWhitelist, gateControlWrite, arm, getWhitelistCalls, holdControlWrite, controlWriteHeld } =
      await makeGatedEnv017({ execute: async () => { execCalls++; return { ok: true, status: 'ok' }; } }, 2);
    await env.queue.pause('暂停', 'user');
    const t1 = blockTask('wrs1', 73);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    arm();
    const pResume = env.queue.resume('user');
    await waitFor(() => getWhitelistCalls() >= 2);
    holdControlWrite();
    const pRevoke = env.coordinator.execute({ kind: 'revoke', reason: 'resume 窗口撤权', pause: false });
    await waitFor(() => controlWriteHeld());
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 150));
    gateControlWrite.resolve();
    await pRevoke;
    await pResume;
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'wrs1');
    expect(execCalls).toBe(0); // 修复前：1 次（red）
    expect(['cancelled', 'skipped']).toContain(finalT?.status);
  });

  it('场景 5：任务完成回调后 pump 继续派发第二任务，其 verify 挂起 + revoke saveControl 挂起 → 第二任务不派发', async () => {
    let execCalls = 0;
    // 第 1 次 whitelist 读 = t1 verify（放行）；第 2 次 = t2 verify（挂起）
    const { env, base, gateWhitelist, gateControlWrite, arm, getWhitelistCalls, holdControlWrite, controlWriteHeld } =
      await makeGatedEnv017({ execute: async () => { execCalls++; return { ok: true, status: 'ok' }; } }, 2);
    const t1 = blockTask('t1', 74);
    const t2 = blockTask('t2', 75);
    await base.set({ 'bb.queue': [t1, t2] });
    env.queue.adoptTasks([t1, t2]);
    arm();
    env.queue.kick(); // t1 verify(#1) → 执行 → 完成 → t2 verify(#2) 挂起
    await waitFor(() => getWhitelistCalls() >= 2);
    holdControlWrite();
    const pRevoke = env.coordinator.execute({ kind: 'revoke', reason: 't2 派发前撤权', pause: false });
    await waitFor(() => controlWriteHeld());
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 150));
    gateControlWrite.resolve();
    await pRevoke;
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const q = raw['bb.queue'] as { id: string; status: string }[];
    const f1 = q.find((x) => x.id === 't1');
    const f2 = q.find((x) => x.id === 't2');
    expect(execCalls).toBe(1); // 仅 t1（修复前：2 次 → red）
    expect(f1?.status).toBe('succeeded');
    expect(['cancelled', 'skipped']).toContain(f2?.status); // 修复前：unknown_outcome（red）
  });
});

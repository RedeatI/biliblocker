/**
 * 复验 P0-5（阶段 E 独立复验 / v0.1.6）：stale verdict TOCTOU。
 *
 * 缺陷路径（独立复现 repro-h-race.ts / repro-cancel-race.ts）：
 * - pump → runTask(task) → verifyTaskEligible：epoch 检查（旧代码位于
 *   getSettingsRevision/getWhitelist 两个 await **之前**）通过后，
 *   在 getWhitelist 的 backend await 中挂起；
 * - 挂起窗口内 revoke（epoch++，queued→cancelled）或 cancelTasks（queued→cancelled）；
 * - verify 恢复 → 拿到陈旧 {ok:true} → runTask 直接 task.status='in_flight'（覆盖 cancelled）
 *   → executor 被调用 → 真实官方请求发出 → 最终存储 succeeded（撤权被吞掉）。
 *
 * 断言（修复后）：
 * - revoke/cancel 窗口内 executor 调用恒为 0；
 * - 最终存储状态 cancelled/skipped（绝不 succeeded）；
 * - revoke 场景 authorizationEpoch === 1。
 *
 * 入口覆盖：
 * - kick() → pump()（场景 1-4、6）；
 * - resume() 末尾 pump()（场景 5）；
 * - 任务完成回调后 pump 循环继续派发下一任务（场景 6）。
 *
 * 关键测试机制：
 * - StorageRepository.read() 首次读后走缓存，后续 verify 不再命中 backend；
 *   因此本文件在 backend.set 钩子中失效仓库缓存（模拟外部存储变化），
 *   保证每次 verifyTaskEligible 都真正读 backend，从而可对第 N 次 whitelist 读注入 gate。
 *
 * 先红：本文件在 v0.1.5 生产代码上运行 → executor 调用 1 次（或 2 次）→ 红。
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

interface GatedEnv {
  env: Awaited<ReturnType<typeof makeRealEnv015>>;
  base: ReturnType<typeof cloneBackend>;
  gateWhitelist: { promise: Promise<void>; resolve: (v: void) => void; reject: (e: unknown) => void };
  arm: () => void;
  getWhitelistCalls: () => number;
}

/**
 * 构造 gate 挂在第 gateAt 次 whitelist 读的环境。
 * backend.set 钩子：每次 backend 写后失效仓库缓存，使下一次 verify 重新读 backend
 * （否则 Repository.read 缓存会让第二次 verify 不再触发 backend 读、gate 失效）。
 */
async function makeGatedEnv(
  executor: { execute: (t: ActionTask) => Promise<TaskResult> },
  gateAt = 1,
): Promise<GatedEnv> {
  let whitelistCalls = 0;
  let armGate = false;
  let repoRef: StorageRepository | null = null;
  const gateWhitelist = deferred();
  // 注意：makeRealEnv015 传入 opts.backend 时忽略 initial 种子，
  // 因此必须在 base backend 中显式播种 settings（举报授权/默认理由/自动处理全开）。
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
      // 模拟外部存储变化：写后失效缓存 → 后续 verify 重新读 backend（gate 可命中）
      repoRef?.invalidate();
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
    arm: () => { armGate = true; whitelistCalls = 0; },
    getWhitelistCalls: () => whitelistCalls,
  };
}

/** block 任务（合法授权：epoch 0、settingsRevision 0、capabilityKey=blockUser） */
function blockTask(id: string, uid: number): ActionTask {
  return mkTask(id, uid, { authorization: makeAuth({ type: 'block' }) });
}

/** report 任务（不可逆副作用路径；reasonId 1 = 垃圾广告，对 video_comment 有效） */
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

describe('复验 P0-5：撤权/取消在 verify 挂起窗口内发生时不得派发（先红后绿）', () => {
  it('场景 1：queued block 任务 verify 挂起 → revoke → executor=0、存储 cancelled、epoch=1', async () => {
    let execCalls = 0;
    const { env, base, gateWhitelist, arm, getWhitelistCalls } = await makeGatedEnv({
      execute: async () => { execCalls++; return { ok: true, status: 'ok' }; },
    });
    const t1 = blockTask('r1', 60);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    arm();
    env.queue.kick(); // kick → pump → runTask → verify 挂起在 getWhitelist
    await waitFor(() => getWhitelistCalls() >= 1);
    // 挂起窗口内撤权：epoch++，queued→cancelled
    await env.coordinator.execute({ kind: 'revoke', reason: '派发前撤权', pause: false });
    expect(env.queue.getStatus().authorizationEpoch).toBe(1);
    // 放行 verify
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'r1');
    expect(execCalls).toBe(0); // 修复前：1 次（red）
    expect(['cancelled', 'skipped']).toContain(finalT?.status); // 修复前：succeeded（red）
    expect(env.queue.getStatus().authorizationEpoch).toBe(1);
  });

  it('场景 2：queued block 任务 verify 挂起 → cancelTasks → executor=0、存储 cancelled', async () => {
    let execCalls = 0;
    const { env, base, gateWhitelist, arm, getWhitelistCalls } = await makeGatedEnv({
      execute: async () => { execCalls++; return { ok: true, status: 'ok' }; },
    });
    const t1 = blockTask('c1', 61);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    arm();
    env.queue.kick();
    await waitFor(() => getWhitelistCalls() >= 1);
    await env.coordinator.execute({ kind: 'cancelTasks', taskIds: ['c1'] });
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'c1');
    expect(execCalls).toBe(0); // 修复前：1 次（red）
    expect(['cancelled', 'skipped']).toContain(finalT?.status); // 修复前：succeeded（red）
  });

  it('场景 3：report 类任务 verify 挂起 → revoke → executor=0（不可逆副作用路径）', async () => {
    let execCalls = 0;
    const { env, base, gateWhitelist, arm, getWhitelistCalls } = await makeGatedEnv({
      execute: async () => { execCalls++; return { ok: true, status: 'ok' }; },
    });
    const t1 = reportTask('rep-r1', 62);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    arm();
    env.queue.kick();
    await waitFor(() => getWhitelistCalls() >= 1);
    await env.coordinator.execute({ kind: 'revoke', reason: '举报撤权', pause: false });
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'rep-r1');
    expect(execCalls).toBe(0); // 修复前：1 次（red）
    expect(['cancelled', 'skipped']).toContain(finalT?.status); // 修复前：succeeded（red）
  });

  it('场景 4：report 类任务 verify 挂起 → cancelTasks → executor=0（不可逆副作用路径）', async () => {
    let execCalls = 0;
    const { env, base, gateWhitelist, arm, getWhitelistCalls } = await makeGatedEnv({
      execute: async () => { execCalls++; return { ok: true, status: 'ok' }; },
    });
    const t1 = reportTask('rep-c1', 63);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    arm();
    env.queue.kick();
    await waitFor(() => getWhitelistCalls() >= 1);
    await env.coordinator.execute({ kind: 'cancelTasks', taskIds: ['rep-c1'] });
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'rep-c1');
    expect(execCalls).toBe(0); // 修复前：1 次（red）
    expect(['cancelled', 'skipped']).toContain(finalT?.status); // 修复前：succeeded（red）
  });

  it('场景 5：resume() 末尾 pump 触发 runTask 时，verify 挂起窗口内 revoke → executor=0', async () => {
    let execCalls = 0;
    // 第 1 次 whitelist 读 = resume 的 revalidation verify（放行）；
    // 第 2 次 = resume 末尾 pump → runTask 的 verify（挂起）
    const { env, base, gateWhitelist, arm, getWhitelistCalls } = await makeGatedEnv(
      { execute: async () => { execCalls++; return { ok: true, status: 'ok' }; } },
      2,
    );
    // 暂停 → 任务入队（resume 才会 pump）
    await env.queue.pause('暂停', 'user');
    const t1 = blockTask('rs1', 64);
    await base.set({ 'bb.queue': [t1] });
    env.queue.adoptTasks([t1]);
    arm();
    const pResume = env.queue.resume('user');
    await waitFor(() => getWhitelistCalls() >= 2);
    await env.coordinator.execute({ kind: 'revoke', reason: 'resume 窗口撤权', pause: false });
    gateWhitelist.resolve();
    await pResume;
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const finalT = (raw['bb.queue'] as { id: string; status: string }[]).find((x) => x.id === 'rs1');
    expect(execCalls).toBe(0); // 修复前：1 次（red）
    expect(['cancelled', 'skipped']).toContain(finalT?.status);
  });

  it('场景 6：任务完成回调后 pump 继续派发下一任务，第二任务 verify 挂起窗口内 revoke → 第二任务不派发', async () => {
    let execCalls = 0;
    // 第 1 次 whitelist 读 = t1 的 verify（放行）；第 2 次 = t2 的 verify（挂起）
    const { env, base, gateWhitelist, arm, getWhitelistCalls } = await makeGatedEnv(
      { execute: async () => { execCalls++; return { ok: true, status: 'ok' }; } },
      2,
    );
    const t1 = blockTask('t1', 65);
    const t2 = blockTask('t2', 66);
    await base.set({ 'bb.queue': [t1, t2] });
    env.queue.adoptTasks([t1, t2]);
    arm();
    env.queue.kick(); // pump：t1 verify（#1）→ 执行 → 完成 → 循环派发 t2 → verify 挂起（#2）
    await waitFor(() => getWhitelistCalls() >= 2);
    // t1 已执行完成；t2 verify 挂起窗口内 revoke
    await env.coordinator.execute({ kind: 'revoke', reason: 't2 派发前撤权', pause: false });
    gateWhitelist.resolve();
    await new Promise((r) => setTimeout(r, 200));
    const raw = await base.get(['bb.queue']);
    const q = raw['bb.queue'] as { id: string; status: string }[];
    const f1 = q.find((x) => x.id === 't1');
    const f2 = q.find((x) => x.id === 't2');
    expect(execCalls).toBe(1); // 仅 t1（修复前：2 次 → red）
    expect(f1?.status).toBe('succeeded');
    expect(['cancelled', 'skipped']).toContain(f2?.status); // 修复前：succeeded（red）
  });
});

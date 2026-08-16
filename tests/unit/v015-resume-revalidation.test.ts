/**
 * 1.4（P1-1 v0.1.5）：resume 保留合法 queued 任务（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P1-1）：resume() 先 `revalidateQueued()` 再 `control.paused = false`；
 * 而 verifyTaskEligible() 第一条检查就是 `if (control.paused) return 队列已暂停` →
 * 恢复时全部 queued 任务被标记 skipped（含仍合法的任务），「用户显式恢复」实际静默清空
 * 可恢复任务 → {after:[skipped '恢复前重新验证：队列已暂停（风控）'], executed:0}。
 *
 * 修复要求：
 * - resume 重验时忽略「正在解除的这一个 pause」本身（controlOverride 或 ignorePauseReason）；
 * - 总开关、epoch、capability、理由、白名单等安全条件仍必须校验；
 * - login_restored 不能恢复 risk-control；只有 user 显式恢复；
 * - 合法任务继续 queued 并执行恰好一次；无效任务因真实失效原因转 skipped；
 * - skipReason 不能是「队列已暂停」。
 */
import { describe, expect, it, vi } from 'vitest';
import { cloneBackend, makeRealEnv015, mkTask, trackActive } from './helpers/v015-env';
import { makeAuth, waitFor } from './helpers/v014-env';
import type { ActionTask, TaskResult } from '@/shared/types';

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

describe('1.4 resume 保留合法 queued 任务（P1-1）', () => {
  it('risk_control 下 user 恢复：合法任务执行恰好一次，仅失效任务因真实原因 skipped', async () => {
    const env = await makeRealEnv015();
    const executed: string[] = [];
    const executor = {
      execute: async (t: ActionTask): Promise<TaskResult> => {
        executed.push(t.id);
        return { ok: true, status: 'ok' };
      },
    };

    // 建立 risk-control paused 队列：控制状态 + 两条任务
    const pausedControl = {
      paused: true,
      pauseReason: '检测到验证码/风控，已暂停自动操作，请手动处理',
      pauseKind: 'risk_control' as const,
      pausedAt: Date.now(),
      requiresExplicitResume: true,
      authorizationEpoch: 1,
      recentAttempts: { block: [], report: [], unblock: [] },
    };
    // 合法任务：epoch/settingsRevision/capability 全部匹配当前 control（epoch=1）
    const validTask = mkTask('valid', 100, {
      status: 'queued' as const,
      authorization: makeAuth({ type: 'block' }, { epoch: 1, settingsRevision: 0 }),
    });
    // 失效任务：epoch 不匹配（0 ≠ 1）→ 真实失效原因
    const staleTask = mkTask('stale', 101, {
      status: 'queued' as const,
      authorization: makeAuth({ type: 'block' }, { epoch: 0, settingsRevision: 0 }),
    });
    // 失效任务：settingsRevision 不匹配
    const staleRevTask = mkTask('stale-rev', 102, {
      status: 'queued' as const,
      authorization: makeAuth({ type: 'block' }, { epoch: 1, settingsRevision: 99 }),
    });

    // 直接落盘控制与任务（真实持久化接线；绕过 queue 内部以便精确控制场景）
    await env.backend.set({
      'bb.queueControl': pausedControl,
      'bb.queue': [validTask, staleTask, staleRevTask],
    });
    const repo = new (await import('@/storage/repository')).StorageRepository(env.backend);
    await repo.init();
    const coordinator = new (await import('@/storage/coordinator')).StorageCoordinator(repo, null, null);
    const dedup = new (await import('@/actions/dedup')).DeduplicationRegistry(repo, coordinator.writer);
    const { ActionQueue } = await import('@/actions/queue');
    const queue = new ActionQueue({
      repo,
      dedup,
      writer: coordinator.writer,
      executor,
      latch: env.latch,
    });
    coordinator.attachQueue(queue);
    await queue.start();
    expect(queue.getStatus().paused).toBe(true);
    expect(queue.getStatus().pauseKind).toBe('risk_control');

    // ---- login_restored 不能恢复 risk-control ----
    await queue.resume('login_restored');
    expect(queue.getStatus().paused).toBe(true);

    // ---- user 显式恢复 ----
    await queue.resume('user');
    expect(queue.getStatus().paused).toBe(false);

    // 等待 pump 执行合法任务（恰好一次）
    await waitFor(() => queue.getStatus().queued === 0, 3000);
    await new Promise((r) => setTimeout(r, 50));

    expect(executed).toEqual(['valid']);
    const tasks = queue.pendingTasks();
    const validFinal = tasks.find((t) => t.id === 'valid');
    const staleFinal = tasks.find((t) => t.id === 'stale');
    const staleRevFinal = tasks.find((t) => t.id === 'stale-rev');
    expect(validFinal?.status).toBe('succeeded');
    // 失效任务仅因真实失效原因 skipped，skipReason 不得是「队列已暂停」
    expect(staleFinal?.status).toBe('skipped');
    expect(staleFinal?.skipReason).toContain('epoch');
    expect(staleFinal?.skipReason).not.toContain('队列已暂停');
    expect(staleRevFinal?.status).toBe('skipped');
    expect(staleRevFinal?.skipReason).toContain('revision');
    expect(staleRevFinal?.skipReason).not.toContain('队列已暂停');
  });

  it('user 恢复后合法任务只执行一次（重复 resume / kick 不重复派发）', async () => {
    const env = await makeRealEnv015();
    let executed = 0;
    const executor = {
      execute: async (): Promise<TaskResult> => {
        executed++;
        return { ok: true, status: 'ok' };
      },
    };
    const pausedControl = {
      paused: true,
      pauseReason: '风控',
      pauseKind: 'risk_control' as const,
      pausedAt: Date.now(),
      requiresExplicitResume: true,
      authorizationEpoch: 0,
      recentAttempts: { block: [], report: [], unblock: [] },
    };
    const validTask = mkTask('valid2', 200, {
      status: 'queued' as const,
      authorization: makeAuth({ type: 'block' }, { epoch: 0, settingsRevision: 0 }),
    });
    await env.backend.set({ 'bb.queueControl': pausedControl, 'bb.queue': [validTask] });
    const repo = new (await import('@/storage/repository')).StorageRepository(env.backend);
    await repo.init();
    const coordinator = new (await import('@/storage/coordinator')).StorageCoordinator(repo, null, null);
    const dedup = new (await import('@/actions/dedup')).DeduplicationRegistry(repo, coordinator.writer);
    const { ActionQueue } = await import('@/actions/queue');
    const queue = new ActionQueue({ repo, dedup, writer: coordinator.writer, executor, latch: env.latch });
    coordinator.attachQueue(queue);
    await queue.start();
    await queue.resume('user');
    await waitFor(() => executed === 1, 3000);
    await queue.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(executed).toBe(1); // 恰好一次
  });

  it('resume 的 control/tasks 落盘原子（单次 backend.set 同时包含 queue 与 queueControl）', async () => {
    const tracked = trackActive(cloneBackend());
    const env = await makeRealEnv015({}, undefined, { backend: tracked });
    const pausedControl = {
      paused: true,
      pauseReason: '风控',
      pauseKind: 'risk_control' as const,
      pausedAt: Date.now(),
      requiresExplicitResume: true,
      authorizationEpoch: 0,
      recentAttempts: { block: [], report: [], unblock: [] },
    };
    const validTask = mkTask('valid3', 300, {
      status: 'queued' as const,
      authorization: makeAuth({ type: 'block' }, { epoch: 0, settingsRevision: 0 }),
    });
    await env.backend.set({ 'bb.queueControl': pausedControl, 'bb.queue': [validTask] });
    const repo = new (await import('@/storage/repository')).StorageRepository(tracked);
    await repo.init();
    const coordinator = new (await import('@/storage/coordinator')).StorageCoordinator(repo, null, null);
    const dedup = new (await import('@/actions/dedup')).DeduplicationRegistry(repo, coordinator.writer);
    const { ActionQueue } = await import('@/actions/queue');
    const queue = new ActionQueue({ repo, dedup, writer: coordinator.writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) }, latch: env.latch });
    coordinator.attachQueue(queue);
    await queue.start();

    // 追踪 resume 过程中的 backend.set 调用：断言存在一次同时含 bb.queue 与 bb.queueControl
    let atomicSetSeen = false;
    const baseSet = tracked.set.bind(tracked);
    (tracked as unknown as { set: unknown }).set = async (items: Record<string, unknown>) => {
      const keys = Object.keys(items);
      if (keys.includes('bb.queue') && keys.includes('bb.queueControl')) atomicSetSeen = true;
      await baseSet(items);
    };
    await queue.resume('user');
    expect(atomicSetSeen).toBe(true);
  });
});

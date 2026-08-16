/**
 * 1.3（P0-2 v0.1.4）：派发前完整校验（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-2.2/2.3）：autoProcessVerified 检查位于 block/report
 * 提前返回之后 → auto_process block 仍放行；unblock 未在队列层校验 unblockUser。
 * 修复要求（每条独立用例）：
 * - autoProcessVerified=false 时 auto-process block/report 拒绝；
 * - unblockUser.verified=false 时 unblock 拒绝；
 * - epoch 变化后 queued 任务拒绝；
 * - capability 被撤回后 queued 任务拒绝；
 * - 举报理由失效/变化后 report 拒绝；
 * - 白名单新增后 queued block/report 拒绝；
 * - paused risk_control / authorization_revoked 时不得新建或派发官方任务。
 *
 * 本文件使用**真实常量**（不 mock capabilities），通过直接修改
 * CAPABILITY_VERIFICATION 模拟能力启用/撤回（与独立复验探针一致）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ActionQueue, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { CAPABILITY_VERIFICATION } from '@/shared/capabilities';
import { REPORT_REASONS } from '@/shared/constants/report-reasons';
import { makeAuth, waitFor } from './helpers/v014-env';
import type { ActionTask, AuthorizationSnapshot } from '@/shared/types';

function directWriter(repo: StorageRepository): QueueWriter {
  return {
    saveTasks: (tasks) => repo.saveQueueTasks(tasks),
    saveControl: (state) => repo.saveQueueControl(state),
    markDedup: (key, ttl) => repo.markDedup(key, ttl),
    clearDedup: (key) => repo.clearDedup(key),
    recordUnknownOutcome: (record) => repo.recordUnknownOutcome(record),
  };
}

function verifiedSettings() {
  return {
    enabled: true, videoCommentsEnabled: true, dynamicsEnabled: true, suspiciousHandling: 'collapse' as const,
    quickActionDisplay: 'hover' as const, autoReportAuthorized: true, defaultReportReason: 1,
    autoProcessVerified: true, operationDelayMs: 3000,
  };
}

/** 预设 queued 任务（带授权快照）的队列；opts.future=true 时任务保持 queued（配合可控时钟） */
function queueWithStored(
  taskPatch: Partial<ActionTask>,
  settings: Record<string, unknown> = {},
  auth?: AuthorizationSnapshot,
  opts: { future?: boolean; now?: () => number } = {},
) {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const backend = inMemoryBackend({
    'bb.settings': { ...verifiedSettings(), ...settings },
    'bb.queueControl': { paused: false, pauseReason: null, pauseKind: 'none' as const, pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } },
    'bb.queue': [
      {
        id: 'q1', groupId: 'g1', type: 'block' as const, uid: 42, source: 'one_click' as const,
        createdAt: t0, attempts: 0, maxAttempts: 3, nextAttemptAt: opts.future ? t0 + 800 : t0, status: 'queued' as const,
        authorization: auth ?? makeAuth({ type: 'block' }),
        ...taskPatch,
      },
    ],
  });
  const repo = new StorageRepository(backend);
  const writer = directWriter(repo);
  const dedup = new DeduplicationRegistry(repo, writer);
  const executed: string[] = [];
  const done: ActionTask[] = [];
  const queue = new ActionQueue({
    repo, dedup, writer, now,
    executor: { execute: async (t) => { executed.push(t.type); return { ok: true, status: 'ok' }; } },
    onTaskDone: (t) => done.push(t),
  });
  return { backend, repo, queue, executed, done };
}
afterEach(() => {
  for (const k of Object.keys(CAPABILITY_VERIFICATION) as (keyof typeof CAPABILITY_VERIFICATION)[]) {
    CAPABILITY_VERIFICATION[k].verified = false;
  }
  // 恢复理由枚举验证状态（本文件通过真实常量测试；默认假）
  (REPORT_REASONS as unknown as { verified: boolean }).verified = false;
});

describe('1.3 派发前完整校验（P0-2）', () => {
  it('autoProcessVerified=false 时 auto-process block 拒绝（位于类型成功返回之前）', async () => {
    CAPABILITY_VERIFICATION.blockUser.verified = true; // 能力本身放行，仍应被来源开关拒绝
    const { queue, executed, done } = queueWithStored(
      { type: 'block', source: 'auto_process' },
      { autoProcessVerified: false },
      makeAuth({ type: 'block', source: 'auto_process' }),
    );
    await queue.start();
    await waitFor(() => done.length === 1);
    expect(executed).toHaveLength(0);
    expect(done[0]?.status).toBe('skipped');
    expect(done[0]?.skipReason).toContain('自动处理已关闭');
  });

  it('autoProcessVerified=false 时 auto-process report 拒绝', async () => {
    CAPABILITY_VERIFICATION.reportVideoComment.verified = true;
    const { queue, executed, done } = queueWithStored(
      { type: 'report', source: 'auto_process', contentType: 'video_comment', contentId: 'r1', reasonId: 1 },
      { autoProcessVerified: false },
      makeAuth({ type: 'report', contentType: 'video_comment', source: 'auto_process' }),
    );
    await queue.start();
    await waitFor(() => done.length === 1);
    expect(executed).toHaveLength(0);
    expect(done[0]?.status).toBe('skipped');
    expect(done[0]?.skipReason).toContain('自动处理已关闭');
  });

  it('unblockUser.verified=false 时 unblock 拒绝（队列层校验）', async () => {
    // 全部能力保持 false（unblockUser 未验证）
    const { queue, executed, done } = queueWithStored(
      { type: 'unblock', uid: 43 },
      {},
      makeAuth({ type: 'unblock' }),
    );
    await queue.start();
    await waitFor(() => done.length === 1);
    expect(executed).toHaveLength(0);
    expect(done[0]?.status).toBe('skipped');
    expect(done[0]?.skipReason).toContain('解除拉黑能力未验证');
  });

  it('epoch 变化后 queued 任务拒绝（撤权代际）', async () => {
    let fakeNow = Date.now();
    const { queue, executed, done } = queueWithStored({}, {}, makeAuth({ type: 'block' }), { future: true, now: () => fakeNow });
    await queue.start();
    expect(queue.getActiveTaskCount()).toBe(1); // 未到期 → 保持 queued
    // 撤权（仅 auto 任务）：epoch 0 → 1，q1（one_click）存活但快照过期
    await queue.revoke('自动任务撤权', { pause: false, autoOnly: true });
    expect(queue.getActiveTaskCount()).toBe(1); // q1 未被取消，保持 queued
    fakeNow += 120_000; // 到期后 pump 不得派发旧快照任务
    await new Promise((r) => setTimeout(r, 1300));
    expect(executed).toHaveLength(0);
    const t = done.find((x) => x.id === 'q1');
    expect(t?.status).toBe('skipped');
    expect(t?.skipReason).toContain('epoch 不匹配');
  });

  it('capability 被撤回后 queued 任务拒绝', async () => {
    CAPABILITY_VERIFICATION.blockUser.verified = true;
    let fakeNow = Date.now();
    const { queue, executed, done } = queueWithStored({}, {}, makeAuth({ type: 'block' }), { future: true, now: () => fakeNow });
    await queue.start();
    // 派发前撤回能力
    CAPABILITY_VERIFICATION.blockUser.verified = false;
    fakeNow += 120_000;
    await new Promise((r) => setTimeout(r, 1300));
    expect(executed).toHaveLength(0);
    expect(done[0]?.skipReason).toContain('官方拉黑能力未验证');
  });

  it('举报理由失效/变化后 report 拒绝', async () => {
    (REPORT_REASONS as unknown as { verified: boolean }).verified = true;
    CAPABILITY_VERIFICATION.reportVideoComment.verified = true;
    let fakeNow = Date.now();
    const { queue, executed, done } = queueWithStored(
      { type: 'report', contentType: 'video_comment', contentId: 'r1', reasonId: 1 },
      {},
      makeAuth({ type: 'report', contentType: 'video_comment' }),
      { future: true, now: () => fakeNow },
    );
    await queue.start();
    // 理由枚举被撤回
    (REPORT_REASONS as unknown as { verified: boolean }).verified = false;
    fakeNow += 120_000;
    await new Promise((r) => setTimeout(r, 1300));
    expect(executed).toHaveLength(0);
    expect(done[0]?.skipReason).toMatch(/举报能力|未验证/);
  });

  it('白名单新增后 queued block/report 拒绝', async () => {
    CAPABILITY_VERIFICATION.blockUser.verified = true;
    (REPORT_REASONS as unknown as { verified: boolean }).verified = true;
    CAPABILITY_VERIFICATION.reportVideoComment.verified = true;
    let fakeNow = Date.now();
    const backend = inMemoryBackend({
      'bb.settings': verifiedSettings(),
      'bb.whitelist': [],
      'bb.queueControl': { paused: false, pauseReason: null, pauseKind: 'none' as const, pausedAt: null, requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] } },
      'bb.queue': [
        { id: 'wb1', groupId: 'g', type: 'block' as const, uid: 50, source: 'one_click' as const, createdAt: fakeNow, attempts: 0, maxAttempts: 3, nextAttemptAt: fakeNow + 800, status: 'queued' as const, authorization: makeAuth({ type: 'block' }) },
        { id: 'wb2', groupId: 'g', type: 'report' as const, uid: 50, contentType: 'video_comment' as const, contentId: 'r-wh', reasonId: 1, source: 'one_click' as const, createdAt: fakeNow, attempts: 0, maxAttempts: 1, nextAttemptAt: fakeNow + 800, status: 'queued' as const, authorization: makeAuth({ type: 'report', contentType: 'video_comment' }) },
      ],
    });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const executed: string[] = [];
    const queue = new ActionQueue({
      repo, dedup, writer, now: () => fakeNow,
      executor: { execute: async (t) => { executed.push(t.type); return { ok: true, status: 'ok' }; } },
    });
    await queue.start();
    // 新增白名单（与任务同 uid）后推进时钟
    await repo.addWhitelist({ uid: 50 });
    fakeNow += 120_000;
    await new Promise((r) => setTimeout(r, 1300));
    expect(executed).toHaveLength(0);
    const stored = await repo.getQueueTasks();
    expect(stored.every((t) => t.status === 'skipped')).toBe(true);
  });

  it('paused risk_control 时不得新建官方任务（enqueue 拒绝）', async () => {
    const backend = inMemoryBackend({ 'bb.settings': verifiedSettings() });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => ({ ok: true, status: 'ok' }) },
    });
    await queue.start();
    await queue.pause('风控', 'risk_control', true);
    const created = await queue.enqueue(
      [{ type: 'block', uid: 60, source: 'manual' }],
      {},
      makeAuth({ type: 'block' }),
    );
    expect(created).toHaveLength(0);
    expect(await repo.getQueueTasks()).toHaveLength(0);
  });

  it('paused authorization_revoked 时不得新建官方任务', async () => {
    const backend = inMemoryBackend({ 'bb.settings': verifiedSettings() });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => ({ ok: true, status: 'ok' }) },
    });
    await queue.start();
    await queue.pause('授权撤销', 'authorization_revoked', true);
    const created = await queue.enqueue(
      [{ type: 'report', uid: 61, contentType: 'video_comment', contentId: 'r1', reasonId: 1, source: 'manual' }],
      {},
      makeAuth({ type: 'report', contentType: 'video_comment' }),
    );
    expect(created).toHaveLength(0);
  });

  it('requiresExplicitResume=true 的 pause 同样拒绝新建官方任务（统一策略）', async () => {
    const backend = inMemoryBackend({ 'bb.settings': verifiedSettings() });
    const repo = new StorageRepository(backend);
    const writer = directWriter(repo);
    const dedup = new DeduplicationRegistry(repo, writer);
    const queue = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => ({ ok: true, status: 'ok' }) },
    });
    await queue.start();
    await queue.pause('用户暂停', 'user', true);
    const created = await queue.enqueue(
      [{ type: 'block', uid: 62, source: 'manual' }],
      {},
      makeAuth({ type: 'block' }),
    );
    expect(created).toHaveLength(0);
  });
});

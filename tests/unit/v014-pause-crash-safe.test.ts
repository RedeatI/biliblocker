/**
 * 1.6（P0-5 v0.1.4）：pause 持久化时序 crash-safe（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-5）：pause() 返回 void，内部 fire-and-forget
 * （void saveControl）→ 返回时持久化未完成 {retType:'undefined', finished:false}。
 * 修复要求：
 * - pause() 返回前 saveControl 必须完成（延迟 writer 证明）；
 * - 保存失败时保持本地 fail-closed，停止 pump（不继续派发）；
 * - 保存开始后模拟 SW 崩溃（重建队列）仍为 paused；
 * - risk_control 只能用户显式恢复；
 * - runTask 对 risk_control/login_invalid 必须 await（风控返回后持久化已完成）。
 */
import { describe, expect, it, vi } from 'vitest';
import { ActionQueue, type QueueWriter } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { deferred, makeAuth, waitFor } from './helpers/v014-env';
import type { QueueControlState, UnknownOutcomeRecord } from '@/shared/types';

function verifiedSettings() {
  return { enabled: true, videoCommentsEnabled: true, dynamicsEnabled: true, suspiciousHandling: 'collapse' as const, quickActionDisplay: 'hover' as const, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true, operationDelayMs: 3000 };
}

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

describe('1.6 pause 持久化时序（P0-5）', () => {
  it('pause() 返回前 saveControl 已完成（延迟 writer；可 await）', async () => {
    const gate = deferred();
    let started = false;
    let finished = false;
    const writer: QueueWriter = {
      saveTasks: async () => undefined,
      saveControl: async () => { started = true; await gate.promise; finished = true; },
      markDedup: async () => undefined,
      clearDedup: async () => undefined,
      recordUnknownOutcome: async (r: UnknownOutcomeRecord) => void r,
    };
    const q = new ActionQueue({ repo: {} as never, dedup: {} as never, writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    const ret = q.pause('风控', 'risk_control', true);
    expect(ret).toBeInstanceOf(Promise); // 可 await
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);
    expect(finished).toBe(false); // 持久化尚未完成
    gate.resolve();
    await ret; // 返回前持久化完成
    expect(finished).toBe(true);
  });

  it('保存失败：本地 fail-closed（内存保持 paused），pump 停止，不继续派发', async () => {
    const backend = inMemoryBackend({ 'bb.settings': verifiedSettings() });
    const repo = new StorageRepository(backend);
    const writer: QueueWriter = {
      saveTasks: async () => undefined,
      saveControl: async (state) => { if (state.paused) throw new Error('storage unavailable'); },
      markDedup: async () => undefined,
      clearDedup: async () => undefined,
      recordUnknownOutcome: async (r: UnknownOutcomeRecord) => void r,
    };
    const dedup = new DeduplicationRegistry(repo, writer);
    let executed = 0;
    const q = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => { executed++; return { ok: false, status: '风控', errorType: 'risk_control' }; } },
    });
    await q.start();
    await q.enqueue([{ type: 'block', uid: 1, source: 'manual' }], {}, makeAuth({ type: 'block' }));
    await waitFor(() => q.getStatus().paused === true);
    expect(q.getStatus().paused).toBe(true); // fail-closed：内存暂停
    expect(q.getStatus().pauseKind).toBe('risk_control');
    const before = executed;
    await q.kick();
    await new Promise((r) => setTimeout(r, 200));
    expect(executed).toBe(before); // 不再派发
  });

  it('保存开始后模拟 SW 崩溃（重建队列）→ 重启仍为 paused', async () => {
    const backend = inMemoryBackend({ 'bb.settings': verifiedSettings() });
    const repo = new StorageRepository(backend);
    const writer: QueueWriter = {
      saveTasks: (tasks) => repo.saveQueueTasks(tasks),
      saveControl: (state) => repo.saveQueueControl(state),
      markDedup: (key, ttl) => repo.markDedup(key, ttl),
      clearDedup: (key) => repo.clearDedup(key),
      recordUnknownOutcome: (r) => repo.recordUnknownOutcome(r),
    };
    const dedup = new DeduplicationRegistry(repo, writer);
    const q1 = new ActionQueue({ repo, dedup, writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    await q1.start();
    await q1.pause('风控', 'risk_control', true);
    // 重建（模拟 SW 崩溃恢复）
    const repo2 = new StorageRepository(backend);
    const q2 = new ActionQueue({ repo: repo2, dedup: new DeduplicationRegistry(repo2, writer), writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    await q2.start();
    expect(q2.getStatus().paused).toBe(true);
    expect(q2.getStatus().pauseKind).toBe('risk_control');
    expect(q2.controlSnapshot().requiresExplicitResume).toBe(true);
  });

  it('risk_control 只能用户显式恢复（login_restored 不生效）', async () => {
    const backend = inMemoryBackend({ 'bb.settings': verifiedSettings() });
    const repo = new StorageRepository(backend);
    const writer = {
      saveTasks: (tasks: never[]) => repo.saveQueueTasks(tasks as never),
      saveControl: (state: QueueControlState) => repo.saveQueueControl(state),
      markDedup: (key: string, ttl: number) => repo.markDedup(key, ttl),
      clearDedup: (key: string) => repo.clearDedup(key),
      recordUnknownOutcome: (r: UnknownOutcomeRecord) => repo.recordUnknownOutcome(r),
    } satisfies QueueWriter;
    const q = new ActionQueue({ repo, dedup: new DeduplicationRegistry(repo, writer), writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    await q.start();
    await q.pause('风控', 'risk_control', true);
    await q.resume('login_restored');
    expect(q.getStatus().paused).toBe(true);
    await q.resume('user');
    expect(q.getStatus().paused).toBe(false);
  });

  it('runTask 对 risk_control 必须 await：任务结束后 pause 已持久化完成', async () => {
    let controlSaved = false;
    const backend = inMemoryBackend({ 'bb.settings': verifiedSettings() });
    const repo = new StorageRepository(backend);
    const writer: QueueWriter = {
      saveTasks: (tasks) => repo.saveQueueTasks(tasks),
      saveControl: async (state) => {
        await repo.saveQueueControl(state);
        if (state.paused) controlSaved = true;
      },
      markDedup: (key, ttl) => repo.markDedup(key, ttl),
      clearDedup: (key) => repo.clearDedup(key),
      recordUnknownOutcome: (r) => repo.recordUnknownOutcome(r),
    };
    const dedup = new DeduplicationRegistry(repo, writer);
    const q = new ActionQueue({
      repo, dedup, writer,
      executor: { execute: async () => ({ ok: false, status: '风控', errorType: 'risk_control' }) },
    });
    await q.start();
    await q.enqueue([{ type: 'block', uid: 2, source: 'manual' }], {}, makeAuth({ type: 'block' }));
    await waitFor(() => q.getStatus().paused === true);
    expect(controlSaved).toBe(true); // 持久化在任务处理结束前完成
  });
});

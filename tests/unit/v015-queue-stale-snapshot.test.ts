/**
 * 1.2（P0-2 v0.1.5）：stale queue snapshot 不得覆盖新状态（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-2）：commitAction 使用 `queue.pendingTasks()`（可变内部数组
 * 旧引用）构造原子快照后跨 backend.set await；等待期间外部 QueueWriter 更新队列
 * （existing→in_flight + 新增 concurrent），延迟的旧快照随后完成 → concurrent 完全丢失、
 * existing 从 in_flight 回退成 queued；SW 恢复时可能把已发送请求当未发送任务重新派发。
 *
 * 修复要求：
 * - 所有 queue 写经全局锁串行（外部 writer 排队，绝不继承进行中命令的 lease）；
 * - 锁内操作读取最新快照；不允许持有旧数组引用后跨 await 覆盖；
 * - pendingTasks() 返回 structuredClone/readonly 快照（不暴露可变内部数组）；
 * - ActionQueue 内存只在 backend 成功后 adopt。
 *
 * 本测试使用真实生产接线（StorageRepository → StorageCoordinator → coordinator.writer
 * → ActionQueue/QueueWriter）+ structured-clone backend。
 */
import { describe, expect, it, vi } from 'vitest';
import { deferred, waitFor, makeAuth } from './helpers/v014-env';
import { cloneBackend, hangingBackend, makeRealEnv015, mkTask } from './helpers/v015-env';
import { StorageRepository } from '@/storage/repository';
import { StorageCoordinator } from '@/storage/coordinator';
import { ActionQueue } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';
import type { CommitActionRequest } from '@/storage/coordinator';
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

describe('1.2 stale queue snapshot 不得覆盖新状态（P0-2）', () => {
  it('commitAction 写等待期间的外部队列更新不被旧快照覆盖：existing 不回退、concurrent 不丢失', async () => {
    const gate = deferred();
    const events: string[] = [];
    const base = cloneBackend();
    // 只挂起 commitAction 的写（含非空 bb.blocked）；init 播种空数组不挂起
    const backend = hangingBackend(
      base,
      (items) => Array.isArray(items['bb.blocked']) && (items['bb.blocked'] as unknown[]).length > 0,
      gate,
      events,
    );
    // 阻塞 executor：pump 派发 created 时卡住，绝不产生额外写干扰（测试只关注受控时序）
    const env = await makeRealEnv015({}, { execute: () => new Promise(() => undefined) }, { backend });

    // 原队列含 existing:queued（真实持久化）
    const existingTask = mkTask('existing', 1, {
      status: 'queued' as const,
      authorization: makeAuth({ type: 'block' }),
    });
    await env.coordinator.execute({ kind: 'saveQueueTasks', tasks: [existingTask] });

    // commitAction：创建新任务（created），本地 blocked 一并提交 → items 含 bb.blocked + bb.queue
    events.length = 0; // 清空 saveQueueTasks 预置事件，确保下面等待的是 commitAction 的写
    const p1 = env.coordinator.execute({
      kind: 'commitAction',
      request: {
        operationId: 'op-stale-1',
        uid: 2,
        username: 'bot2',
        contentType: 'video_comment',
        contentId: 'r2',
        rootContentId: 'r2',
        oid: '2',
        source: 'one_click',
        localActions: { commitLocalBlock: true, commitVerified: false },
        officialTasks: [{ type: 'block', uid: 2, source: 'one_click' }],
        skipOfficial: false,
        authorization: makeAuth({ type: 'block' }),
        frameNonce: 'n',
        loginOk: true,
        currentMid: 999,
      },
      origin: { tabId: 1, frameId: 0 },
    });

    // 等待 commitAction 的 backend.set 挂起（bb.blocked 的非空写已进入；label 可能含多个键）
    await waitFor(() => events.some((e) => e.startsWith('start:bb.blocked')));

    // 并发队列状态更新：existing → in_flight + 新增 concurrent（外部 QueueWriter）
    const existingInFlight = mkTask('existing', 1, {
      status: 'in_flight' as const,
      authorization: makeAuth({ type: 'block' }),
    });
    const concurrent = mkTask('concurrent', 3, {
      groupId: 'g3',
      authorization: makeAuth({ type: 'block' }),
    });
    const p2 = env.coordinator.writer.saveTasks([existingInFlight, concurrent]);
    await new Promise((r) => setTimeout(r, 30));

    gate.resolve();
    await Promise.all([p1, p2]);

    // ---- 断言最终 Storage ----
    const raw = await env.backend.get(['bb.queue', 'bb.blocked']);
    const finalQueue = (raw['bb.queue'] as ActionTask[]) ?? [];

    // existing 不回退（保持 in_flight，不允许被旧快照回退成 queued）
    const existing = finalQueue.find((t) => t.id === 'existing');
    expect(existing).toBeDefined();
    expect(existing!.status).toBe('in_flight');
    // concurrent 不丢失
    expect(finalQueue.some((t) => t.id === 'concurrent')).toBe(true);
    // 新创建任务只追加一次（id 不重复且存在）
    const createdTasks = finalQueue.filter((t) => t.uid === 2);
    expect(createdTasks).toHaveLength(1);
    // 不会出现已发送任务（in_flight）重新变为 queued
    expect(existing!.status).not.toBe('queued');

    // ---- SW 重启后不会重复派发（existing 为 in_flight → 转 unknown_outcome，绝不重发）----
    const executedIds: string[] = [];
    const repo2 = new StorageRepository(env.backend);
    await repo2.init();
    const coordinator2 = new StorageCoordinator(repo2, null, null);
    const dedup2 = new DeduplicationRegistry(repo2, coordinator2.writer);
    const queue2 = new ActionQueue({
      repo: repo2,
      dedup: dedup2,
      writer: coordinator2.writer,
      executor: {
        execute: async (t: ActionTask): Promise<TaskResult> => {
          executedIds.push(t.id);
          return { ok: true, status: 'ok' };
        },
      },
    });
    coordinator2.attachQueue(queue2);
    await queue2.start();
    await waitFor(() => executedIds.length >= 1, 3000);
    // existing（已发送）绝不重复派发
    expect(executedIds).not.toContain('existing');
    const restarted = (await env.backend.get(['bb.queue']))['bb.queue'] as ActionTask[];
    const existingAfter = restarted.find((t) => t.id === 'existing');
    expect(existingAfter?.status).toBe('unknown_outcome');
  });

  it('commitAction 自身基于锁内最新快照：重复 commitAction 不重复追加、不回退已有状态', async () => {
    const env = await makeRealEnv015();
    const existingTask = mkTask('existing', 1, {
      status: 'queued' as const,
      authorization: makeAuth({ type: 'block' }),
    });
    await env.coordinator.execute({ kind: 'saveQueueTasks', tasks: [existingTask] });

    const req: CommitActionRequest = {
      operationId: 'op-stale-2',
      uid: 2,
      username: 'bot2',
      contentType: 'video_comment',
      contentId: 'r2',
      rootContentId: 'r2',
      oid: '2',
      source: 'one_click',
      localActions: { commitLocalBlock: true, commitVerified: false },
      officialTasks: [{ type: 'block', uid: 2, source: 'one_click' }],
      skipOfficial: false,
      authorization: makeAuth({ type: 'block' }),
      frameNonce: 'n',
      loginOk: true,
      currentMid: 999,
    };
    const r1 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    // 同 operationId 重放（响应丢失场景）
    const r2 = await env.coordinator.execute({ kind: 'commitAction', request: req, origin: { tabId: 1, frameId: 0 } });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const raw = await env.backend.get(['bb.queue']);
    const q = (raw['bb.queue'] as ActionTask[]) ?? [];
    // existing 仍在且状态未回退
    const existing = q.find((t) => t.id === 'existing');
    expect(existing).toBeDefined();
    // uid=2 的任务只追加一次
    expect(q.filter((t) => t.uid === 2)).toHaveLength(1);
    // r1/r2 结果一致（幂等）
    expect(r2.enqueued).toBe(r1.enqueued);
  });
});

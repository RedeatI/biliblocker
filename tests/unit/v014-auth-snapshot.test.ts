/**
 * 1.2（P0-2 v0.1.4）：原子提交授权快照（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-2.1）：commitAction 调 planEnqueue 未传授权快照
 * → capturedAuthorization/adoptedAuthorization 均为 null。
 * 修复要求：
 * - 从真实 BB_COMMIT_ACTION 消息链路开始（coordinator.execute commitAction）；
 * - 每一个创建的任务均持久化 authorizationEpoch/settingsRevision/capabilityKey/
 *   reasonId/contentType/source/autoProcessAuthorized/reportAuthorized/createdAt；
 * - block 与 report 分别保存自己的 capabilityKey/reasonId；
 * - 缺少任意必要字段 → 拒绝创建官方任务；
 * - 快照跨 SW 重启（重建 repo+queue）持久。
 */
import { describe, expect, it, vi } from 'vitest';
import { makeRealEnv, commitRequest } from './helpers/v014-env';
import { StorageRepository } from '@/storage/repository';
import { ActionQueue } from '@/actions/queue';
import { DeduplicationRegistry } from '@/actions/dedup';

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

describe('1.2 原子提交授权快照（P0-2）', () => {
  it('BB_COMMIT_ACTION 创建的每个官方任务持久化完整授权快照（8 字段）', async () => {
    const env = await makeRealEnv();
    const res = await env.coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({
        officialTasks: [
          { type: 'block', uid: 10086, source: 'one_click', contentHash: 'h' },
          { type: 'report', uid: 10086, contentType: 'video_comment', contentId: 'rpid-1', reasonId: 1, source: 'one_click', contentHash: 'h' },
        ],
      }),
      origin: { tabId: 7, frameId: 0 },
    });
    expect(res.ok).toBe(true);
    expect(res.enqueued).toBe(2);

    const raw = await env.backend.get(['bb.queue']);
    const tasks = (raw['bb.queue'] as { type: string; authorization?: Record<string, unknown> }[]) ?? [];
    const block = tasks.find((t) => t.type === 'block');
    const report = tasks.find((t) => t.type === 'report');
    expect(block?.authorization).toBeDefined();
    expect(report?.authorization).toBeDefined();

    // block：capabilityKey=blockUser、reasonId=null
    expect(block!.authorization).toMatchObject({
      epoch: 0, settingsRevision: 0, capabilityKey: 'blockUser', reasonId: null,
      contentType: 'video_comment', source: 'one_click',
      autoProcessAuthorized: true, reportAuthorized: true,
    });
    expect(typeof (block!.authorization as { createdAt: number }).createdAt).toBe('number');
    // report：capabilityKey=reportVideoComment、reasonId=1
    expect(report!.authorization).toMatchObject({
      epoch: 0, settingsRevision: 0, capabilityKey: 'reportVideoComment', reasonId: 1,
      contentType: 'video_comment', source: 'one_click',
      autoProcessAuthorized: true, reportAuthorized: true,
    });
  });

  it('快照跨 SW 重启持久（重建 repo+queue 后读取任务仍携带完整快照）', async () => {
    const env = await makeRealEnv();
    await env.coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({
        officialTasks: [{ type: 'block', uid: 10087, source: 'one_click' }],
      }),
    });
    // 模拟 SW 重启：同一 backend 上重建全部实例
    const repo2 = new StorageRepository(env.backend as never);
    await repo2.init();
    const coordinator2 = new (await import('@/storage/coordinator')).StorageCoordinator(repo2, null, null);
    const dedup2 = new DeduplicationRegistry(repo2, coordinator2.writer);
    const queue2 = new ActionQueue({ repo: repo2, dedup: dedup2, writer: coordinator2.writer, executor: { execute: async () => ({ ok: true, status: 'ok' }) } });
    coordinator2.attachQueue(queue2);
    await queue2.start();

    const tasks = await repo2.getQueueTasks();
    const block = tasks.find((t) => t.type === 'block');
    expect(block?.authorization).toMatchObject({ epoch: 0, settingsRevision: 0, capabilityKey: 'blockUser', source: 'one_click' });
  });

  it('缺少任一必要授权字段 → 拒绝创建官方任务（本地名单也不写）', async () => {
    const env = await makeRealEnv();
    const base = commitRequest({
      officialTasks: [{ type: 'block', uid: 10088, source: 'one_click' }],
    });
    // 去掉 reportAuthorized（模拟不完整快照；消息层本会拦截，此处测 coordinator 防御）
    const bad = { ...base, authorization: { ...base.authorization, reportAuthorized: undefined as unknown as boolean } };
    const res = await env.coordinator.execute({ kind: 'commitAction', request: bad });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('authorization_changed');
    const raw = await env.backend.get(['bb.queue', 'bb.blocked']);
    expect(raw['bb.queue']).toEqual([]);
    expect(raw['bb.blocked']).toEqual([]);
  });

  it('无授权快照的官方任务意图直接拒绝（不回退到无快照入队）', async () => {
    const env = await makeRealEnv();
    const base = commitRequest({
      officialTasks: [{ type: 'block', uid: 10089, source: 'one_click' }],
    });
    const bad = { ...base, authorization: undefined as unknown as typeof base.authorization };
    const res = await env.coordinator.execute({ kind: 'commitAction', request: bad });
    expect(res.ok).toBe(false);
    expect((await env.backend.get(['bb.queue']))['bb.queue']).toEqual([]);
  });
});

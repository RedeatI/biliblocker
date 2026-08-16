/**
 * 1.8（5.3 v0.1.4）：BB_ENQUEUE 信任边界（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE 5.3）：background 仍公开接收 BB_ENQUEUE，绕过原子提交与
 * 完整授权模型（无 evidence/settings/epoch/pause/白名单约束）。
 * 修复要求：
 * - 若删除该消息：生产消息 Schema 不再接受它（parseContentToBackground 返回 ok:false）；
 * - 外部 runtime message 无法经它创建任务；
 * - 官方任务只能经 BB_COMMIT_ACTION（完整授权/证据/epoch/pause/白名单门禁）。
 */
import { describe, expect, it } from 'vitest';
import { parseContentToBackground, contentToBackgroundSchema } from '@/shared/messages';
import { commitRequest, makeRealEnv } from './helpers/v014-env';

describe('1.8 BB_ENQUEUE 信任边界（5.3）', () => {
  it('生产消息 Schema 不再接受 BB_ENQUEUE（删除无保护入队通道）', () => {
    const parsed = parseContentToBackground(
      { type: 'BB_ENQUEUE', tasks: [{ type: 'block', uid: 1, source: 'manual' }], frameNonce: 'n1' },
      { tab: { id: 1 }, frameId: 0 },
    );
    expect(parsed.ok).toBe(false);
  });

  it('Schema 定义中不存在 BB_ENQUEUE 类型', () => {
    // Zod 允许安全探测 option map；通过 JSON 序列化检查（不含 shape 访问）
    const def = (contentToBackgroundSchema as unknown as { _def?: unknown })._def;
    expect(JSON.stringify(def ?? '')).not.toContain('BB_ENQUEUE');
  });

  it('外部消息无法经 enqueue 通道创建任务：唯一路径是 BB_COMMIT_ACTION（含暂停/授权门禁）', async () => {
    // 模拟"伪造入队"被拒绝：无 BB_ENQUEUE 后，唯一创建路径是 commitAction
    const env = await makeRealEnv();
    // commitAction 在 paused（风控）时拒绝创建官方任务（5.1 门禁）
    await env.queue.pause('风控', 'risk_control', true);
    const res = await env.coordinator.execute({
      kind: 'commitAction',
      request: commitRequest({
        officialTasks: [{ type: 'block', uid: 1, source: 'manual' }],
      }),
    });
    expect(res.ok).toBe(true); // 本地仍可提交
    expect(res.enqueued ?? 0).toBe(0); // 官方任务未创建（暂停门禁）
    expect((await env.backend.get(['bb.queue']))['bb.queue']).toEqual([]);
  });

  it('BB_COMMIT_ACTION 缺少完整授权字段时 parse 拒绝（消息层拦截）', () => {
    const base = {
      type: 'BB_COMMIT_ACTION' as const,
      operationId: 'op-1', uid: 1, contentType: 'video_comment', contentId: 'r1',
      rootContentId: 'r1', oid: '1', source: 'one_click',
      localActions: { commitLocalBlock: true, commitVerified: false },
      officialTasks: [], skipOfficial: false, frameNonce: 'n', loginOk: true, currentMid: 999,
    };
    // 缺少 createdAt（新必填字段）
    const parsed = parseContentToBackground(
      { ...base, authorization: { epoch: 0, settingsRevision: 0, reasonId: null, capabilityKey: 'blockUser', source: 'one_click', autoProcessAuthorized: true, reportAuthorized: true } },
      { tab: { id: 1 }, frameId: 0 },
    );
    expect(parsed.ok).toBe(false);
  });
});

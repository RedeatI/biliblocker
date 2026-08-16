/**
 * P1-6 消息协议 Zod 校验测试：
 * - 合法消息通过；字段范围错误拒绝（uid 非正整数、reasonId 越界、未知 type）；
 * - 发送上下文校验（tabId/frameId 与 sender 不匹配拒绝）；
 * - 名单变更 discriminated union 校验；
 * - 任务结果/任务结构校验。
 */
import { describe, expect, it } from 'vitest';
import {
  actionTaskSchema,
  parseContentToBackground,
  parseBackgroundToContent,
  taskInputSchema,
} from '@/shared/messages';

describe('taskInputSchema 字段范围', () => {
  it('合法任务通过', () => {
    const r = taskInputSchema.safeParse({ type: 'block', uid: 10086, source: 'manual' });
    expect(r.success).toBe(true);
  });

  it('举报任务拒绝空白 contentId，避免无内容标识任务穿过后台协议', () => {
    expect(
      taskInputSchema.safeParse({
        type: 'report',
        uid: 10086,
        contentId: '   ',
        source: 'manual',
      }).success,
    ).toBe(false);
  });

  it('举报 TaskInput/ActionTask 都要求内容类型、非空内容 ID 与举报理由', () => {
    expect(taskInputSchema.safeParse({ type: 'report', uid: 10086, source: 'manual' }).success).toBe(false);
    const validTaskInput = {
      type: 'report' as const,
      uid: 10086,
      contentType: 'video_comment' as const,
      contentId: '123',
      reasonId: 1,
      source: 'manual' as const,
    };
    expect(taskInputSchema.safeParse(validTaskInput).success).toBe(true);
    expect(taskInputSchema.safeParse({ ...validTaskInput, contentId: '   ' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...validTaskInput, contentId: null }).success).toBe(false);

    const baseActionTask = {
      id: 'task-1',
      groupId: 'group-1',
      type: 'report' as const,
      uid: 10086,
      contentType: 'video_comment' as const,
      reasonId: 1,
      source: 'manual' as const,
      createdAt: 1,
      attempts: 0,
      maxAttempts: 1,
      nextAttemptAt: 1,
      status: 'queued' as const,
    };
    expect(actionTaskSchema.safeParse(baseActionTask).success).toBe(false);
    expect(actionTaskSchema.safeParse({ ...baseActionTask, contentId: '123' }).success).toBe(true);
    expect(actionTaskSchema.safeParse({ ...baseActionTask, contentId: '   ' }).success).toBe(false);
    expect(actionTaskSchema.safeParse({ ...baseActionTask, contentId: null }).success).toBe(false);
  });

  it('uid 非正整数拒绝', () => {
    expect(taskInputSchema.safeParse({ type: 'block', uid: 0, source: 'manual' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'block', uid: -5, source: 'manual' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'block', uid: 1.5, source: 'manual' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'block', source: 'manual' }).success).toBe(false);
  });

  it('未知 type / source 拒绝', () => {
    expect(taskInputSchema.safeParse({ type: 'delete', uid: 1, source: 'manual' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'block', uid: 1, source: 'auto' }).success).toBe(false);
  });

  it('reasonId 越界拒绝', () => {
    expect(taskInputSchema.safeParse({ type: 'report', uid: 1, reasonId: -1, source: 'manual' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'report', uid: 1, reasonId: 999999, source: 'manual' }).success).toBe(false);
  });
});

describe('parseContentToBackground（发送上下文校验）', () => {
  const sender = { tab: { id: 5 }, frameId: 0 };

  it('合法 BB_PING 通过（tabId/frameId 由 background 从 sender 推导）', () => {
    const r = parseContentToBackground(
      { type: 'BB_PING', pageScope: 'video_page', frameNonce: 'n1' },
      sender,
    );
    expect(r.ok).toBe(true);
  });

  it('BB_PING 缺少 frameNonce 拒绝（防伪造/防无身份页面）', () => {
    const r = parseContentToBackground({ type: 'BB_PING', pageScope: 'video_page' }, sender);
    expect(r.ok).toBe(false);
  });

  it('BB_OPEN_OPTIONS 仅允许默认页或日志目标，避免任意 Options URL 导航', () => {
    expect(parseContentToBackground({ type: 'BB_OPEN_OPTIONS' }, sender).ok).toBe(true);
    expect(parseContentToBackground({ type: 'BB_OPEN_OPTIONS', target: 'logs' }, sender).ok).toBe(true);
    expect(parseContentToBackground({ type: 'BB_OPEN_OPTIONS', target: 'welcome' }, sender).ok).toBe(true);
    expect(parseContentToBackground({ type: 'BB_OPEN_OPTIONS', target: 'privacy' }, sender).ok).toBe(false);
  });

  it('BB_COMMIT_ACTION 在无/空白 contentId 时拒绝 verified 意图，但允许 block-only', () => {
    const base = {
      type: 'BB_COMMIT_ACTION' as const,
      operationId: 'op-no-content-id',
      uid: 10086,
      contentType: 'video_comment' as const,
      contentId: '   ',
      rootContentId: null,
      oid: null,
      source: 'one_click' as const,
      localActions: { commitLocalBlock: true, commitVerified: true },
      officialTasks: [],
      skipOfficial: false,
      authorization: {
        epoch: 0,
        settingsRevision: 0,
        reasonId: null,
        capabilityKey: null,
        contentType: 'video_comment' as const,
        source: 'one_click' as const,
        autoProcessAuthorized: false,
        reportAuthorized: false,
        createdAt: 1,
      },
      frameNonce: 'nonce',
      loginOk: true,
      currentMid: 999,
    };
    expect(parseContentToBackground(base, sender).ok).toBe(false);
    expect(parseContentToBackground({ ...base, contentId: null }, sender).ok).toBe(false);
    expect(
      parseContentToBackground(
        { ...base, contentId: null, localActions: { ...base.localActions, commitVerified: false } },
        sender,
      ).ok,
    ).toBe(true);
  });

  it('BB_ENQUEUE 已删除：任何该类型消息一律拒绝（5.3 无保护入队通道关闭）', () => {
    const ok = parseContentToBackground(
      { type: 'BB_ENQUEUE', tasks: [{ type: 'block', uid: 1, source: 'manual' }], frameNonce: 'n1' },
      sender,
    );
    expect(ok.ok).toBe(false);
    const bad = parseContentToBackground(
      { type: 'BB_ENQUEUE', tasks: [{ type: 'block', uid: 0, source: 'manual' }], frameNonce: 'n1' },
      sender,
    );
    expect(bad.ok).toBe(false);
    const noNonce = parseContentToBackground(
      { type: 'BB_ENQUEUE', tasks: [], tabId: 5, frameId: 0 },
      sender,
    );
    expect(noNonce.ok).toBe(false);
  });

  it('未知 type 拒绝', () => {
    const r = parseContentToBackground({ type: 'BB_HACK', tabId: 5, frameId: 0 }, sender);
    expect(r.ok).toBe(false);
  });

  it('BB_MUTATE_LIST discriminated union：非法 op/字段拒绝', () => {
    const ok = parseContentToBackground(
      { type: 'BB_MUTATE_LIST', mutation: { op: 'addBlocked', uid: 1, source: 'manual' } },
      sender,
    );
    expect(ok.ok).toBe(true);
    const badOp = parseContentToBackground(
      { type: 'BB_MUTATE_LIST', mutation: { op: 'dropDatabase', uid: 1 } },
      sender,
    );
    expect(badOp.ok).toBe(false);
    const badField = parseContentToBackground(
      { type: 'BB_MUTATE_LIST', mutation: { op: 'addBlocked', uid: -1, source: 'manual' } },
      sender,
    );
    expect(badField.ok).toBe(false);
  });
});

describe('parseBackgroundToContent', () => {
  it('合法 BB_EXECUTE_TASK 通过（含 P1-6 executionToken）；非法任务结构拒绝；缺 token 拒绝', () => {
    const task = {
      id: 't1',
      groupId: 'g1',
      type: 'block',
      uid: 10086,
      source: 'manual',
      createdAt: 1,
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: 1,
      status: 'queued',
    };
    expect(parseBackgroundToContent({ type: 'BB_EXECUTE_TASK', task, executionToken: 'tok-1' }).ok).toBe(true);
    const bad = parseBackgroundToContent({ type: 'BB_EXECUTE_TASK', task: { ...task, uid: -1 }, executionToken: 'tok-1' });
    expect(bad.ok).toBe(false);
    // P1-6：缺少 executionToken 拒绝
    const noToken = parseBackgroundToContent({ type: 'BB_EXECUTE_TASK', task });
    expect(noToken.ok).toBe(false);
  });

  it('未知后台消息拒绝', () => {
    expect(parseBackgroundToContent({ type: 'BB_FAKE' }).ok).toBe(false);
  });

  it('BB_REFRESH_DATA 通过（P1-1 通知协议）', () => {
    expect(parseBackgroundToContent({ type: 'BB_REFRESH_DATA' }).ok).toBe(true);
  });
});

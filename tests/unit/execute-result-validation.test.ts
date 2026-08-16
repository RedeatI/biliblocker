/**
 * P1-6（v0.1.2）：BB_EXECUTE_RESULT 归属校验。
 * 无 tab / 错误 tab / 错误 frame / 旧 nonce / 错误 token / 重复结果（已消费）全部拒绝。
 */
import { describe, expect, it } from 'vitest';
import { validateExecuteResult, type PendingExecEntry } from '@/shared/execute-result-validation';

const entry: PendingExecEntry = {
  executionToken: 'tok-abc',
  tabId: 100,
  frameId: 0,
  frameNonce: 'nonce-1',
};

function sender(partial: { tabId?: number; frameId?: number } = {}) {
  return {
    tab: partial.tabId !== undefined ? { id: partial.tabId } : undefined,
    frameId: partial.frameId,
  };
}

describe('P1-6 BB_EXECUTE_RESULT 归属校验', () => {
  it('完全匹配（taskId/tabId/frameId/nonce/token）→ 通过', () => {
    const v = validateExecuteResult(entry, { taskId: 't1', executionToken: 'tok-abc' }, sender({ tabId: 100, frameId: 0 }), { nonce: 'nonce-1' });
    expect(v).toEqual({ ok: true });
  });

  it('无 sender tab → 拒绝', () => {
    const v = validateExecuteResult(entry, { taskId: 't1', executionToken: 'tok-abc' }, sender({ frameId: 0 }), { nonce: 'nonce-1' });
    expect(v.ok).toBe(false);
  });

  it('无 sender frame → 拒绝', () => {
    const v = validateExecuteResult(entry, { taskId: 't1', executionToken: 'tok-abc' }, sender({ tabId: 100 }), { nonce: 'nonce-1' });
    expect(v.ok).toBe(false);
  });

  it('错误 tab（sender.tab.id ≠ 派发 tabId）→ 拒绝', () => {
    const v = validateExecuteResult(entry, { taskId: 't1', executionToken: 'tok-abc' }, sender({ tabId: 999, frameId: 0 }), { nonce: 'nonce-1' });
    expect(v.ok).toBe(false);
  });

  it('错误 frame → 拒绝', () => {
    const v = validateExecuteResult(entry, { taskId: 't1', executionToken: 'tok-abc' }, sender({ tabId: 100, frameId: 7 }), { nonce: 'nonce-1' });
    expect(v.ok).toBe(false);
  });

  it('错误 token → 拒绝', () => {
    const v = validateExecuteResult(entry, { taskId: 't1', executionToken: 'tok-wrong' }, sender({ tabId: 100, frameId: 0 }), { nonce: 'nonce-1' });
    expect(v.ok).toBe(false);
  });

  it('旧 nonce（帧身份已刷新）→ 拒绝', () => {
    const v = validateExecuteResult(entry, { taskId: 't1', executionToken: 'tok-abc' }, sender({ tabId: 100, frameId: 0 }), { nonce: 'nonce-OLD' });
    expect(v.ok).toBe(false);
  });

  it('entry 不存在（已消费/超时）→ 拒绝（重复结果无法再次通过）', () => {
    const v = validateExecuteResult(undefined, { taskId: 't1', executionToken: 'tok-abc' }, sender({ tabId: 100, frameId: 0 }), { nonce: 'nonce-1' });
    expect(v.ok).toBe(false);
  });

  it('entry 无 frameNonce 时不做 nonce 强校验（旧任务兼容）', () => {
    const noNonce: PendingExecEntry = { executionToken: 'tok-x', tabId: 1, frameId: 0 };
    const v = validateExecuteResult(noNonce, { taskId: 't1', executionToken: 'tok-x' }, sender({ tabId: 1, frameId: 0 }), undefined);
    expect(v).toEqual({ ok: true });
  });
});

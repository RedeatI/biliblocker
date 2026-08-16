/**
 * P1-6（v0.1.2）：BB_EXECUTE_RESULT 归属校验（纯函数，可单元测试）。
 *
 * 结果必须同时匹配：
 * - taskId（pendingExec 中存在，且未被消费/超时）
 * - sender.tab.id（必须存在，且等于派发时的 tabId）
 * - sender.frameId（必须存在，且等于派发时的 frameId）
 * - executionToken（一次性，等于派发时生成的值）
 * - frameNonce（当前帧身份注册 nonce 与任务一致，防旧页面复用）
 *
 * sender 缺少 tab 或 frame 直接拒绝；token 只消费一次（删除后不再匹配）。
 */

/** 派发时保存的待执行条目 */
export interface PendingExecEntry {
  executionToken: string;
  tabId: number;
  frameId: number;
  frameNonce?: string;
}

/** 消息发送者信息（background 的 sender） */
export interface ExecuteResultSender {
  tab?: { id?: number };
  frameId?: number;
}

/** 帧身份（当前注册的 nonce） */
export interface FrameIdentityForCheck {
  nonce?: string;
}

export type ExecuteResultValidation =
  | { ok: true }
  | { ok: false; message: string };

/**
 * 校验执行结果归属。
 * @param entry 派发时保存的待执行条目；不存在视为「已消费/超时/未知任务」
 * @param msg 收到的 BB_EXECUTE_RESULT 消息
 * @param sender 消息发送者
 * @param identity 当前帧身份（用于 nonce 校验）
 */
export function validateExecuteResult(
  entry: PendingExecEntry | undefined,
  msg: { taskId: string; executionToken: string },
  sender: ExecuteResultSender,
  identity: FrameIdentityForCheck | undefined,
): ExecuteResultValidation {
  if (!entry) {
    return { ok: false, message: '任务不存在、已超时或结果已消费' };
  }
  if (sender.tab?.id === undefined) {
    return { ok: false, message: '结果缺少 sender tab' };
  }
  if (sender.frameId === undefined) {
    return { ok: false, message: '结果缺少 sender frame' };
  }
  if (sender.tab.id !== entry.tabId) {
    return { ok: false, message: '结果来源页面与任务不符（tabId 不匹配）' };
  }
  if (sender.frameId !== entry.frameId) {
    return { ok: false, message: '结果来源 frame 与任务不符' };
  }
  if (msg.executionToken !== entry.executionToken) {
    return { ok: false, message: 'executionToken 不匹配' };
  }
  if (entry.frameNonce && (!identity || identity.nonce !== entry.frameNonce)) {
    return { ok: false, message: '帧会话 nonce 不匹配，结果被拒绝' };
  }
  return { ok: true };
}

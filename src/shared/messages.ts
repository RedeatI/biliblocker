/**
 * 扩展内部消息协议（MV3 环境：content ↔ background ↔ options/popup）。
 *
 * P1-6：所有 runtime message 使用 Zod discriminated union 校验：
 * - 校验字段类型与范围（uid 正整数、reasonId 合法整数、任务类型枚举等）；
 * - 校验发送上下文（tabId/frameId 与 sender 一致）；
 * - 校验任务归属（BB_EXECUTE_RESULT 只能来自任务派发页面）。
 * 接收方必须先经过校验函数再处理，防止伪造消息。
 */
import { z } from 'zod';
import type {
  ActionTask,
  ContentType,
  PageScope,
  TaskResult,
  TaskSource,
} from './types';
import { PAGE_SCOPES, CONTENT_TYPES } from './types';

// ---------------- 基础 schema ----------------

export const taskResultSchema = z.object({
  ok: z.boolean(),
  status: z.string().max(200),
  code: z.number().int().optional(),
  message: z.string().max(500).optional(),
  errorType: z
    .enum(['network', 'login_invalid', 'risk_control', 'duplicate', 'api_changed', 'invalid_reason', 'cancelled', 'tab_closed', 'validation', 'unknown', 'capability_not_verified', 'authorization_changed'])
    .optional(),
  attemptedAt: z.number().int().optional(),
});

/** P0-5（v0.1.3）/P0-2（v0.1.4）：授权快照（任务入队时捕获；派发前逐项重新验证） */
export const authorizationSnapshotSchema = z.object({
  epoch: z.number().int().nonnegative(),
  settingsRevision: z.number().int().nonnegative(),
  reasonId: z.number().int().min(0).max(10_000).nullable(),
  capabilityKey: z
    .enum(['blockUser', 'unblockUser', 'reportVideoComment', 'reportVideoReply', 'reportDynamicComment', 'reportDynamic', 'selectorsVideo', 'selectorsDynamic'])
    .nullable(),
  contentType: z.enum(CONTENT_TYPES as unknown as [ContentType, ...ContentType[]]).optional(),
  source: z.enum(['one_click', 'auto_process', 'manual']),
  /** P0-2（v0.1.4）：入队时自动处理（autoProcessVerified）授权 */
  autoProcessAuthorized: z.boolean(),
  /** P0-2（v0.1.4）：入队时自动举报授权（autoReportAuthorized）状态 */
  reportAuthorized: z.boolean(),
  /** P0-2（v0.1.4）：快照创建时间 */
  createdAt: z.number().int().nonnegative(),
});

export type AuthorizationSnapshot = z.infer<typeof authorizationSnapshotSchema>;

export const taskInputSchema = z.object({
  type: z.enum(['block', 'unblock', 'report']),
  uid: z.number().int().positive(),
  username: z.string().max(64).optional(),
  contentType: z.enum(CONTENT_TYPES as unknown as [ContentType, ...ContentType[]]).optional(),
  contentId: z.string().trim().min(1).max(64).optional(),
  rootContentId: z.string().min(1).max(64).optional(),
  /** 内容归属 ID（评论举报的 oid：视频 aid / 动态 ID） */
  oid: z.string().min(1).max(64).optional(),
  reasonId: z.number().int().min(0).max(10_000).optional(),
  source: z.enum(['one_click', 'auto_process', 'manual']),
  groupId: z.string().min(1).max(64).optional(),
  contentHash: z.string().min(1).max(64).optional(),
}).superRefine((task, ctx) => {
  if (task.type !== 'report') return;
  if (task.contentType === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentType'], message: '举报任务缺少内容类型' });
  }
  if (task.contentId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentId'], message: '举报任务缺少内容 ID' });
  }
  if (task.reasonId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonId'], message: '举报任务缺少举报理由' });
  }
});

export type TaskInput = z.infer<typeof taskInputSchema>;

export const actionTaskSchema = z.object({
  id: z.string().min(1).max(64),
  groupId: z.string().min(1).max(64),
  type: z.enum(['block', 'unblock', 'report']),
  uid: z.number().int().positive(),
  username: z.string().max(64).optional(),
  contentType: z.enum(CONTENT_TYPES as unknown as [ContentType, ...ContentType[]]).optional(),
  contentId: z.string().trim().min(1).max(64).optional(),
  rootContentId: z.string().min(1).max(64).optional(),
  oid: z.string().min(1).max(64).optional(),
  reasonId: z.number().int().min(0).max(10_000).optional(),
  source: z.enum(['one_click', 'auto_process', 'manual']),
  createdAt: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: z.number().int().nonnegative(),
  status: z.enum(['queued', 'in_flight', 'succeeded', 'failed', 'cancelled', 'skipped', 'unknown_outcome']),
  result: taskResultSchema.optional(),
  tabId: z.number().int().nonnegative().optional(),
  frameId: z.number().int().nonnegative().optional(),
  /** 发起页面会话 nonce：恢复/派发前验证 tab 与页面身份（P1-6） */
  frameNonce: z.string().min(1).max(64).optional(),
  contentHash: z.string().min(1).max(64).optional(),
  /** P0-5（v0.1.3）：入队时授权快照；派发前重新验证 */
  authorization: authorizationSnapshotSchema.optional(),
  /** P0-3（v0.1.3）：撤权/取消已请求（in_flight → unknown_outcome，真实结果保留） */
  revocationRequested: z.boolean().optional(),
  /** 派发前验证失败原因 */
  skipReason: z.string().max(200).optional(),
}).superRefine((task, ctx) => {
  if (task.type !== 'report') return;
  if (task.contentType === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentType'], message: '举报任务缺少内容类型' });
  }
  if (task.contentId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentId'], message: '举报任务缺少内容 ID' });
  }
  if (task.reasonId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonId'], message: '举报任务缺少举报理由' });
  }
});

export type ActionTaskSchema = z.infer<typeof actionTaskSchema>;

export const pageScopeSchema = z.enum(PAGE_SCOPES as unknown as [PageScope, ...PageScope[]]);

// ---------------- content → background ----------------

import { LIMITS } from './constants/defaults';
import { importDataSchema } from '../rules/import-export';
import { ruleSchema } from '../rules/schema';

/** P1-3：设置增量更新（CAS 写入 background） */
const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  videoCommentsEnabled: z.boolean().optional(),
  dynamicsEnabled: z.boolean().optional(),
  suspiciousHandling: z.enum(['collapse', 'hide', 'flag_only']).optional(),
  quickActionDisplay: z.enum(['hover', 'always']).optional(),
  autoReportAuthorized: z.boolean().optional(),
  defaultReportReason: z.number().int().nullable().optional(),
  autoProcessVerified: z.boolean().optional(),
  operationDelayMs: z.number().int().min(0).max(60000).optional(),
});

const pingSchema = z.object({
  type: z.literal('BB_PING'),
  pageScope: pageScopeSchema,
  /** 页面会话 nonce（注册帧身份） */
  frameNonce: z.string().min(1).max(64),
  url: z.string().max(2048).optional(),
});

const loginSchema = z.object({
  type: z.literal('BB_LOGIN'),
  isLogin: z.boolean(),
  mid: z.number().int().positive().nullable(),
});

const cancelTasksSchema = z.object({
  type: z.literal('BB_CANCEL_TASKS'),
  taskIds: z.array(z.string().min(1).max(64)).max(200),
});

const executeResultSchema = z.object({
  type: z.literal('BB_EXECUTE_RESULT'),
  taskId: z.string().min(1).max(64),
  /** P1-6：一次性 executionToken（每次派发生成，只消费一次） */
  executionToken: z.string().min(1).max(64),
  result: taskResultSchema,
});

const queueStatusReqSchema = z.object({ type: z.literal('BB_QUEUE_STATUS_REQ') });
const loginRestoredSchema = z.object({ type: z.literal('BB_LOGIN_RESTORED') });
/** popup 请求打开 Options；仅允许公开的日志页内锚点，避免任意 extension URL 导航。 */
const openOptionsSchema = z.object({
  type: z.literal('BB_OPEN_OPTIONS'),
  target: z.enum(['logs', 'welcome']).optional(),
});

// ---- 名单/数据变更（P1-1：RMW 统一到 background 串行执行） ----
// P1-1（v0.1.2）：addBlocked/addVerified/addWhitelist 可携带 operationId（跨 Tab 事务归属）；
// 补偿回滚只删除同一 operationId 创建且版本未变化的记录。
// P1-3（v0.1.2）：saveRules/updateSettings 携带 expectedRevision（CAS 拒绝过期覆盖）；
// importAll.data 使用完整 Zod Schema（不再是 z.unknown()）。
export const listMutationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addBlocked'), uid: z.number().int().positive(), username: z.string().max(64).optional(), reason: z.string().max(200).optional(), source: z.enum(['user_action', 'manual', 'import', 'auto_process']), operationId: z.string().min(1).max(64).optional() }),
  z.object({ op: z.literal('removeBlocked'), uid: z.number().int().positive() }),
  z.object({ op: z.literal('addVerified'), uid: z.number().int().positive(), username: z.string().max(64).optional(), source: z.enum(['user_action', 'manual', 'import', 'official_mark']), operationId: z.string().min(1).max(64).optional() }),
  z.object({ op: z.literal('removeVerified'), uid: z.number().int().positive() }),
  z.object({ op: z.literal('addWhitelist'), uid: z.number().int().positive(), username: z.string().max(64).optional(), operationId: z.string().min(1).max(64).optional() }),
  z.object({ op: z.literal('removeWhitelist'), uid: z.number().int().positive() }),
  z.object({
    op: z.literal('addBlockedBatch'),
    items: z.array(z.object({ uid: z.number().int().positive(), username: z.string().max(64).optional(), reason: z.string().max(200).optional(), source: z.enum(['user_action', 'manual', 'import', 'auto_process']) })).max(20_000),
  }),
  z.object({
    op: z.literal('addVerifiedBatch'),
    items: z.array(z.object({ uid: z.number().int().positive(), username: z.string().max(64).optional(), source: z.enum(['user_action', 'manual', 'import', 'official_mark']) })).max(20_000),
  }),
  z.object({
    op: z.literal('addWhitelistBatch'),
    items: z.array(z.object({ uid: z.number().int().positive(), username: z.string().max(64).optional() })).max(5_000),
  }),
  z.object({
    op: z.literal('appendAudit'),
    entry: z.object({
      uid: z.number().int().nonnegative(),
      username: z.string().max(64).optional(),
      contentType: z.enum(CONTENT_TYPES as unknown as [ContentType, ...ContentType[]]).optional(),
      contentId: z.string().min(1).max(64).optional(),
      trigger: z.enum(['one_click', 'auto_process', 'manual', 'rule_auto', 'system']),
      matchedRuleIds: z.array(z.string().max(64)).max(50),
      localHidden: z.boolean(),
      blockResult: taskResultSchema.optional(),
      reportResult: taskResultSchema.optional(),
      failureReason: z.string().max(500).optional(),
      cancelled: z.boolean().optional(),
      /** P0-3：SW 崩溃恢复时结果未知 */
      outcomeUnknown: z.boolean().optional(),
      /** P0-5（v0.1.3）：派发前验证被跳过的原因 */
      skipReason: z.string().max(200).optional(),
    }),
  }),
  // P1-1（v0.1.3）：审计清空收归 background（与 reset/clear 互斥）
  z.object({ op: z.literal('clearAudit') }),
  // P0-4（v0.1.4）：unknown_outcome 持久证据（幂等 upsert；锁外写经本 op 排队）
  z.object({
    op: z.literal('appendUnknownOutcome'),
    record: z.object({
      taskId: z.string().min(1).max(64),
      groupId: z.string().min(1).max(64).optional(),
      type: z.enum(['block', 'unblock', 'report']),
      uid: z.number().int().positive(),
      contentId: z.string().min(1).max(64).optional(),
      reasonId: z.number().int().min(0).max(10_000).optional(),
      dispatchedAt: z.number().int().nonnegative().optional(),
      markedAt: z.number().int().nonnegative(),
      cause: z.enum(['sw_restart', 'cancel_in_flight', 'revoke', 'reset', 'clear']),
      acknowledgedAt: z.number().int().nonnegative().optional(),
    }),
  }),
  // P0-4（v0.1.4）：用户显式「已人工核对/已知晓」结果未知记录
  z.object({ op: z.literal('acknowledgeUnknownOutcome'), taskId: z.string().min(1).max(64) }),
  // P1-3：settings/rules 写收归 background + CAS
  z.object({
    op: z.literal('saveRules'),
    rules: z.array(ruleSchema).max(LIMITS.MAX_RULES),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  z.object({
    op: z.literal('updateSettings'),
    patch: settingsPatchSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  // P1-6（v0.1.2）：importAll.data 完整 Zod Schema（不再是 z.unknown()）
  z.object({ op: z.literal('importAll'), data: importDataSchema }),
  z.object({ op: z.literal('resetDefaults') }),
  z.object({ op: z.literal('clearAll') }),
]);

export type ListMutation = z.infer<typeof listMutationSchema>;

const mutateListSchema = z.object({
  type: z.literal('BB_MUTATE_LIST'),
  mutation: listMutationSchema,
});

/**
 * P0-4/P0-5（v0.1.3）：一键动作原子提交。
 * 倒计时只属于 UI；倒计时结束后内容脚本向 background 发送一次本消息，
 * background 在单个短生命周期协调操作内重新验证 → 计算精确 delta →
 * 原子写入本地名单 + 队列（全部成功或全部失败），不再有跨倒计时长生命周期事务。
 */
const commitActionSchema = z.object({
  type: z.literal('BB_COMMIT_ACTION'),
  /** 请求唯一标识（幂等/审计用；由内容脚本生成，一次提交使用一次） */
  operationId: z.string().min(1).max(64),
  uid: z.number().int().positive(),
  username: z.string().max(64).optional(),
  contentType: z.enum(CONTENT_TYPES as unknown as [ContentType, ...ContentType[]]),
  contentId: z.string().min(1).max(64).nullable(),
  rootContentId: z.string().min(1).max(64).nullable(),
  oid: z.string().min(1).max(64).nullable(),
  contentHash: z.string().min(1).max(64).optional(),
  source: z.enum(['one_click', 'auto_process', 'manual']),
  /** 本地动作矩阵（commitLocalBlock / commitVerified 由调用方按计划决定） */
  localActions: z.object({
    commitLocalBlock: z.boolean(),
    commitVerified: z.boolean(),
  }),
  /** 已过滤的官方任务意图（已过能力/理由/类型门禁；可空） */
  officialTasks: z.array(taskInputSchema).max(100),
  /** true = 用户选择「仅取消官方任务」：只提交本地，不入队官方 */
  skipOfficial: z.boolean(),
  /** 入队时授权快照（background 重新验证用） */
  authorization: authorizationSnapshotSchema,
  /** 发起页面会话 nonce */
  frameNonce: z.string().min(1).max(64),
  /** 是否已通过登录检查（仅当存在官方任务时 content 才会执行 checkLogin） */
  loginOk: z.boolean(),
  currentMid: z.number().int().positive().nullable(),
});

/** P0-5（v0.1.3）：用户显式恢复队列（risk_control/authorization_revoked 只能经此恢复） */
const queueResumeSchema = z.object({
  type: z.literal('BB_QUEUE_RESUME'),
  mode: z.enum(['user', 'login_restored']),
});

/** P0-5（v0.1.3）：用户显式「取消全部待执行官方操作」 */
const cancelAllPendingSchema = z.object({
  type: z.literal('BB_CANCEL_ALL_PENDING'),
  reason: z.string().max(200).optional(),
});

export const contentToBackgroundSchema = z.discriminatedUnion('type', [
  pingSchema,
  loginSchema,
  cancelTasksSchema,
  executeResultSchema,
  queueStatusReqSchema,
  loginRestoredSchema,
  openOptionsSchema,
  mutateListSchema,
  commitActionSchema,
  queueResumeSchema,
  cancelAllPendingSchema,
]);

export type ContentToBackground = z.infer<typeof contentToBackgroundSchema>;

// ---------------- background → content ----------------

const executeTaskSchema = z.object({
  type: z.literal('BB_EXECUTE_TASK'),
  task: actionTaskSchema,
  /** P1-6：一次性 executionToken（内容脚本执行后原样回传，防伪造结果） */
  executionToken: z.string().min(1).max(64),
});

const taskDoneSchema = z.object({
  type: z.literal('BB_TASK_DONE'),
  taskId: z.string().min(1).max(64),
  groupId: z.string().min(1).max(64),
  result: taskResultSchema,
  taskType: z.string().max(32),
  /** P0-3：true 表示该任务结果未知（SW 崩溃恢复），需要人工核对，不得保证撤销 */
  unknownOutcome: z.boolean().optional(),
});

const taskCancelledSchema = z.object({
  type: z.literal('BB_TASK_CANCELLED'),
  taskId: z.string().min(1).max(64),
});

const queuePausedSchema = z.object({
  type: z.literal('BB_QUEUE_PAUSED'),
  reason: z.string().max(200),
});

const queueResumedSchema = z.object({ type: z.literal('BB_QUEUE_RESUMED') });

const notifySchema = z.object({
  type: z.literal('BB_NOTIFY'),
  level: z.enum(['info', 'success', 'error', 'warning']),
  message: z.string().max(300),
});

/** import/reset/clear 后通知内容脚本刷新（P1-1） */
const refreshDataSchema = z.object({ type: z.literal('BB_REFRESH_DATA') });

export const backgroundToContentSchema = z.discriminatedUnion('type', [
  executeTaskSchema,
  taskDoneSchema,
  taskCancelledSchema,
  queuePausedSchema,
  queueResumedSchema,
  notifySchema,
  refreshDataSchema,
]);

export type BackgroundToContent = z.infer<typeof backgroundToContentSchema>;

/** background → options/popup */
export const backgroundToUiSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('BB_QUEUE_STATUS'), status: z.unknown() }),
  z.object({ type: z.literal('BB_SETTINGS_CHANGED') }),
]);

export type BackgroundToUi = z.infer<typeof backgroundToUiSchema>;

export type RuntimeMessage = ContentToBackground | BackgroundToContent | BackgroundToUi;

// ---------------- 解析工具 ----------------

export interface ParseResult<T> {
  ok: true;
  data: T;
}

export function parseContentToBackground(
  msg: unknown,
  sender: { tab?: { id?: number }; frameId?: number },
): { ok: true; data: ContentToBackground } | { ok: false; error: string } {
  const parsed = contentToBackgroundSchema.safeParse(msg);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  const data = parsed.data;
  // 发布不变量：无/空白 contentId 的提交不得携带 verified 写入意图。
  // 举报任务的非空 contentId 由 taskInputSchema 继续独立约束。
  if (
    data.type === 'BB_COMMIT_ACTION' &&
    !data.contentId?.trim() &&
    data.localActions.commitVerified
  ) {
    return { ok: false, error: '缺少内容 ID 时不得标记为已确认机器人' };
  }
  // 发送上下文校验：带 frameId 的消息必须与 sender.frameId 一致（防伪造）
  if ('frameId' in data && data.frameId !== undefined) {
    if (sender.frameId !== undefined && data.frameId !== sender.frameId) {
      return { ok: false, error: `frameId 不匹配（消息=${data.frameId}, sender=${sender.frameId}）` };
    }
  }
  return { ok: true, data };
}

export function parseBackgroundToContent(
  msg: unknown,
): { ok: true; data: BackgroundToContent } | { ok: false; error: string } {
  const parsed = backgroundToContentSchema.safeParse(msg);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: firstIssue(parsed.error) };
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? '消息格式非法';
}

// ---------------- 兼容导出（旧类型） ----------------

export type { ActionTask, ContentType, PageScope, TaskResult, TaskSource };

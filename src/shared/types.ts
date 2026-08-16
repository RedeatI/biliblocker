/**
 * BiliBlocker 共享类型定义。
 * 所有核心模块（规则引擎、动作队列、适配器、存储）共享的类型，禁止在业务层散落重复定义。
 */

/**
 * 能力键名称（P0-5）：与 shared/capabilities.ts 的 CapabilityKey 同构。
 * 定义在 types 层避免 capabilities → selectors → types 的循环依赖；
 * capabilities.ts 复用本类型（`export type CapabilityKey = CapabilityKeyName`）。
 */
export type CapabilityKeyName =
  | 'blockUser'
  | 'unblockUser'
  | 'reportVideoComment'
  | 'reportVideoReply'
  | 'reportDynamicComment'
  | 'reportDynamic'
  | 'selectorsVideo'
  | 'selectorsDynamic';

/** 内容类型 */
export type ContentType = 'video_comment' | 'video_reply' | 'dynamic' | 'dynamic_comment';

/** 页面范围 */
export type PageScope =
  | 'video_page'
  | 'dynamic_feed'
  | 'dynamic_detail'
  | 'dynamic_comments'
  | 'other';

/** 从 DOM 提取到的原始内容（页面适配器产出） */
export interface ExtractedContent {
  contentType: ContentType;
  pageScope: PageScope;
  /** 发布者 UID；无法可靠取得时为 null（此时禁止官方拉黑/举报） */
  uid: number | null;
  username: string | null;
  text: string;
  links: string[];
  linkDomains: string[];
  /** 内容 ID（评论 rpid / 动态 id）；无法取得时为 null */
  contentId: string | null;
  /** 根评论 ID（楼中楼为其所属根评论的 rpid；一级评论等于自身） */
  rootContentId: string | null;
  /** 视频 aid（oid）或 null */
  videoId: string | null;
  /** 原动态 ID（转发动态时）或 null */
  origDynamicId: string | null;
  /** 对应 DOM 节点引用 */
  node: HTMLElement;
}

/** 规则引擎求值上下文（提取内容 + 本地名单状态） */
export interface ContentContext {
  uid: number | null;
  username: string | null;
  text: string;
  links: string[];
  linkDomains: string[];
  contentType: ContentType;
  pageScope: PageScope;
  hasLinks: boolean;
  isLocalBlocked: boolean;
  isWhitelisted: boolean;
  isVerifiedMachine: boolean;
  contentId: string | null;
  rootContentId: string | null;
  videoId: string | null;
  origDynamicId: string | null;
}

/** 规则字段 */
export type RuleField =
  | 'uid'
  | 'username'
  | 'content'
  | 'links'
  | 'linkDomains'
  | 'contentType'
  | 'pageScope'
  | 'isLocalBlocked'
  | 'isWhitelisted'
  | 'isVerifiedMachine'
  | 'hasLinks';

/** 规则运算符 */
export type RuleOperator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'not_contains'
  | 'prefix'
  | 'suffix'
  | 'regex'
  | 'exists'
  | 'not_exists';

/** 单条匹配条件 */
export interface Condition {
  field: RuleField;
  operator: RuleOperator;
  /** 比较值；exists/not_exists 时忽略 */
  value: string;
  /**
   * P1-7：正则条件的 Worker 验证记录（保存硬门禁）。
   * pattern/sample/operator 变化后状态失效；无 Worker 时 workerAvailable=false。
   */
  regexVerification?: RegexVerification;
}

/** P1-7：正则 Worker 验证状态（每个 regex row 持久化） */
export interface RegexVerification {
  ok: boolean;
  /** 被验证的精确 pattern */
  pattern: string;
  /** 验证时使用的样例（变化后状态失效） */
  sample: string;
  /** 验证时是否实际使用了 Worker（无 Worker 环境不得显示「已通过 Worker」） */
  workerAvailable: boolean;
  verifiedAt: number;
}

/** 条件组：支持 and / or / not 组合 */
export interface ConditionGroup {
  logic: 'and' | 'or' | 'not';
  conditions: Condition[];
  groups: ConditionGroup[];
}

/** 规则动作 */
export type RuleAction =
  | 'flag_suspicious'
  | 'collapse_content'
  | 'hide_content'
  | 'notify_user'
  | 'suggest_manual_action'
  | 'local_block_verified_uid'
  | 'official_block_verified_uid'
  | 'report_verified_uid_content';

/** 可举报类别（用于「内容条件」判定） */
export type ReportCategory = 'ad' | 'spam' | 'fraud' | 'other';

export interface Rule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** 数字越大优先级越高 */
  priority: number;
  conditions: ConditionGroup;
  /** 空数组 = 全部页面 */
  pageScope: PageScope[];
  /** 空数组 = 全部内容类型 */
  contentTypes: ContentType[];
  action: RuleAction;
  /** 规则命中是否构成「内容违规」（自动举报内容条件的依据之一） */
  reportCategory: ReportCategory | null;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}

export interface Settings {
  /** 总开关 */
  enabled: boolean;
  videoCommentsEnabled: boolean;
  dynamicsEnabled: boolean;
  /** 疑似内容处理方式 */
  suspiciousHandling: 'collapse' | 'hide' | 'flag_only';
  /** 快捷按钮显示方式 */
  quickActionDisplay: 'hover' | 'always';
  /** 自动举报首次授权 */
  autoReportAuthorized: boolean;
  /** 默认举报理由（reason id） */
  defaultReportReason: number | null;
  /** 对已确认机器人自动处理（默认关闭） */
  autoProcessVerified: boolean;
  /** 官方操作倒计时（毫秒） */
  operationDelayMs: number;
}

export interface BlockedUser {
  uid: number;
  username?: string;
  reason?: string;
  blockedAt: number;
  source: 'user_action' | 'manual' | 'import' | 'auto_process';
}

export interface VerifiedMachine {
  uid: number;
  username?: string;
  source: 'user_action' | 'manual' | 'import' | 'official_mark';
  addedAt: number;
}

export interface WhitelistedUser {
  uid: number;
  username?: string;
  addedAt: number;
}

/** 任务类型 */
export type TaskType = 'block' | 'unblock' | 'report';

/**
 * 任务状态。
 * - unknown_outcome（P0-3，v0.1.2）：SW 崩溃时 in_flight 任务可能已被服务端接收但结果未知；
 *   不可逆举报绝不自动重发；需要人工核对。该状态不进入 pump、不自动执行。
 */
export type TaskStatus =
  | 'queued'
  | 'in_flight'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'unknown_outcome';

export type TaskSource = 'one_click' | 'auto_process' | 'manual';

export type TaskErrorType =
  | 'network'
  | 'login_invalid'
  | 'risk_control'
  | 'duplicate'
  | 'api_changed'
  | 'invalid_reason'
  | 'cancelled'
  | 'tab_closed'
  | 'validation'
  | 'capability_not_verified'
  | 'authorization_changed'
  | 'unknown';

export interface TaskResult {
  ok: boolean;
  status: string;
  code?: number;
  message?: string;
  errorType?: TaskErrorType;
  attemptedAt?: number;
}

export interface ActionTask {
  id: string;
  /** 一组动作（拉黑+举报）共享的分组 id，用于 UI 状态关联 */
  groupId: string;
  type: TaskType;
  uid: number;
  username?: string;
  contentType?: ContentType;
  contentId?: string;
  rootContentId?: string;
  /** 内容归属 ID（评论举报的 oid：视频 aid / 动态 ID） */
  oid?: string;
  reasonId?: number;
  source: TaskSource;
  createdAt: number;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  status: TaskStatus;
  result?: TaskResult;
  /** 发起该任务的页面（用于把任务派发回内容脚本执行） */
  tabId?: number;
  frameId?: number;
  /** 发起页面会话 nonce（P1-6：恢复/派发前验证 tab 与页面身份，防旧 tabId 复用） */
  frameNonce?: string;
  /** 内容正文摘要哈希（用于日志，不保存正文） */
  contentHash?: string;
  /**
   * P0-5（v0.1.3）：入队时授权快照。派发前必须与当前状态逐项重新验证；
   * 任何撤权（epoch 递增）/设置变化/能力回退都会导致旧快照任务被跳过。
   */
  authorization?: AuthorizationSnapshot;
  /**
   * P0-3（v0.1.3）：撤权/取消已请求（针对 in_flight 任务）。
   * 为 true 时执行器返回的真实结果仍被保留，但最终状态保持 unknown_outcome，
   * 绝不自动重发、绝不显示「已取消成功」。
   */
  revocationRequested?: boolean;
  /** 派发前验证失败原因（audit/UI 展示用） */
  skipReason?: string;
}

/**
 * P0-5（v0.1.3）/P0-2（v0.1.4）：授权快照（每官方任务必填）。
 * 任务入队时捕获；派发前与当前 settings/epoch/capabilities/reasons/whitelist 逐项比较。
 * epoch 变化（任何撤权/reset/clear/能力回退）→ 旧任务不得执行。
 * v0.1.4：block/unblock/report 分别保存自己的 capabilityKey/reasonId；
 * 缺少任一必要授权标识（epoch/settingsRevision/capabilityKey/source/
 * autoProcessAuthorized/reportAuthorized/createdAt）的任务拒绝创建官方任务。
 */
export interface AuthorizationSnapshot {
  /** 授权纪元：任何撤权/重置/清空/能力回退都会递增 */
  epoch: number;
  /** settings 的 revision（入队时读取） */
  settingsRevision: number;
  /** 入队时解析的举报理由（report 任务必填）；无有效理由为 null */
  reasonId: number | null;
  /** 该任务依赖的真实能力键（block→blockUser、unblock→unblockUser、report→按内容类型） */
  capabilityKey: CapabilityKeyName | null;
  /** 任务内容类型（report 任务必须有） */
  contentType?: ContentType;
  /** 任务来源 */
  source: TaskSource;
  /** 入队时自动处理（autoProcessVerified）是否已授权 */
  autoProcessAuthorized: boolean;
  /** 入队时自动举报授权（autoReportAuthorized）是否已开启 */
  reportAuthorized: boolean;
  /** 快照创建时间 */
  createdAt: number;
}

/**
 * P0-4（v0.1.4）：不可逆操作「结果未知」持久证据（tombstone）。
 * in-flight 任务被 cancel/revoke/reset/clear/SW 重启转为 unknown_outcome 时，
 * 必须先原子写入本记录与审计；普通队列可清理，但结果未知记录不得被 reset/clear
 * 静默删除；只能通过用户显式「已人工核对/已知晓」标记 acknowledgedAt。
 */
export interface UnknownOutcomeRecord {
  /** 对应队列任务 id */
  taskId: string;
  /** 一组动作共享的分组 id */
  groupId?: string;
  type: TaskType;
  uid: number;
  contentId?: string;
  reasonId?: number;
  /** 任务实际派发时间（in_flight 时记录） */
  dispatchedAt?: number;
  /** 标记为结果未知的时间 */
  markedAt: number;
  cause: 'sw_restart' | 'cancel_in_flight' | 'revoke' | 'reset' | 'clear';
  /** 用户显式「已人工核对/已知晓」时间；null = 未核对 */
  acknowledgedAt?: number;
}

/**
 * P0-5（v0.1.3）：队列暂停种类。
 * - login：登录失效，已验证重新登录后可恢复；
 * - risk_control：风控/验证码，只能由用户显式恢复，跨 SW 重启保持；
 * - user：用户手动暂停，由用户恢复；
 * - authorization_revoked：授权被撤销（总开关关闭等），恢复前必须重新验证授权。
 */
export type PauseKind = 'none' | 'login' | 'risk_control' | 'user' | 'authorization_revoked';

/**
 * P0-5（v0.1.3）：持久化队列安全状态（storage bb.queueControl）。
 * 跨 MV3 Service Worker 重启保持；ActionQueue 构造/启动时不得默认恢复为未暂停。
 */
export interface QueueControlState {
  paused: boolean;
  pauseReason: string | null;
  pauseKind: PauseKind;
  pausedAt: number | null;
  /** risk_control / authorization_revoked 必须用户显式恢复 */
  requiresExplicitResume: boolean;
  /** 授权纪元：任何撤权/reset/clear/能力回退递增 */
  authorizationEpoch: number;
  /** 最近一分钟内各类实际发送尝试时间戳（crash-safe：发送前持久化） */
  recentAttempts: Record<'block' | 'report' | 'unblock', number[]>;
}

export interface AuditEntry {
  id: string;
  ts: number;
  uid: number;
  username?: string;
  contentType?: ContentType;
  contentId?: string;
  trigger: 'one_click' | 'auto_process' | 'manual' | 'rule_auto' | 'system';
  matchedRuleIds: string[];
  localHidden: boolean;
  blockResult?: TaskResult;
  reportResult?: TaskResult;
  failureReason?: string;
  cancelled?: boolean;
  /** P0-3：SW 崩溃恢复时 in_flight 任务结果未知（可能已发送但未确认） */
  outcomeUnknown?: boolean;
}

export interface ReportReason {
  id: number;
  label: string;
  category: ReportCategory;
}

/** 规则引擎决策结果 */
export interface EngineDecision {
  hide: boolean;
  collapse: boolean;
  flag: boolean;
  notify: boolean;
  suggestManual: boolean;
  localBlock: boolean;
  matchedRules: Rule[];
}

export interface QueueStatus {
  running: boolean;
  paused: boolean;
  pausedReason?: string;
  /** P0-5：暂停种类（none/login/risk_control/user/authorization_revoked） */
  pauseKind?: PauseKind;
  /** P0-5：当前授权纪元（派发前验证用） */
  authorizationEpoch?: number;
  queued: number;
  inFlight: number;
  lastError?: string;
}

export const CONTENT_TYPES: readonly ContentType[] = [
  'video_comment',
  'video_reply',
  'dynamic',
  'dynamic_comment',
];

export const PAGE_SCOPES: readonly PageScope[] = [
  'video_page',
  'dynamic_feed',
  'dynamic_detail',
  'dynamic_comments',
  'other',
];

export const RULE_ACTIONS: readonly RuleAction[] = [
  'flag_suspicious',
  'collapse_content',
  'hide_content',
  'notify_user',
  'suggest_manual_action',
  'local_block_verified_uid',
  'official_block_verified_uid',
  'report_verified_uid_content',
];

/** 官方动作：只有精确 UID + 已确认机器人名单才能获得 */
export const OFFICIAL_ACTIONS: readonly RuleAction[] = [
  'local_block_verified_uid',
  'official_block_verified_uid',
  'report_verified_uid_content',
];

/** 疑似类动作：任何内容规则（正文/用户名/链接/正则）可合法使用 */
export const SUSPICIOUS_ACTIONS: readonly RuleAction[] = [
  'flag_suspicious',
  'collapse_content',
  'hide_content',
  'notify_user',
  'suggest_manual_action',
];

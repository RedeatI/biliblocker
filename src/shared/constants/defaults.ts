/**
 * 默认设置、存储键、限额与限流参数集中配置。
 */
import type { QueueControlState, Settings } from '../types';

export const STORAGE_KEYS = {
  settings: 'bb.settings',
  rules: 'bb.rules',
  blocked: 'bb.blocked',
  verified: 'bb.verified',
  whitelist: 'bb.whitelist',
  dedup: 'bb.dedup',
  queue: 'bb.queue',
  audit: 'bb.audit',
  meta: 'bb.meta',
  /** P1-3：settings/rules 的乐观并发版本号（CAS） */
  revisions: 'bb.revisions',
  /** P0-5（v0.1.3）：队列安全状态（暂停/风控/授权纪元/速率预算），跨 SW 重启持久 */
  queueControl: 'bb.queueControl',
  /** P0-4（v0.1.4）：不可逆操作「结果未知」持久证据（tombstone），reset/clear 不删除 */
  unknownOutcomes: 'bb.unknownOutcomes',
  /** P0-5（v0.1.4）：BB_COMMIT_ACTION operationId 幂等结果（有限 TTL/容量） */
  operationOutcomes: 'bb.operationOutcomes',
} as const;

export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  videoCommentsEnabled: true,
  dynamicsEnabled: true,
  suspiciousHandling: 'collapse',
  quickActionDisplay: 'hover',
  autoReportAuthorized: false,
  defaultReportReason: null,
  autoProcessVerified: false,
  operationDelayMs: 3000,
};

/** 生产 background 首次播种专用；升级已有设置、导入和显式重置不使用。 */
export const NEW_INSTALL_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  enabled: false,
  suspiciousHandling: 'flag_only',
};

/** 数据规模上限（防御性限制，防止导入超大文件拖垮页面） */
export const LIMITS = {
  MAX_RULES: 300,
  MAX_BLOCKED: 20_000,
  MAX_VERIFIED: 20_000,
  MAX_WHITELIST: 5_000,
  MAX_AUDIT: 2_000,
  IMPORT_MAX_BYTES: 512 * 1024,
  REGEX_MAX_LEN: 200,
  TEST_TEXT_MAX_LEN: 1_000,
  CONDITION_VALUE_MAX_LEN: 500,
  /** 每组条件数上限 */
  MAX_CONDITIONS_PER_GROUP: 20,
  /** 每组子组数上限 */
  MAX_SUBGROUPS_PER_GROUP: 4,
  /** 条件树最大递归深度 */
  MAX_CONDITIONS_DEPTH: 5,
  /** 条件树全树条件总数上限（防超大导入） */
  MAX_CONDITIONS_TOTAL: 100,
} as const;

/** 队列与限流参数（保守值，均可配置化） */
export const QUEUE = {
  /** 拉黑与举报队列分离，各自串行执行 */
  BLOCK_CONCURRENCY: 1,
  REPORT_CONCURRENCY: 1,
  /** 网络错误最多重试次数 */
  MAX_NETWORK_RETRIES: 2,
  /** 服务端明确拒绝：不重试 */
  MAX_REJECT_RETRIES: 0,
  /** 网络错误退避（毫秒，指数） */
  BACKOFF_BASE_MS: 2_000,
  /** 每分钟操作上限（保守，避免触发风控） */
  MAX_BLOCK_PER_MINUTE: 15,
  MAX_REPORT_PER_MINUTE: 8,
  /** 派发到内容脚本执行的最长等待时间 */
  EXECUTE_TIMEOUT_MS: 20_000,
  /** P0-5（v0.1.4）：SW 重启后等待内容脚本重新注册帧身份的宽限期（毫秒） */
  FRAME_REGISTRATION_GRACE_MS: 10_000,
  /** 终态任务（failed/cancelled/skipped）在活动队列中的最长保留时间（7 天） */
  TERMINAL_TTL_MS: 7 * 24 * 3600 * 1000,
  /** 队列持久化键 */
  KEY: 'bb.queue',
} as const;

/** P0-4（v0.1.4）：unknown_outcome 持久证据容量/保留策略 */
export const UNKNOWN_OUTCOME = {
  /** 最多保留的记录数 */
  MAX_RECORDS: 500,
  /** 已人工核对记录的最长保留时间（30 天）；未核对记录不因 TTL 删除 */
  ACKNOWLEDGED_TTL_MS: 30 * 24 * 3600 * 1000,
} as const;

/** P0-5（v0.1.4）：operationId 幂等结果容量/保留策略 */
export const OPERATION_OUTCOME = {
  /** 最多保留的结果数 */
  MAX_RECORDS: 200,
  /** 结果保留时间（30 分钟） */
  TTL_MS: 30 * 60 * 1000,
} as const;

/** P0-5（v0.1.3）：默认队列控制状态（未暂停、纪元 0、空速率预算） */
export const DEFAULT_QUEUE_CONTROL: QueueControlState = {
  paused: false,
  pauseReason: null,
  pauseKind: 'none',
  pausedAt: null,
  requiresExplicitResume: false,
  authorizationEpoch: 0,
  recentAttempts: { block: [], report: [], unblock: [] },
};

/** 去重 TTL（毫秒） */
export const DEDUP_TTL = {
  BLOCK: 30 * 24 * 3600 * 1000,
  UNBLOCK: 7 * 24 * 3600 * 1000,
  REPORT: 365 * 24 * 3600 * 1000,
} as const;

/** 扩展内部域名（不视为站外链接） */
export const INTERNAL_DOMAINS = new Set<string>([
  'bilibili.com',
  'www.bilibili.com',
  'api.bilibili.com',
  'b23.tv',
  'bili2233.cn',
  'biligame.com',
]);

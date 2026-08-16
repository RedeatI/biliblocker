/**
 * 真实能力硬门禁（P0-4）。
 *
 * 每种真实接口能力有独立的 Verification 记录，引用 docs/REAL-ACCOUNT-VALIDATION-RECORD.md
 * 中的证据编号。生产包中任何未验证能力不得发送真实请求。
 *
 * Mock/dev 隔离：E2E 构建（E2E=1）通过编译期常量 __BILIBLOCKER_E2E__=true 强制放行，
 * 生产构建（__BILIBLOCKER_E2E__=false，经 vite define + minify）不含任何强制放行路径。
 */
import { REPORT_REASONS } from './constants/report-reasons';
import { VERIFICATION as SELECTOR_VERIFICATION } from '../adapters/bilibili/selectors';
import type { CapabilityKeyName, Settings } from './types';

/** 编译期常量（wxt define 注入；类型声明见 src/env.d.ts） */
declare const __BILIBLOCKER_E2E__: boolean;

export interface Verification {
  /** 是否已通过真实账号人工验证 */
  verified: boolean;
  /** 最近核验时间（ISO 8601）；未验证为 null */
  verifiedAt: string | null;
  /** docs/REAL-ACCOUNT-VALIDATION-RECORD.md 中的证据编号；未验证为 null */
  evidenceId: string | null;
  /** 验证时使用的浏览器版本；未验证为 null */
  browserVersion: string | null;
}

/** 能力键（与 shared/types.ts 的 CapabilityKeyName 同构，避免循环依赖） */
export type CapabilityKey = CapabilityKeyName;

export type CapabilityVerification = Record<CapabilityKey, Verification>;

/**
 * 能力验证状态表。
 * ⚠️ 唯一证据来源：docs/REAL-ACCOUNT-VALIDATION-RECORD.md。
 * 当前整改环境无真实登录账号（2026-08-13），全部保持 verified=false。
 */
export const CAPABILITY_VERIFICATION: CapabilityVerification = {
  blockUser: { verified: false, verifiedAt: null, evidenceId: null, browserVersion: null },
  unblockUser: { verified: false, verifiedAt: null, evidenceId: null, browserVersion: null },
  reportVideoComment: { verified: false, verifiedAt: null, evidenceId: null, browserVersion: null },
  reportVideoReply: { verified: false, verifiedAt: null, evidenceId: null, browserVersion: null },
  reportDynamicComment: { verified: false, verifiedAt: null, evidenceId: null, browserVersion: null },
  reportDynamic: { verified: false, verifiedAt: null, evidenceId: null, browserVersion: null },
  selectorsVideo: { verified: false, verifiedAt: null, evidenceId: null, browserVersion: null },
  selectorsDynamic: { verified: false, verifiedAt: null, evidenceId: null, browserVersion: null },
};

/** E2E/Mock 构建强制放行（编译隔离：生产包恒为 false） */
export const E2E_FORCED =
  typeof __BILIBLOCKER_E2E__ !== 'undefined' && __BILIBLOCKER_E2E__ === true;

/** 当前是否为 E2E/Mock 构建模式（生产包恒为 false） */
export function isE2EMode(): boolean {
  return E2E_FORCED;
}

/** 内容类型 → 所需能力键 */
export const CONTENT_TYPE_CAPABILITY: Record<
  'video_comment' | 'video_reply' | 'dynamic' | 'dynamic_comment',
  CapabilityKey
> = {
  video_comment: 'reportVideoComment',
  video_reply: 'reportVideoReply',
  dynamic: 'reportDynamic',
  dynamic_comment: 'reportDynamicComment',
};

/** 页面范围 → 选择器能力键 */
export function selectorCapabilityFor(pageScope: 'video_page' | 'dynamic_feed' | 'dynamic_detail'): CapabilityKey {
  return pageScope === 'video_page' ? 'selectorsVideo' : 'selectorsDynamic';
}

/**
 * P0-2（v0.1.4）：任务 → 所需能力键（block/unblock/report 各自独立）。
 * 授权快照适配（buildTask）与派发前校验（verifyTaskEligible）共用，
 * 避免「创建」与「派发」两套能力逻辑漂移。
 */
export function capabilityForTaskType(
  type: 'block' | 'unblock' | 'report',
  contentType?: 'video_comment' | 'video_reply' | 'dynamic' | 'dynamic_comment',
): CapabilityKey | null {
  if (type === 'block') return 'blockUser';
  if (type === 'unblock') return 'unblockUser';
  if (type === 'report') {
    return CONTENT_TYPE_CAPABILITY[contentType ?? 'video_comment'] ?? null;
  }
  return null;
}

/**
 * 能力是否可发送真实请求。
 * - 生产：仅当人工验证通过（CAPABILITY_VERIFICATION[key].verified === true）。
 * - E2E 构建：强制放行（Mock 环境）。
 */
export function isCapabilityEnabled(key: CapabilityKey): boolean {
  if (E2E_FORCED) return true;
  return CAPABILITY_VERIFICATION[key].verified === true;
}

/**
 * 运行时官方请求门禁。
 *
 * 真实 Bilibili 请求必须同时满足：用户已启用扩展，且对应端点已经过人工验证。
 * 这是内容脚本初始化、交互动作和任务执行器共用的唯一入口；任一条件不满足
 * 时一律 fail-closed，调用方不得尝试登录探测或调用适配器。
 */
export function canUseOfficialRequest(
  settings: Pick<Settings, 'enabled'> | null | undefined,
  capability: CapabilityKey,
): boolean {
  return settings?.enabled === true && isCapabilityEnabled(capability);
}

/**
 * 登录态探测也是官方请求。只有至少一个真实操作端点已获准时才有探测的必要；
 * 选择器能力不对应网络端点，不能单独解锁 /nav 请求。
 */
export function canRefreshOfficialLogin(settings: Pick<Settings, 'enabled'> | null | undefined): boolean {
  return (
    canUseOfficialRequest(settings, 'blockUser') ||
    canUseOfficialRequest(settings, 'unblockUser') ||
    canUseOfficialRequest(settings, 'reportVideoComment') ||
    canUseOfficialRequest(settings, 'reportVideoReply') ||
    canUseOfficialRequest(settings, 'reportDynamicComment') ||
    canUseOfficialRequest(settings, 'reportDynamic')
  );
}

/** 能力未放行的原因（供设置页/UI 展示） */
export function capabilityDenyReason(key: CapabilityKey): string | null {
  if (isCapabilityEnabled(key)) return null;
  const v = CAPABILITY_VERIFICATION[key];
  if (E2E_FORCED) return null;
  if (!v.verified) {
    return `能力未通过真实账号验证（evidenceId=${v.evidenceId ?? '无'}，见 docs/REAL-ACCOUNT-VALIDATION-RECORD.md），生产环境已禁用真实请求`;
  }
  return null;
}

/** 全部未验证能力清单（设置页展示用） */
export function listUnverifiedCapabilities(): { key: CapabilityKey; reason: string }[] {
  return (Object.keys(CAPABILITY_VERIFICATION) as CapabilityKey[])
    .filter((k) => !CAPABILITY_VERIFICATION[k].verified)
    .map((k) => ({ key: k, reason: capabilityDenyReason(k) ?? '未验证' }));
}

/** 是否允许该内容类型的自动举报（内容类型独立门禁；E2E/Mock 构建整体放行） */
export function canReportContentType(contentType: 'video_comment' | 'video_reply' | 'dynamic' | 'dynamic_comment'): boolean {
  if (E2E_FORCED) return true; // Mock 模式：mock 已处理 reason 语义，编译隔离于生产包
  const key = CONTENT_TYPE_CAPABILITY[contentType];
  if (!isCapabilityEnabled(key)) return false;
  // 举报理由枚举也必须已验证（reason 枚举独立核验）
  if (!REPORT_REASONS.verified) return false;
  return true;
}

/** 纯决策函数：内容类型举报门禁 = 能力验证 ∧ reason 枚举验证（可测试组合） */
export function contentTypeReportDecision(
  capabilityVerified: boolean,
  reasonsVerified: boolean,
): boolean {
  return capabilityVerified && reasonsVerified;
}

/** 选择器是否已验证（页面范围独立门禁） */
export function areSelectorsVerified(pageScope: 'video_page' | 'dynamic_feed' | 'dynamic_detail'): boolean {
  const key = selectorCapabilityFor(pageScope);
  return isCapabilityEnabled(key);
}

/** 选择器验证状态（来自 adapters/selectors 的 VERIFICATION 常量，保证单一来源） */
export function selectorsVerificationStatus(): { selectorsVerified: boolean; selectorsVerifiedAt: string | null } {
  return {
    selectorsVerified: SELECTOR_VERIFICATION.selectorsVerified,
    selectorsVerifiedAt: SELECTOR_VERIFICATION.selectorsVerifiedAt,
  };
}

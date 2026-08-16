/**
 * Bilibili 举报理由枚举（版本化集中管理）。
 *
 * ⚠️ 核验状态说明：
 * - 这些 reason id 依据社区公开资料（bilibili-API-collect 等）整理，
 *   本仓库开发环境无法登录真实账号逐项验证，因此一律标记 UNVERIFIED。
 * - 运行时以本文件为准；若 Bilibili 页面/接口返回当前理由无效（invalid_reason），
 *   适配器会停止提交并要求用户在设置页重新选择，绝不猜测或替代 reason id。
 */
import type { ContentType, ReportReason } from '../types';

export interface ReportReasonsConfig {
  /** 枚举来源说明 */
  source: string;
  /** 是否已通过真实账号人工验证 */
  verified: boolean;
  /** 最近核验日期 */
  verifiedAt: string | null;
  reasons: Record<'video_comment' | 'video_reply' | 'dynamic' | 'dynamic_comment', ReportReason[]>;
}

export const REPORT_REASONS: ReportReasonsConfig = {
  source: 'bilibili-API-collect 社区文档（原仓库已关停，活跃 fork: afiuh/bilibili-api-collect）与公开资料整理（2026-08）',
  verified: false,
  verifiedAt: null,
  reasons: {
    video_comment: [
      { id: 1, label: '垃圾广告', category: 'ad' },
      { id: 2, label: '色情低俗', category: 'other' },
      { id: 3, label: '人身攻击', category: 'other' },
      { id: 4, label: '违法违禁', category: 'other' },
      { id: 5, label: '视频无关', category: 'other' },
      { id: 6, label: '刷屏', category: 'spam' },
      { id: 7, label: '涉及未成年', category: 'other' },
      { id: 8, label: '其它', category: 'other' },
      { id: 9, label: '引战', category: 'other' },
      { id: 12, label: '赌博诈骗', category: 'fraud' },
    ],
    video_reply: [
      { id: 1, label: '垃圾广告', category: 'ad' },
      { id: 2, label: '色情低俗', category: 'other' },
      { id: 3, label: '人身攻击', category: 'other' },
      { id: 4, label: '违法违禁', category: 'other' },
      { id: 6, label: '刷屏', category: 'spam' },
      { id: 7, label: '涉及未成年', category: 'other' },
      { id: 8, label: '其它', category: 'other' },
      { id: 12, label: '赌博诈骗', category: 'fraud' },
    ],
    dynamic: [
      { id: 1, label: '垃圾广告', category: 'ad' },
      { id: 2, label: '色情低俗', category: 'other' },
      { id: 3, label: '人身攻击', category: 'other' },
      { id: 4, label: '违法违禁', category: 'other' },
      { id: 6, label: '刷屏', category: 'spam' },
      { id: 8, label: '其它', category: 'other' },
      { id: 12, label: '赌博诈骗', category: 'fraud' },
    ],
    dynamic_comment: [
      { id: 1, label: '垃圾广告', category: 'ad' },
      { id: 2, label: '色情低俗', category: 'other' },
      { id: 3, label: '人身攻击', category: 'other' },
      { id: 4, label: '违法违禁', category: 'other' },
      { id: 6, label: '刷屏', category: 'spam' },
      { id: 7, label: '涉及未成年', category: 'other' },
      { id: 8, label: '其它', category: 'other' },
      { id: 12, label: '赌博诈骗', category: 'fraud' },
    ],
  },
};

/** 获取某内容类型的有效举报理由；为空或无效时返回 null */
export function getReasonsFor(contentType: ContentType): ReportReason[] {
  return REPORT_REASONS.reasons[contentType] ?? [];
}

/** 校验 reason id 对指定内容类型是否有效 */
export function isValidReason(contentType: ContentType, reasonId: number): boolean {
  return getReasonsFor(contentType).some((r) => r.id === reasonId);
}

/** 获取理由标签 */
export function getReasonLabel(contentType: ContentType, reasonId: number): string | null {
  return getReasonsFor(contentType).find((r) => r.id === reasonId)?.label ?? null;
}

/** 校验当前配置的默认理由；无效则返回 null（调用方必须停止提交） */
export function resolveDefaultReason(
  contentType: ContentType,
  configuredReasonId: number | null,
): number | null {
  if (configuredReasonId === null) return null;
  if (!isValidReason(contentType, configuredReasonId)) return null;
  return configuredReasonId;
}

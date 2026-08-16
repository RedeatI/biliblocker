/**
 * 真实能力硬门禁测试（P0-4）：
 * - 未验证能力在生产语义下不可用、不发送真实请求；
 * - 内容类型独立门禁（视频评论验证通过不能解锁动态举报）；
 * - 能力状态引用 REAL-ACCOUNT-VALIDATION-RECORD.md 证据编号；
 * - E2E 构建（编译常量 __BILIBLOCKER_E2E__=true）强制放行，但单元测试运行于生产语义。
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_VERIFICATION,
  isCapabilityEnabled,
  capabilityDenyReason,
  listUnverifiedCapabilities,
  canReportContentType,
  areSelectorsVerified,
  CONTENT_TYPE_CAPABILITY,
  E2E_FORCED,
  contentTypeReportDecision,
} from '@/shared/capabilities';

const ALL_KEYS = [
  'blockUser',
  'unblockUser',
  'reportVideoComment',
  'reportVideoReply',
  'reportDynamicComment',
  'reportDynamic',
  'selectorsVideo',
  'selectorsDynamic',
] as const;

describe('能力验证状态（P0-4）', () => {
  it('单元测试运行于生产语义：E2E_FORCED 必须为 false', () => {
    expect(E2E_FORCED).toBe(false);
  });

  it('所有能力键均有 Verification 记录且初始未验证', () => {
    for (const k of ALL_KEYS) {
      const v = CAPABILITY_VERIFICATION[k];
      expect(v).toBeDefined();
      expect(v.verified).toBe(false);
      expect(v.verifiedAt).toBeNull();
      expect(v.evidenceId).toBeNull();
    }
  });

  it('未验证能力在生产语义下不可用', () => {
    for (const k of ALL_KEYS) {
      expect(isCapabilityEnabled(k)).toBe(false);
    }
  });

  it('未验证能力返回明确原因（引用验证记录文档）', () => {
    const reason = capabilityDenyReason('blockUser');
    expect(reason).toContain('未通过真实账号验证');
    expect(reason).toContain('REAL-ACCOUNT-VALIDATION-RECORD');
  });

  it('listUnverifiedCapabilities 返回全部未验证能力', () => {
    const list = listUnverifiedCapabilities();
    expect(list.length).toBe(ALL_KEYS.length);
    expect(list.every((x) => x.reason.length > 0)).toBe(true);
  });
});

describe('内容类型独立门禁（P0-4）', () => {
  it('任一内容类型的举报能力未验证 → 该类型不可举报', () => {
    for (const ct of ['video_comment', 'video_reply', 'dynamic_comment', 'dynamic'] as const) {
      expect(canReportContentType(ct)).toBe(false);
    }
  });

  it('CONTENT_TYPE_CAPABILITY 映射覆盖全部内容类型（每种独立键）', () => {
    expect(CONTENT_TYPE_CAPABILITY.video_comment).toBe('reportVideoComment');
    expect(CONTENT_TYPE_CAPABILITY.video_reply).toBe('reportVideoReply');
    expect(CONTENT_TYPE_CAPABILITY.dynamic).toBe('reportDynamic');
    expect(CONTENT_TYPE_CAPABILITY.dynamic_comment).toBe('reportDynamicComment');
    const used = new Set(Object.values(CONTENT_TYPE_CAPABILITY));
    expect(used.size).toBe(4); // 四个独立能力键，互不共享
  });

  it('纯决策函数：能力验证 ∧ reason 枚举验证（组合边界）', () => {
    expect(contentTypeReportDecision(true, true)).toBe(true);
    expect(contentTypeReportDecision(true, false)).toBe(false); // 能力过了但 reason 未验证
    expect(contentTypeReportDecision(false, true)).toBe(false); // 能力未验证
    expect(contentTypeReportDecision(false, false)).toBe(false);
  });

  it('视频评论验证通过不能自动解锁动态举报（独立键门禁）', () => {
    // 门禁按 CONTENT_TYPE_CAPABILITY 独立键取值：video_comment 的键 ≠ dynamic 的键
    expect(CONTENT_TYPE_CAPABILITY.dynamic).not.toBe(CONTENT_TYPE_CAPABILITY.video_comment);
    // 生产语义下即便视频能力被人工回填为已验证，动态键仍未验证 → 动态仍不可举报
    const snapshot = CAPABILITY_VERIFICATION.reportVideoComment;
    try {
      (CAPABILITY_VERIFICATION as unknown as Record<string, { verified: boolean; verifiedAt: string | null; evidenceId: string | null; browserVersion: string | null }>).reportVideoComment = {
        verified: true,
        verifiedAt: '2026-08-13T00:00:00Z',
        evidenceId: 'EV-TEST-001',
        browserVersion: 'Chrome 126',
      };
      // 视频评论：能力已验证但 reason 枚举未验证 → 仍不可用（双条件）
      expect(canReportContentType('video_comment')).toBe(false);
      // 动态：独立键仍未验证 → 不可用
      expect(isCapabilityEnabled('reportDynamic')).toBe(false);
      expect(canReportContentType('dynamic')).toBe(false);
    } finally {
      (CAPABILITY_VERIFICATION as unknown as Record<string, unknown>).reportVideoComment = snapshot;
    }
  });

  it('选择器能力独立于举报能力', () => {
    expect(areSelectorsVerified('video_page')).toBe(false);
    expect(areSelectorsVerified('dynamic_feed')).toBe(false);
    expect(areSelectorsVerified('dynamic_detail')).toBe(false);
  });
});

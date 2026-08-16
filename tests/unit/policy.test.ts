/**
 * ActionPolicyEngine：自动举报双条件校验（证据模型）、登录失效、理由失效、白名单覆盖。
 */
import { describe, expect, it } from 'vitest';
import { ActionPolicyEngine } from '@/actions/policy';
import type { Settings } from '@/shared/types';
import type { RuleEvidence } from '@/rules/evidence';

const policy = new ActionPolicyEngine();

const settings: Settings = {
  enabled: true,
  videoCommentsEnabled: true,
  dynamicsEnabled: true,
  suspiciousHandling: 'collapse',
  quickActionDisplay: 'hover',
  autoReportAuthorized: true,
  defaultReportReason: 1,
  autoProcessVerified: true,
  operationDelayMs: 3000,
};

/** 精确 UID 账号授权证据 */
const exactUidEvidence: RuleEvidence = {
  accountAuthorization: [{ ruleId: 'r1', kind: 'exact_uid' }],
  contentViolation: [{ ruleId: 'r2', category: 'ad', fields: ['content'] }],
};

/** 仅有内容违规证据（无账号授权） */
const contentOnlyEvidence: RuleEvidence = {
  accountAuthorization: [],
  contentViolation: [{ ruleId: 'r2', category: 'ad', fields: ['content'] }],
};

/** 仅有账号授权证据（无内容违规） */
const accountOnlyEvidence: RuleEvidence = {
  accountAuthorization: [{ ruleId: 'r1', kind: 'exact_uid' }],
  contentViolation: [],
};

function base(partial: Partial<Parameters<ActionPolicyEngine['canReport']>[0]> = {}) {
  return {
    userConfirmed: false,
    evidence: exactUidEvidence,
    contentType: 'video_comment' as const,
    contentId: '123456',
    uid: 10086,
    isWhitelisted: false,
    isVerifiedMachine: true,
    currentMid: 99999,
    loginOk: true,
    settings,
    reasonId: 1,
    ...partial,
  };
}

describe('账号条件（accountAuthorization 证据）', () => {
  it('用户一键确认 → 放行（用户确认可同时提供账号+内容证据）', () => {
    const verdict = policy.canReport(base({ userConfirmed: true, evidence: accountOnlyEvidence }));
    expect(verdict.allowed).toBe(true);
  });

  it('exact_uid 证据 + 自动处理开关 → 放行（内容违规时）', () => {
    const verdict = policy.canReport(base({ userConfirmed: false, evidence: exactUidEvidence }));
    expect(verdict.allowed).toBe(true);
  });

  it('exact_uid 证据 + 未开启自动处理 → 拒绝', () => {
    const verdict = policy.canReport(
      base({ userConfirmed: false, settings: { ...settings, autoProcessVerified: false } }),
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('not_verified');
  });

  it('无任何账号授权证据且未确认 → 拒绝', () => {
    const verdict = policy.canReport(base({ userConfirmed: false, evidence: contentOnlyEvidence }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('not_verified');
  });

  it('缺少 UID → 拒绝', () => {
    const verdict = policy.canReport(base({ uid: null }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('no_uid');
  });

  it('举报自己 → 拒绝', () => {
    const verdict = policy.canReport(base({ currentMid: 10086 }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('self');
  });

  it('白名单 → 拒绝', () => {
    const verdict = policy.canReport(base({ isWhitelisted: true }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('whitelisted');
  });

  it('登录失效 → 拒绝', () => {
    const verdict = policy.canReport(base({ loginOk: false }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('not_logged_in');
  });
});

describe('内容条件（独立内容违规证据）', () => {
  it('有账号授权但无独立内容违规证据 → 拒绝（已确认机器人发布的普通内容不自动举报）', () => {
    const verdict = policy.canReport(base({ userConfirmed: false, evidence: accountOnlyEvidence }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('not_violation');
  });

  it.each([null, '', '   '])('缺少或空白内容 ID（%p）→ 拒绝', (contentId) => {
    const verdict = policy.canReport(base({ contentId }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('no_content_id');
  });
});

describe('理由条件', () => {
  it('未授权自动举报 → 拒绝', () => {
    const verdict = policy.canReport(base({ settings: { ...settings, autoReportAuthorized: false } }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('not_authorized');
  });

  it('未配置理由 → 拒绝', () => {
    const verdict = policy.canReport(base({ reasonId: null }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('no_reason_configured');
  });

  it('理由对内容类型无效 → 拒绝（不猜测、不替代）', () => {
    // reasonId=5 仅视频评论有效；用于动态时无效
    const verdict = policy.canReport(base({ contentType: 'dynamic', reasonId: 5 }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('invalid_reason');
  });
});

describe('canBlock', () => {
  it('正常放行', () => {
    const verdict = policy.canBlock({ uid: 10086, isWhitelisted: false, currentMid: 99999, loginOk: true });
    expect(verdict.allowed).toBe(true);
  });

  it('缺 UID / 自己 / 白名单 / 未登录均拒绝', () => {
    expect(policy.canBlock({ uid: null, isWhitelisted: false, currentMid: 99999, loginOk: true }).allowed).toBe(false);
    expect(policy.canBlock({ uid: 99999, isWhitelisted: false, currentMid: 99999, loginOk: true }).allowed).toBe(false);
    expect(policy.canBlock({ uid: 10086, isWhitelisted: true, currentMid: 99999, loginOk: true }).allowed).toBe(false);
    expect(policy.canBlock({ uid: 10086, isWhitelisted: false, currentMid: 99999, loginOk: false }).allowed).toBe(false);
  });
});

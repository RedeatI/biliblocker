/**
 * ActionPolicyEngine：官方动作（拉黑/举报）的「账号条件 + 内容条件」双重校验。
 *
 * 自动举报必要条件（P0-3 证据模型）：
 * 1. 账号条件（accountAuthorization）：
 *    - 用户刚点击该内容的一键拉黑并举报（user_confirmation）；或
 *    - 精确 UID 规则命中 且 UID 在已确认机器人名单 且 用户开启自动处理（exact_uid）。
 * 2. 内容条件（contentViolation，独立证据）：
 *    - 独立内容规则命中 content/links/linkDomains/hasLinks 且带 ad/spam/fraud 类别；或
 *    - 用户本次点击显式确认。
 *
 * 对「已确认机器人发布的普通内容」只允许隐藏或拉黑，禁止自动举报。
 * 白名单覆盖一切；当前登录用户永远被保护。
 */
import type {
  ContentType,
  Settings,
} from '../shared/types';
import { resolveDefaultReason } from '../shared/constants/report-reasons';
import type { RuleEvidence } from '../rules/evidence';

export type PolicyDenyReason =
  | 'no_uid'
  | 'self'
  | 'whitelisted'
  | 'not_verified'
  | 'not_authorized'
  | 'invalid_reason'
  | 'no_content_id'
  | 'not_violation'
  | 'not_logged_in'
  | 'no_reason_configured'
  | 'capability_not_verified';

export type PolicyVerdict =
  | { allowed: true }
  | { allowed: false; reason: PolicyDenyReason; message: string };

export interface ReportPolicyParams {
  /** 用户本次点击是否显式确认（可同时充当账号与内容证据） */
  userConfirmed: boolean;
  /** 规则证据（buildActionPlan 产出） */
  evidence: RuleEvidence;
  contentType: ContentType;
  contentId: string | null;
  uid: number | null;
  isWhitelisted: boolean;
  isVerifiedMachine: boolean;
  currentMid: number | null;
  loginOk: boolean;
  settings: Settings;
  /** 本次实际使用的举报理由（已由调用方解析） */
  reasonId: number | null;
}

export class ActionPolicyEngine {
  /** 拉黑账号条件校验 */
  canBlock(params: {
    uid: number | null;
    isWhitelisted: boolean;
    currentMid: number | null;
    loginOk: boolean;
  }): PolicyVerdict {
    if (params.uid === null) return deny('no_uid', '无法取得该账号 UID，仅可隐藏内容');
    if (params.currentMid !== null && params.uid === params.currentMid) {
      return deny('self', '不能拉黑自己');
    }
    if (params.isWhitelisted) return deny('whitelisted', '该账号在白名单中，请先移出白名单');
    if (!params.loginOk) return deny('not_logged_in', '请先登录 Bilibili');
    return { allowed: true };
  }

  /** 举报双重条件校验（自动举报唯一入口） */
  canReport(p: ReportPolicyParams): PolicyVerdict {
    // ---- 账号条件 ----
    if (p.uid === null) return deny('no_uid', '无法取得 UID，不能提交举报');
    if (p.currentMid !== null && p.uid === p.currentMid) {
      return deny('self', '不能举报自己');
    }
    if (p.isWhitelisted) return deny('whitelisted', '该账号在白名单中');
    if (!p.loginOk) return deny('not_logged_in', '登录状态失效，无法举报');
    if (!p.settings.autoReportAuthorized) return deny('not_authorized', '尚未授权自动举报，请在设置页完成首次授权');

    const hasExactUidEvidence = p.evidence.accountAuthorization.some(
      (e) => e.kind === 'exact_uid',
    );
    const accountConfirmed = p.userConfirmed || (hasExactUidEvidence && p.settings.autoProcessVerified);
    if (!accountConfirmed) {
      return deny('not_verified', '缺少账号授权证据：仅精确 UID 名单中的已确认机器人可自动举报');
    }

    // ---- 内容条件（独立内容违规证据） ----
    if (p.contentId === null || p.contentId.trim() === '') {
      return deny('no_content_id', '无法取得内容 ID，不能提交举报');
    }
    const contentConfirmed =
      p.userConfirmed || p.evidence.contentViolation.some((e) => e.ruleId !== 'user_confirmation');
    if (!contentConfirmed) {
      return deny('not_violation', '缺少独立内容违规证据，且用户未明确确认，不提交举报');
    }

    // ---- 理由条件 ----
    if (p.reasonId === null) return deny('no_reason_configured', '未配置有效的默认举报理由');
    const resolved = resolveDefaultReason(p.contentType, p.reasonId);
    if (resolved === null) {
      return deny('invalid_reason', '当前举报理由已失效，请在设置页重新选择');
    }

    return { allowed: true };
  }
}

function deny(reason: PolicyDenyReason, message: string): PolicyVerdict {
  return { allowed: false, reason, message };
}

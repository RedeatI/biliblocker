/**
 * BilibiliReportAdapter：自动提交举报。
 *
 * ⚠️ 核验状态（本仓库开发环境无法登录真实账号验证，已全部标记）：
 * - 视频评论/楼中楼举报：POST api.bilibili.com/x/v2/reply/report
 *   （oid=视频aid, type=1, rpid=评论ID, reason=理由ID, csrf）—— 依据社区文档，待人工核验。
 * - 动态评论举报：同上接口，type=11, oid=动态ID —— 待人工核验。
 * - 动态本体举报：api.bilibili.com/x/polymer/web-dynamic/v1/dynamic/report —— 端点待人工核验。
 * - reason 枚举见 shared/constants/report-reasons.ts（UNVERIFIED）。
 *
 * 安全不变量：
 * - 理由必须在本项目枚举内有效，否则返回 invalid_reason 并停止提交，绝不猜测/替代。
 * - 不虚构违规描述，不自动生成证据文本。
 */
import type { ContentType, TaskResult } from '../../shared/types';
import { isValidReason } from '../../shared/constants/report-reasons';
import { isCapabilityEnabled, CONTENT_TYPE_CAPABILITY } from '../../shared/capabilities';
import { biliFetchJson, classifyApiCode, getCsrfToken, toTaskResultError } from './api';

export interface ReportParams {
  contentType: ContentType;
  /** 评论/楼中楼：rpid；动态评论：rpid；动态本体：动态 ID */
  contentId: string;
  /** 视频 oid（aid）；动态评论时为动态 ID */
  oid: string | null;
  uid: number;
  reasonId: number;
}

/**
 * 评论业务类型（type 参数）：视频=1、动态=17（带图动态=11、专栏=12，视内容而定）。
 * ⚠️ UNVERIFIED：依据 bilibili-API-collect 社区文档，需人工验收确认。
 */
const COMMENT_BUSINESS_TYPE: Record<'video_comment' | 'video_reply' | 'dynamic_comment', string> = {
  video_comment: '1',
  video_reply: '1',
  dynamic_comment: '17',
};

export class BilibiliReportAdapter {
  /** 评论举报端点（视频评论/楼中楼/动态评论共用），待人工核验 */
  private readonly commentReportUrl: string;
  /** 动态本体举报端点，待人工核验 */
  private readonly dynamicReportUrl: string;

  constructor(opts: {
    commentReportUrl?: string;
    dynamicReportUrl?: string;
  } = {}) {
    this.commentReportUrl =
      opts.commentReportUrl ?? 'https://api.bilibili.com/x/v2/reply/report';
    this.dynamicReportUrl =
      opts.dynamicReportUrl ??
      'https://api.bilibili.com/x/polymer/web-dynamic/v1/dynamic/report';
  }

  async report(p: ReportParams): Promise<TaskResult> {
    // P0-4：未验证能力不得发送真实请求（内容类型独立门禁）
    const capability = CONTENT_TYPE_CAPABILITY[p.contentType];
    if (!isCapabilityEnabled(capability)) {
      return {
        ok: false,
        status: '能力未验证',
        message: `真实能力 ${capability} 未通过人工验证，生产环境已禁用该举报请求`,
        errorType: 'capability_not_verified',
      };
    }
    // 1. 理由有效性：无效立即停止，绝不猜测
    if (!isValidReason(p.contentType, p.reasonId)) {
      return {
        ok: false,
        status: '举报理由失效',
        message: '当前举报理由对该内容类型无效，请在设置页重新选择',
        errorType: 'invalid_reason',
      };
    }
    const csrf = getCsrfToken();
    if (!csrf) {
      return {
        ok: false,
        status: '未登录',
        message: '缺少 CSRF 令牌（bili_jct），请确认已登录 Bilibili',
        errorType: 'login_invalid',
      };
    }

    try {
      if (p.contentType === 'dynamic') {
        return await this.reportDynamic(p, csrf);
      }
      return await this.reportComment(p, csrf);
    } catch (e) {
      return toTaskResultError(e);
    }
  }

  private async reportComment(p: ReportParams, csrf: string): Promise<TaskResult> {
    if (!p.oid) {
      return {
        ok: false,
        status: '缺少内容归属信息',
        message: '无法取得该评论所属视频/动态 ID，不能提交举报',
        errorType: 'validation',
      };
    }
    const type = COMMENT_BUSINESS_TYPE[p.contentType as keyof typeof COMMENT_BUSINESS_TYPE] ?? '1';
    const oid = p.oid ?? p.contentId;
    const body = new URLSearchParams({
      oid,
      type,
      rpid: p.contentId,
      reason: String(p.reasonId),
      csrf,
    });
    const json = await biliFetchJson<unknown>(this.commentReportUrl, {
      method: 'POST',
      body: body.toString(),
    });
    const r = classifyApiCode(json.code, json.message);
    if (r.ok) {
      return { ok: true, status: '举报已提交', code: 0 };
    }
    return { ok: false, status: r.status, message: r.message, errorType: r.errorType, code: r.code };
  }

  private async reportDynamic(p: ReportParams, csrf: string): Promise<TaskResult> {
    const body = new URLSearchParams({
      dynamic_id: p.contentId,
      reason: String(p.reasonId),
      csrf,
    });
    const json = await biliFetchJson<unknown>(this.dynamicReportUrl, {
      method: 'POST',
      body: body.toString(),
    });
    const r = classifyApiCode(json.code, json.message);
    if (r.ok) {
      return { ok: true, status: '举报已提交', code: 0 };
    }
    return { ok: false, status: r.status, message: r.message, errorType: r.errorType, code: r.code };
  }
}

/**
 * BilibiliBlockAdapter：官方拉黑 / 解除拉黑。
 *
 * 接口：POST https://api.bilibili.com/x/relation/modify
 * 参数（依据 bilibili-API-collect 社区文档整理，act=5 拉黑 / act=6 解除拉黑 为多年稳定约定）：
 *   fid=目标UID&act=5|6&re_src=11&csrf=bili_jct
 *
 * ⚠️ P0-4 能力硬门禁：blockUser/unblockUser 未通过真实账号验证（evidenceId 为空）时，
 * 生产环境拒绝发送真实请求（isCapabilityEnabled=false）；E2E 构建强制放行。
 * 门禁在适配器层再次兜底（即使消息被伪造也无法绕过）。
 */
import type { TaskResult } from '../../shared/types';
import { isCapabilityEnabled } from '../../shared/capabilities';
import { biliFetchJson, classifyApiCode, getCsrfToken, toTaskResultError } from './api';

const BLOCK_URL = 'https://api.bilibili.com/x/relation/modify';

export class BilibiliBlockAdapter {
  constructor(private readonly baseUrl: string = BLOCK_URL) {}

  async block(uid: number): Promise<TaskResult> {
    return this.modifyRelation(uid, '5', 'blockUser');
  }

  async unblock(uid: number): Promise<TaskResult> {
    return this.modifyRelation(uid, '6', 'unblockUser');
  }

  private async modifyRelation(uid: number, act: '5' | '6', capability: 'blockUser' | 'unblockUser'): Promise<TaskResult> {
    // P0-4：未验证能力不得发送真实请求
    if (!isCapabilityEnabled(capability)) {
      return {
        ok: false,
        status: '能力未验证',
        message: `真实能力 ${capability} 未通过人工验证，生产环境已禁用该请求`,
        errorType: 'capability_not_verified',
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
      const body = new URLSearchParams({
        fid: String(uid),
        act,
        re_src: '11',
        csrf,
      });
      const json = await biliFetchJson<unknown>(this.baseUrl, {
        method: 'POST',
        body: body.toString(),
      });
      const r = classifyApiCode(json.code, json.message);
      if (r.ok) {
        return { ok: true, status: act === '5' ? '已拉黑' : '已解除拉黑', code: 0 };
      }
      return {
        ok: false,
        status: r.status,
        message: r.message,
        errorType: r.errorType,
        code: r.code,
      };
    } catch (e) {
      return toTaskResultError(e);
    }
  }
}

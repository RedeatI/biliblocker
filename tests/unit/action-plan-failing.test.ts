/**
 * P0-2 失败测试（阶段 A 复现）：动作副作用必须按 ActionExecutionPlan 矩阵拆分。
 *
 * 旧实现缺陷（本文件证明其失败）：
 * - buildActionPlan 返回的 ActionPlan 没有 commitLocalBlock / commitVerified /
 *   enqueueOfficialBlock / enqueueReport 维度；runActionFlow 用
 *   `block: plan.officialBlock || plan.localBlock` 把本地/确认/官方拉黑混在一起；
 *   一键流程恒写 verified（无条件 addVerified），无明确动作矩阵。
 * - 本文件断言新矩阵字段存在且取值正确 → 旧实现下这些字段为 undefined → 全部失败。
 *
 * 新语义断言（阶段 B 实现后本文件必须全绿）：
 * - local_block_verified_uid：Local ✅ / Verified ❌ / Official ❌ / Report ❌
 * - official_block_verified_uid：Local ❌ / Verified ❌ / Official ✅ / Report ❌
 * - report_verified_uid_content：Local ❌ / Verified ❌ / Official ❌ / Report ✅
 * - 一键拉黑并举报：Local ✅ / Verified ✅ / Official ✅ / Report ✅
 * - 仅隐藏：全部 ❌
 */
import { describe, expect, it } from 'vitest';
import { buildActionPlan } from '@/rules/evidence';
import type { ContentContext, Rule } from '@/shared/types';

function ctx(partial: Partial<ContentContext> = {}): ContentContext {
  return {
    uid: 10086,
    username: 'bot',
    text: '加微信领福利，普通内容',
    links: [],
    linkDomains: [],
    contentType: 'video_comment',
    pageScope: 'video_page',
    hasLinks: false,
    isLocalBlocked: false,
    isWhitelisted: false,
    isVerifiedMachine: true,
    contentId: 'rpid-1',
    rootContentId: 'rpid-1',
    videoId: '123456',
    origDynamicId: null,
    ...partial,
  };
}

function rule(partial: Partial<Rule> = {}): Rule {
  return {
    id: 'rule_x',
    name: '规则',
    description: '',
    enabled: true,
    priority: 0,
    conditions: { logic: 'and', conditions: [], groups: [] },
    pageScope: [],
    contentTypes: [],
    action: 'collapse_content',
    reportCategory: null,
    createdAt: 0,
    updatedAt: 0,
    schemaVersion: 1,
    ...partial,
  };
}

/** 从返回对象提取 ActionExecutionPlan 字段（旧实现为 undefined → 断言失败证明缺陷） */
function planFields(plan: unknown): Record<string, unknown> {
  return plan as Record<string, unknown>;
}

const localRule = rule({
  id: 'local',
  action: 'local_block_verified_uid',
  conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
});

const officialRule = rule({
  id: 'official',
  action: 'official_block_verified_uid',
  conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
});

const reportRule = rule({
  id: 'report',
  action: 'report_verified_uid_content',
  reportCategory: 'ad',
  conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
});

const contentRule = rule({
  id: 'content_ev',
  reportCategory: 'ad',
  conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '加微信' }], groups: [] },
});

const hideRule = rule({
  id: 'hide',
  action: 'hide_content',
  conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '加微信' }], groups: [] },
});

describe('P0-2 ActionExecutionPlan 矩阵（阶段 A 失败测试）', () => {
  it('local_block_verified_uid：Local ✅ / Verified ❌ / Official ❌ / Report ❌', () => {
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: true, matchedRules: [localRule] },
      ctx(),
      { userConfirmed: false },
    );
    const p = planFields(plan);
    expect(p.commitLocalBlock).toBe(true);
    expect(p.commitVerified).toBe(false);
    expect(p.enqueueOfficialBlock).toBe(false);
    expect(p.enqueueReport).toBe(false);
  });

  it('official_block_verified_uid：Local ❌ / Verified ❌ / Official ✅ / Report ❌', () => {
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [officialRule] },
      ctx(),
      { userConfirmed: false },
    );
    const p = planFields(plan);
    expect(p.commitLocalBlock).toBe(false);
    expect(p.commitVerified).toBe(false);
    expect(p.enqueueOfficialBlock).toBe(true);
    expect(p.enqueueReport).toBe(false);
  });

  it('report_verified_uid_content + 独立内容证据：Local ❌ / Verified ❌ / Official ❌ / Report ✅', () => {
    // reportRule（exact UID 账号授权）+ contentRule（独立内容违规证据）
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [reportRule, contentRule] },
      ctx(),
      { userConfirmed: false },
    );
    const p = planFields(plan);
    expect(p.commitLocalBlock).toBe(false);
    expect(p.commitVerified).toBe(false);
    expect(p.enqueueOfficialBlock).toBe(false);
    expect(p.enqueueReport).toBe(true);
  });

  it('一键拉黑并举报（用户确认）：Local ✅ / Verified ✅ / Official ✅ / Report ✅', () => {
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: true, matchedRules: [localRule] },
      ctx(),
      { userConfirmed: true },
    );
    const p = planFields(plan);
    expect(p.commitLocalBlock).toBe(true);
    expect(p.commitVerified).toBe(true);
    expect(p.enqueueOfficialBlock).toBe(true);
    expect(p.enqueueReport).toBe(true);
  });

  it('仅隐藏：Local ❌ / Verified ❌ / Official ❌ / Report ❌（不隐式产生任何动作）', () => {
    const plan = buildActionPlan(
      { collapse: false, hide: true, localBlock: false, matchedRules: [hideRule] },
      ctx(),
      { userConfirmed: false },
    );
    const p = planFields(plan);
    expect(p.commitLocalBlock).toBe(false);
    expect(p.commitVerified).toBe(false);
    expect(p.enqueueOfficialBlock).toBe(false);
    expect(p.enqueueReport).toBe(false);
  });

  it('official_block_verified_uid 不在已确认名单：无账号证据 → 官方拉黑被拒绝，且不隐式写本地/确认名单', () => {
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [officialRule] },
      ctx({ isVerifiedMachine: false }),
      { userConfirmed: false },
    );
    const p = planFields(plan);
    expect(p.enqueueOfficialBlock).toBe(false);
    expect(p.commitLocalBlock).toBe(false);
    expect(p.commitVerified).toBe(false);
  });

  it('能力门禁关闭时仅本地动作仍应表达为可完成（commitLocalBlock 独立于官方能力）', () => {
    // 本地拉黑不需要官方能力：矩阵必须允许 commitLocalBlock=true 而官方字段 false
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: true, matchedRules: [localRule] },
      ctx(),
      { userConfirmed: false },
    );
    const p = planFields(plan);
    expect(p.commitLocalBlock).toBe(true);
    expect(p.enqueueOfficialBlock).toBe(false);
  });
});

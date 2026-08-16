/**
 * 证据模型测试（P0-3）：独立内容违规证据边界、动作计划副作用、组合行为。
 */
import { describe, expect, it } from 'vitest';
import {
  buildActionPlan,
  buildEvidence,
  hasContentEvidenceCondition,
  ruleContentFields,
  CONTENT_EVIDENCE_FIELDS,
} from '@/rules/evidence';
import type { ContentContext, Rule } from '@/shared/types';

function ctx(partial: Partial<ContentContext> = {}): ContentContext {
  return {
    uid: 10086,
    username: 'bot',
    text: '加微信领福利',
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

const uidOnlyRule = rule({
  id: 'uid_only',
  action: 'official_block_verified_uid',
  conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
});

const contentAdRule = rule({
  id: 'content_ad',
  reportCategory: 'ad',
  conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '加微信' }], groups: [] },
});

const linkAdRule = rule({
  id: 'link_ad',
  reportCategory: 'fraud',
  conditions: { logic: 'and', conditions: [{ field: 'linkDomains', operator: 'contains', value: 't.cn' }], groups: [] },
});

const usernameRuleWithTag = rule({
  id: 'username_tag',
  reportCategory: 'spam',
  conditions: { logic: 'and', conditions: [{ field: 'username', operator: 'prefix', value: 'bot' }], groups: [] },
});

const reportUidRule = rule({
  id: 'report_uid',
  action: 'report_verified_uid_content',
  reportCategory: 'ad',
  conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
});

describe('内容证据字段判定（P0-3）', () => {
  it('content/links/linkDomains/hasLinks 属于内容证据字段；uid/username 等不属于', () => {
    expect(CONTENT_EVIDENCE_FIELDS).toEqual(['content', 'links', 'linkDomains', 'hasLinks']);
    expect(hasContentEvidenceCondition(contentAdRule)).toBe(true);
    expect(hasContentEvidenceCondition(linkAdRule)).toBe(true);
    expect(hasContentEvidenceCondition(uidOnlyRule)).toBe(false);
    expect(hasContentEvidenceCondition(usernameRuleWithTag)).toBe(false);
  });

  it('ruleContentFields 递归收集命中的内容字段', () => {
    const nested = rule({
      conditions: {
        logic: 'and',
        conditions: [{ field: 'hasLinks', operator: 'eq', value: 'true' }],
        groups: [
          { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: 'x' }], groups: [] },
        ],
      },
    });
    const fields = ruleContentFields(nested);
    expect(fields).toContain('hasLinks');
    expect(fields).toContain('content');
  });
});

describe('buildEvidence（P0-3）', () => {
  it('精确 UID 规则 + 已确认名单 → 账号授权证据', () => {
    const evidence = buildEvidence([uidOnlyRule], ctx());
    expect(evidence.accountAuthorization).toEqual([{ ruleId: 'uid_only', kind: 'exact_uid' }]);
    expect(evidence.contentViolation).toHaveLength(0);
  });

  it('内容违规规则（reportCategory=ad + content 字段）→ 独立内容证据', () => {
    const evidence = buildEvidence([contentAdRule], ctx());
    expect(evidence.contentViolation).toEqual([{ ruleId: 'content_ad', category: 'ad', fields: ['content'] }]);
    expect(evidence.accountAuthorization).toHaveLength(0);
  });

  it('UID 单独命中 + reportCategory 标签：不构成内容违规证据（标签不得冒充当前内容证据）', () => {
    // report_uid 规则只条件 uid，reportCategory=ad —— 没有内容字段命中
    const evidence = buildEvidence([reportUidRule], ctx());
    expect(evidence.accountAuthorization).toHaveLength(1);
    expect(evidence.contentViolation).toHaveLength(0);
  });

  it('username 条件 + reportCategory 标签：不构成内容违规证据', () => {
    const evidence = buildEvidence([usernameRuleWithTag], ctx());
    expect(evidence.contentViolation).toHaveLength(0);
  });

  it('多规则叠加：exact UID 账号授权 + 独立 content/link 违规证据', () => {
    const evidence = buildEvidence([uidOnlyRule, contentAdRule], ctx());
    expect(evidence.accountAuthorization).toHaveLength(1);
    expect(evidence.contentViolation).toHaveLength(1);
    expect(evidence.contentViolation[0]?.fields).toContain('content');
  });

  it('reportCategory=other 不产生内容违规证据', () => {
    const otherRule = rule({ id: 'other', reportCategory: 'other', conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: 'x' }], groups: [] } });
    const evidence = buildEvidence([otherRule], ctx());
    expect(evidence.contentViolation).toHaveLength(0);
  });
});

describe('buildActionPlan（P0-3）', () => {
  it('report 动作要求账号授权 + 独立内容违规证据（自动流程）', () => {
    // 只有报告 UID 规则（无独立内容证据）→ report=false
    const plan1 = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [reportUidRule] },
      ctx(),
      { userConfirmed: false },
    );
    expect(plan1.report).toBe(false);

    // exact UID 账号授权 + 独立内容违规规则 → report=true
    const plan2 = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [reportUidRule, contentAdRule] },
      ctx(),
      { userConfirmed: false },
    );
    expect(plan2.report).toBe(true);
    expect(plan2.evidence.contentViolation.some((e) => e.ruleId === 'content_ad')).toBe(true);
  });

  it('用户点击确认可同时提供账号与内容证据（user_confirmation）', () => {
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [reportUidRule] },
      ctx(),
      { userConfirmed: true },
    );
    expect(plan.report).toBe(true);
    expect(plan.evidence.accountAuthorization).toContainEqual({ ruleId: 'user_confirmation', kind: 'user_confirmation' });
    // 用户确认以 user_confirmation 充当内容证据（ruleId 标记，可区别于独立规则证据）
    expect(plan.evidence.contentViolation.some((e) => e.ruleId === 'user_confirmation')).toBe(true);
  });

  it('无规则且用户确认：动作计划不虚构 report（规则链无举报意图，policy 层放行由调用方决定）', () => {
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [] },
      ctx(),
      { userConfirmed: true },
    );
    expect(plan.report).toBe(false);
    expect(plan.evidence.accountAuthorization).toContainEqual({ ruleId: 'user_confirmation', kind: 'user_confirmation' });
  });

  it('official_block 需要账号授权证据', () => {
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [uidOnlyRule] },
      ctx({ isVerifiedMachine: true }),
      { userConfirmed: false },
    );
    expect(plan.officialBlock).toBe(true);

    // 不在已确认名单：无账号证据 → officialBlock=false
    const plan2 = buildActionPlan(
      { collapse: false, hide: false, localBlock: false, matchedRules: [uidOnlyRule] },
      ctx({ isVerifiedMachine: false }),
      { userConfirmed: false },
    );
    expect(plan2.officialBlock).toBe(false);
  });

  it('local_block 来自最高优先级规则动作', () => {
    const localRule = rule({ id: 'local', action: 'local_block_verified_uid', conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] } });
    const plan = buildActionPlan(
      { collapse: false, hide: false, localBlock: true, matchedRules: [localRule] },
      ctx(),
      { userConfirmed: false },
    );
    expect(plan.localBlock).toBe(true);
  });

  it('已确认机器人发布的普通内容（无内容证据）：最多隐藏/拉黑，不举报', () => {
    const plan = buildActionPlan(
      { collapse: true, hide: false, localBlock: false, matchedRules: [uidOnlyRule, usernameRuleWithTag] },
      ctx(),
      { userConfirmed: false },
    );
    expect(plan.collapse).toBe(true);
    expect(plan.report).toBe(false);
  });
});

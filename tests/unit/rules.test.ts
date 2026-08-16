/**
 * 规则引擎单元测试：全部运算符、AND/OR/NOT、优先级、白名单覆盖、
 * 当前用户保护、UID 精确匹配、疑似状态不能触发官方操作、官方动作权限校验。
 */
import { describe, expect, it } from 'vitest';
import { RuleEngine } from '@/rules/engine';
import type { ContentContext, Rule } from '@/shared/types';
import { OFFICIAL_ACTIONS } from '@/shared/types';

function ctx(partial: Partial<ContentContext> = {}): ContentContext {
  return {
    uid: 12345,
    username: 'test_user',
    text: 'hello world',
    links: [],
    linkDomains: [],
    contentType: 'video_comment',
    pageScope: 'video_page',
    hasLinks: false,
    isLocalBlocked: false,
    isWhitelisted: false,
    isVerifiedMachine: false,
    contentId: '123456',
    rootContentId: '123456',
    videoId: '1',
    origDynamicId: null,
    ...partial,
  };
}

function rule(partial: Partial<Rule> = {}): Rule {
  return {
    id: 'rule_1',
    name: '测试规则',
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

const engine = new RuleEngine({ currentMid: 99999 });

describe('运算符', () => {
  it('eq / ne', () => {
    const c = ctx({ uid: 12345 });
    const r1 = rule({ conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '12345' }], groups: [] } });
    const r2 = rule({ id: 'r2', conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'ne', value: '8888' }], groups: [] } });
    expect(engine.evaluateRule(c, r1)).toBe(true);
    expect(engine.evaluateRule(c, r2)).toBe(true);
  });

  it('contains / not_contains（大小写不敏感）', () => {
    const c = ctx({ text: '加微信 私聊 领福利' });
    const r1 = rule({ conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '加微信' }], groups: [] } });
    const r2 = rule({ id: 'r2', conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'not_contains', value: '不存在' }], groups: [] } });
    expect(engine.evaluateRule(c, r1)).toBe(true);
    expect(engine.evaluateRule(c, r2)).toBe(true);
  });

  it('prefix / suffix', () => {
    const c = ctx({ username: 'BiliRobotFan' });
    const r1 = rule({ conditions: { logic: 'and', conditions: [{ field: 'username', operator: 'prefix', value: 'bili' }], groups: [] } });
    const r2 = rule({ id: 'r2', conditions: { logic: 'and', conditions: [{ field: 'username', operator: 'suffix', value: 'FAN' }], groups: [] } });
    expect(engine.evaluateRule(c, r1)).toBe(true);
    expect(engine.evaluateRule(c, r2)).toBe(true);
  });

  it('regex', () => {
    const c = ctx({ text: '联系 vx:abc12345' });
    const r = rule({ conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'regex', value: '(?:加|联系)\\s*vx\\s*[:：]?\\s*\\w{4,}' }], groups: [] } });
    expect(engine.evaluateRule(c, r)).toBe(true);
  });

  it('exists / not_exists', () => {
    const c = ctx({ text: 'http://example.com 领取', links: ['http://example.com'], linkDomains: ['example.com'], hasLinks: true });
    const r1 = rule({ conditions: { logic: 'and', conditions: [{ field: 'links', operator: 'exists', value: '' }], groups: [] } });
    const r2 = rule({ id: 'r2', conditions: { logic: 'and', conditions: [{ field: 'linkDomains', operator: 'exists', value: '' }], groups: [] } });
    const r3 = rule({ id: 'r3', conditions: { logic: 'and', conditions: [{ field: 'linkDomains', operator: 'not_exists', value: '' }], groups: [] } });
    expect(engine.evaluateRule(c, r1)).toBe(true);
    expect(engine.evaluateRule(c, r2)).toBe(true);
    expect(engine.evaluateRule(c, r3)).toBe(false);
  });

  it('linkDomains 精确匹配', () => {
    const c = ctx({ linkDomains: ['t.cn'], hasLinks: true });
    const r = rule({ conditions: { logic: 'and', conditions: [{ field: 'linkDomains', operator: 'contains', value: 't.cn' }], groups: [] } });
    expect(engine.evaluateRule(c, r)).toBe(true);
  });
});

describe('AND / OR / NOT', () => {
  it('AND：全部满足才命中', () => {
    const c = ctx({ text: '广告 加微信', uid: 111 });
    const r = rule({
      conditions: {
        logic: 'and',
        conditions: [
          { field: 'content', operator: 'contains', value: '广告' },
          { field: 'uid', operator: 'eq', value: '111' },
        ],
        groups: [],
      },
    });
    const c2 = ctx({ text: '广告 加微信', uid: 222 });
    expect(engine.evaluateRule(c, r)).toBe(true);
    expect(engine.evaluateRule(c2, r)).toBe(false);
  });

  it('OR：任一满足即命中', () => {
    const c = ctx({ text: '普通内容', username: 'spam_bot' });
    const r = rule({
      conditions: {
        logic: 'or',
        conditions: [
          { field: 'content', operator: 'contains', value: '领福利' },
          { field: 'username', operator: 'prefix', value: 'spam' },
        ],
        groups: [],
      },
    });
    expect(engine.evaluateRule(c, r)).toBe(true);
  });

  it('NOT：取反', () => {
    const c = ctx({ text: '正常内容' });
    const r = rule({
      conditions: {
        logic: 'not',
        conditions: [{ field: 'content', operator: 'contains', value: '广告' }],
        groups: [],
      },
    });
    expect(engine.evaluateRule(c, r)).toBe(true);
  });

  it('嵌套子组', () => {
    const c = ctx({ text: 'x', uid: 1, username: 'bob' });
    const r = rule({
      conditions: {
        logic: 'and',
        conditions: [],
        groups: [
          {
            logic: 'or',
            conditions: [
              { field: 'uid', operator: 'eq', value: '1' },
              { field: 'username', operator: 'eq', value: 'alice' },
            ],
            groups: [],
          },
          { logic: 'not', conditions: [{ field: 'content', operator: 'contains', value: 'y' }], groups: [] },
        ],
      },
    });
    expect(engine.evaluateRule(c, r)).toBe(true);
  });
});

describe('优先级与动作合并', () => {
  it('高优先级规则决定动作', () => {
    const c = ctx({ text: '广告' });
    const low = rule({ id: 'low', priority: 10, action: 'collapse_content', conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '广告' }], groups: [] } });
    const high = rule({ id: 'high', priority: 100, action: 'hide_content', conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '广告' }], groups: [] } });
    const decision = engine.evaluate(c, [low, high]);
    expect(decision.hide).toBe(true);
    expect(decision.collapse).toBe(false);
    expect(decision.matchedRules.map((r) => r.id)).toContain('high');
  });

  it('disabled 规则不生效', () => {
    const r = rule({ enabled: false, conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '广告' }], groups: [] } });
    expect(engine.evaluateRule(ctx({ text: '广告' }), r)).toBe(false);
  });

  it('页面范围与内容类型过滤', () => {
    const c = ctx({ contentType: 'video_comment', pageScope: 'video_page' });
    const r = rule({ pageScope: ['dynamic_feed'], conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '广告' }], groups: [] } });
    const r2 = rule({ id: 'r2', contentTypes: ['dynamic'], conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '广告' }], groups: [] } });
    expect(engine.evaluateRule(c, r)).toBe(false);
    expect(engine.evaluateRule(c, r2)).toBe(false);
  });
});

describe('安全不变量', () => {
  it('白名单覆盖一切普通规则', () => {
    const c = ctx({ text: '加微信领福利', isWhitelisted: true });
    const r = rule({ conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '微信' }], groups: [] } });
    const decision = engine.evaluate(c, [r]);
    expect(decision.hide).toBe(false);
    expect(decision.collapse).toBe(false);
    expect(decision.matchedRules).toHaveLength(0);
  });

  it('当前登录用户永不被处理', () => {
    const c = ctx({ uid: 99999, text: '广告' });
    const r = rule({ conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '广告' }], groups: [] } });
    expect(engine.evaluateRule(c, r)).toBe(false);
  });

  it('疑似状态不能触发官方操作：内容规则 + 官方动作被拒绝', () => {
    for (const action of OFFICIAL_ACTIONS) {
      const c = ctx({ text: '加微信', isVerifiedMachine: true });
      const r = rule({
        action,
        reportCategory: 'ad',
        conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '微信' }], groups: [] },
      });
      // 非精确 UID 规则：官方动作一律不生效
      expect(RuleEngine.isActionAllowed(r, c)).toBe(false);
    }
  });

  it('精确 UID 规则 + 已确认名单：官方动作放行', () => {
    const c = ctx({ uid: 10086, isVerifiedMachine: true });
    const r = rule({
      action: 'official_block_verified_uid',
      conditions: {
        logic: 'and',
        conditions: [
          { field: 'uid', operator: 'eq', value: '10086' },
          { field: 'isVerifiedMachine', operator: 'eq', value: 'true' },
        ],
        groups: [],
      },
    });
    expect(RuleEngine.isActionAllowed(r, c)).toBe(true);
  });

  it('精确 UID 但不在已确认名单：官方动作拒绝', () => {
    const c = ctx({ uid: 10086, isVerifiedMachine: false });
    const r = rule({
      action: 'official_block_verified_uid',
      conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
    });
    expect(RuleEngine.isActionAllowed(r, c)).toBe(false);
  });

  it('report_verified_uid_content 必须带可举报类别', () => {
    const c = ctx({ uid: 10086, isVerifiedMachine: true, text: '广告' });
    const without = rule({
      action: 'report_verified_uid_content',
      reportCategory: null,
      conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
    });
    const withCat = rule({
      id: 'with',
      action: 'report_verified_uid_content',
      reportCategory: 'ad',
      conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
    });
    expect(RuleEngine.isActionAllowed(without, c)).toBe(false);
    expect(RuleEngine.isActionAllowed(withCat, c)).toBe(true);
  });

  it('uid 为 null 时官方动作一律拒绝', () => {
    const c = ctx({ uid: null, isVerifiedMachine: true });
    const r = rule({
      action: 'official_block_verified_uid',
      conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
    });
    expect(RuleEngine.isActionAllowed(r, c)).toBe(false);
  });

  it('正则异常规则被禁用而非影响全部', () => {
    const errored: Rule[] = [];
    const engineWithHandler = new RuleEngine({
      currentMid: null,
      onRuleError: (r) => {
        errored.push(r);
      },
    });
    const bad = rule({
      conditions: {
        logic: 'and',
        conditions: [{ field: 'content', operator: 'regex', value: '(invalid' }],
        groups: [],
      },
    });
    expect(engineWithHandler.evaluateRule(ctx(), bad)).toBe(false);
    expect(errored[0]?.id).toBe('rule_1');
  });
});

describe('hasReportableContent', () => {
  it('命中带 reportCategory 的规则视为内容违规', () => {
    const c = ctx({ text: '加微信' });
    const r = rule({
      reportCategory: 'ad',
      conditions: { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: '微信' }], groups: [] },
    });
    const decision = engine.evaluate(c, [r]);
    expect(RuleEngine.hasReportableContent(decision)).toBe(true);
  });

  it('未命中任何规则不算内容违规', () => {
    const decision = engine.evaluate(ctx({ text: '正常' }), []);
    expect(RuleEngine.hasReportableContent(decision)).toBe(false);
  });
});

describe('空条件组（全匹配）', () => {
  it('and 空组视为恒真', () => {
    const r = rule({ conditions: { logic: 'and', conditions: [], groups: [] } });
    expect(engine.evaluateRule(ctx(), r)).toBe(true);
  });
});

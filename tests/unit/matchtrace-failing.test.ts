/**
 * P0-1 失败测试（阶段 A 复现）：规则求值必须带因果路径（MatchTrace）。
 *
 * 旧实现缺陷（本文件证明其失败）：
 * - buildEvidence() 用 ruleContentFields() 递归收集规则树中出现的全部内容字段，
 *   不区分 OR 分支是否命中、条件是否位于 NOT 下、运算符是否反向。
 * - 后果：OR 未命中内容分支 / NOT(content contains x) / content not_contains x
 *   都会错误产生内容违规证据 → 普通内容被标记为广告。
 *
 * 新语义断言（阶段 B 实现后本文件必须全绿）：
 * - 内容证据只来自「实际正向命中的因果路径」（contributingLeaves）。
 * - ne / not_contains / not_exists / 负极性上下文 不得产生内容证据。
 * - uid/username/页面范围/名单状态/内容类型 不得作为内容违规证据。
 */
import { describe, expect, it } from 'vitest';
import { buildEvidence } from '@/rules/evidence';
import type { ContentContext, Rule } from '@/shared/types';

function ctx(partial: Partial<ContentContext> = {}): ContentContext {
  return {
    uid: 10086,
    username: 'bot',
    text: '这是一个普通内容，没有任何广告',
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

describe('P0-1 MatchTrace：OR/NOT/反向运算符不得伪造内容证据（阶段 A 失败测试）', () => {
  it('OR：仅用户名命中（username==bot OR content contains 广告）→ 无内容证据', () => {
    // ctx.username='bot' 命中第一个分支；content 分支未命中
    const r = rule({
      id: 'or_username',
      reportCategory: 'ad',
      conditions: {
        logic: 'or',
        conditions: [
          { field: 'username', operator: 'eq', value: 'bot' },
          { field: 'content', operator: 'contains', value: '加微信' },
        ],
        groups: [],
      },
    });
    const evidence = buildEvidence([r], ctx());
    // 旧实现：ruleContentFields 收集到 content → 产生内容证据 → 本断言失败
    expect(evidence.contentViolation).toHaveLength(0);
  });

  it('OR：仅正文命中 → 有内容证据（对照组，旧实现也应通过）', () => {
    const r = rule({
      id: 'or_content',
      reportCategory: 'ad',
      conditions: {
        logic: 'or',
        conditions: [
          { field: 'username', operator: 'eq', value: 'not-this-name' },
          { field: 'content', operator: 'contains', value: '普通内容' },
        ],
        groups: [],
      },
    });
    const evidence = buildEvidence([r], ctx());
    expect(evidence.contentViolation).toHaveLength(1);
    expect(evidence.contentViolation[0]?.fields).toContain('content');
  });

  it('NOT(content contains 广告) 对普通内容为 true → 无内容证据', () => {
    // 普通内容不包含广告 → NOT 组为 true，但 content 叶子位于负极性上下文
    const r = rule({
      id: 'not_content',
      reportCategory: 'ad',
      conditions: {
        logic: 'not',
        conditions: [{ field: 'content', operator: 'contains', value: '广告' }],
        groups: [],
      },
    });
    const evidence = buildEvidence([r], ctx());
    // 旧实现：收集 content 字段 → 产生内容证据 → 本断言失败
    expect(evidence.contentViolation).toHaveLength(0);
  });

  it('content not_contains 广告（反向运算符）→ 无内容证据', () => {
    const r = rule({
      id: 'not_contains',
      reportCategory: 'spam',
      conditions: {
        logic: 'and',
        conditions: [{ field: 'content', operator: 'not_contains', value: '广告' }],
        groups: [],
      },
    });
    const evidence = buildEvidence([r], ctx());
    expect(evidence.contentViolation).toHaveLength(0);
  });

  it('content ne 广告（反向运算符）→ 无内容证据', () => {
    const r = rule({
      id: 'ne_content',
      reportCategory: 'spam',
      conditions: {
        logic: 'and',
        conditions: [{ field: 'content', operator: 'ne', value: '广告' }],
        groups: [],
      },
    });
    const evidence = buildEvidence([r], ctx());
    expect(evidence.contentViolation).toHaveLength(0);
  });

  it('content not_exists（反向运算符）→ 无内容证据', () => {
    const r = rule({
      id: 'not_exists',
      reportCategory: 'spam',
      conditions: {
        logic: 'and',
        conditions: [{ field: 'content', operator: 'not_exists', value: '' }],
        groups: [],
      },
    });
    // ctx.text 有值 → content exists → not_exists 为 false → 规则不命中
    const ev1 = buildEvidence([r], ctx());
    expect(ev1.contentViolation).toHaveLength(0);
    // ctx.text 为空 → not_exists 为 true（规则命中）→ 仍不得产生内容证据
    const ev2 = buildEvidence([r], ctx({ text: '' }));
    expect(ev2.contentViolation).toHaveLength(0);
  });

  it('content contains 广告 AND uid == x → 有内容证据（正向路径对照组）', () => {
    const r = rule({
      id: 'and_content_uid',
      reportCategory: 'fraud',
      conditions: {
        logic: 'and',
        conditions: [
          { field: 'content', operator: 'contains', value: '普通内容' },
          { field: 'uid', operator: 'eq', value: '10086' },
        ],
        groups: [],
      },
    });
    const evidence = buildEvidence([r], ctx());
    expect(evidence.contentViolation).toHaveLength(1);
    expect(evidence.contentViolation[0]?.fields).toContain('content');
    // uid 字段不得混入内容证据字段
    expect(evidence.contentViolation[0]?.fields).not.toContain('uid');
  });

  it('嵌套 OR/AND/NOT：只有正向命中路径产生内容证据', () => {
    // (username==bot OR (content contains 普通内容 AND NOT(content contains 广告)))
    const r = rule({
      id: 'nested',
      reportCategory: 'ad',
      conditions: {
        logic: 'or',
        conditions: [{ field: 'username', operator: 'eq', value: 'bot' }],
        groups: [
          {
            logic: 'and',
            conditions: [{ field: 'content', operator: 'contains', value: '普通内容' }],
            groups: [
              {
                logic: 'not',
                conditions: [{ field: 'content', operator: 'contains', value: '广告' }],
                groups: [],
              },
            ],
          },
        ],
      },
    });
    // 两条 OR 分支都命中：username 分支 + AND 分支。内容证据只应来自 AND 分支的 content contains
    const evidence = buildEvidence([r], ctx({ text: '这是一条普通内容' }));
    expect(evidence.contentViolation).toHaveLength(1);
    expect(evidence.contentViolation[0]?.fields).toEqual(['content']);
  });

  it('多个 true OR 分支：确定性收集（content 命中 + hasLinks 命中）', () => {
    const r = rule({
      id: 'multi_or',
      reportCategory: 'ad',
      conditions: {
        logic: 'or',
        conditions: [
          { field: 'content', operator: 'contains', value: '普通内容' },
          { field: 'hasLinks', operator: 'eq', value: 'true' },
        ],
        groups: [],
      },
    });
    const evidence = buildEvidence([r], ctx({ hasLinks: true, links: ['https://evil.example/x'] }));
    // 两个正向分支都命中：content + hasLinks 都应被确定性收集
    expect(evidence.contentViolation).toHaveLength(1);
    const fields = evidence.contentViolation[0]?.fields ?? [];
    expect(fields).toContain('content');
    expect(fields).toContain('hasLinks');
  });

  it('精确 UID 授权证据与内容证据保持独立：UID 规则命中不产生内容证据，但仍产生账号授权', () => {
    const uidRule = rule({
      id: 'uid_only',
      action: 'report_verified_uid_content',
      reportCategory: 'ad',
      conditions: { logic: 'and', conditions: [{ field: 'uid', operator: 'eq', value: '10086' }], groups: [] },
    });
    const evidence = buildEvidence([uidRule], ctx());
    expect(evidence.accountAuthorization).toHaveLength(1);
    expect(evidence.contentViolation).toHaveLength(0);
  });

  it('hasLinks eq true 命中可作内容证据，但 isLocalBlocked/isWhitelisted 等名单状态不得作内容证据', () => {
    const listStateRule = rule({
      id: 'list_state',
      reportCategory: 'spam',
      conditions: {
        logic: 'and',
        conditions: [
          { field: 'isLocalBlocked', operator: 'eq', value: 'true' },
          { field: 'isWhitelisted', operator: 'eq', value: 'false' },
          { field: 'hasLinks', operator: 'eq', value: 'true' },
        ],
        groups: [],
      },
    });
    const evidence = buildEvidence([listStateRule], ctx({ isLocalBlocked: true, hasLinks: true }));
    expect(evidence.contentViolation).toHaveLength(1);
    expect(evidence.contentViolation[0]?.fields).toEqual(['hasLinks']);
  });
});

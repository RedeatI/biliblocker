/**
 * 内置默认规则（全部为「疑似」级别，绝不内置任何官方动作规则）。
 * 首次安装时写入；可通过「恢复默认设置」重置。
 */
import type { Rule } from '../shared/types';
import { shortId } from '../shared/utils';

function makeRule(
  name: string,
  description: string,
  conditions: Rule['conditions'],
  action: Rule['action'],
  reportCategory: Rule['reportCategory'],
  priority: number,
  opts: Partial<Pick<Rule, 'pageScope' | 'contentTypes'>> = {},
): Rule {
  const ts = Date.now();
  return {
    id: shortId('rule'),
    name,
    description,
    enabled: true,
    priority,
    conditions,
    pageScope: opts.pageScope ?? [],
    contentTypes: opts.contentTypes ?? [],
    action,
    reportCategory,
    createdAt: ts,
    updatedAt: ts,
    schemaVersion: 1,
  };
}

export const DEFAULT_RULES: Rule[] = [
  makeRule(
    '疑似广告关键词',
    '正文包含典型广告/引流关键词（如 加微信、加QQ、私聊、点击链接、低价代刷 等），折叠并提示检查。',
    {
      logic: 'and',
      conditions: [
        {
          field: 'content',
          operator: 'regex',
          value: '(加|联系|私|来)\\s*(vx|v信|威信|微信|企鹅|qq|QQ|q群|裙号|薇|微❤)|低价出|代练|刷赞|刷粉|兼职|日赚|佣金|点击链接|主页有|主页领取',
        },
      ],
      groups: [],
    },
    'collapse_content',
    'ad',
    100,
  ),
  makeRule(
    '疑似营销引流链接',
    '正文包含站外营销/电商/引流链接（短链或电商域名为白名单），折叠并提示检查。',
    {
      logic: 'or',
      conditions: [
        {
          field: 'links',
          operator: 'regex',
          // links 字段均为带协议完整 URL（extractLinksFromText/domLinks 归一化）
          value: '^https?:\\/\\/(?:t\\.cn|dwz\\.cn|s2\\.bz|url\\.cn|bit\\.ly|goo\\.gl|c\\.tb\\.cn|item\\.taobao\\.com|item\\.jd\\.com|u\\.muxiaoguo|haokan|xiaohongshu|douyin|weidian|kuaishou|m\\.huya|link\\.zhihu)',
        },
      ],
      groups: [],
    },
    'collapse_content',
    'ad',
    90,
  ),
  makeRule(
    '疑似联系方式',
    '正文疑似包含联系方式（微信/QQ 号模式），仅标记提醒，不自动隐藏，减少误伤。',
    {
      logic: 'and',
      conditions: [
        {
          field: 'content',
          operator: 'regex',
          value: '(?:vx|v信|威信|薇|微❤|企鹅|扣扣|qq)\\s*[:：]?\\s*[a-zA-Z0-9_\\-]{4,}|\\b[1-9]\\d{4,10}\\b',
        },
      ],
      groups: [],
    },
    'flag_suspicious',
    'spam',
    50,
  ),
  makeRule(
    '已拉黑账号的内容',
    '本地黑名单中账号发布的内容默认折叠（可在设置调整处理方式）。',
    {
      logic: 'and',
      conditions: [{ field: 'isLocalBlocked', operator: 'eq', value: 'true' }],
      groups: [],
    },
    'collapse_content',
    null,
    200,
  ),
  makeRule(
    '已确认机器人的内容',
    '已确认机器人名单中的精确 UID 发布的内容默认折叠（官方拉黑/举报由名单与开关编排，不由此规则触发）。',
    {
      logic: 'and',
      conditions: [{ field: 'isVerifiedMachine', operator: 'eq', value: 'true' }],
      groups: [],
    },
    'collapse_content',
    null,
    180,
  ),
];

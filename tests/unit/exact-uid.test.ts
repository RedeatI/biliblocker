/**
 * P1-5 精确 UID 规则规范化：完整边界表。
 * 根级或任意层级 NOT 一律拒绝；OR 一律拒绝；必须恰好一个 UID eq 正整数；
 * 可选条件只能是 isVerifiedMachine eq true；多 UID、isVerifiedMachine=false、
 * 空组、嵌套组、重复冲突条件均拒绝。
 */
import { describe, expect, it } from 'vitest';
import { exactUidIssue, isExactUidRule } from '@/rules/schema';
import type { ConditionGroup } from '@/shared/types';

const and = (conditions: ConditionGroup['conditions'], groups: ConditionGroup['groups'] = []): ConditionGroup => ({
  logic: 'and',
  conditions,
  groups,
});
const uidEq = (v: string) => ({ field: 'uid' as const, operator: 'eq' as const, value: v });
const verifiedEq = (v: string) => ({ field: 'isVerifiedMachine' as const, operator: 'eq' as const, value: v });
const contentContains = (v: string) => ({ field: 'content' as const, operator: 'contains' as const, value: v });
const usernameEq = (v: string) => ({ field: 'username' as const, operator: 'eq' as const, value: v });

describe('P1-5 精确 UID 边界表', () => {
  const cases: Array<{ name: string; conditions: ConditionGroup; expectValid: boolean; issue?: string }> = [
    // ---- 合法 ----
    { name: '仅 UID eq', conditions: and([uidEq('10086')]), expectValid: true },
    { name: 'UID eq + isVerifiedMachine=true', conditions: and([uidEq('10086'), verifiedEq('true')]), expectValid: true },
    { name: 'isVerifiedMachine=true + UID eq（顺序无关）', conditions: and([verifiedEq('true'), uidEq('10086')]), expectValid: true },
    // ---- 根级 NOT / OR ----
    { name: '根级 NOT', conditions: { logic: 'not', conditions: [uidEq('10086')], groups: [] }, expectValid: false, issue: 'contains_not' },
    { name: '根级 OR', conditions: { logic: 'or', conditions: [uidEq('10086')], groups: [] }, expectValid: false, issue: 'contains_or' },
    // ---- 任意层级 NOT / OR（嵌套组） ----
    { name: '子组 NOT', conditions: and([], [{ logic: 'not', conditions: [uidEq('10086')], groups: [] }]), expectValid: false, issue: 'nested_group' },
    { name: '子组 OR', conditions: and([], [{ logic: 'or', conditions: [uidEq('10086')], groups: [] }]), expectValid: false, issue: 'nested_group' },
    // ---- 多个不同 UID ----
    { name: '两个不同 UID', conditions: and([uidEq('10086'), uidEq('10087')]), expectValid: false, issue: 'multiple_uids' },
    { name: '两个相同 UID（重复但不冲突）→ 拒绝（必须恰好一个）', conditions: and([uidEq('10086'), uidEq('10086')]), expectValid: false, issue: 'multiple_uids' },
    // ---- isVerifiedMachine=false ----
    { name: 'isVerifiedMachine=false', conditions: and([uidEq('10086'), verifiedEq('false')]), expectValid: false, issue: 'is_verified_false' },
    // ---- UID 缺失 / 非正整数 / 非 eq ----
    { name: '缺少 UID', conditions: and([verifiedEq('true')]), expectValid: false, issue: 'uid_missing' },
    { name: '空组', conditions: and([]), expectValid: false, issue: 'empty_group' },
    { name: 'UID 非正整数（0）', conditions: and([uidEq('0')]), expectValid: false, issue: 'uid_not_positive_integer' },
    { name: 'UID 非数字', conditions: and([uidEq('abc')]), expectValid: false, issue: 'uid_not_positive_integer' },
    { name: 'UID 负数', conditions: and([uidEq('-5')]), expectValid: false, issue: 'uid_not_positive_integer' },
    { name: 'UID 使用 ne', conditions: and([{ field: 'uid', operator: 'ne', value: '10086' }]), expectValid: false, issue: 'uid_not_positive_integer' },
    // ---- 禁止字段 ----
    { name: 'UID + content 条件', conditions: and([uidEq('10086'), contentContains('广告')]), expectValid: false, issue: 'forbidden_field' },
    { name: 'UID + username 条件', conditions: and([uidEq('10086'), usernameEq('bot')]), expectValid: false, issue: 'forbidden_field' },
    // ---- isVerifiedMachine 非 eq / 非布尔 ----
    { name: 'isVerifiedMachine=yes', conditions: and([uidEq('10086'), verifiedEq('yes')]), expectValid: false, issue: 'is_verified_false' },
    { name: 'isVerifiedMachine 用 contains', conditions: and([uidEq('10086'), { field: 'isVerifiedMachine', operator: 'contains', value: 'true' }]), expectValid: false, issue: 'is_verified_false' },
  ];

  it.each(cases)('$name → $expectValid', ({ conditions, expectValid, issue }) => {
    const result = exactUidIssue({ conditions });
    expect(result === null).toBe(expectValid);
    if (!expectValid) {
      expect(result).toBe(issue);
    }
    expect(isExactUidRule({ conditions })).toBe(expectValid);
  });

  it('完整边界表覆盖全部拒绝类别（无遗漏）', () => {
    const issues = new Set(cases.filter((c) => !c.expectValid).map((c) => c.issue));
    expect(issues).toEqual(
      new Set(['contains_not', 'contains_or', 'nested_group', 'multiple_uids', 'is_verified_false', 'uid_missing', 'empty_group', 'uid_not_positive_integer', 'forbidden_field']),
    );
  });
});

describe('P1-3 条件树限制', () => {
  it('超过深度上限被拒绝', () => {
    // 深度 6（超过 MAX_CONDITIONS_DEPTH=5）
    let g: ConditionGroup = and([uidEq('1')]);
    for (let i = 0; i < 6; i++) {
      g = { logic: 'and', conditions: [], groups: [g] };
    }
    expect(isExactUidRule({ conditions: g })).toBe(false);
  });
});

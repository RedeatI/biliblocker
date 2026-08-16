/**
 * P1-7（v0.1.2）：正则 Worker 保存硬门禁。
 * - Worker 超时/失败/不可用 → 不能保存启用状态的 regex 规则；
 * - pattern/样例变化后状态失效；
 * - 无 Worker 时不得显示「已通过 Worker」；
 * - 可以保存 disabled 草稿，但必须明确标注。
 */
import { describe, expect, it } from 'vitest';
import { regexSaveGate, collectRegexConditions, isRegexVerificationValid } from '@/rules/regex-gate';
import type { Condition, ConditionGroup, RegexVerification, RuleOperator } from '@/shared/types';

function group(conditions: Array<{ operator: RuleOperator; value: string; verification?: RegexVerification }>): ConditionGroup {
  return {
    logic: 'and',
    conditions: conditions.map((c) => ({
      field: 'content',
      operator: c.operator,
      value: c.value,
      regexVerification: c.verification,
    })) as Condition[],
    groups: [],
  };
}

const validVerification: RegexVerification = {
  ok: true,
  pattern: '^广告\\d+$',
  sample: '广告123',
  workerAvailable: true,
  verifiedAt: Date.now(),
};

describe('P1-7 regexSaveGate 保存硬门禁', () => {
  it('regex 条件带有效 Worker 验证（启用）→ 可保存', () => {
    const g = group([{ operator: 'regex', value: '^广告\\d+$', verification: validVerification }]);
    const r = regexSaveGate(g, { enabled: true, currentSample: '广告123' });
    expect(r.canSaveEnabled).toBe(true);
  });

  it('无 Worker 验证记录（启用）→ 拒绝保存', () => {
    const g = group([{ operator: 'regex', value: '^广告\\d+$' }]);
    const r = regexSaveGate(g, { enabled: true });
    expect(r.canSaveEnabled).toBe(false);
  });

  it('Worker 失败（ok=false，启用）→ 拒绝保存', () => {
    const g = group([{
      operator: 'regex', value: '^广告\\d+$',
      verification: { ...validVerification, ok: false },
    }]);
    const r = regexSaveGate(g, { enabled: true });
    expect(r.canSaveEnabled).toBe(false);
  });

  it('无 Worker 环境（workerAvailable=false，启用）→ 拒绝保存，且不算「已通过 Worker」', () => {
    const g = group([{
      operator: 'regex', value: '^广告\\d+$',
      verification: { ...validVerification, workerAvailable: false },
    }]);
    const r = regexSaveGate(g, { enabled: true });
    expect(r.canSaveEnabled).toBe(false);
    expect(isRegexVerificationValid(
      g.conditions[0]!,
      { ...validVerification, workerAvailable: false },
    )).toBe(false);
  });

  it('pattern 变化后验证状态失效（启用）→ 拒绝保存', () => {
    const g = group([{
      operator: 'regex', value: '^新版\\d+$',
      verification: validVerification, // pattern 是旧值
    }]);
    const r = regexSaveGate(g, { enabled: true });
    expect(r.canSaveEnabled).toBe(false);
  });

  it('样例变化后验证状态失效（启用）→ 拒绝保存', () => {
    const g = group([{ operator: 'regex', value: '^广告\\d+$', verification: validVerification }]);
    const r = regexSaveGate(g, { enabled: true, currentSample: '完全不同的样例' });
    expect(r.canSaveEnabled).toBe(false);
  });

  it('非 regex 条件不受门禁影响（启用）→ 可保存', () => {
    const g = group([{ operator: 'contains', value: '广告' }]);
    const r = regexSaveGate(g, { enabled: true });
    expect(r.canSaveEnabled).toBe(true);
  });

  it('disabled 草稿允许保存，但必须标注未通过 Worker 验证', () => {
    const g = group([{ operator: 'regex', value: '^广告\\d+$' }]);
    const r = regexSaveGate(g, { enabled: false });
    expect(r.canSaveEnabled).toBe(true);
    expect(r.reason).toContain('草稿');
    expect(r.unverified.length).toBeGreaterThan(0);
  });

  it('collectRegexConditions 收集嵌套组中的 regex 条件', () => {
    const g: ConditionGroup = {
      logic: 'or',
      conditions: [{ field: 'content', operator: 'regex', value: 'a' }],
      groups: [
        { logic: 'and', conditions: [{ field: 'content', operator: 'regex', value: 'b' }], groups: [] },
      ],
    };
    const rows = collectRegexConditions(g);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.path).toContain('conditions[0]');
    expect(rows[1]?.path).toContain('groups[0]');
  });
});

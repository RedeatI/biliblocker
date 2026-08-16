/**
 * 正则安全层测试：语法校验、ReDoS 高风险结构拒绝、长度限制。
 */
import { describe, expect, it } from 'vitest';
import { RegexSafety } from '@/rules/safety';

describe('RegexSafety.validate', () => {
  it('合法正则通过', () => {
    expect(RegexSafety.validate('广告|加微信').ok).toBe(true);
    expect(RegexSafety.validate('\\b[1-9]\\d{4,10}\\b').ok).toBe(true);
    expect(RegexSafety.validate('(?:vx|v信)\\s*[:：]?\\s*\\w{4,}').ok).toBe(true);
  });

  it('空值/超长拒绝', () => {
    expect(RegexSafety.validate('').ok).toBe(false);
    expect(RegexSafety.validate('a'.repeat(201)).ok).toBe(false);
  });

  it('嵌套量词灾难性回溯结构被拒绝', () => {
    const dangerous = ['(a+)+', '(a*)*', '(ab?)+?', '((a|b)+)*', '(\\w+\\s*)+'];
    for (const p of dangerous) {
      const r = RegexSafety.validate(p);
      expect(r.ok, `应拒绝：${p}`).toBe(false);
      expect(r.riskLevel).toBe('risky');
    }
  });

  it('语法错误拒绝', () => {
    const r = RegexSafety.validate('(unclosed');
    expect(r.ok).toBe(false);
    expect(r.riskLevel).toBe('invalid');
  });

  it('truncateInput 限制输入长度', () => {
    expect(RegexSafety.truncateInput('x'.repeat(5000)).length).toBeLessThanOrEqual(1000);
  });

  it('编译后的正则可安全执行', () => {
    const re = RegexSafety.compile('广告');
    expect(re.test('这是广告内容')).toBe(true);
  });
});

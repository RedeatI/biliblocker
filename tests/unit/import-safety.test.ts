/**
 * P1-4/P1-3 导入安全测试：
 * - parseListImport 统一名单解析（字节上限、schema、原型污染、无效拒绝）；
 * - 全量导入：危险正则拒绝、深层条件树拒绝、超大名单拒绝、原型污染剥离。
 */
import { describe, expect, it } from 'vitest';
import { parseListImport, parseImportText } from '@/rules/import-export';
import { LIMITS } from '@/shared/constants/defaults';

describe('P1-4 parseListImport（统一名单导入）', () => {
  it('有效数组全部解析成功', () => {
    const r = parseListImport(
      JSON.stringify([
        { uid: 1, username: 'a' },
        { uid: 2, username: 'b', reason: '广告' },
      ]),
      'blocked',
    );
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(2);
  });

  it('单个对象（非数组）兼容', () => {
    const r = parseListImport(JSON.stringify({ uid: 42, username: 'x' }), 'verified');
    expect(r.ok).toBe(true);
    expect(r.items?.[0]?.uid).toBe(42);
  });

  it('无效条目 → 整包拒绝（不部分写入）', () => {
    const r = parseListImport(
      JSON.stringify([
        { uid: 1 },
        { uid: -2 },
        { uid: 'abc' },
      ]),
      'whitelist',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无效条目');
    expect(r.items).toBeUndefined();
  });

  it('字节上限拒绝', () => {
    const big = '[' + Array.from({ length: 60000 }, () => '{"uid":1}').join(',') + ']';
    expect(big.length).toBeGreaterThan(LIMITS.IMPORT_MAX_BYTES);
    const r = parseListImport(big, 'blocked');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('大小上限');
  });

  it('原型污染键被剥离', () => {
    const r = parseListImport(
      '[{"uid":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}]',
      'blocked',
    );
    expect(r.ok).toBe(true);
    expect((r.items?.[0] as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('非 JSON 拒绝', () => {
    const r = parseListImport('not json', 'blocked');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('JSON 解析失败');
  });
});

describe('P1-3 全量导入安全', () => {
  it('危险正则（嵌套量词）导入整包拒绝', () => {
    const text = JSON.stringify({
      rules: [
        {
          id: 'r_bad_regex',
          name: '危险正则',
          enabled: true,
          priority: 0,
          conditions: {
            logic: 'and',
            conditions: [{ field: 'content', operator: 'regex', value: '(a+)+' }],
            groups: [],
          },
          pageScope: [],
          contentTypes: [],
          action: 'collapse_content',
          reportCategory: null,
          createdAt: 0,
          updatedAt: 0,
          schemaVersion: 1,
        },
      ],
    });
    const r = parseImportText(text);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('正则');
  });

  it('深层条件树（超过深度限制）导入拒绝', () => {
    let group: {
      logic: 'and';
      conditions: { field: string; operator: string; value: string }[];
      groups: unknown[];
    } = { logic: 'and', conditions: [{ field: 'content', operator: 'contains', value: 'x' }], groups: [] };
    for (let i = 0; i < 6; i++) {
      group = { logic: 'and', conditions: [], groups: [group] };
    }
    const text = JSON.stringify({
      rules: [
        {
          id: 'r_deep',
          name: '深层树',
          enabled: true,
          priority: 0,
          conditions: group,
          pageScope: [],
          contentTypes: [],
          action: 'collapse_content',
          reportCategory: null,
          createdAt: 0,
          updatedAt: 0,
          schemaVersion: 1,
        },
      ],
    });
    const r = parseImportText(text);
    expect(r.ok).toBe(false);
  });

  it('条件总数超限（>100）导入拒绝', () => {
    const conditions = Array.from({ length: 110 }, () => ({
      field: 'content',
      operator: 'contains',
      value: 'x',
    }));
    const text = JSON.stringify({
      rules: [
        {
          id: 'r_many',
          name: '条件过多',
          enabled: true,
          priority: 0,
          conditions: { logic: 'and', conditions, groups: [] },
          pageScope: [],
          contentTypes: [],
          action: 'collapse_content',
          reportCategory: null,
          createdAt: 0,
          updatedAt: 0,
          schemaVersion: 1,
        },
      ],
    });
    const r = parseImportText(text);
    expect(r.ok).toBe(false);
  });

  it('超大批量名单（超过上限）导入拒绝', () => {
    const items = Array.from({ length: LIMITS.MAX_BLOCKED + 10 }, (_, i) => ({ uid: i + 1 }));
    const text = JSON.stringify({ blocked: items });
    const r = parseImportText(text);
    expect(r.ok).toBe(false);
  });

  it('原型污染键被剥离后仍可导入', () => {
    const text = JSON.stringify({
      blocked: [{ uid: 1, '__proto__': { polluted: true } }],
      settings: { enabled: true },
    });
    const r = parseImportText(text);
    expect(r.ok).toBe(true);
  });
});

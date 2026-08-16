/**
 * 导入导出测试：Schema 校验、原型污染防护、大小限制、预览统计、迁移幂等。
 */
import { describe, expect, it } from 'vitest';
import {
  computeImportPreview,
  parseImportText,
  serializeForExport,
  toEntities,
} from '@/rules/import-export';
import { runMigrations } from '@/rules/migrations';
import { inMemoryBackend } from '@/storage/backend';
import type { Rule } from '@/shared/types';

const validExport = () => ({
  app: 'biliblocker',
  schemaVersion: 1,
  exportedAt: Date.now(),
  settings: { enabled: true },
  rules: [
    {
      id: 'rule_abc123',
      name: '测试规则',
      description: '',
      enabled: true,
      priority: 10,
      conditions: {
        logic: 'and',
        conditions: [{ field: 'content', operator: 'contains', value: '广告' }],
        groups: [],
      },
      pageScope: [],
      contentTypes: [],
      action: 'collapse_content',
      reportCategory: 'ad',
      createdAt: 0,
      updatedAt: 0,
      schemaVersion: 1,
    },
  ],
  blocked: [{ uid: 10086, username: 'spam1' }],
  verified: [{ uid: 10086, username: 'spam1', source: 'import' }],
  whitelist: [{ uid: 20000 }],
});

describe('parseImportText', () => {
  it('合法导出可解析', () => {
    const r = parseImportText(JSON.stringify(validExport()));
    expect(r.ok).toBe(true);
    expect(r.data?.rules).toHaveLength(1);
  });

  it('非 JSON 拒绝', () => {
    expect(parseImportText('not json').ok).toBe(false);
  });

  it('超过大小上限拒绝', () => {
    const huge = JSON.stringify({ rules: Array.from({ length: 1000 }, () => ({ x: 'y'.repeat(1000) })) });
    const r = parseImportText(huge);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('大小上限');
  });

  it('Schema 不符拒绝（未知字段被严格 schema 拒绝）', () => {
    const bad = { ...validExport(), rules: [{ ...validExport().rules[0], evil: 'code' }] };
    const r = parseImportText(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('原型污染载荷被剥离后校验（__proto__/constructor 键）', () => {
    const polluted = JSON.parse(JSON.stringify(validExport())) as Record<string, unknown>;
    polluted['__proto__'] = { polluted: true };
    polluted['constructor'] = { prototype: { polluted: true } };
    const r = parseImportText(JSON.stringify(polluted));
    expect(r.ok).toBe(true);
    // 剥离后不影响结果结构
    expect(r.data?.rules).toHaveLength(1);
  });

  it('恶意规则（可执行代码字段）被拒绝', () => {
    const evil = { ...validExport(), rules: [{ ...validExport().rules[0], code: 'eval("x")', script: 'window.x=1' }] };
    expect(parseImportText(JSON.stringify(evil)).ok).toBe(false);
  });
});

describe('序列化与预览', () => {
  it('导出后可再导入（round-trip）', () => {
    const data = {
      rules: toEntities(parseImportText(JSON.stringify(validExport())).data!)!.rules!,
      blocked: [
        { uid: 1, username: 'a', blockedAt: 1, source: 'import' as const },
      ],
      verified: [],
      whitelist: [],
    };
    const text = serializeForExport(data);
    const parsed = parseImportText(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.blocked).toHaveLength(1);
  });

  it('预览统计：新增/覆盖/忽略', () => {
    const parsed = parseImportText(JSON.stringify(validExport()));
    expect(parsed.ok).toBe(true);
    const preview = computeImportPreview(parsed.data!, {
      rules: [{ ...(validExport().rules[0] as Rule) }], // 同 id 存在 → 覆盖
      blocked: [],
      verified: [],
      whitelist: [{ uid: 20000, addedAt: 1 }],
    });
    expect(preview.rules.toOverride).toBe(1);
    expect(preview.blocked.toAdd).toBe(1);
    expect(preview.whitelist.toIgnore).toBe(1);
  });
});

describe('migrations', () => {
  it('无迁移时原样返回（幂等）', async () => {
    const backend = inMemoryBackend();
    const raw = { 'bb.settings': { enabled: true } };
    const out = await runMigrations(1, raw, backend);
    expect(out['bb.settings']).toEqual({ enabled: true });
    // 再次执行结果一致
    const out2 = await runMigrations(1, out, backend);
    expect(out2).toEqual(out);
  });
});

/**
 * 规则/数据导入导出。
 * 安全要求：
 * - JSON Schema 校验（Zod，strict 模式）
 * - 限制文件大小（LIMITS.IMPORT_MAX_BYTES）
 * - 阻止原型污染（JSON.parse 后的 __proto__/constructor 键剥离 + Zod strict 天然拒绝未知键）
 * - 不允许导入可执行代码（无任何代码字段，且严格 schema 拒绝未知键）
 * - 导入前展示 新增/覆盖/忽略 数量并需用户确认（UI 层负责确认步骤）
 */
import { z } from 'zod';
import { BlockedUser, Rule, Settings, VerifiedMachine, WhitelistedUser } from '../shared/types';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS, LIMITS } from '../shared/constants/defaults';
import { parseRulesArrayLoose, ruleSchema } from './schema';
import { RegexSafety } from './safety';

export interface ImportPreview {
  rules: { toAdd: number; toOverride: number; toIgnore: number };
  blocked: { toAdd: number; toIgnore: number };
  verified: { toAdd: number; toIgnore: number };
  whitelist: { toAdd: number; toIgnore: number };
  totalValid: number;
  invalidEntries: number;
}

const blockedSchema = z.object({
  uid: z.number().int().positive(),
  username: z.string().max(64).optional(),
  reason: z.string().max(200).optional(),
  blockedAt: z.number().int().nonnegative().optional(),
  source: z.enum(['user_action', 'manual', 'import', 'auto_process']).optional(),
});

const verifiedSchema = z.object({
  uid: z.number().int().positive(),
  username: z.string().max(64).optional(),
  source: z.enum(['user_action', 'manual', 'import', 'official_mark']).optional(),
  addedAt: z.number().int().nonnegative().optional(),
});

const whitelistSchema = z.object({
  uid: z.number().int().positive(),
  username: z.string().max(64).optional(),
  addedAt: z.number().int().nonnegative().optional(),
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  videoCommentsEnabled: z.boolean().optional(),
  dynamicsEnabled: z.boolean().optional(),
  suspiciousHandling: z.enum(['collapse', 'hide', 'flag_only']).optional(),
  quickActionDisplay: z.enum(['hover', 'always']).optional(),
  autoReportAuthorized: z.boolean().optional(),
  defaultReportReason: z.number().int().nullable().optional(),
  autoProcessVerified: z.boolean().optional(),
  operationDelayMs: z.number().int().min(0).max(60000).optional(),
});

export const importDataSchema = z
  .object({
    app: z.literal('biliblocker').optional(),
    schemaVersion: z.number().int().nonnegative().default(CURRENT_SCHEMA_VERSION),
    exportedAt: z.number().int().nonnegative().optional(),
    settings: settingsSchema.optional(),
    rules: z.array(ruleSchema).max(LIMITS.MAX_RULES).optional(),
    blocked: z.array(blockedSchema).max(LIMITS.MAX_BLOCKED).optional(),
    verified: z.array(verifiedSchema).max(LIMITS.MAX_VERIFIED).optional(),
    whitelist: z.array(whitelistSchema).max(LIMITS.MAX_WHITELIST).optional(),
  })
  .strict();

export type ImportData = z.infer<typeof importDataSchema>;

export interface ParsedImport {
  ok: boolean;
  error?: string;
  data?: ImportData;
}

/** 解析并校验导入文本；任何失败都返回可读错误 */
export function parseImportText(text: string): ParsedImport {
  if (text.length > LIMITS.IMPORT_MAX_BYTES) {
    return { ok: false, error: `文件超过大小上限（${Math.round(LIMITS.IMPORT_MAX_BYTES / 1024)} KB）` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 解析失败：文件不是有效的 JSON' };
  }
  // 原型污染防护：剥离危险键
  const cleaned = stripDangerousKeys(raw);
  const result = importDataSchema.safeParse(cleaned);
  if (!result.success) {
    return {
      ok: false,
      error: `数据校验失败：${result.error.issues[0]?.message ?? '格式不符合 BiliBlocker 导出格式'}`,
    };
  }
  // P1-3：导入必须通过正则安全校验（任一危险正则 → 整包拒绝）
  const regexError = findUnsafeRegex(result.data.rules);
  if (regexError) {
    return { ok: false, error: `导入失败：${regexError}` };
  }
  return { ok: true, data: result.data };
}

/** 检查规则集中是否存在未通过 RegexSafety.validate 的正则条件（递归） */
function findUnsafeRegex(rules: Rule[] | undefined): string | null {
  if (!rules) return null;
  for (const rule of rules) {
    const walk = (group: { conditions: { operator: string; value: string }[]; groups: unknown[] }): string | null => {
      for (const c of group.conditions) {
        if (c.operator === 'regex') {
          const r = RegexSafety.validate(c.value);
          if (!r.ok) return `规则「${rule.name}」的正则未通过安全校验：${r.error}`;
        }
      }
      for (const g of group.groups as { conditions: { operator: string; value: string }[]; groups: unknown[] }[]) {
        const err = walk(g);
        if (err) return err;
      }
      return null;
    };
    const err = walk(rule.conditions);
    if (err) return err;
  }
  return null;
}

/** 递归剥离 __proto__ / constructor / prototype 键 */
function stripDangerousKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDangerousKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = stripDangerousKeys(v);
    }
    return out;
  }
  return value;
}

export function serializeForExport(
  data: {
    rules: Rule[];
    blocked: BlockedUser[];
    verified: VerifiedMachine[];
    whitelist: WhitelistedUser[];
    settings?: Settings;
  },
): string {
  return JSON.stringify(
    {
      app: 'biliblocker',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: Date.now(),
      settings: data.settings ?? DEFAULT_SETTINGS,
      rules: data.rules,
      blocked: data.blocked,
      verified: data.verified,
      whitelist: data.whitelist,
    },
    null,
    2,
  );
}

/** 计算导入预览（对比现有数据），供 UI 展示后由用户确认 */
export function computeImportPreview(
  parsed: ImportData,
  current: { rules: Rule[]; blocked: BlockedUser[]; verified: VerifiedMachine[]; whitelist: WhitelistedUser[] },
): ImportPreview {
  const currentRuleIds = new Set(current.rules.map((r) => r.id));

  const newRules = (parsed.rules ?? []).filter((r) => !currentRuleIds.has(r.id));
  const overrideRules = (parsed.rules ?? []).filter((r) => currentRuleIds.has(r.id));
  const ignoreRules = Math.max(
    0,
    current.rules.length - (parsed.rules ?? []).length,
  );

  const countByUid = (list: { uid: number }[], incoming: { uid: number }[]) => {
    const currentUids = new Set(list.map((x) => x.uid));
    return {
      toAdd: incoming.filter((x) => !currentUids.has(x.uid)).length,
      toIgnore: incoming.filter((x) => currentUids.has(x.uid)).length,
    };
  };

  const blocked = countByUid(current.blocked, parsed.blocked ?? []);
  const verified = countByUid(current.verified, parsed.verified ?? []);
  const whitelist = countByUid(current.whitelist, parsed.whitelist ?? []);

  return {
    rules: {
      toAdd: newRules.length,
      toOverride: overrideRules.length,
      toIgnore: ignoreRules,
    },
    blocked,
    verified,
    whitelist,
    totalValid:
      (parsed.rules?.length ?? 0) +
      (parsed.blocked?.length ?? 0) +
      (parsed.verified?.length ?? 0) +
      (parsed.whitelist?.length ?? 0),
    invalidEntries: 0,
  };
}

/**
 * 解析成可直接写入的实体（对 Rule 做 loose 归一化）。
 * P1-4（v0.1.2）：保留并验证 settings，使「完整 JSON 导入」能恢复设置。
 */
export function toEntities(parsed: ImportData): {
  settings?: Settings;
  rules?: Rule[];
  blocked?: BlockedUser[];
  verified?: VerifiedMachine[];
  whitelist?: WhitelistedUser[];
} {
  const out: {
    settings?: Settings;
    rules?: Rule[];
    blocked?: BlockedUser[];
    verified?: VerifiedMachine[];
    whitelist?: WhitelistedUser[];
  } = {
    rules: parsed.rules ? parseRulesArrayLoose(parsed.rules) : undefined,
    blocked: parsed.blocked as BlockedUser[] | undefined,
    verified: parsed.verified as VerifiedMachine[] | undefined,
    whitelist: parsed.whitelist as WhitelistedUser[] | undefined,
  };
  if (parsed.settings) {
    // 用 default 补全缺失字段，保证 Settings 完整性
    out.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
  }
  return out;
}

// ---------------- P1-4：统一名单导入 ----------------

export type ListKind = 'blocked' | 'verified' | 'whitelist';

export interface ListImportItem {
  uid: number;
  username?: string;
  reason?: string;
  source?: 'user_action' | 'manual' | 'import' | 'auto_process' | 'official_mark';
}

export interface ListImportResult {
  ok: boolean;
  error?: string;
  items?: ListImportItem[];
  /** 原始条目数 */
  total: number;
}

const LIST_ITEM_SCHEMAS: Record<ListKind, z.ZodType<ListImportItem>> = {
  blocked: z.object({
    uid: z.number().int().positive(),
    username: z.string().max(64).optional(),
    reason: z.string().max(200).optional(),
    source: z.enum(['user_action', 'manual', 'import', 'auto_process']).optional(),
  }) as z.ZodType<ListImportItem>,
  verified: z.object({
    uid: z.number().int().positive(),
    username: z.string().max(64).optional(),
    source: z.enum(['user_action', 'manual', 'import', 'official_mark']).optional(),
  }) as z.ZodType<ListImportItem>,
  whitelist: z.object({
    uid: z.number().int().positive(),
    username: z.string().max(64).optional(),
  }) as z.ZodType<ListImportItem>,
};

/**
 * 统一名单导入解析（P1-4）：字节上限、JSON 解析、原型污染剥离、schema 校验。
 * 任一无效条目 → 整体失败（不部分写入）。
 */
export function parseListImport(text: string, kind: ListKind): ListImportResult {
  if (text.length > LIMITS.IMPORT_MAX_BYTES) {
    return { ok: false, error: `文件超过大小上限（${Math.round(LIMITS.IMPORT_MAX_BYTES / 1024)} KB）`, total: 0 };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 解析失败：文件不是有效的 JSON', total: 0 };
  }
  const cleaned = stripDangerousKeys(raw);
  const arr = Array.isArray(cleaned) ? cleaned : [cleaned];
  const schema = LIST_ITEM_SCHEMAS[kind];
  const items: ListImportItem[] = [];
  const invalid: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const parsed = schema.safeParse(arr[i]);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      invalid.push(`第 ${i + 1} 条：${parsed.error.issues[0]?.message ?? '格式无效'}`);
    }
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      total: arr.length,
      error: `名单包含 ${invalid.length} 条无效条目（已拒绝整包导入）：${invalid.slice(0, 3).join('；')}`,
    };
  }
  return { ok: true, items, total: arr.length };
}

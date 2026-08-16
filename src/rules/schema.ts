/**
 * 规则数据结构的 Zod Schema。
 * 用于：导入校验（防原型污染/防超大/防恶意结构）、编辑器表单校验、数据迁移校验。
 *
 * P1-3 条件树限制：最大递归深度、节点总数、每组条件数、每组子组数。
 * P1-5 精确 UID 规则规范化：NOT/OR 一律拒绝；必须恰好一个 UID eq 正整数；
 * 可选条件只能是 isVerifiedMachine eq true；多 UID、isVerifiedMachine=false、
 * 空组、重复冲突条件均拒绝。
 */
import { z } from 'zod';
import type {
  ConditionGroup,
  Rule,
  RuleAction,
  RuleField,
  RuleOperator,
  PageScope,
  ContentType,
  ReportCategory,
} from '../shared/types';
import { LIMITS } from '../shared/constants/defaults';

export const FIELD_VALUES = [
  'uid',
  'username',
  'content',
  'links',
  'linkDomains',
  'contentType',
  'pageScope',
  'isLocalBlocked',
  'isWhitelisted',
  'isVerifiedMachine',
  'hasLinks',
] as const satisfies readonly RuleField[];

export const OPERATOR_VALUES = [
  'eq',
  'ne',
  'contains',
  'not_contains',
  'prefix',
  'suffix',
  'regex',
  'exists',
  'not_exists',
] as const satisfies readonly RuleOperator[];

export const ACTION_VALUES = [
  'flag_suspicious',
  'collapse_content',
  'hide_content',
  'notify_user',
  'suggest_manual_action',
  'local_block_verified_uid',
  'official_block_verified_uid',
  'report_verified_uid_content',
] as const satisfies readonly RuleAction[];

export const PAGE_SCOPE_VALUES = [
  'video_page',
  'dynamic_feed',
  'dynamic_detail',
  'dynamic_comments',
  'other',
] as const satisfies readonly PageScope[];

export const CONTENT_TYPE_VALUES = [
  'video_comment',
  'video_reply',
  'dynamic',
  'dynamic_comment',
] as const satisfies readonly ContentType[];

export const REPORT_CATEGORY_VALUES = ['ad', 'spam', 'fraud', 'other'] as const satisfies readonly ReportCategory[];

export const regexVerificationSchema = z
  .object({
    ok: z.boolean(),
    pattern: z.string().max(LIMITS.CONDITION_VALUE_MAX_LEN),
    sample: z.string().max(LIMITS.TEST_TEXT_MAX_LEN),
    workerAvailable: z.boolean(),
    verifiedAt: z.number().int().nonnegative(),
  })
  .optional();

export const conditionSchema = z.object({
  field: z.enum(FIELD_VALUES),
  operator: z.enum(OPERATOR_VALUES),
  value: z.string().max(LIMITS.CONDITION_VALUE_MAX_LEN).default(''),
  /** P1-7：正则 Worker 验证记录（保存硬门禁） */
  regexVerification: regexVerificationSchema,
});

export type ConditionSchema = z.infer<typeof conditionSchema>;

/** P1-3：条件树深度限制（z.lazy 递归；超过 MAX_CONDITIONS_DEPTH 由上层 .max 拒绝） */
export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(
  () =>
    z
      .object({
        logic: z.enum(['and', 'or', 'not']),
        conditions: z.array(conditionSchema).max(LIMITS.MAX_CONDITIONS_PER_GROUP),
        groups: z.array(conditionGroupSchema).max(LIMITS.MAX_SUBGROUPS_PER_GROUP),
      })
      .refine((g) => g.conditions.length > 0 || g.groups.length > 0, {
        message: '条件组至少需要一个条件或子组',
      }) as unknown as z.ZodType<ConditionGroup>,
);

/** P1-3：全树节点统计与深度校验（防栈溢出与超大树） */
export interface ConditionTreeStats {
  totalConditions: number;
  totalGroups: number;
  maxDepth: number;
}

export function conditionTreeStats(group: ConditionGroup): ConditionTreeStats {
  let totalConditions = 0;
  let totalGroups = 0;
  let maxDepth = 0;
  const walk = (g: ConditionGroup, depth: number): void => {
    totalGroups++;
    totalConditions += g.conditions.length;
    maxDepth = Math.max(maxDepth, depth);
    if (depth > LIMITS.MAX_CONDITIONS_DEPTH) return; // 防御：超过深度上限后不再深入
    for (const sub of g.groups) walk(sub, depth + 1);
  };
  walk(group, 1);
  return { totalConditions, totalGroups, maxDepth };
}

/** P1-3：条件树是否超过总节点数限制 */
export function isTreeOverLimit(group: ConditionGroup): boolean {
  const stats = conditionTreeStats(group);
  return (
    stats.totalConditions > LIMITS.MAX_CONDITIONS_TOTAL ||
    stats.maxDepth > LIMITS.MAX_CONDITIONS_DEPTH
  );
}

export const ruleSchema = z
  .object({
    id: z.string().min(4).max(64).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1).max(64),
    description: z.string().max(200).default(''),
    enabled: z.boolean().default(true),
    priority: z.number().int().min(-1000).max(1000).default(0),
    conditions: conditionGroupSchema,
    pageScope: z.array(z.enum(PAGE_SCOPE_VALUES)).max(10).default([]),
    contentTypes: z.array(z.enum(CONTENT_TYPE_VALUES)).max(10).default([]),
    action: z.enum(ACTION_VALUES),
    reportCategory: z.enum(REPORT_CATEGORY_VALUES).nullable().default(null),
    createdAt: z.number().int().nonnegative().default(0),
    updatedAt: z.number().int().nonnegative().default(0),
    schemaVersion: z.number().int().nonnegative().default(1),
  })
  .strict()
  .refine((r) => !isTreeOverLimit(r.conditions), {
    message: `条件树超过限制（总条件数 ≤ ${LIMITS.MAX_CONDITIONS_TOTAL}，深度 ≤ ${LIMITS.MAX_CONDITIONS_DEPTH}）`,
  });

export type RuleSchema = z.infer<typeof ruleSchema>;

export const rulesArraySchema = z.array(ruleSchema).max(LIMITS.MAX_RULES);

/** 宽松解析：忽略未知字段、补默认值，用于导入容错 */
export function parseRuleLoose(input: unknown): Rule {
  return ruleSchema.parse(input) as Rule;
}

export function parseRulesArrayLoose(input: unknown): Rule[] {
  return rulesArraySchema.parse(input) as Rule[];
}

// ---------------- P1-5：精确 UID 规则规范化 ----------------

export type ExactUidIssue =
  | 'contains_not'
  | 'contains_or'
  | 'multiple_uids'
  | 'uid_missing'
  | 'uid_not_positive_integer'
  | 'is_verified_false'
  | 'empty_group'
  | 'forbidden_field'
  | 'nested_group';

/** 校验结果：null 表示完全合法 */
export function exactUidIssue(rule: Pick<Rule, 'conditions'>): ExactUidIssue | null {
  const root = rule.conditions;
  // 空组拒绝
  if (root.conditions.length === 0 && root.groups.length === 0) return 'empty_group';
  // 嵌套子组一律拒绝（规范化后只能是一层 AND 组）
  if (root.groups.length > 0) return 'nested_group';
  // 根逻辑必须 AND
  if (root.logic !== 'and') return root.logic === 'or' ? 'contains_or' : 'contains_not';

  let uidCount = 0;
  let uidValue: string | null = null;
  for (const c of root.conditions) {
    if (c.field === 'uid') {
      if (c.operator !== 'eq') return 'uid_not_positive_integer';
      const v = c.value.trim();
      if (!/^\d+$/.test(v) || !(Number(v) > 0)) return 'uid_not_positive_integer';
      uidCount++;
      if (uidValue === null) uidValue = v;
      else if (uidValue !== v) return 'multiple_uids';
    } else if (c.field === 'isVerifiedMachine') {
      if (c.operator !== 'eq') return 'is_verified_false';
      if (c.value.trim() !== 'true') return 'is_verified_false';
    } else {
      return 'forbidden_field';
    }
  }
  if (uidCount === 0) return 'uid_missing';
  if (uidCount > 1) return 'multiple_uids';
  return null;
}

/** P1-5：判断一条规则是否为规范化的「精确 UID 规则」 */
export function isExactUidRule(rule: Pick<Rule, 'conditions'>): boolean {
  return exactUidIssue(rule) === null;
}

/** 规范化错误的人类可读说明（UI 用） */
export function exactUidIssueMessage(issue: ExactUidIssue): string {
  switch (issue) {
    case 'contains_not':
      return '官方动作不允许使用 NOT 逻辑';
    case 'contains_or':
      return '官方动作不允许使用 OR 逻辑';
    case 'multiple_uids':
      return '必须恰好存在一个 UID 条件（不能包含多个不同 UID）';
    case 'uid_missing':
      return '必须包含 UID 等于某值的条件';
    case 'uid_not_positive_integer':
      return 'UID 条件必须是等于一个正整数';
    case 'is_verified_false':
      return '可选条件只能是「已确认机器人 = 是」';
    case 'empty_group':
      return '条件组不能为空';
    case 'forbidden_field':
      return '官方动作只允许 UID 与「已确认机器人」字段条件';
    case 'nested_group':
      return '官方动作不允许嵌套条件组';
  }
}

/** 空条件（全匹配）：当条件组只有一个空 and 时按匹配处理 */
export function isEmptyConditions(group: ConditionGroup): boolean {
  return group.conditions.length === 0 && group.groups.length === 0;
}

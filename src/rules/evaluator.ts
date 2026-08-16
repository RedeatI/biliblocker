/**
 * 条件求值器：把 ContentContext 映射为可比较字段，再对条件组（and/or/not 递归）求值。
 * 纯函数，无 DOM 依赖，可直接单元测试。
 *
 * P1-3：
 * - 运行时只接受通过 RegexSafety.validate() 的正则；未通过视为规则错误（抛出 →
 *   由 engine 的 onRuleError 禁用该规则），绝不直接执行未经校验的正则。
 * - 递归带深度防护（MAX_EVAL_DEPTH），防止恶意深层条件树导致栈溢出。
 *
 * P0-1（v0.1.2）：带因果路径的求值（MatchTrace）。
 * - evaluateConditionWithTrace / evaluateGroupWithTrace / evaluateRuleWithTrace
 *   返回结构化结果：哪个叶子真正对最终 true 有贡献。
 * - AND true：收集所有实际为 true 且有贡献的叶子。
 * - OR true：只收集实际命中的分支，绝不收集未命中分支。
 * - NOT true：NOT 内部叶子不得成为正向内容违规证据。
 * - 反向运算符（ne / not_contains / not_exists）的叶子 positivePolarity=false，
 *   永远 contributedToTrue=false，不得作为可举报内容证据。
 */
import type { Condition, ConditionGroup, ContentContext, RuleField, RuleOperator } from '../shared/types';
import { RegexSafety } from './safety';

/** 求值递归深度上限（超限返回 false，防止栈溢出） */
const MAX_EVAL_DEPTH = 64;

/** 单个匹配叶子的因果信息（P0-1） */
export interface MatchedLeaf {
  /** 条件树内路径，如 conditions[0] / groups[0].conditions[1] */
  path: string;
  field: RuleField;
  operator: RuleOperator;
  /** 运算符是否正向（eq/contains/prefix/suffix/regex/exists 正向；ne/not_contains/not_exists 反向） */
  positivePolarity: boolean;
  /** 该叶子是否真正对最终 true 有贡献（位于正极性上下文且实际命中） */
  contributedToTrue: boolean;
}

/** 结构化求值结果（P0-1） */
export interface MatchTrace {
  matched: boolean;
  /** 对最终 true 有正向贡献的叶子（NOT 内部/反向运算符/未命中分支均不在此列） */
  contributingLeaves: MatchedLeaf[];
}

/** 字段值提取；null 表示字段无值（用于 exists/not_exists） */
export function getFieldValue(ctx: ContentContext, field: RuleField): string | null {
  switch (field) {
    case 'uid':
      return ctx.uid !== null ? String(ctx.uid) : null;
    case 'username':
      return ctx.username;
    case 'content':
      return ctx.text || null;
    case 'links':
      return ctx.links.length > 0 ? ctx.links.join('\n') : null;
    case 'linkDomains':
      return ctx.linkDomains.length > 0 ? ctx.linkDomains.join('\n') : null;
    case 'contentType':
      return ctx.contentType;
    case 'pageScope':
      return ctx.pageScope;
    case 'isLocalBlocked':
      return ctx.isLocalBlocked ? 'true' : 'false';
    case 'isWhitelisted':
      return ctx.isWhitelisted ? 'true' : 'false';
    case 'isVerifiedMachine':
      return ctx.isVerifiedMachine ? 'true' : 'false';
    case 'hasLinks':
      return ctx.hasLinks ? 'true' : 'false';
    default:
      return null;
  }
}

function compareValues(actual: string, op: Condition['operator'], expected: string): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'contains':
      return actual.toLowerCase().includes(expected.toLowerCase());
    case 'not_contains':
      return !actual.toLowerCase().includes(expected.toLowerCase());
    case 'prefix':
      return actual.toLowerCase().startsWith(expected.toLowerCase());
    case 'suffix':
      return actual.toLowerCase().endsWith(expected.toLowerCase());
    case 'regex': {
      // P1-3：运行时只接受通过 RegexSafety.validate() 的正则；未通过抛错 → 规则被禁用
      const validated = RegexSafety.validate(expected);
      if (!validated.ok) {
        throw new Error(`正则未通过安全校验：${validated.error}`);
      }
      return RegexSafety.compile(RegexSafety.truncateInput(expected)).test(
        RegexSafety.truncateInput(actual),
      );
    }
    default:
      return false;
  }
}

export function evaluateCondition(ctx: ContentContext, cond: Condition): boolean {
  const actual = getFieldValue(ctx, cond.field);
  if (cond.operator === 'exists') {
    return actual !== null && actual.length > 0;
  }
  if (cond.operator === 'not_exists') {
    return actual === null || actual.length === 0;
  }
  if (actual === null) return false;
  return compareValues(actual, cond.operator, cond.value);
}

export function evaluateGroup(ctx: ContentContext, group: ConditionGroup): boolean {
  return evaluateGroupDepth(ctx, group, 0);
}

function evaluateGroupDepth(ctx: ContentContext, group: ConditionGroup, depth: number): boolean {
  // 深度防护：超限返回 false（不抛栈溢出）
  if (depth > MAX_EVAL_DEPTH) return false;
  if (group.conditions.length === 0 && group.groups.length === 0) {
    // 空组：视为恒真（全匹配），与 schema 校验保持兼容
    return true;
  }
  const conditionResults = group.conditions.map((c) => evaluateCondition(ctx, c));
  const groupResults = group.groups.map((g) => evaluateGroupDepth(ctx, g, depth + 1));
  const all = [...conditionResults, ...groupResults];

  switch (group.logic) {
    case 'and':
      return all.every((r) => r);
    case 'or':
      return all.some((r) => r);
    case 'not':
      // NOT 对唯一子项取反；多个子项时对全部结果取反
      return !all.every((r) => r);
    default:
      return false;
  }
}

// ---------------- P0-1：带因果路径的求值 ----------------

/** 运算符是否正向（反向运算符不得作为可举报内容证据） */
function isPositiveOperator(op: RuleOperator): boolean {
  return op !== 'ne' && op !== 'not_contains' && op !== 'not_exists';
}

/** 单条件带 trace 求值 */
export function evaluateConditionWithTrace(
  ctx: ContentContext,
  cond: Condition,
  path: string,
): { matched: boolean; leaf: MatchedLeaf } {
  const actual = getFieldValue(ctx, cond.field);
  let matched: boolean;
  if (cond.operator === 'exists') {
    matched = actual !== null && actual.length > 0;
  } else if (cond.operator === 'not_exists') {
    matched = actual === null || actual.length === 0;
  } else if (actual === null) {
    matched = false;
  } else {
    matched = compareValues(actual, cond.operator, cond.value);
  }
  const positivePolarity = isPositiveOperator(cond.operator);
  return {
    matched,
    leaf: {
      path,
      field: cond.field,
      operator: cond.operator,
      positivePolarity,
      // 只有正向运算符且实际命中才对最终 true 有贡献
      contributedToTrue: matched && positivePolarity,
    },
  };
}

/** 条件组带 trace 求值（P0-1 语义见文件头） */
export function evaluateGroupWithTrace(
  ctx: ContentContext,
  group: ConditionGroup,
  depth = 0,
  path = 'conditions',
): MatchTrace {
  if (depth > MAX_EVAL_DEPTH) return { matched: false, contributingLeaves: [] };
  if (group.conditions.length === 0 && group.groups.length === 0) {
    return { matched: true, contributingLeaves: [] };
  }
  const condResults = group.conditions.map((c, i) =>
    evaluateConditionWithTrace(ctx, c, `${path}.conditions[${i}]`),
  );
  const groupResults = group.groups.map((g, i) =>
    evaluateGroupWithTrace(ctx, g, depth + 1, `${path}.groups[${i}]`),
  );

  switch (group.logic) {
    case 'and': {
      // 全部子项为 true 才 true；收集所有 true 且有贡献的叶子
      const allMatched = [...condResults, ...groupResults].every((r) => r.matched);
      if (!allMatched) return { matched: false, contributingLeaves: [] };
      return {
        matched: true,
        contributingLeaves: [
          ...condResults.map((r) => r.leaf),
          ...groupResults.flatMap((r) => r.contributingLeaves),
        ].filter((l) => l.contributedToTrue),
      };
    }
    case 'or': {
      // 任一子项为 true；只收集实际命中分支的叶子，绝不收集未命中分支
      const matchedChildren = [...condResults, ...groupResults].filter((r) => r.matched);
      if (matchedChildren.length === 0) return { matched: false, contributingLeaves: [] };
      return {
        matched: true,
        contributingLeaves: [
          ...condResults.filter((r) => r.matched).map((r) => r.leaf),
          ...groupResults.filter((r) => r.matched).flatMap((r) => r.contributingLeaves),
        ].filter((l) => l.contributedToTrue),
      };
    }
    case 'not': {
      // NOT 为 true：内部叶子不得成为正向内容违规证据（contributingLeaves 恒为空）
      const all = [...condResults, ...groupResults].map((r) => r.matched);
      return { matched: !all.every((r) => r), contributingLeaves: [] };
    }
    default:
      return { matched: false, contributingLeaves: [] };
  }
}

/**
 * 整条规则带 trace 求值（P0-1）。
 * 与 evaluateRule 相同的范围/白名单/本人保护前置检查，但返回因果路径。
 * 不执行动作权限校验（权限由 engine/policy 层负责；本函数供证据构建消费）。
 */
export function evaluateRuleWithTrace(
  ctx: ContentContext,
  rule: { enabled: boolean; pageScope: string[]; contentTypes: string[]; conditions: ConditionGroup },
): MatchTrace {
  if (!rule.enabled) return { matched: false, contributingLeaves: [] };
  if (rule.pageScope.length > 0 && !rule.pageScope.includes(ctx.pageScope)) {
    return { matched: false, contributingLeaves: [] };
  }
  if (rule.contentTypes.length > 0 && !rule.contentTypes.includes(ctx.contentType)) {
    return { matched: false, contributingLeaves: [] };
  }
  if (ctx.isWhitelisted) return { matched: false, contributingLeaves: [] };
  try {
    return evaluateGroupWithTrace(ctx, rule.conditions, 0, 'conditions');
  } catch {
    return { matched: false, contributingLeaves: [] };
  }
}

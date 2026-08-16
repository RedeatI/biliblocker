/**
 * 规则引擎：按优先级执行规则，并在执行前做动作权限校验。
 *
 * 安全不变量（必须在 engine 与 policy 双层保证）：
 * - 白名单优先级高于一切普通规则。
 * - 当前登录用户本人永不被隐藏/拉黑/举报。
 * - 任何基于正文/用户名/链接/正则的规则，只能获得疑似类动作；
 *   官方动作（local_block_verified_uid / official_block_verified_uid /
 *   report_verified_uid_content）仅允许「精确 UID 规则」且 UID 在已确认机器人名单时获得。
 * - 疑似状态绝不触发官方拉黑/举报。
 */
import type {
  ContentContext,
  EngineDecision,
  Rule,
} from '../shared/types';
import { OFFICIAL_ACTIONS } from '../shared/types';
import { evaluateGroup } from './evaluator';
import { isExactUidRule } from './schema';

export interface EnginePolicyState {
  /** 当前登录用户 UID；规则不得作用于本人 */
  currentMid: number | null;
  /** 是否允许官方动作（名单已确认且为精确 UID 规则时由 engine 自动判定） */
}

export interface RuleEngineOptions {
  currentMid: number | null;
  /** 规则出错时回调（例如正则编译失败 → 禁用该规则并记录） */
  onRuleError?: (rule: Rule, error: Error) => void;
}

export class RuleEngine {
  private currentMid: number | null;

  constructor(private readonly options: RuleEngineOptions) {
    this.currentMid = options.currentMid ?? null;
  }

  /** 登录用户变化时更新（SPA 切换/登录恢复） */
  setCurrentMid(mid: number | null): void {
    this.currentMid = mid;
  }

  /** 动作权限校验：疑似规则可任意；官方动作需精确 UID 规则 + 已确认 */
  static isActionAllowed(rule: Rule, ctx: ContentContext): boolean {
    if (OFFICIAL_ACTIONS.includes(rule.action)) {
      if (ctx.uid === null) return false;
      if (!ctx.isVerifiedMachine) return false;
      if (!isExactUidRule(rule)) return false;
      if (rule.action === 'report_verified_uid_content' && rule.reportCategory === null) {
        // 举报类官方动作要求规则带有可举报类别（内容违规依据）
        return false;
      }
      return true;
    }
    return true;
  }

  /** 对单条规则求值（含作用域过滤与权限校验） */
  evaluateRule(ctx: ContentContext, rule: Rule): boolean {
    if (!rule.enabled) return false;
    // 页面范围 / 内容类型过滤（空数组 = 全部）
    if (rule.pageScope.length > 0 && !rule.pageScope.includes(ctx.pageScope)) return false;
    if (rule.contentTypes.length > 0 && !rule.contentTypes.includes(ctx.contentType)) return false;
    // 白名单与当前用户保护：engine 层硬性短路（policy 层再兜底一次）
    if (ctx.isWhitelisted) return false;
    if (ctx.uid !== null && this.currentMid !== null && ctx.uid === this.currentMid) {
      return false;
    }
    let matched = false;
    try {
      matched = evaluateGroup(ctx, rule.conditions);
    } catch (e) {
      this.options.onRuleError?.(rule, e instanceof Error ? e : new Error(String(e)));
      return false;
    }
    if (!matched) return false;
    // 动作权限校验：不允许的动作直接不生效（不隐藏、不标记）
    return RuleEngine.isActionAllowed(rule, ctx);
  }

  /** 全量求值：按优先级降序取最高优先级动作，notify/suggest 可叠加 */
  evaluate(ctx: ContentContext, rules: Rule[]): EngineDecision {
    const decision: EngineDecision = {
      hide: false,
      collapse: false,
      flag: false,
      notify: false,
      suggestManual: false,
      localBlock: false,
      matchedRules: [],
    };

    // 白名单 / 当前用户 硬性短路
    if (ctx.isWhitelisted) return decision;
    if (ctx.uid !== null && this.currentMid !== null && ctx.uid === this.currentMid) {
      return decision;
    }

    const matched: Rule[] = [];
    for (const rule of rules) {
      if (this.evaluateRule(ctx, rule)) matched.push(rule);
    }
    if (matched.length === 0) return decision;

    // 按优先级降序排序（数值大优先）；同优先级按创建时间新者优先
    matched.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt);
    decision.matchedRules = matched;

    const top = matched[0]!;
    decision.localBlock = top.action === 'local_block_verified_uid';
    switch (top.action) {
      case 'hide_content':
        decision.hide = true;
        break;
      case 'collapse_content':
        decision.collapse = true;
        break;
      case 'flag_suspicious':
        decision.flag = true;
        break;
      case 'notify_user':
        decision.notify = true;
        break;
      case 'suggest_manual_action':
        decision.suggestManual = true;
        break;
      case 'local_block_verified_uid':
      case 'official_block_verified_uid':
      case 'report_verified_uid_content':
        // 官方动作由 ActionPolicyEngine 单独编排，这里不直接执行
        decision.flag = true;
        break;
    }
    // notify/suggest 来自任意命中的规则均可叠加
    decision.notify = decision.notify || matched.some((r) => r.action === 'notify_user');
    decision.suggestManual =
      decision.suggestManual || matched.some((r) => r.action === 'suggest_manual_action');

    return decision;
  }

  /** 汇总命中规则名（UI 展示用） */
  static matchedRuleNames(decision: EngineDecision): string[] {
    return decision.matchedRules.map((r) => r.name);
  }

  /** 判断命中规则中是否存在「可举报内容」（reportCategory 非空），供自动举报内容条件使用 */
  static hasReportableContent(decision: EngineDecision): boolean {
    return decision.matchedRules.some((r) => r.reportCategory !== null && r.reportCategory !== 'other');
  }
}

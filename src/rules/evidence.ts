/**
 * 规则动作执行链的证据模型（P0-3）与动作计划矩阵（P0-2，v0.1.2）。
 *
 * 硬性不变量：
 * - UID / isVerifiedMachine / pageScope / contentType / username 单独命中
 *   不得构成内容违规证据。
 * - 举报必须同时拥有「账号授权证据」与「独立内容违规证据」；
 *   用户本次点击可以同时提供显式确认（user_confirmation），自动流程不能。
 * - reportCategory 标签本身不得冒充当前内容证据。
 *
 * P0-1（v0.1.2）：buildEvidence() 只消费 MatchTrace（evaluateRuleWithTrace 的
 * contributingLeaves），绝不再次遍历整棵条件树猜测证据。OR 未命中分支、NOT 内部
 * 叶子、反向运算符（ne/not_contains/not_exists）均不会产生内容证据。
 *
 * P0-2（v0.1.2）：ActionExecutionPlan 固定动作矩阵（本地/确认/官方拉黑/举报副作用
 * 完全独立，单一映射函数 mapActionMatrix，禁止 block: official||local 混写）。
 */
import type { ContentContext, Rule, RuleAction } from '../shared/types';
import { evaluateRuleWithTrace } from './evaluator';

/** 内容违规证据允许的字段（username 等账号字段不构成内容违规） */
export const CONTENT_EVIDENCE_FIELDS = ['content', 'links', 'linkDomains', 'hasLinks'] as const;
export type ContentEvidenceField = (typeof CONTENT_EVIDENCE_FIELDS)[number];

export interface RuleEvidence {
  accountAuthorization: Array<{ ruleId: string; kind: 'exact_uid' | 'user_confirmation' }>;
  contentViolation: Array<{
    ruleId: string;
    category: 'ad' | 'spam' | 'fraud';
    fields: ContentEvidenceField[];
  }>;
}

export const EMPTY_EVIDENCE: RuleEvidence = {
  accountAuthorization: [],
  contentViolation: [],
};

/**
 * P0-2：动作执行计划（副作用矩阵）。
 * - commitLocalBlock：写入本地黑名单（bb.blocked）
 * - commitVerified：写入已确认机器人名单（bb.verified）
 * - enqueueOfficialBlock：入队官方拉黑任务（需要登录）
 * - enqueueReport：入队举报任务（需要登录 + 双重证据）
 * 禁止用「block: officialBlock || localBlock」混写本地与官方副作用。
 */
export interface ActionExecutionPlan {
  fold: boolean;
  commitLocalBlock: boolean;
  commitVerified: boolean;
  enqueueOfficialBlock: boolean;
  enqueueReport: boolean;
  source: 'one_click' | 'auto_process' | 'manual';
  evidence: RuleEvidence;
}

/** 兼容旧字段的视图（collapse/hide/localBlock/officialBlock/report 由矩阵派生） */
export interface ActionPlan {
  collapse: boolean;
  hide: boolean;
  localBlock: boolean;
  officialBlock: boolean;
  report: boolean;
  evidence: RuleEvidence;
}

/** 官方拉黑但不举报时，本地/确认名单提交的明确常量（默认不写） */
export interface OfficialBlockSideEffects {
  commitLocalBlock: boolean;
  commitVerified: boolean;
}

export const DEFAULT_OFFICIAL_BLOCK_SIDE_EFFECTS: OfficialBlockSideEffects = {
  commitLocalBlock: false,
  commitVerified: false,
};

/**
 * 官方拉黑但不举报（用户手动触发）：本地黑名单同步写入，
 * 但不隐式加入已确认机器人名单（P0-2 明确常量）。
 */
export const BLOCK_ONLY_SIDE_EFFECTS: OfficialBlockSideEffects = {
  commitLocalBlock: true,
  commitVerified: false,
};

/** 动作矩阵输入（P0-2：来源/动作 → 副作用） */
export type MatrixAction =
  | RuleAction
  | 'one_click_block_report'
  | 'hide_only';

/**
 * P0-2：动作矩阵单一映射函数。
 * | 来源/动作                    | Local | Verified | Official | Report |
 * | local_block_verified_uid    | ✅    | ❌        | ❌       | ❌      |
 * | official_block_verified_uid | 常量  | 常量      | ✅       | ❌      |
 * | report_verified_uid_content | ❌    | ❌        | ❌       | ✅      |
 * | 一键拉黑并举报               | ✅    | ✅        | ✅       | ✅      |
 * | 仅隐藏                       | ❌    | ❌        | ❌       | ❌      |
 */
export function mapActionMatrix(
  action: MatrixAction,
  officialSideEffects: OfficialBlockSideEffects = DEFAULT_OFFICIAL_BLOCK_SIDE_EFFECTS,
): Pick<ActionExecutionPlan, 'commitLocalBlock' | 'commitVerified' | 'enqueueOfficialBlock' | 'enqueueReport'> {
  switch (action) {
    case 'local_block_verified_uid':
      return { commitLocalBlock: true, commitVerified: false, enqueueOfficialBlock: false, enqueueReport: false };
    case 'official_block_verified_uid':
      // 官方拉黑但不举报：本地/确认由明确常量决定，不得隐式加入
      return { ...officialSideEffects, enqueueOfficialBlock: true, enqueueReport: false };
    case 'report_verified_uid_content':
      return { commitLocalBlock: false, commitVerified: false, enqueueOfficialBlock: false, enqueueReport: true };
    case 'one_click_block_report':
      return { commitLocalBlock: true, commitVerified: true, enqueueOfficialBlock: true, enqueueReport: true };
    case 'hide_only':
      return { commitLocalBlock: false, commitVerified: false, enqueueOfficialBlock: false, enqueueReport: false };
    default:
      // flag_suspicious / collapse_content / hide_content / notify_user / suggest_manual_action
      return { commitLocalBlock: false, commitVerified: false, enqueueOfficialBlock: false, enqueueReport: false };
  }
}

/** 判断规则条件是否为「UID eq <给定值>」的精确匹配（含可选 isVerifiedMachine eq true） */
export function isExactUidMatch(rule: Pick<Rule, 'conditions'>, uid: number): boolean {
  const { conditions, groups } = rule.conditions;
  if (groups.length > 0) return false;
  if (conditions.length === 0) return false;
  let hasUidEq = false;
  for (const c of conditions) {
    if (c.field === 'uid') {
      if (c.operator !== 'eq') return false;
      if (c.value.trim() !== String(uid)) return false;
      hasUidEq = true;
    } else if (c.field === 'isVerifiedMachine') {
      if (c.operator !== 'eq' || c.value.trim() !== 'true') return false;
    } else {
      return false;
    }
  }
  return hasUidEq;
}

/**
 * 由命中规则构建证据（P0-1：只消费 MatchTrace）。
 * @param matchedRules 已按优先级降序排列的命中规则
 * @param ctx 内容上下文
 */
export function buildEvidence(matchedRules: Rule[], ctx: ContentContext): RuleEvidence {
  const evidence: RuleEvidence = { accountAuthorization: [], contentViolation: [] };
  for (const rule of matchedRules) {
    if (!rule.enabled) continue;
    // 账号授权证据：精确 UID 规则 且 UID 在已确认机器人名单
    if (
      rule.action.startsWith('local_block') ||
      rule.action.startsWith('official_block') ||
      rule.action === 'report_verified_uid_content'
    ) {
      if (ctx.isVerifiedMachine && ctx.uid !== null && isExactUidMatch(rule, ctx.uid)) {
        evidence.accountAuthorization.push({ ruleId: rule.id, kind: 'exact_uid' });
      }
    }
    // 内容违规证据：只消费 MatchTrace 的 contributingLeaves（正向命中因果路径）
    if (rule.reportCategory !== null && rule.reportCategory !== 'other') {
      const trace = evaluateRuleWithTrace(ctx, rule);
      if (trace.matched) {
        const fields = new Set<ContentEvidenceField>();
        for (const leaf of trace.contributingLeaves) {
          // 双保险：只有正向极性且有贡献的内容字段才成为证据
          if (
            leaf.contributedToTrue &&
            leaf.positivePolarity &&
            (CONTENT_EVIDENCE_FIELDS as readonly string[]).includes(leaf.field)
          ) {
            fields.add(leaf.field as ContentEvidenceField);
          }
        }
        if (fields.size > 0) {
          evidence.contentViolation.push({
            ruleId: rule.id,
            category: rule.reportCategory,
            fields: [...fields],
          });
        }
      }
    }
  }
  return evidence;
}

/** 判定命中规则对应的矩阵动作（P0-2） */
export function deriveMatrixAction(
  decision: { collapse: boolean; hide: boolean; localBlock: boolean; matchedRules: Rule[] },
  userConfirmed: boolean,
): MatrixAction {
  const top = decision.matchedRules[0];
  // 一键拉黑并举报：用户确认且引擎判定本地拉黑意图
  if (userConfirmed && (decision.localBlock || top?.action === 'local_block_verified_uid')) {
    return 'one_click_block_report';
  }
  if (top === undefined) return 'hide_only';
  switch (top.action) {
    case 'local_block_verified_uid':
      return 'local_block_verified_uid';
    case 'official_block_verified_uid':
      return 'official_block_verified_uid';
    case 'report_verified_uid_content':
      return 'report_verified_uid_content';
    default:
      // 仅隐藏 / 折叠 / 标记 / 通知等疑似动作：不产生任何名单/官方副作用
      return 'hide_only';
  }
}

/**
 * 构建动作执行计划（P0-2）。
 * @param decision 引擎决策（含 matchedRules 与折叠/隐藏等）
 * @param ctx 内容上下文
 * @param opts.userConfirmed 用户本次点击是否显式确认（可为账号+内容双重证据）
 * @param opts.source 动作来源（默认 auto_process）
 * @param opts.officialSideEffects 官方拉黑但不举报时本地/确认名单的明确常量（默认不写）
 */
export function buildActionExecutionPlan(
  decision: { collapse: boolean; hide: boolean; localBlock: boolean; matchedRules: Rule[] },
  ctx: ContentContext,
  opts: {
    userConfirmed: boolean;
    source?: 'one_click' | 'auto_process' | 'manual';
    officialSideEffects?: OfficialBlockSideEffects;
  },
): ActionExecutionPlan {
  const evidence = buildEvidence(decision.matchedRules, ctx);
  if (opts.userConfirmed) {
    // 用户本次点击的显式确认：同时提供账号与内容证据（防止自动流程冒充）
    evidence.accountAuthorization.push({
      ruleId: 'user_confirmation',
      kind: 'user_confirmation',
    });
    evidence.contentViolation.push({
      ruleId: 'user_confirmation',
      category: 'ad',
      fields: ['content'],
    });
  }

  const action = deriveMatrixAction(decision, opts.userConfirmed);
  const matrix = mapActionMatrix(action, opts.officialSideEffects);
  const { commitLocalBlock, commitVerified, enqueueOfficialBlock: enqueueOfficialBlockRaw, enqueueReport: enqueueReportRaw } = matrix;
  let enqueueOfficialBlock = enqueueOfficialBlockRaw;
  let enqueueReport = enqueueReportRaw;

  // 官方动作硬性条件：
  // - enqueueOfficialBlock：需要账号授权证据（exact_uid 或用户确认）
  // - enqueueReport：需要账号授权证据 + 独立内容违规证据（自动流程不含 user_confirmation 时必须有 exact_uid + contentViolation）
  const hasAccount = evidence.accountAuthorization.length > 0;
  if (enqueueOfficialBlock && !hasAccount) enqueueOfficialBlock = false;
  if (enqueueReport) {
    const contentEvidence =
      evidence.contentViolation.some((e) => e.ruleId !== 'user_confirmation') || opts.userConfirmed;
    if (!hasAccount || !contentEvidence) enqueueReport = false;
  }

  return {
    fold: decision.collapse,
    commitLocalBlock,
    commitVerified,
    enqueueOfficialBlock,
    enqueueReport,
    source: opts.source ?? 'auto_process',
    evidence,
  };
}

/**
 * 兼容旧签名：构建动作计划视图（字段由 ActionExecutionPlan 矩阵派生）。
 * 新增的矩阵字段（commitLocalBlock/commitVerified/enqueueOfficialBlock/enqueueReport）
 * 同时暴露，供 runActionFlow 直接消费。
 */
export function buildActionPlan(
  decision: { collapse: boolean; hide: boolean; localBlock: boolean; matchedRules: Rule[] },
  ctx: ContentContext,
  opts: { userConfirmed: boolean; source?: 'one_click' | 'auto_process' | 'manual' },
): ActionPlan & Pick<ActionExecutionPlan, 'commitLocalBlock' | 'commitVerified' | 'enqueueOfficialBlock' | 'enqueueReport' | 'fold' | 'source'> {
  const plan = buildActionExecutionPlan(decision, ctx, opts);
  return {
    collapse: decision.collapse,
    hide: decision.hide,
    localBlock: plan.commitLocalBlock,
    officialBlock: plan.enqueueOfficialBlock,
    report: plan.enqueueReport,
    evidence: plan.evidence,
    fold: plan.fold,
    commitLocalBlock: plan.commitLocalBlock,
    commitVerified: plan.commitVerified,
    enqueueOfficialBlock: plan.enqueueOfficialBlock,
    enqueueReport: plan.enqueueReport,
    source: plan.source,
  };
}

/** 规则条件树中是否命中内容证据字段（静态检查，仅供 UI/导入提示；证据构建请用 buildEvidence） */
export function ruleContentFields(rule: Pick<Rule, 'conditions'>): ContentEvidenceField[] {
  const found = new Set<ContentEvidenceField>();
  const walk = (conds: readonly { field: string }[], groups: readonly { conditions: readonly { field: string }[]; groups: readonly unknown[] }[]): void => {
    for (const c of conds) {
      if ((CONTENT_EVIDENCE_FIELDS as readonly string[]).includes(c.field)) {
        found.add(c.field as ContentEvidenceField);
      }
    }
    for (const g of groups) walk(g.conditions, g.groups as never);
  };
  walk(rule.conditions.conditions, rule.conditions.groups as never);
  return [...found];
}

/** 规则是否命中内容证据字段（静态检查；是否真正构成证据由 MatchTrace 决定） */
export function hasContentEvidenceCondition(rule: Pick<Rule, 'conditions'>): boolean {
  return ruleContentFields(rule).length > 0;
}

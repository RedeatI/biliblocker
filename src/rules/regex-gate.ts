/**
 * P1-7（v0.1.2）：正则 Worker 保存硬门禁。
 *
 * 语义：
 * - 每个 regex 条件行必须保存 Worker 验证状态（regexVerification）与被验证的
 *   exact pattern / 样例版本；
 * - pattern、样例或条件（operator/field）变化后状态失效；
 * - Worker 超时/失败/不可用时，不能保存「启用状态」的 regex 规则；
 * - 无 Worker 环境不得显示「已通过 Worker」；
 * - 可以保存为 disabled 草稿，但必须明确标注未通过 Worker 验证。
 */
import type { Condition, ConditionGroup, RegexVerification } from '../shared/types';

/** 校验当前验证记录是否仍有效（pattern/样例/条件未变化且 Worker 通过） */
export function isRegexVerificationValid(
  condition: Condition,
  verification: RegexVerification,
  opts: { currentSample?: string } = {},
): boolean {
  if (!verification.ok) return false;
  if (!verification.workerAvailable) return false; // 无 Worker 不算通过
  if (verification.pattern !== condition.value) return false; // pattern 变化 → 失效
  if (opts.currentSample !== undefined && verification.sample !== opts.currentSample) {
    return false; // 样例变化 → 失效
  }
  return true;
}

/** 收集条件树中全部 regex 条件（含嵌套组） */
export function collectRegexConditions(group: ConditionGroup): Array<{ condition: Condition; path: string }> {
  const out: Array<{ condition: Condition; path: string }> = [];
  const walk = (g: ConditionGroup, path: string): void => {
    g.conditions.forEach((c, i) => {
      if (c.operator === 'regex') out.push({ condition: c, path: `${path}.conditions[${i}]` });
    });
    g.groups.forEach((sub, i) => walk(sub, `${path}.groups[${i}]`));
  };
  walk(group, 'conditions');
  return out;
}

export interface RegexSaveGateResult {
  canSaveEnabled: boolean;
  /** 未通过时的原因（用于 UI 提示） */
  reason?: string;
  /** 未验证的 regex 行路径列表 */
  unverified: Array<{ path: string; reason: string }>;
}

/**
 * 保存门禁：
 * - enabled=true 且含 regex 条件 → 每个 regex 条件都必须有有效 Worker 验证，否则拒绝；
 * - enabled=false → 允许保存为草稿（不强制验证），但调用方必须明确标注。
 */
export function regexSaveGate(
  group: ConditionGroup,
  opts: { enabled: boolean; currentSample?: string },
): RegexSaveGateResult {
  const regexRows = collectRegexConditions(group);
  const unverified: Array<{ path: string; reason: string }> = [];
  for (const { condition, path } of regexRows) {
    const v = condition.regexVerification;
    if (!v) {
      unverified.push({ path, reason: '未经过 Worker 验证（请先点击「验证」并通过时间预算测试）' });
      continue;
    }
    if (!v.workerAvailable) {
      unverified.push({ path, reason: '当前环境无 Worker，无法通过时间预算验证' });
      continue;
    }
    if (!v.ok) {
      unverified.push({ path, reason: 'Worker 验证失败（超时/正则执行错误）' });
      continue;
    }
    if (v.pattern !== condition.value) {
      unverified.push({ path, reason: '正则表达式已修改，验证状态失效，请重新验证' });
      continue;
    }
    if (opts.currentSample !== undefined && v.sample !== opts.currentSample) {
      unverified.push({ path, reason: '样例已变化，验证状态失效，请重新验证' });
    }
  }
  if (unverified.length === 0) return { canSaveEnabled: true, unverified: [] };
  if (!opts.enabled) {
    // disabled 草稿：允许保存，但必须标注
    return {
      canSaveEnabled: true,
      reason: '规则处于禁用状态，允许保存为草稿；启用前必须通过正则 Worker 验证',
      unverified,
    };
  }
  return {
    canSaveEnabled: false,
    reason: `存在未通过正则 Worker 验证的条件（${unverified.length} 处），不能保存为启用状态：${unverified.map((u) => u.reason).join('；')}`,
    unverified,
  };
}

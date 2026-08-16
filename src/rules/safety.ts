/**
 * 正则安全层。
 *
 * 威胁：灾难性回溯（ReDoS）导致页面卡死。
 * 防护（多层）：
 * 1. 模式长度限制（LIMITS.REGEX_MAX_LEN）。
 * 2. 启发式拒绝高风险结构：嵌套量词、重叠量词组合（如 (a+)+、(a*)*、a+a+ 尾连等）。
 * 3. 编译期 try/catch，语法错误规则将被禁用（engine 层处理）。
 * 4. 测试文本长度限制（LIMITS.TEST_TEXT_MAX_LEN）。
 * 5. 设置页通过独立 Worker（public/workers/regex-tester.js）做时间预算测试，
 *    超时即判为「存在性能风险」并要求用户修改。
 */
import { LIMITS } from '../shared/constants/defaults';

export interface RegexValidationResult {
  ok: boolean;
  error?: string;
  riskLevel: 'safe' | 'risky' | 'invalid';
}

/** 高风险结构启发式：嵌套/重叠量词 */
const RISKY_PATTERNS: RegExp[] = [
  // (a+)+ / (a*)* / (a?)? 嵌套量词（组内量词 + 组后量词）
  /\((?:[^()\\]|\\.)*[*+?][^()]*\)[*+?]/,
  // ((a|b)+)* 双层嵌套：外层组内含被量词修饰的内层组
  /\([^()]*\([^()]*\)[*+?][^()]*\)[*+?]/,
  // 重叠量词如 a++、a*? 合法但 a** / a*+ 非法；连续量词风险
  /(?:[*+?]){2,}/,
];

const MAX_BRANCHES = 32;

function countBranches(pattern: string): number {
  let branches = 0;
  let depth = 0;
  let inClass = false;
  let escaped = false;
  for (const ch of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '|' && depth <= 1) branches++;
  }
  return branches;
}

/** 统计量词数量与最大组嵌套深度（用于多层回溯风险判定） */
function analyzePattern(pattern: string): { quantifiers: number; maxDepth: number } {
  let quantifiers = 0;
  let nestedDepth = 0;
  let maxDepth = 0;
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      nestedDepth++;
      maxDepth = Math.max(maxDepth, nestedDepth);
    } else if (ch === ')') {
      nestedDepth = Math.max(0, nestedDepth - 1);
    } else if (ch === '*' || ch === '+' || ch === '?') {
      quantifiers++;
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close > 0) {
        quantifiers++;
        i = close;
      }
    }
  }
  return { quantifiers, maxDepth };
}

function countQuantifiers(pattern: string): number {
  return analyzePattern(pattern).quantifiers;
}

function maxGroupDepth(pattern: string): number {
  return analyzePattern(pattern).maxDepth;
}

/** 量化组内的「可回溯宽度」：粗略估算状态数，超过阈值判风险 */
function backtrackingWidth(pattern: string): number {
  const { quantifiers, maxDepth } = analyzePattern(pattern);
  return quantifiers * Math.max(1, maxDepth);
}

const WIDTH_THRESHOLD = 24;

export class RegexSafety {
  /** 校验并编译；ok=false 时 error 说明原因 */
  static validate(pattern: string): RegexValidationResult {
    if (!pattern || pattern.trim().length === 0) {
      return { ok: false, error: '正则表达式不能为空', riskLevel: 'invalid' };
    }
    if (pattern.length > LIMITS.REGEX_MAX_LEN) {
      return {
        ok: false,
        error: `正则长度超过上限（${LIMITS.REGEX_MAX_LEN} 字符）`,
        riskLevel: 'invalid',
      };
    }
    for (const risky of RISKY_PATTERNS) {
      if (risky.test(pattern)) {
        return {
          ok: false,
          error: '检测到嵌套量词或重叠量词，可能导致灾难性回溯，请简化表达式',
          riskLevel: 'risky',
        };
      }
    }
    if (countBranches(pattern) > MAX_BRANCHES) {
      return { ok: false, error: '分支过多（超过 32 个），请简化', riskLevel: 'risky' };
    }
  if (backtrackingWidth(pattern) > WIDTH_THRESHOLD) {
    return { ok: false, error: '表达式状态数过大，存在性能风险，请简化', riskLevel: 'risky' };
  }
  // 保守规则：组嵌套深度 ≥ 2 且量词 ≥ 2 → 多层回溯风险（如 ((a|b)+)* ）
  if (maxGroupDepth(pattern) >= 2 && countQuantifiers(pattern) >= 2) {
    return { ok: false, error: '检测到多层嵌套量词，可能导致灾难性回溯，请简化表达式', riskLevel: 'risky' };
  }
    try {
      // 编译验证（不启用 g/y，避免 lastIndex 状态污染；u 标志确保 Unicode 语义）
      new RegExp(pattern, 'u');
    } catch (e) {
      return {
        ok: false,
        error: `正则语法错误：${e instanceof Error ? e.message : String(e)}`,
        riskLevel: 'invalid',
      };
    }
    return { ok: true, riskLevel: 'safe' };
  }

  /** 在受控输入长度内执行 test；语法错误会抛出，由调用方捕获并禁用规则 */
  static compile(pattern: string): RegExp {
    return new RegExp(pattern, 'u');
  }

  /** 限制被测文本长度，防止超大输入放大回溯成本 */
  static truncateInput(text: string): string {
    return text.length > LIMITS.TEST_TEXT_MAX_LEN ? text.slice(0, LIMITS.TEST_TEXT_MAX_LEN) : text;
  }
}

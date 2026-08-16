<script setup lang="ts">
/**
 * 规则编辑器（表单式，不要求用户写 JSON）。
 * 支持：and/or/not 条件组（最多两层）、正则即时校验、
 * 动作权限校验（官方动作必须为精确 UID 规则）、规则测试面板。
 */
import { computed, reactive, ref } from 'vue';
import type { ConditionGroup, Rule, RuleAction, RuleField, RuleOperator } from '../../../shared/types';
import { CONTENT_TYPES, PAGE_SCOPES, RULE_ACTIONS, OFFICIAL_ACTIONS } from '../../../shared/types';
import { RegexSafety } from '../../../rules/safety';
import { exactUidIssueMessage, exactUidIssue } from '../../../rules/schema';
import { RuleEngine } from '../../../rules/engine';
import { buildContext } from '../../../adapters/context';
import { shortId } from '../../../shared/utils';
import { testRegexInWorker } from '../../../shared/regex-worker';
import { regexSaveGate, type RegexSaveGateResult } from '../../../rules/regex-gate';
import type { RegexVerification } from '../../../shared/types';
import type { ExtractedContent } from '../../../shared/types';

const props = defineProps<{ model: Rule | null }>();
const emit = defineEmits<{ save: [rule: Rule]; cancel: [] }>();

interface Row {
  field: RuleField;
  operator: RuleOperator;
  value: string;
  /** P1-7：正则 Worker 验证记录（保存硬门禁） */
  regexVerification?: RegexVerification;
}

interface Group {
  logic: 'and' | 'or' | 'not';
  conditions: Row[];
  groups: Group[];
}

const FIELD_LABELS: Record<RuleField, string> = {
  uid: 'UID',
  username: '用户名',
  content: '正文',
  links: '链接',
  linkDomains: '链接域名',
  contentType: '内容类型',
  pageScope: '页面范围',
  isLocalBlocked: '本地黑名单状态',
  isWhitelisted: '白名单状态',
  isVerifiedMachine: '已确认机器人状态',
  hasLinks: '是否含链接',
};

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  eq: '等于',
  ne: '不等于',
  contains: '包含',
  not_contains: '不包含',
  prefix: '前缀为',
  suffix: '后缀为',
  regex: '正则匹配',
  exists: '存在',
  not_exists: '不存在',
};

const ACTION_LABELS: Record<RuleAction, string> = {
  flag_suspicious: '标记为疑似（仅标记提示）',
  collapse_content: '折叠内容（显示占位条）',
  hide_content: '完全隐藏',
  notify_user: '提醒用户',
  suggest_manual_action: '建议用户手动处理',
  local_block_verified_uid: '加入本地黑名单（官方级：需精确 UID）',
  official_block_verified_uid: '官方拉黑（官方级：需精确 UID）',
  report_verified_uid_content: '自动举报（官方级：需精确 UID + 内容违规）',
};

const ACTION_HINTS: Record<RuleAction, string> = {
  flag_suspicious: '只做提示，不隐藏、不拉黑、不举报。',
  collapse_content: '折叠为占位条，可临时查看或放行。',
  hide_content: '直接从页面移除该内容。',
  notify_user: '在页面顶部弹出提示。',
  suggest_manual_action: '提示用户手动处理。',
  local_block_verified_uid: '⚠️ 仅「精确 UID 规则」且该 UID 已在已确认机器人名单时生效。',
  official_block_verified_uid: '⚠️ 仅「精确 UID 规则」且该 UID 已在已确认机器人名单时生效，将调用 Bilibili 官方拉黑。',
  report_verified_uid_content: '⚠️ 仅「精确 UID 规则」+ 已确认名单 + 命中可举报类别时生效，将代表你提交举报。',
};

const emptyRow = (): Row => ({ field: 'content', operator: 'contains', value: '' });
const emptyGroup = (): Group => ({ logic: 'and', conditions: [emptyRow()], groups: [] });

const form = reactive<{
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  action: RuleAction;
  reportCategory: 'ad' | 'spam' | 'fraud' | 'other' | null;
  pageScope: string[];
  contentTypes: string[];
  root: Group;
}>({
  name: '',
  description: '',
  enabled: true,
  priority: 0,
  action: 'collapse_content',
  reportCategory: null,
  pageScope: [],
  contentTypes: [],
  root: emptyGroup(),
});

if (props.model) {
  form.name = props.model.name;
  form.description = props.model.description;
  form.enabled = props.model.enabled;
  form.priority = props.model.priority;
  form.action = props.model.action;
  form.reportCategory = props.model.reportCategory;
  form.pageScope = [...props.model.pageScope];
  form.contentTypes = [...props.model.contentTypes];
  form.root = toEditor(props.model.conditions);
}

const error = ref('');
const regexStatus = ref<{ ok: boolean; message: string } | null>(null);
const regexTesting = ref(false);

function toEditor(g: ConditionGroup): Group {
  return {
    logic: g.logic,
    conditions: g.conditions.map((c) => ({
      field: c.field,
      operator: c.operator,
      value: c.value,
      regexVerification: c.regexVerification,
    })),
    groups: g.groups.map(toEditor),
  };
}

function toSchema(g: Group): ConditionGroup {
  return {
    logic: g.logic,
    conditions: g.conditions.filter((c) => c.operator === 'exists' || c.operator === 'not_exists' || c.value !== '' || c.field === 'contentType' || c.field === 'pageScope' || c.field.startsWith('is') || c.field === 'hasLinks').map((c) => ({ field: c.field, operator: c.operator, value: c.value.trim(), regexVerification: c.regexVerification })),
    groups: g.groups.map(toSchema),
  };
}

function isOfficialAction(action: RuleAction): boolean {
  return (OFFICIAL_ACTIONS as readonly RuleAction[]).includes(action);
}

const actionOfficial = computed(() => isOfficialAction(form.action));

function addRow(g: Group): void {
  g.conditions.push(emptyRow());
}

function removeRow(g: Group, i: number): void {
  g.conditions.splice(i, 1);
}

function addGroup(g: Group): void {
  if (g.groups.length >= 4) return;
  g.groups.push(emptyGroup());
}

function removeGroup(g: Group, i: number): void {
  g.groups.splice(i, 1);
}

/** P1-3：正则先静态校验，再经独立 Worker 做时间预算测试（超时由 Worker 方 terminate） */
async function validateRegex(value: string, row?: Row): Promise<void> {
  regexStatus.value = null;
  if (!value) return;
  const staticResult = RegexSafety.validate(value);
  if (!staticResult.ok) {
    regexStatus.value = { ok: false, message: staticResult.error ?? '正则无效' };
    return;
  }
  regexTesting.value = true;
  try {
    const workerResult = await testRegexInWorker(value, '测试文本 ' + testText.value, 200);
    // P1-7：无 Worker 环境（usedWorker=false）不得显示「已通过 Worker」
    if (workerResult.ok && workerResult.usedWorker) {
      regexStatus.value = { ok: true, message: '正则有效（已通过 Worker 时间预算测试）' };
      if (row) {
        row.regexVerification = {
          ok: true,
          pattern: value,
          sample: testText.value,
          workerAvailable: true,
          verifiedAt: Date.now(),
        };
      }
    } else if (!workerResult.usedWorker) {
      regexStatus.value = { ok: false, message: '当前环境无 Worker，无法完成时间预算验证（保存启用状态的正则规则被禁止）' };
      if (row) {
        row.regexVerification = {
          ok: false,
          pattern: value,
          sample: testText.value,
          workerAvailable: false,
          verifiedAt: Date.now(),
        };
      }
    } else {
      regexStatus.value = { ok: false, message: workerResult.error ?? '正则执行失败' };
      if (row) {
        row.regexVerification = {
          ok: false,
          pattern: value,
          sample: testText.value,
          workerAvailable: true,
          verifiedAt: Date.now(),
        };
      }
    }
  } catch {
    regexStatus.value = { ok: true, message: '正则有效（静态校验通过）' };
  } finally {
    regexTesting.value = false;
  }
}

function onOperatorChange(row: Row): void {
  if (row.operator === 'regex') void validateRegex(row.value, row);
}

// ---------- 测试面板 ----------
const testText = ref('加微信 xxx，点击链接 t.cn/abc 领取福利');
const testUid = ref('12345678');
const testResult = ref<{ matched: boolean; message: string } | null>(null);

function runTest(): void {
  const conditionGroup = toSchema(form.root);
  const ctx = buildContext(
    {
      contentType: 'video_comment',
      pageScope: 'video_page',
      uid: testUid.value ? Number(testUid.value) : null,
      username: '测试用户',
      text: testText.value,
      links: [],
      linkDomains: [],
      contentId: '10086',
      rootContentId: '10086',
      videoId: '1',
      origDynamicId: null,
      node: document.createElement('div'),
    } as ExtractedContent,
    { isLocalBlocked: false, isWhitelisted: false, isVerifiedMachine: true },
  );
  const engine = new RuleEngine({ currentMid: 999999 });
  const rule = {
    id: 'test',
    name: '测试规则',
    description: '',
    enabled: true,
    priority: 0,
    conditions: conditionGroup,
    pageScope: form.pageScope as never[],
    contentTypes: form.contentTypes as never[],
    action: form.action,
    reportCategory: form.reportCategory,
    createdAt: 0,
    updatedAt: 0,
    schemaVersion: 1,
  } as Rule;
  const decision = engine.evaluate(ctx, [rule]);
  testResult.value = decision.hide || decision.collapse || decision.flag || decision.notify || decision.suggestManual
    ? { matched: true, message: `命中！将执行：${ACTION_LABELS[form.action]}` }
    : { matched: false, message: '未命中（可尝试调整条件或样例内容）' };
}

// ---------- 保存 ----------
function validate(): string | null {
  if (!form.name.trim()) return '请填写规则名称';
  const conditionGroup = toSchema(form.root);
  if (conditionGroup.conditions.length === 0 && conditionGroup.groups.length === 0) {
    return '至少需要一个条件';
  }
  if (isOfficialAction(form.action)) {
    const probe: Rule = {
      id: 'probe',
      name: form.name,
      description: '',
      enabled: true,
      priority: 0,
      conditions: conditionGroup,
      pageScope: [],
      contentTypes: [],
      action: form.action,
      reportCategory: form.reportCategory,
      createdAt: 0,
      updatedAt: 0,
      schemaVersion: 1,
    };
    // P1-5：规范化精确 UID 校验（含全部拒绝规则）
    const issue = exactUidIssue(probe);
    if (issue !== null) {
      return `官方动作（拉黑/举报）只允许规范化的「精确 UID 规则」：${exactUidIssueMessage(issue)}`;
    }
    if (form.action === 'report_verified_uid_content' && form.reportCategory === null) {
      return '自动举报规则必须选择可举报类别（广告/垃圾/诈骗）作为内容违规依据';
    }
  }
  for (const row of [...form.root.conditions, ...form.root.groups.flatMap((g) => g.conditions)]) {
    if (row.operator === 'regex') {
      const r = RegexSafety.validate(row.value);
      if (!r.ok) return `正则表达式错误：${r.error}`;
    }
  }
  // P1-7：正则 Worker 保存硬门禁（启用状态的规则必须全部通过 Worker 验证）
  const gate: RegexSaveGateResult = regexSaveGate(toSchema(form.root), {
    enabled: form.enabled,
    currentSample: testText.value,
  });
  if (!gate.canSaveEnabled) {
    return gate.reason ?? '正则条件未通过 Worker 验证';
  }
  return null;
}

function save(): void {
  const err = validate();
  if (err) {
    error.value = err;
    return;
  }
  error.value = '';
  const now = Date.now();
  const rule: Rule = {
    id: props.model?.id ?? shortId('rule'),
    name: form.name.trim(),
    description: form.description.trim(),
    enabled: form.enabled,
    priority: form.priority,
    conditions: toSchema(form.root),
    pageScope: form.pageScope as never[],
    contentTypes: form.contentTypes as never[],
    action: form.action,
    reportCategory: form.reportCategory,
    createdAt: props.model?.createdAt ?? now,
    updatedAt: now,
    schemaVersion: 1,
  };
  emit('save', rule);
}

function fieldOptions(): RuleField[] {
  return Object.keys(FIELD_LABELS) as RuleField[];
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('cancel')">
    <div class="modal">
      <h3>{{ props.model ? '编辑规则' : '新建规则' }}</h3>

      <div class="row">
        <label>名称</label>
        <input v-model="form.name" type="text" placeholder="例如：疑似广告关键词" style="width: 280px" />
        <label class="muted">启用</label>
        <label class="switch">
          <input v-model="form.enabled" type="checkbox" />
          <span class="slider"></span>
        </label>
        <label>优先级</label>
        <input v-model.number="form.priority" type="number" min="-1000" max="1000" style="width: 90px" />
      </div>

      <div class="row">
        <label>动作</label>
        <select v-model="form.action" style="width: 340px">
          <option v-for="a in RULE_ACTIONS" :key="a" :value="a">{{ ACTION_LABELS[a] }}</option>
        </select>
      </div>
      <div class="tip">{{ ACTION_HINTS[form.action] }}</div>

      <div class="row">
        <label>可举报类别</label>
        <select v-model="form.reportCategory" style="width: 200px">
          <option :value="null">无（不构成举报依据）</option>
          <option value="ad">广告</option>
          <option value="spam">垃圾/刷屏</option>
          <option value="fraud">诈骗/引流</option>
          <option value="other">其它</option>
        </select>
        <span class="muted">仅「自动举报」动作需要；命中时作为内容违规依据</span>
      </div>

      <div class="row">
        <label>生效页面</label>
        <label v-for="p in PAGE_SCOPES" :key="p" class="muted" style="display: inline-flex; align-items: center; gap: 4px">
          <input v-model="form.pageScope" type="checkbox" :value="p" />
          {{ p }}
        </label>
        <span class="muted">（不选 = 全部页面）</span>
      </div>

      <div class="row">
        <label>生效内容类型</label>
        <label v-for="c in CONTENT_TYPES" :key="c" class="muted" style="display: inline-flex; align-items: center; gap: 4px">
          <input v-model="form.contentTypes" type="checkbox" :value="c" />
          {{ c }}
        </label>
        <span class="muted">（不选 = 全部类型）</span>
      </div>

      <h3>匹配条件</h3>
      <div class="tip">
        条件组逻辑：AND（全部满足）、OR（任一满足）、NOT（取反）。官方动作只允许「UID 等于」条件。
      </div>

      <div class="card" style="margin-bottom: 8px">
        <div class="row">
          <label>逻辑</label>
          <select v-model="form.root.logic" style="width: 120px">
            <option value="and">AND</option>
            <option value="or">OR</option>
            <option value="not">NOT</option>
          </select>
        </div>
        <div v-for="(row, i) in form.root.conditions" :key="i" class="row">
          <select v-model="row.field" style="width: 140px">
            <option v-for="f in fieldOptions()" :key="f" :value="f">{{ FIELD_LABELS[f] }}</option>
          </select>
          <select v-model="row.operator" style="width: 120px" @change="onOperatorChange(row)">
            <option v-for="(label, o) in OPERATOR_LABELS" :key="o" :value="o">{{ label }}</option>
          </select>
          <input
            v-if="row.operator !== 'exists' && row.operator !== 'not_exists'"
            v-model="row.value"
            type="text"
            placeholder="比较值"
            style="width: 240px"
            @blur="row.operator === 'regex' && validateRegex(row.value)"
          />
          <button class="btn danger" @click="removeRow(form.root, i)">删除</button>
        </div>
        <div class="row">
          <button class="btn" @click="addRow(form.root)">+ 添加条件</button>
          <button class="btn" @click="addGroup(form.root)">+ 添加子条件组</button>
        </div>
      </div>

      <div v-for="(sub, si) in form.root.groups" :key="si" class="card" style="margin-bottom: 8px; margin-left: 18px">
        <div class="row">
          <label>子组逻辑</label>
          <select v-model="sub.logic" style="width: 110px">
            <option value="and">AND</option>
            <option value="or">OR</option>
            <option value="not">NOT</option>
          </select>
          <button class="btn danger" @click="removeGroup(form.root, si)">删除子组</button>
        </div>
        <div v-for="(row, i) in sub.conditions" :key="i" class="row">
          <select v-model="row.field" style="width: 140px">
            <option v-for="f in fieldOptions()" :key="f" :value="f">{{ FIELD_LABELS[f] }}</option>
          </select>
          <select v-model="row.operator" style="width: 120px" @change="onOperatorChange(row)">
            <option v-for="(label, o) in OPERATOR_LABELS" :key="o" :value="o">{{ label }}</option>
          </select>
          <input
            v-if="row.operator !== 'exists' && row.operator !== 'not_exists'"
            v-model="row.value"
            type="text"
            placeholder="比较值"
            style="width: 240px"
          />
          <button class="btn danger" @click="removeRow(sub, i)">删除</button>
        </div>
        <div class="row">
          <button class="btn" @click="addRow(sub)">+ 添加条件</button>
        </div>
      </div>

      <div v-if="regexStatus" :class="regexStatus.ok ? 'ok-text' : 'error-text'">
        {{ regexStatus.message }}
      </div>
      <div v-if="actionOfficial" class="tip">
        该动作属于官方级动作：仅当 UID 精确等于已确认机器人名单中的账号时才会执行。
      </div>

      <h3>规则测试</h3>
      <div class="row">
        <label>样例正文</label>
        <input v-model="testText" type="text" style="width: 320px" />
        <label>样例 UID</label>
        <input v-model="testUid" type="text" style="width: 120px" />
        <button class="btn primary" @click="runTest">运行测试</button>
      </div>
      <div v-if="testResult" :class="testResult.matched ? 'ok-text' : 'muted'">
        {{ testResult.message }}
      </div>

      <div class="row">
        <label>描述</label>
        <input v-model="form.description" type="text" style="width: 480px" placeholder="可选" />
      </div>

      <div v-if="error" class="error-text">{{ error }}</div>

      <div class="actions">
        <button class="btn" @click="emit('cancel')">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

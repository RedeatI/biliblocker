<script setup lang="ts">
import { ref } from 'vue';
import { saveRules, state } from '../store';
import type { Rule } from '../../../shared/types';
import RuleEditor from './RuleEditor.vue';

const editing = ref<Rule | null | 'new'>(null);
const error = ref('');

function toggle(rule: Rule): void {
  void saveRules(state.rules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
}

function move(rule: Rule, dir: -1 | 1): void {
  const list = [...state.rules];
  const idx = list.findIndex((r) => r.id === rule.id);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= list.length) return;
  const [item] = list.splice(idx, 1);
  list.splice(target, 0, item!);
  void saveRules(list);
}

function remove(rule: Rule): void {
  if (!window.confirm(`删除规则「${rule.name}」？`)) return;
  void saveRules(state.rules.filter((r) => r.id !== rule.id));
}

function onSaved(rule: Rule): void {
  const exists = state.rules.some((r) => r.id === rule.id);
  const list = exists
    ? state.rules.map((r) => (r.id === rule.id ? rule : r))
    : [...state.rules, rule];
  void saveRules(list).catch((e) => {
    error.value = e instanceof Error ? e.message : String(e);
  });
  editing.value = null;
}
</script>

<template>
  <div>
    <div class="card">
      <div class="row">
        <h2 style="margin: 0">规则列表</h2>
        <button class="btn primary" @click="editing = 'new'">+ 新建规则</button>
      </div>
      <p class="muted">
        疑似类规则只能隐藏/标记/提示；拉黑与举报类动作只对「精确 UID + 已确认机器人名单」生效。
        优先级数字越大越优先；白名单始终高于一切规则；你本人的内容永远不会被处理。
      </p>

      <div v-if="error" class="error-text">{{ error }}</div>

      <table class="list" v-if="state.rules.length">
        <thead>
          <tr>
            <th>启用</th>
            <th>优先级</th>
            <th>名称</th>
            <th>动作</th>
            <th>命中范围</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rule in [...state.rules].sort((a, b) => b.priority - a.priority)" :key="rule.id">
            <td>
              <label class="switch" style="transform: scale(0.85)">
                <input type="checkbox" :checked="rule.enabled" @change="toggle(rule)" />
                <span class="slider"></span>
              </label>
            </td>
            <td>{{ rule.priority }}</td>
            <td>
              <strong>{{ rule.name }}</strong>
              <div class="muted">{{ rule.description }}</div>
            </td>
            <td>
              <span class="badge" :class="rule.action.startsWith('flag') || rule.action.startsWith('collapse') || rule.action.startsWith('hide') || rule.action.startsWith('notify') || rule.action.startsWith('suggest') ? 'warn' : 'danger'">
                {{ rule.action }}
              </span>
            </td>
            <td class="muted">
              {{ rule.contentTypes.length ? rule.contentTypes.join(', ') : '全部类型' }}
            </td>
            <td>
              <button class="btn" @click="editing = rule">编辑</button>
              <button class="btn" @click="move(rule, -1)">↑</button>
              <button class="btn" @click="move(rule, 1)">↓</button>
              <button class="btn danger" @click="remove(rule)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无规则，点击「新建规则」创建</div>
    </div>

    <RuleEditor v-if="editing" :model="editing === 'new' ? null : editing" @save="onSaved" @cancel="editing = null" />
  </div>
</template>

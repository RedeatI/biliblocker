<script setup lang="ts">
/**
 * 名单管理（P1-4）：统一导入解析器 + 批量原子写入。
 * 删除旧的「直接 JSON.parse + fire-and-forget」路径；
 * 导入前预览数量并确认，失败不部分写入，返回新增/重复/无效数量。
 */
import { ref } from 'vue';
import {
  addBlocked,
  addVerified,
  addWhitelist,
  addBlockedBatch,
  addVerifiedBatch,
  addWhitelistBatch,
  removeBlocked,
  removeVerified,
  removeWhitelist,
  state,
} from '../store';
import { parseListImport, type ListKind, type ListImportItem } from '../../../rules/import-export';

const active = ref<ListKind>('blocked');

const newUid = ref('');
const newName = ref('');
const error = ref('');
const info = ref('');
const pendingImport = ref<{ kind: ListKind; items: ListImportItem[]; total: number } | null>(null);

const LIST_META: Record<ListKind, { title: string; desc: string }> = {
  blocked: {
    title: '本地黑名单',
    desc: '仅本地生效：隐藏该账号的内容。不会调用官方接口。',
  },
  verified: {
    title: '已确认机器人名单',
    desc: '确定性状态（由你确认或精确 UID 导入）。只有此名单中的账号可触发官方拉黑/自动举报。',
  },
  whitelist: {
    title: '白名单',
    desc: '白名单优先级高于一切规则；白名单账号不会被隐藏、拉黑或举报。',
  },
};

async function addCurrent(): Promise<void> {
  error.value = '';
  info.value = '';
  const uid = Number(newUid.value.trim());
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    error.value = '请输入有效的 UID（正整数）';
    return;
  }
  const name = newName.value.trim() || undefined;
  if (active.value === 'blocked') await addBlocked({ uid, username: name, source: 'manual' });
  else if (active.value === 'verified') await addVerified({ uid, username: name, source: 'manual' });
  else await addWhitelist({ uid, username: name });
  newUid.value = '';
  newName.value = '';
}

function remove(list: ListKind, uid: number): void {
  if (!window.confirm(`从${LIST_META[list].title}移除 UID ${uid}？`)) return;
  if (list === 'blocked') void removeBlocked(uid);
  else if (list === 'verified') void removeVerified(uid);
  else void removeWhitelist(uid);
}

const entries = (list: ListKind) => state[list];

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportList(list: ListKind): void {
  download(`biliblocker-${list}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(entries(list), null, 2));
}

/** P1-4：统一解析 + 预览，不直接写入 */
function onPickImportFile(): void {
  error.value = '';
  info.value = '';
  pendingImport.value = null;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const parsed = parseListImport(text, active.value);
      if (!parsed.ok || !parsed.items) {
        error.value = parsed.error ?? '导入解析失败';
        return;
      }
      pendingImport.value = { kind: active.value, items: parsed.items, total: parsed.total };
    };
    reader.readAsText(file);
  };
  input.click();
}

/** P1-4：确认后批量原子写入，返回新增/重复/无效数量 */
async function confirmListImport(): Promise<void> {
  const pending = pendingImport.value;
  if (!pending) return;
  error.value = '';
  try {
    let result: { added: number; duplicate: number; invalid: number };
    if (pending.kind === 'blocked') {
      result = await addBlockedBatch(pending.items.map((i) => ({ uid: i.uid, username: i.username, reason: i.reason, source: 'import' as const })));
    } else if (pending.kind === 'verified') {
      result = await addVerifiedBatch(pending.items.map((i) => ({ uid: i.uid, username: i.username, source: 'import' as const })));
    } else {
      result = await addWhitelistBatch(pending.items.map((i) => ({ uid: i.uid, username: i.username })));
    }
    info.value = `导入完成：新增 ${result.added}，重复跳过 ${result.duplicate}，无效 ${result.invalid}（共 ${pending.total} 条）`;
    pendingImport.value = null;
  } catch (e) {
    error.value = `导入失败：${e instanceof Error ? e.message : String(e)}（未写入任何条目）`;
  }
}
</script>

<template>
  <div>
    <div class="card">
      <div class="tabs" style="border: none; padding: 0; margin-bottom: 12px">
        <button v-for="k in (['blocked', 'verified', 'whitelist'] as ListKind[])" :key="k" :class="{ active: active === k }" @click="active = k">
          {{ LIST_META[k].title }}（{{ state[k].length }}）
        </button>
      </div>
      <p class="muted">{{ LIST_META[active].desc }}</p>

      <div class="row">
        <input v-model="newUid" type="text" placeholder="UID（正整数）" style="width: 160px" />
        <input v-model="newName" type="text" placeholder="用户名（可选）" style="width: 180px" />
        <button class="btn primary" @click="addCurrent()">添加</button>
        <button class="btn" @click="exportList(active)">导出该名单</button>
        <button class="btn" @click="onPickImportFile()">导入该名单</button>
      </div>
      <div v-if="error" class="error-text">{{ error }}</div>
      <div v-if="info" class="ok-text">{{ info }}</div>

      <div v-if="pendingImport" class="tip">
        <strong>导入预览：</strong>
        共 {{ pendingImport.total }} 条，将写入「{{ LIST_META[pendingImport.kind].title }}」。
        重复 UID 将被跳过，全部条目通过校验后一次性提交（失败不部分写入）。
        <div class="row" style="margin-top: 10px">
          <button class="btn primary" @click="confirmListImport()">确认导入</button>
          <button class="btn" @click="pendingImport = null">取消</button>
        </div>
      </div>

      <table class="list" v-if="entries(active).length">
        <thead>
          <tr>
            <th>UID</th>
            <th>用户名</th>
            <th>来源</th>
            <th>时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in entries(active)" :key="e.uid">
            <td>{{ e.uid }}</td>
            <td>{{ e.username ?? '—' }}</td>
            <td class="muted">{{ (e as { source?: string; blockedAt?: number; addedAt?: number }).source ?? '—' }}</td>
            <td class="muted">
              {{ new Date((e as { blockedAt?: number; addedAt?: number }).blockedAt ?? (e as { addedAt?: number }).addedAt ?? 0).toLocaleString() }}
            </td>
            <td>
              <button class="btn danger" @click="remove(active, e.uid)">移除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">该名单为空</div>
    </div>
  </div>
</template>

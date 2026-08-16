<script setup lang="ts">
import { ref } from 'vue';
import { clearAll, exportJson, importJson, resetDefaults, state } from '../store';
import { parseImportText, computeImportPreview } from '../../../rules/import-export';

const message = ref('');
const preview = ref<Awaited<ReturnType<typeof computeImportPreview>> | null>(null);
const pendingText = ref('');

function onExport(): void {
  const blob = new Blob([exportJson()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `biliblocker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function onPickFile(): void {
  message.value = '';
  preview.value = null;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const parsed = parseImportText(text);
      if (!parsed.ok || !parsed.data) {
        message.value = `导入失败：${parsed.error}`;
        return;
      }
      pendingText.value = text;
      preview.value = computeImportPreview(parsed.data, {
        rules: state.rules,
        blocked: state.blocked,
        verified: state.verified,
        whitelist: state.whitelist,
      });
    };
    reader.readAsText(file);
  };
  input.click();
}

async function confirmImport(): Promise<void> {
  const result = await importJson(pendingText.value);
  message.value = result.message;
  preview.value = null;
  pendingText.value = '';
}

async function onResetDefaults(): Promise<void> {
  if (!window.confirm('恢复默认设置？现有规则与名单将被默认值替换。')) return;
  await resetDefaults();
  message.value = '已恢复默认设置';
}

async function onClearAll(): Promise<void> {
  if (!window.confirm('清除全部本地数据？包括设置、规则、全部名单与操作日志。此操作不可恢复！')) return;
  if (!window.confirm('再次确认：真的要清除全部本地数据吗？')) return;
  await clearAll();
  message.value = '已清除全部本地数据';
}
</script>

<template>
  <div>
    <div class="card">
      <h2>导入 / 导出</h2>
      <p class="muted">
        导出包含：设置、规则、本地黑名单、已确认机器人名单、白名单。不包含操作日志正文。
        导入时校验 JSON Schema、限制文件大小、阻止原型污染；导入前请确认预览数量。
      </p>
      <div class="row">
        <button class="btn primary" @click="onExport()">导出备份（JSON）</button>
        <button class="btn" @click="onPickFile()">导入备份（JSON）</button>
      </div>

      <div v-if="preview" class="tip">
        <strong>导入预览：</strong>
        <div>规则：新增 {{ preview.rules.toAdd }} / 覆盖 {{ preview.rules.toOverride }} / 忽略 {{ preview.rules.toIgnore }}</div>
        <div>黑名单：新增 {{ preview.blocked.toAdd }} / 忽略 {{ preview.blocked.toIgnore }}</div>
        <div>已确认机器人：新增 {{ preview.verified.toAdd }} / 忽略 {{ preview.verified.toIgnore }}</div>
        <div>白名单：新增 {{ preview.whitelist.toAdd }} / 忽略 {{ preview.whitelist.toIgnore }}</div>
        <div class="row" style="margin-top: 10px">
          <button class="btn primary" @click="confirmImport()">确认导入</button>
          <button class="btn" @click="preview = null; pendingText = ''">取消</button>
        </div>
      </div>

      <div v-if="message" class="ok-text">{{ message }}</div>
    </div>

    <div class="card">
      <h2>恢复默认设置</h2>
      <p class="muted">将设置与规则恢复为出厂默认（清空名单、去重记录与队列）。</p>
      <button class="btn" @click="onResetDefaults()">恢复默认设置</button>
    </div>

    <div class="card">
      <h2>清除全部本地数据</h2>
      <p class="muted">删除扩展在本机保存的全部数据（不会影响你的 Bilibili 账号）。</p>
      <button class="btn danger" @click="onClearAll()">清除全部本地数据</button>
    </div>
  </div>
</template>

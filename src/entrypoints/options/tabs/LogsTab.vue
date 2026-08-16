<script setup lang="ts">
import { computed, ref } from 'vue';
import { clearAudit, state } from '../store';

const keyword = ref('');
const statusFilter = ref<'all' | 'ok' | 'fail' | 'cancelled' | 'unknown'>('all');

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return state.audit
    .filter((e) => {
      if (statusFilter.value === 'ok' && !(e.blockResult?.ok || e.reportResult?.ok)) return false;
      if (statusFilter.value === 'fail' && !(!e.blockResult?.ok || !e.reportResult?.ok || e.failureReason)) return false;
      if (statusFilter.value === 'cancelled' && !e.cancelled) return false;
      // P0-3：SW 崩溃恢复时结果未知（可能已发送但未确认），需要人工核对
      if (statusFilter.value === 'unknown' && !e.outcomeUnknown) return false;
      if (!kw) return true;
      return (
        String(e.uid).includes(kw) ||
        (e.username ?? '').toLowerCase().includes(kw) ||
        (e.contentId ?? '').toLowerCase().includes(kw) ||
        (e.failureReason ?? '').toLowerCase().includes(kw)
      );
    })
    .slice()
    .reverse();
});

function exportLogs(): void {
  // 脱敏导出：仅导出必要字段（无正文，仅 id/时间/uid/结果）
  const sanitized = filtered.value.map((e) => ({
    ts: new Date(e.ts).toISOString(),
    uid: e.uid,
    username: e.username ?? null,
    contentType: e.contentType ?? null,
    contentId: e.contentId ?? null,
    trigger: e.trigger,
    localHidden: e.localHidden,
    blockOk: e.blockResult?.ok ?? null,
    blockStatus: e.blockResult?.status ?? null,
    reportOk: e.reportResult?.ok ?? null,
    reportStatus: e.reportResult?.status ?? null,
    failureReason: e.failureReason ?? null,
    cancelled: e.cancelled ?? false,
  }));
  const blob = new Blob([JSON.stringify(sanitized, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `biliblocker-audit-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clear(): void {
  if (!window.confirm('清除全部操作日志？此操作不可恢复。')) return;
  void clearAudit();
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div>
    <div class="card">
      <div class="row">
        <h2 style="margin: 0">操作日志</h2>
        <span class="muted">（默认仅本地保存，不包含评论正文）</span>
      </div>
      <div class="row">
        <input v-model="keyword" type="text" placeholder="搜索 UID / 用户名 / 内容 ID" style="width: 280px" />
        <select v-model="statusFilter" style="width: 140px">
          <option value="all">全部状态</option>
          <option value="ok">成功</option>
          <option value="fail">失败</option>
          <option value="cancelled">已取消</option>
          <option value="unknown">结果未知</option>
        </select>
        <button class="btn" @click="exportLogs()">导出脱敏日志</button>
        <button class="btn danger" @click="clear()">清除全部</button>
      </div>

      <table class="list" v-if="filtered.length">
        <thead>
          <tr>
            <th>时间</th>
            <th>UID</th>
            <th>用户名</th>
            <th>类型</th>
            <th>触发</th>
            <th>本地隐藏</th>
            <th>拉黑结果</th>
            <th>举报结果</th>
            <th>失败原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in filtered" :key="e.id">
            <td class="muted">{{ fmtTime(e.ts) }}</td>
            <td>{{ e.uid }}</td>
            <td>{{ e.username ?? '—' }}</td>
            <td class="muted">{{ e.contentType ?? '—' }}</td>
            <td class="muted">{{ e.trigger }}</td>
            <td>
              <span class="badge" :class="e.localHidden ? 'success' : 'info'">{{ e.localHidden ? '是' : '否' }}</span>
            </td>
            <td>
              <span v-if="e.blockResult" class="badge" :class="e.blockResult.ok ? 'success' : 'danger'">
                {{ e.blockResult.ok ? '成功' : e.blockResult.status }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span v-if="e.reportResult" class="badge" :class="e.reportResult.ok ? 'success' : 'danger'">
                {{ e.reportResult.ok ? '已提交' : e.reportResult.status }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted">{{ e.failureReason ?? (e.cancelled ? '用户取消' : (e.outcomeUnknown ? '结果未知（SW 中断恢复，可能已发送但未确认，未自动重发）' : '—')) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无日志</div>
    </div>
  </div>
</template>

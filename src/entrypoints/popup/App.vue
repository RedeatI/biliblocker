<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { StorageRepository } from '../../storage/repository';
import { chromeStorageBackend } from '../../storage/backend';
import type { QueueStatus, Settings } from '../../shared/types';
import { togglePopupMaster } from './controller';

// P1-1（v0.1.3）：popup 只读存储；写入（updateSettings）经 background 协调
const repo = new StorageRepository(chromeStorageBackend(), { allowWrites: false });

const ready = ref(false);
const settings = ref<Settings | null>(null);
const counts = ref({ blocked: 0, verified: 0, whitelist: 0 });
const queue = ref<QueueStatus | null>(null);

onMounted(async () => {
  await repo.init();
  settings.value = await repo.getSettings();
  const [blocked, verified, whitelist] = await Promise.all([
    repo.getBlocked(),
    repo.getVerified(),
    repo.getWhitelist(),
  ]);
  counts.value = { blocked: blocked.length, verified: verified.length, whitelist: whitelist.length };
  ready.value = true;
  try {
    queue.value = (await browser.runtime.sendMessage({ type: 'BB_QUEUE_STATUS_REQ' })) as QueueStatus;
  } catch {
    queue.value = null;
  }
});

async function toggleMaster(): Promise<void> {
  if (!settings.value) return;
  const result = await togglePopupMaster(settings.value, {
    sendMessage: (message) => browser.runtime.sendMessage(message),
    getSettingsRevision: () => repo.getSettingsRevision(),
  });
  if (result === 'open_welcome') {
    window.close();
    return;
  }
  settings.value = await repo.getSettings();
}

async function openOptions(target?: 'logs' | 'welcome'): Promise<void> {
  // 后台是唯一打开页面的一方：默认走 registered Options，日志使用 extension URL 的 hash。
  await browser.runtime.sendMessage({ type: 'BB_OPEN_OPTIONS', target }).catch(() => undefined);
  window.close();
}
</script>

<template>
  <div class="popup">
    <div class="header">
      <img src="/icons/icon-32.png" alt="BiliBlocker" />
      <h1>BiliBlocker</h1>
    </div>

    <div v-if="ready && settings">
      <div class="switch-row">
        <span>启用过滤与快捷操作</span>
        <label class="switch">
          <input type="checkbox" :checked="settings.enabled" @change="toggleMaster()" />
          <span class="slider"></span>
        </label>
      </div>

      <div class="stats">
        <div class="stat"><div class="num">{{ counts.blocked }}</div><div class="label">黑名单</div></div>
        <div class="stat"><div class="num">{{ counts.verified }}</div><div class="label">已确认机器人</div></div>
        <div class="stat"><div class="num">{{ counts.whitelist }}</div><div class="label">白名单</div></div>
      </div>

      <div class="footer">
        队列：{{ queue ? (queue.paused ? `已暂停（${queue.pausedReason ?? ''}）` : `等待 ${queue.queued} / 执行中 ${queue.inFlight}`) : '未知' }}
        <br />
        自动举报：{{ settings.autoReportAuthorized ? '已授权' : '未授权' }}
      </div>

      <div class="actions">
        <button @click="openOptions()">打开设置</button>
        <button class="primary" @click="openOptions('logs')">查看日志</button>
      </div>
    </div>

    <div v-else class="footer">正在加载…</div>
  </div>
</template>

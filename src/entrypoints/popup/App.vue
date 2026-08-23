<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { StorageRepository } from '../../storage/repository';
import { chromeStorageBackend } from '../../storage/backend';
import type { QueueStatus, Settings } from '../../shared/types';
import { CAPABILITY_VERIFICATION } from '../../shared/capabilities';
import { REPORT_REASONS } from '../../shared/constants/report-reasons';
import {
  projectPopupCapabilityTruth,
  readPopupCapabilityVerification,
  type PopupCapabilityRead,
  type PopupSettingsRead,
} from '../../shared/popup-capability-truth';
import { togglePopupMaster } from './controller';

// P1-1（v0.1.3）：popup 只读存储；写入（updateSettings）经 background 协调
const repo = new StorageRepository(chromeStorageBackend(), { allowWrites: false });

const ready = ref(false);
const settings = ref<Settings | null>(null);
const counts = ref({ blocked: 0, verified: 0, whitelist: 0 });
const queue = ref<QueueStatus | null>(null);
const settingsRead = ref<PopupSettingsRead>({ state: 'unknown' });
const capabilityRead = ref<PopupCapabilityRead>({ state: 'unknown' });
const capabilityTruth = computed(() =>
  projectPopupCapabilityTruth(settingsRead.value, capabilityRead.value),
);

function recordSettings(value: Settings): void {
  settings.value = value;
  settingsRead.value = { state: 'known', settings: value };
}

onMounted(async () => {
  try {
    capabilityRead.value = readPopupCapabilityVerification(
      CAPABILITY_VERIFICATION,
      REPORT_REASONS,
    );
  } catch {
    capabilityRead.value = { state: 'unknown' };
  }

  try {
    await repo.init();
    recordSettings(await repo.getSettings());
    const [blocked, verified, whitelist] = await Promise.all([
      repo.getBlocked(),
      repo.getVerified(),
      repo.getWhitelist(),
    ]);
    counts.value = { blocked: blocked.length, verified: verified.length, whitelist: whitelist.length };
  } catch {
    settings.value = null;
    settingsRead.value = { state: 'unknown' };
  } finally {
    ready.value = true;
  }

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
  try {
    recordSettings(await repo.getSettings());
  } catch {
    settings.value = null;
    settingsRead.value = { state: 'unknown' };
  }
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

    <div v-if="ready">
      <div v-if="settings" class="switch-row">
        <span>启用过滤与快捷操作</span>
        <label class="switch">
          <input type="checkbox" :checked="settings.enabled" @change="toggleMaster()" />
          <span class="slider"></span>
        </label>
      </div>

      <div v-if="settings" class="stats">
        <div class="stat"><div class="num">{{ counts.blocked }}</div><div class="label">黑名单</div></div>
        <div class="stat"><div class="num">{{ counts.verified }}</div><div class="label">已确认机器人</div></div>
        <div class="stat"><div class="num">{{ counts.whitelist }}</div><div class="label">白名单</div></div>
      </div>

      <div class="footer">
        队列：{{ queue ? (queue.paused ? `已暂停（${queue.pausedReason ?? ''}）` : `等待 ${queue.queued} / 执行中 ${queue.inFlight}`) : '未知' }}
        <br />
        总设置：{{ capabilityTruth.settingText }}
        <br />
        自动举报授权：{{ capabilityTruth.authorizationText }}
        <br />
        自动举报真实能力：{{ capabilityTruth.capabilityText }}
      </div>

      <div class="actions">
        <button @click="openOptions()">打开设置</button>
        <button class="primary" @click="openOptions('logs')">查看日志</button>
      </div>
    </div>

    <div v-else class="footer">正在加载…</div>
  </div>
</template>

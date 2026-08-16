<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { initStore, state } from './store';
import { BRAND } from '../../shared/constants/brand';
import OverviewTab from './tabs/OverviewTab.vue';
import RulesTab from './tabs/RulesTab.vue';
import ListsTab from './tabs/ListsTab.vue';
import LogsTab from './tabs/LogsTab.vue';
import DataTab from './tabs/DataTab.vue';
import PrivacyTab from './tabs/PrivacyTab.vue';
import AboutTab from './tabs/AboutTab.vue';

type TabKey =
  | 'overview'
  | 'rules'
  | 'lists'
  | 'logs'
  | 'data'
  | 'privacy'
  | 'about';

const tabs: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'rules', label: '规则' },
  { key: 'lists', label: '名单' },
  { key: 'logs', label: '操作日志' },
  { key: 'data', label: '数据' },
  { key: 'privacy', label: '隐私与权限' },
  { key: 'about', label: '关于' },
];

const active = ref<TabKey>('overview');

onMounted(() => {
  const hash = location.hash.replace(/^#\/?/, '') as TabKey;
  if (tabs.some((t) => t.key === hash)) active.value = hash;
  void initStore();
});
</script>

<template>
  <header class="app-header">
    <img class="logo" src="/icons/icon-48.png" alt="BiliBlocker 图标" />
    <div>
      <h1>{{ BRAND.name }}</h1>
      <div class="sub">{{ BRAND.purpose }}</div>
    </div>
  </header>

  <nav class="tabs" role="tablist">
    <button
      v-for="t in tabs"
      :key="t.key"
      :class="{ active: active === t.key }"
      @click="active = t.key; location.hash = `#${t.key}`"
    >
      {{ t.label }}
    </button>
  </nav>

  <div v-if="!state.ready" class="card">
    <div class="empty">正在加载设置…</div>
  </div>

  <template v-else>
    <OverviewTab v-show="active === 'overview'" />
    <RulesTab v-show="active === 'rules'" />
    <ListsTab v-show="active === 'lists'" />
    <LogsTab v-show="active === 'logs'" />
    <DataTab v-show="active === 'data'" />
    <PrivacyTab v-show="active === 'privacy'" />
    <AboutTab v-show="active === 'about'" />
  </template>
</template>

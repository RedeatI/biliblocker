<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { BRAND } from '../../../shared/constants/brand';

const version = ref('0.1.0');
const manifestVersion = ref('');

onMounted(() => {
  void browser.runtime.getManifest().then((m) => {
    version.value = m.version ?? '0.1.0';
    manifestVersion.value = m.manifest_version?.toString() ?? '';
  });
});
</script>

<template>
  <div class="card">
    <h2>关于 {{ BRAND.name }}</h2>
    <div class="row">
      <span>版本：{{ version }}</span>
      <span v-if="manifestVersion" class="muted">Manifest V{{ manifestVersion }}</span>
    </div>
    <p class="muted">
      {{ BRAND.purpose }}
    </p>
    <p class="muted">
      技术栈：Manifest V3 · TypeScript · WXT · Vue 3 · Zod。所有数据本地保存。
    </p>
    <p class="muted">{{ BRAND.disclaimer }}</p>
  </div>
</template>

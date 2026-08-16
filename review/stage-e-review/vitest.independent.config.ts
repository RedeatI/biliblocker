/**
 * 独立探针专用 vitest 配置（阶段 E 复验方工作流）。
 * 用法：pnpm vitest run --config review/stage-e-review/vitest.independent.config.ts
 * 输出：review/stage-e-review/independent-evidence.json（probes 内 writeFileSync 生成）
 */
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
  test: {
    include: ['review/stage-e-review/independent-probes.probe.test.ts'],
    testTimeout: 15_000,
    restoreMocks: true,
    clearMocks: true,
  },
});

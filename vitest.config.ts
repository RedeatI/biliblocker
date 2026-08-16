import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/dom/**/*.test.ts'],
    environmentMatchGlobs: [['tests/dom/**', 'happy-dom']],
    setupFiles: ['tests/unit/setup.ts'],
    testTimeout: 15_000,
    restoreMocks: true,
    clearMocks: true,
  },
});

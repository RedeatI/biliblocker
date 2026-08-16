/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<Record<string, never>, Record<string, never>, any>;
  export default component;
}

/** 编译期构建模式常量（wxt define 注入）：E2E 构建为 true，生产构建恒为 false */
declare const __BILIBLOCKER_E2E__: boolean;

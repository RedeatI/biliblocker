import { defineConfig } from 'wxt';
import { fileURLToPath } from 'node:url';
import { resolveBuildMode, patchContentScriptsForE2E, viteDefine } from './scripts/build-mode.mjs';

/**
 * BiliBlocker 构建配置（WXT）。
 *
 * 构建隔离（P0-1）：
 * - 生产构建（build:chrome / build:edge / zip）：输出到 out/<browser>-mv3，
 *   内容脚本只匹配 https://www.bilibili.com/*，__BILIBLOCKER_E2E__ 编译为 false。
 * - E2E 构建（E2E=1）：输出到独立目录 out-e2e/<browser>-mv3，内容脚本追加
 *   localhost 匹配，__BILIBLOCKER_E2E__ 编译为 true（Mock 能力强制可用）。
 *   E2E=1 绝不修改 out/chrome-mv3 或 out/edge-mv3。
 */
const mode = resolveBuildMode();

export default defineConfig({
  srcDir: 'src',
  outDir: mode.outDir,
  // 使用字符串模块引用（避免 jiti 对双格式包 import 互操作的问题）
  modules: ['@wxt-dev/module-vue'],
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
  // 编译模式隔离：E2E 构建内 __BILIBLOCKER_E2E__ === true，生产构建恒为 false。
  // 生产包经 vite 常量替换 + minify 后不包含任何 Mock/强制启用路径。
  vite: () => viteDefine(mode),
  // 官方 WXT production ZIP 流程（wxt zip / wxt zip -b edge）输出到 out/；
  // source ZIP 由 scripts/package.mjs 以确定性 STORE 方式生成（可复现），此处关闭 wxt 自带 sources
  zip: {
    name: 'biliblocker',
    artifactTemplate: '{{name}}-{{version}}-{{browser}}.zip',
    zipSources: false,
  },
  manifest: {
    name: 'BiliBlocker',
    description:
      '在本地标记、折叠并可恢复地管理 Bilibili 评论与动态中的疑似广告和垃圾内容',
    permissions: ['storage', 'alarms'],
    host_permissions: [],
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'BiliBlocker',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // 仅 E2E 测试构建（out-e2e）时追加 localhost 匹配；生产构建不进入此分支。
      patchContentScriptsForE2E(manifest, mode.isE2E);
    },
  },
});

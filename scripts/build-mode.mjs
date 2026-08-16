/**
 * 构建模式决策（P0-1）：E2E 与生产构建的隔离点。
 * 纯 JS 模块，wxt.config.ts 与单元测试共享同一逻辑来源。
 */

/** 根据环境变量解析构建模式 */
export function resolveBuildMode(env = process.env) {
  const isE2E = env.E2E === '1';
  return {
    isE2E,
    /** E2E 构建输出到独立目录，绝不触碰 out/ */
    outDir: isE2E ? 'out-e2e' : 'out',
    /** 编译期常量：生产包恒为 false（经 vite define + minify 消除 Mock 路径） */
    e2eDefine: isE2E ? 'true' : 'false',
  };
}

/** 仅 E2E 构建向内容脚本追加 localhost 匹配（生产构建不得追加） */
export function patchContentScriptsForE2E(manifest, isE2E) {
  if (isE2E && manifest.content_scripts) {
    for (const cs of manifest.content_scripts) {
      cs.matches.push('http://localhost/*', 'http://127.0.0.1/*');
    }
  }
  return manifest;
}

/** vite define：把编译期常量注入所有 bundle（E2E=true / 生产=false） */
export function viteDefine(mode) {
  return {
    define: {
      __BILIBLOCKER_E2E__: mode.e2eDefine,
    },
  };
}

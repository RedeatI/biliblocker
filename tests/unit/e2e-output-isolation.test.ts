/**
 * e2e-output-isolation：E2E=1 构建输出到 out-e2e/，绝不修改 out/chrome-mv3 或 out/edge-mv3。
 *
 * 通过共享纯逻辑模块 scripts/build-mode.mjs 验证：
 * - E2E=1 → outDir 'out-e2e'，e2eDefine 'true'
 * - 无 E2E → outDir 'out'，e2eDefine 'false'
 * 并验证 E2E 构建 hook 只追加 localhost 匹配、E2E global-setup 指向 out-e2e。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveBuildMode, patchContentScriptsForE2E, viteDefine } from '../../scripts/build-mode.mjs';

const ROOT = resolve(__dirname, '../..');

describe('e2e-output-isolation', () => {
  it('E2E=1 时 outDir 为 out-e2e，生产 outDir 为 out', () => {
    expect(resolveBuildMode({ E2E: '1' }).outDir).toBe('out-e2e');
    expect(resolveBuildMode({}).outDir).toBe('out');
    expect(resolveBuildMode({ E2E: undefined }).outDir).toBe('out');
  });

  it('__BILIBLOCKER_E2E__ 编译常量按模式隔离（vite define）', () => {
    const e2e = resolveBuildMode({ E2E: '1' });
    const prod = resolveBuildMode({});
    expect(viteDefine(e2e).define['__BILIBLOCKER_E2E__']).toBe('true');
    expect(viteDefine(prod).define['__BILIBLOCKER_E2E__']).toBe('false');
    expect(resolveBuildMode({ E2E: '1' }).e2eDefine).toBe('true');
    expect(resolveBuildMode({}).e2eDefine).toBe('false');
  });

  it('E2E 构建 hook 只在 E2E=1 时追加 localhost 匹配', () => {
    const manifest: { content_scripts?: Array<{ matches: string[] }> } = {
      content_scripts: [{ matches: ['https://www.bilibili.com/*'] }],
    };
    patchContentScriptsForE2E(manifest, true);
    expect(manifest.content_scripts?.[0]?.matches).toContain('http://localhost/*');
    expect(manifest.content_scripts?.[0]?.matches).toContain('http://127.0.0.1/*');

    const manifest2: { content_scripts?: Array<{ matches: string[] }> } = {
      content_scripts: [{ matches: ['https://www.bilibili.com/*'] }],
    };
    patchContentScriptsForE2E(manifest2, false);
    expect(manifest2.content_scripts?.[0]?.matches).toEqual(['https://www.bilibili.com/*']);
  });

  it('E2E global-setup 的 EXTENSION_PATH 指向 out-e2e/chrome-mv3', () => {
    const src = readFileSync(resolve(ROOT, 'tests/e2e/global-setup.ts'), 'utf8');
    expect(src).toContain('out-e2e/chrome-mv3');
    expect(src).not.toContain("'../../out/chrome-mv3'");
  });
});

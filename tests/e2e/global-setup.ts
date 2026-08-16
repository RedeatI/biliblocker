/**
 * E2E global setup：确保扩展以 E2E 配置构建（独立输出目录 out-e2e/chrome-mv3，
 * 内容脚本含 localhost 匹配、__BILIBLOCKER_E2E__=true）。
 *
 * 隔离保证（P0-1）：E2E 构建只写入 out-e2e/，绝不触碰 out/chrome-mv3、out/edge-mv3。
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = resolve(here, '../../out-e2e/chrome-mv3');

export default async function globalSetup(): Promise<void> {
  const manifest = resolve(EXTENSION_PATH, 'manifest.json');
  const marker = resolve(EXTENSION_PATH, '.e2e-built');
  const sourceNewer = isSourceNewer();
  if (existsSync(manifest) && existsSync(marker) && !sourceNewer) {
    console.log('[e2e] 使用已构建的 E2E 扩展（out-e2e/chrome-mv3）');
    return;
  }
  console.log('[e2e] 构建 E2E 扩展（E2E=1 pnpm build:chrome → out-e2e/chrome-mv3）…');
  execSync('pnpm build:chrome', {
    cwd: resolve(here, '../..'),
    stdio: 'inherit',
    env: { ...process.env, E2E: '1' },
    timeout: 300_000,
  });
  writeFileSync(marker, new Date().toISOString());
}

function isSourceNewer(): boolean {
  const srcDir = resolve(here, '../../src');
  const markerPath = resolve(EXTENSION_PATH, '.e2e-built');
  if (!existsSync(markerPath)) return true;
  const markerTime = statSync(markerPath).mtimeMs;
  const walk = (dir: string): boolean => {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isDirectory() && !name.startsWith('.')) {
        if (walk(p)) return true;
      } else if (st.isFile() && st.mtimeMs > markerTime) {
        return true;
      }
    }
    return false;
  };
  return walk(srcDir);
}

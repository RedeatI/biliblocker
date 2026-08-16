/**
 * Stage-E 交付包打包（biliblocker-v{version}-stage-e.zip）。
 *
 * 包含（与 Source ZIP 相同的源码集合）+ out/chrome-mv3 + out/edge-mv3 + dist/；
 * 排除：node_modules / .git / .wxt / test-results / playwright-report / coverage /
 * .workbuddy / 浏览器用户目录等（不含任何 Cookie / bili_jct / Access Token / 真实账号数据）。
 *
 * 用法：node scripts/stage-e-package.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip-util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.wxt', 'out-e2e', 'test-results', 'playwright-report', 'coverage', '.workbuddy', '__pycache__',
]);
const EXCLUDED_FILES = new Set(['.stage-dummy']);
/** 与 Source ZIP 一致：不排除 out/dist（Stage-E 包需要产物） */

function collectFiles() {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(name) || EXCLUDED_FILES.has(name) || name.startsWith('.stage-')) continue;
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(root, p).replace(/\\/g, '/'), readFileSync(p));
    }
  };
  walk(root);
  return out;
}

async function main() {
  if (!existsSync(resolve(root, 'dist/biliblocker-source-' + version + '.zip'))) {
    console.error('[stage-e] 缺少 dist/ 产物，请先执行 pnpm release');
    process.exit(1);
  }
  const files = collectFiles();
  const zipPath = resolve(root, `biliblocker-v${version}-stage-e.zip`);
  rmSync(zipPath, { force: true });
  await createZip(files, zipPath);
  const h = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  const size = statSync(zipPath).size;
  writeFileSync(resolve(root, `biliblocker-v${version}-stage-e.sha256.txt`), `${h}  biliblocker-v${version}-stage-e.zip\n`);
  console.log(`[stage-e] ${relative(root, zipPath)}（${files.size} 个文件，${size} bytes）`);
  console.log(`[stage-e] SHA-256: ${h}`);
  console.log(`[stage-e] 校验值已写入 biliblocker-v${version}-stage-e.sha256.txt`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

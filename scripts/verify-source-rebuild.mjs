/**
 * P0-4（v0.1.2）：Source ZIP 干净重建验证。
 *
 * 用法：node scripts/verify-source-rebuild.mjs [sourceZipPath]
 * 默认读取 dist/biliblocker-source-{version}.zip。
 *
 * 校验：
 * 1. Source ZIP 内文件集合与当前工作区（排除构建产物）一致（相对路径 + 内容 SHA-256）。
 * 2. Source ZIP 不含 node_modules/out/out-e2e/dist/.git/test-results 等。
 * 3. 关键产物清单（package.json / pnpm-lock.yaml / src / scripts / docs）逐一哈希一致。
 * 4. 打印差异；若 ZIP 字节时间戳不同（重新打包），内容哈希仍必须一致。
 *
 * 完整可复现验证（人工/CI）：
 *   mkdir clean && cd clean
 *   unzip ../dist/biliblocker-source-{version}.zip
 *   pnpm install --frozen-lockfile
 *   pnpm release
 *   比较重建 manifest.json、文件清单与关键产物哈希（见 docs/REMEDIATION-TRACE-v0.1.2.md）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from './zip-util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const EXCLUDED_DIRS = new Set([
  'node_modules', 'out', 'out-e2e', 'dist', '.wxt', '.git', 'test-results',
  'playwright-report', 'coverage', '.workbuddy', 'stage-e-review', '__pycache__',
]);
const EXCLUDED_FILES = new Set(['.stage-dummy']);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 当前工作区文件清单（相对路径 → sha256） */
function workspaceFiles() {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(name) || EXCLUDED_FILES.has(name) || name.startsWith('.stage-')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(root, p).replace(/\\/g, '/'), sha256(readFileSync(p)));
    }
  };
  walk(root);
  return out;
}

async function main() {
  const version = pkg.version;
  const zipPath = resolve(process.argv[2] ?? `dist/biliblocker-source-${version}.zip`);
  if (!existsSync(zipPath)) {
    console.error(`[verify] Source ZIP 不存在：${zipPath}`);
    console.error('[verify] 请先执行 pnpm release（阶段 D）');
    process.exit(1);
  }
  const entries = await readZipEntries(zipPath);
  const zipFiles = new Map();
  for (const e of entries) zipFiles.set(e.name, sha256(e.data));

  // 1. 文件集合比对
  const ws = workspaceFiles();
  const wsNames = new Set(ws.keys());
  const zipNames = new Set(zipFiles.keys());
  const onlyZip = [...zipNames].filter((n) => !wsNames.has(n)).sort();
  const onlyWs = [...wsNames].filter((n) => !zipNames.has(n)).sort();
  if (onlyZip.length > 0) {
    console.error('[verify] ❌ Source ZIP 中存在工作区没有的文件：');
    for (const n of onlyZip.slice(0, 20)) console.error('   ', n);
    process.exit(1);
  }
  if (onlyWs.length > 0) {
    console.error('[verify] ❌ 工作区存在但 Source ZIP 缺失的文件：');
    for (const n of onlyWs.slice(0, 20)) console.error('   ', n);
    process.exit(1);
  }

  // 2. 禁止目录检查
  const forbidden = ['node_modules/', 'out/', 'out-e2e/', 'dist/', '.git/', 'test-results/', '.wxt/'];
  const bad = [...zipNames].filter((n) => forbidden.some((f) => n.startsWith(f)));
  if (bad.length > 0) {
    console.error('[verify] ❌ Source ZIP 含禁止目录：', bad.slice(0, 10));
    process.exit(1);
  }

  // 3. 内容哈希一致性
  let diff = 0;
  for (const n of wsNames) {
    if (ws.get(n) !== zipFiles.get(n)) {
      diff++;
      console.error(`[verify] ❌ 内容哈希不一致：${n}`);
      if (diff > 20) break;
    }
  }
  if (diff > 0) {
    console.error(`[verify] ❌ ${diff} 个文件内容不一致（Source ZIP 与工作区不同步）`);
    process.exit(1);
  }

  console.log(`[verify] ✅ Source ZIP 文件集合与内容哈希完全一致（${wsNames.size} 个文件）`);
  console.log(`[verify] ✅ 无禁止目录/构建产物泄漏`);
  console.log('[verify] ✅ 干净重建前提满足：解压后 pnpm install --frozen-lockfile && pnpm release 应可复现');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

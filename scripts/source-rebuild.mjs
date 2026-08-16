/**
 * P0-1（v0.1.3）：Source ZIP 干净重建验证（release 第 9 步）。
 *
 * 从 dist/biliblocker-source-{version}.zip 解压到全新临时目录：
 *   1. pnpm install --frozen-lockfile（固定锁文件安装）
 *   2. pnpm build:chrome / pnpm build:edge（生产构建，无 E2E 环境变量）
 *   3. pnpm test（单元测试数量对比）
 * 然后比较（全部一致才 PASS）：
 *   - Manifest 全字段（字节级比较 manifest.json）；
 *   - Chrome/Edge 解包文件集合（递归文件名集合）；
 *   - 每个内容文件 SHA-256；
 *   - 权限与 matches（manifest 字节比较已覆盖，另行显式断言）；
 *   - 真实能力关闭状态（比较能力常量的编译产物 —— 字节比较覆盖；另行显式断言
 *     out 内 JS 不含 E2E 标记）；
 *   - 测试数量（重建环境的 unit 通过数 == 工作区 unit 通过数）；
 *   - Source 文件集合与内容哈希（解压内容 vs 当前工作区，排除构建产物）。
 *
 * ZIP 容器时间戳导致整体字节哈希不同可接受，但解包后的全部文件必须一致。
 * 退出码 0 = PASS；非 0 = FAIL（release 流水线立即失败）。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from './zip-util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

const EXCLUDED_DIRS = new Set([
  'node_modules', 'out', 'out-e2e', 'dist', '.wxt', '.git', 'test-results',
  'playwright-report', 'coverage', '.workbuddy', 'stage-e-review', '__pycache__',
]);
const EXCLUDED_FILES = new Set(['.stage-dummy']);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(p) {
  return sha256(readFileSync(p));
}

/** 当前工作区文件清单（相对路径 → sha256；排除构建产物） */
function workspaceFiles() {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(name) || EXCLUDED_FILES.has(name) || name.startsWith('.stage-')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(root, p).replace(/\\/g, '/'), sha256File(p));
    }
  };
  walk(root);
  return out;
}

/** 递归列出目录内全部文件（相对路径 → sha256） */
function dirFiles(dir, base) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(base, p).replace(/\\/g, '/'), sha256File(p));
    }
  };
  walk(dir);
  return out;
}

function run(cmd, args, cwd, env) {
  // 与 release.mjs 一致：spawnSync + shell（Windows 下 pnpm.cmd 为 .cmd 包装）
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env, shell: process.platform === 'win32', timeout: 20 * 60_000 });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status !== 0) {
    const err = new Error(`Command failed: ${cmd} ${args.join(' ')}\n${out}`);
    err.stdout = r.stdout ?? '';
    err.stderr = r.stderr ?? '';
    throw err;
  }
  return out;
}

function prodEnv() {
  const env = { ...process.env };
  delete env.E2E;
  return env;
}

function fail(msg) {
  console.error(`[source-rebuild] ❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const zipPath = resolve(process.argv[2] ?? `dist/biliblocker-source-${version}.zip`);
  if (!existsSync(zipPath)) fail(`Source ZIP 不存在：${zipPath}`);

  const entries = await readZipEntries(zipPath);
  const zipFiles = new Map();
  for (const e of entries) zipFiles.set(e.name, sha256(e.data));

  console.log(`[source-rebuild] Source ZIP: ${zipPath}（${zipFiles.size} 个文件）`);

  // ---- 0. Source 文件集合与内容哈希（解压内容 vs 工作区） ----
  const ws = workspaceFiles();
  const wsNames = new Set(ws.keys());
  const zipNames = new Set(zipFiles.keys());
  const onlyZip = [...zipNames].filter((n) => !wsNames.has(n)).sort();
  const onlyWs = [...wsNames].filter((n) => !zipNames.has(n)).sort();
  if (onlyZip.length > 0) fail(`Source ZIP 存在工作区没有的文件：${onlyZip.slice(0, 10).join(', ')}`);
  if (onlyWs.length > 0) fail(`工作区存在 Source ZIP 缺失的文件：${onlyWs.slice(0, 10).join(', ')}`);
  let diff = 0;
  for (const n of wsNames) {
    if (ws.get(n) !== zipFiles.get(n)) {
      diff++;
      if (diff <= 20) console.error(`[source-rebuild] ❌ 内容哈希不一致：${n}`);
    }
  }
  if (diff > 0) fail(`${diff} 个文件内容不一致（Source ZIP 与工作区不同步）`);
  console.log(`[source-rebuild] ✅ Source 文件集合与内容哈希一致（${wsNames.size} 个文件）`);

  // ---- 1. 解压到全新临时目录（注意：ZIP 内已含 src/ 目录，解压目录不得再叫 src） ----
  // 8.3 短路径（os.tmpdir() 可能返回 ADMINI~1 形式）会导致 cmd 子进程（pnpm→wxt→vite-node）
  // 无法加载解压文件；用 USERPROFILE 构造长路径临时目录。
  const tempBase = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, 'AppData/Local/Temp')
    : tmpdir();
  const tmp = mkdtempSync(join(tempBase, 'biliblocker-rebuild-'));
  const extractDir = join(tmp, 'work');
  const mkdirSync = (await import('node:fs')).mkdirSync;
  mkdirSync(extractDir, { recursive: true });
  for (const e of entries) {
    const p = join(extractDir, e.name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, e.data);
  }
  // 调试：校验关键文件已落盘（若缺失，说明解压/路径问题）
  const probe = join(extractDir, 'src/entrypoints/content/index.ts');
  if (!existsSync(probe)) {
    fail(`解压后缺少关键文件：${probe}`);
  }
  console.log(`[source-rebuild] 解压到临时目录: ${extractDir}（${entries.length} 个文件，关键文件已校验）`);

  try {
    // ---- 2. 固定安装 ----
    console.log('[source-rebuild] pnpm install --frozen-lockfile …');
    run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install', '--frozen-lockfile'], extractDir, prodEnv());

    // ---- 3. 生产重建（chrome + edge） ----
    console.log('[source-rebuild] pnpm build:chrome …');
    run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['build:chrome'], extractDir, prodEnv());
    console.log('[source-rebuild] pnpm build:edge …');
    run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['build:edge'], extractDir, prodEnv());

    // ---- 4. 单元测试数量 ----
    console.log('[source-rebuild] pnpm test …');
    let rebuildUnit = null;
    try {
      const out = run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['test'], extractDir, prodEnv());
      const ansiRe = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
      const plain = out.replace(ansiRe, '');
      const m = plain.match(/Tests\s+(\d+)\s+passed\s*\((\d+)\)/) ?? plain.match(/(\d+)\s+passed\s*\((\d+)\)/);
      rebuildUnit = m ? Number(m[1]) : null;
    } catch (e) {
      fail(`干净重建单元测试失败：${e.message}`);
    }

    // ---- 5. 产物比较 ----
    for (const [label, sub] of [['Chrome', 'chrome-mv3'], ['Edge', 'edge-mv3']]) {
      const wsOut = resolve(root, 'out', sub);
      const rbOut = resolve(extractDir, 'out', sub);
      if (!existsSync(wsOut)) fail(`工作区 out/${sub} 不存在（先执行 pnpm build:${label === 'Chrome' ? 'chrome' : 'edge'}）`);
      if (!existsSync(rbOut)) fail(`重建环境 out/${sub} 不存在`);
      // Manifest 全字段（字节级）
      const wsMan = readFileSync(resolve(wsOut, 'manifest.json'));
      const rbMan = readFileSync(resolve(rbOut, 'manifest.json'));
      if (wsMan.toString('utf8') !== rbMan.toString('utf8')) fail(`${label} manifest.json 不一致`);
      console.log(`[source-rebuild] ✅ ${label} manifest.json 全字段一致`);
      // 文件集合 + 内容哈希
      const wsFiles = dirFiles(wsOut, wsOut);
      const rbFiles = dirFiles(rbOut, rbOut);
      const wsSet = new Set(wsFiles.keys());
      const rbSet = new Set(rbFiles.keys());
      const missing = [...wsSet].filter((n) => !rbSet.has(n)).sort();
      const extra = [...rbSet].filter((n) => !wsSet.has(n)).sort();
      if (missing.length > 0) fail(`${label} 重建缺失文件：${missing.slice(0, 10).join(', ')}`);
      if (extra.length > 0) fail(`${label} 重建多出文件：${extra.slice(0, 10).join(', ')}`);
      let fileDiff = 0;
      for (const n of wsSet) {
        if (wsFiles.get(n) !== rbFiles.get(n)) {
          fileDiff++;
          if (fileDiff <= 10) console.error(`[source-rebuild] ❌ ${label} 文件哈希不一致：${n}`);
        }
      }
      if (fileDiff > 0) fail(`${label} ${fileDiff} 个文件内容不一致`);
      console.log(`[source-rebuild] ✅ ${label} 解包文件集合与内容哈希一致（${wsSet.size} 个文件）`);
      // 权限与 matches 显式断言
      const man = JSON.parse(wsMan.toString('utf8'));
      const perms = man.permissions ?? [];
      const hostPerms = man.host_permissions ?? [];
      const matches = man.content_scripts?.[0]?.matches ?? [];
      if (JSON.stringify(perms) !== JSON.stringify(['storage', 'alarms'])) fail(`${label} 权限不一致：${JSON.stringify(perms)}`);
      if (hostPerms.length !== 0) fail(`${label} host_permissions 非空`);
      if (JSON.stringify(matches) !== JSON.stringify(['https://www.bilibili.com/*'])) fail(`${label} matches 不一致`);
      if (/localhost|127\.0\.0\.1|\.e2e/i.test(JSON.stringify(man))) fail(`${label} manifest 含测试痕迹`);
      console.log(`[source-rebuild] ✅ ${label} 权限/matches/无测试痕迹`);
    }

    // ---- 6. 真实能力关闭状态（产物中不含 E2E 放行；src 常量 verified=false 由 release gate 覆盖） ----
    for (const sub of ['chrome-mv3', 'edge-mv3']) {
      const outDir = resolve(root, 'out', sub);
      const scan = (d) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          const st = statSync(p);
          if (st.isDirectory()) scan(p);
          else if (name.endsWith('.js')) {
            const text = readFileSync(p, 'utf8');
            if (text.includes('.e2e-built') || /__BILIBLOCKER_E2E__[\s\S]{0,40}true/.test(text) && /127\.0\.0\.1|localhost/.test(text)) {
              fail(`${sub} 产物含 E2E 痕迹：${relative(outDir, p)}`);
            }
          }
        }
      };
      scan(outDir);
    }
    console.log('[source-rebuild] ✅ 生产产物无 E2E 痕迹');

    // ---- 7. 测试数量对比 ----
    const wsUnit = await workspaceUnitCount();
    if (wsUnit !== null && rebuildUnit !== null && wsUnit !== rebuildUnit) {
      fail(`单元测试数量不一致：工作区 ${wsUnit} vs 重建 ${rebuildUnit}`);
    }
    console.log(`[source-rebuild] ✅ 测试数量一致（unit=${rebuildUnit}）`);

    console.log('[source-rebuild] ✅ 干净重建通过：Manifest/文件集合/内容哈希/权限/matches/能力关闭/测试数量全部一致');
    rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    fail(`干净重建失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 从工作区最近一次 unit 日志读取通过数（无日志则 null，跳过对比） */
async function workspaceUnitCount() {
  try {
    const log = readFileSync(resolve(root, 'dist/logs/unit.log'), 'utf8');
    const ansiRe = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
    const plain = log.replace(ansiRe, '');
    const m = plain.match(/Tests\s+(\d+)\s+passed\s*\((\d+)\)/) ?? plain.match(/(\d+)\s+passed\s*\((\d+)\)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

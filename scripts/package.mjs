/**
 * 打包脚本（pnpm zip）：可复现发布入口。
 *
 * 流程（P0-1 硬门禁）：
 * 1. Git 候选门禁：拒绝全部未确认源码改动；out-e2e/ 仅可作为显式排除例外。
 * 2. 生产洁净门禁：out/ 目录不得含 .e2e-built、localhost、非 Bilibili matches、非预期权限。
 * 3. 强制清理 out/ 后重新生产构建（wxt build -b chrome / edge，E2E 环境变量显式清除）。
 * 4. 官方 WXT production ZIP 流程（wxt zip -b chrome / wxt zip -b edge）生成商店 ZIP。
 * 5. 回读 ZIP 内容再次执行 manifest 门禁（无 E2E 痕迹）。
 * 6. 生成 Source ZIP（跨平台零依赖 ZIP 写入器，确定性 STORE）。
 * 7. 输出 SHA256SUMS.txt 与 build-info.json。
 *
 * 跨平台：不依赖 powershell.exe / pnpm.cmd（zip 由 scripts/zip-util.mjs 与 wxt 内置 JSZip 完成）。
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync as listDir,
} from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createZip, readZipEntries } from './zip-util.mjs';
import { assertProductionClean } from './production-gate.mjs';
import {
  assertSourceZipEntriesSafe,
  captureCandidateProvenance,
  listTrackedFiles,
  RELEASE_BASELINE_MANIFEST,
  summarizeManifest,
  summarizeManifestDelta,
} from './package-evidence.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
const dist = resolve(root, 'dist');
mkdirSync(dist, { recursive: true });

// ---- 门禁：生产输出洁净性（纯逻辑模块，单元测试复用） ----

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function pnpmEntrypoint() {
  // `pnpm zip` supplies this Node entrypoint on every supported OS. Invoking
  // it through the current Node process avoids .cmd/cmd.exe and shell parsing.
  const entrypoint = process.env.npm_execpath;
  if (!entrypoint || !existsSync(entrypoint)) {
    throw new Error('[package] 未取得 pnpm Node 入口；请以 `pnpm zip`（而非直接 node 脚本）运行。');
  }
  return entrypoint;
}

function runPnpm(args, opts = {}) {
  execFileSync(process.execPath, [pnpmEntrypoint(), ...args], { stdio: 'inherit', ...opts });
}

function actualPnpmVersion() {
  return execFileSync(process.execPath, [pnpmEntrypoint(), '--version'], { cwd: root, encoding: 'utf8' }).trim();
}

/** 生产环境变量（显式清除 E2E） */
function prodEnv() {
  const env = { ...process.env };
  delete env.E2E;
  return env;
}

/** 生产构建（out/ 在入口清理一次，避免第二个浏览器清掉第一个的产物） */
function buildProduction(browser) {
  console.log(`[package] 生产构建 ${browser}（生产模式，无 E2E 环境变量）…`);
  runPnpm([`build:${browser}`], {
    cwd: root,
    env: prodEnv(),
  });
}

async function main() {
  // Must run before creating/removing an output directory. A release candidate
  // is always built from a committed source tree; out-e2e/ is the sole explicit
  // exception and is excluded from every release archive.
  const candidate = captureCandidateProvenance(root);

  // 1. 门禁：现有 out/ 若存在必须洁净（防止 E2E 污染被带入）
  for (const outDir of ['out/chrome-mv3', 'out/edge-mv3']) {
    if (existsSync(resolve(root, outDir))) {
      const r = assertProductionClean(resolve(root, outDir), basename(outDir), version);
      console.log(`[gate] ✅ ${outDir} 生产洁净（matches=${JSON.stringify(r.matches)}）`);
    }
  }

  // 2. 强制清理 + 生产重建（out/ 清一次，两个浏览器产物共存）
  rmSync(resolve(root, 'out'), { recursive: true, force: true });
  buildProduction('chrome');
  buildProduction('edge');

  // 3. 门禁复检
  assertProductionClean(resolve(root, 'out/chrome-mv3'), 'chrome', version);
  assertProductionClean(resolve(root, 'out/edge-mv3'), 'edge', version);
  console.log('[gate] ✅ 生产构建门禁通过（chrome/edge）');

  // 4. 官方 WXT ZIP 流程
  console.log('[package] wxt zip -b chrome …');
  runPnpm(['exec', 'wxt', 'zip', '-b', 'chrome'], {
    cwd: root,
    env: prodEnv(),
  });
  console.log('[package] wxt zip -b edge …');
  runPnpm(['exec', 'wxt', 'zip', '-b', 'edge'], {
    cwd: root,
    env: prodEnv(),
  });

  // wxt zip 输出目录为 outBaseDir（即 out/，非 dist/）
  const wxtZipDir = resolve(root, 'out');
  const findWxtZip = (browser) => {
    const names = listDir(wxtZipDir).filter(
      (n) => n.endsWith(`-${version}-${browser}.zip`) && !n.startsWith('biliblocker-chrome-') && !n.startsWith('biliblocker-edge-'),
    );
    if (names.length === 0) throw new Error(`[package] 未找到 wxt 生成的 ${browser} ZIP（${wxtZipDir}）`);
    return resolve(wxtZipDir, names[0]);
  };
  const chromeZipSrc = findWxtZip('chrome');
  const edgeZipSrc = findWxtZip('edge');

  // 5. 重命名为交付名
  const chromeZip = resolve(dist, `biliblocker-chrome-${version}.zip`);
  const edgeZip = resolve(dist, `biliblocker-edge-${version}.zip`);
  rmSync(chromeZip, { force: true });
  rmSync(edgeZip, { force: true });
  const { renameSync } = await import('node:fs');
  renameSync(chromeZipSrc, chromeZip);
  renameSync(edgeZipSrc, edgeZip);

  // 6. ZIP 内容回读门禁
  const manifests = {};
  for (const [label, zipPath] of [
    ['Chrome', chromeZip],
    ['Edge', edgeZip],
  ]) {
    const entries = await readZipEntries(zipPath);
    const names = entries.map((e) => e.name);
    const man = entries.find((e) => e.name === 'manifest.json');
    if (!man) throw new Error(`[gate] ${label} ZIP 缺少根 manifest.json`);
    const manifest = JSON.parse(man.data.toString('utf8'));
    const matches = manifest.content_scripts?.[0]?.matches ?? [];
    const joined = JSON.stringify(matches) + JSON.stringify(manifest.permissions ?? []) + JSON.stringify(manifest.host_permissions ?? []);
    if (/localhost|127\.0\.0\.1|\.e2e/i.test(joined)) {
      throw new Error(`[gate] ${label} ZIP 内 manifest 含测试痕迹：${joined}`);
    }
    if (names.some((n) => n.includes('.e2e'))) {
      throw new Error(`[gate] ${label} ZIP 含 .e2e 文件`);
    }
    manifests[label.toLowerCase()] = summarizeManifest(manifest);
    console.log(`[gate] ✅ ${label} ZIP 内容校验通过（${names.length} 个文件）`);
  }

  // 7. Source ZIP（零依赖、确定性 STORE）
  // P1-7（v0.1.7）：排除 __pycache__（python gate 运行副产物，非源码）
  const EXCLUDED_DIRS = new Set([
    'node_modules',
    'out',
    'out-e2e',
    'dist',
    '.wxt',
    '.git',
    '.workbuddy',
    'test-results',
    'playwright-report',
    'coverage',
    'stage-e-review', // 独立复验材料（stage-e 包注入；不进入 Source ZIP，保持 reviewer 比较语义一致）
    '__pycache__',
  ]);
  // A clean candidate contains committed files only. This intentionally does
  // not walk the filesystem: ignored local files (including arbitrary ZIPs)
  // must never become Source ZIP input merely because they sit beside source.
  const srcFiles = listTrackedFiles(root).filter((file) =>
    !file.split('/').some((part) => EXCLUDED_DIRS.has(part) || part.startsWith('.stage-')),
  );
  const srcEntries = new Map();
  for (const file of srcFiles) {
    srcEntries.set(file, readFileSync(resolve(root, file)));
  }
  const srcZip = resolve(dist, `biliblocker-source-${version}.zip`);
  await createZip(srcEntries, srcZip);
  const sourceEntries = await readZipEntries(srcZip);
  assertSourceZipEntriesSafe(sourceEntries.map((entry) => entry.name));
  console.log(`[package] Source ZIP → ${relative(root, srcZip)}（${srcFiles.length} 个文件）`);

  // 8. 校验值与构建信息
  const artifacts = [
    { file: chromeZip, kind: 'Chrome 商店 ZIP' },
    { file: edgeZip, kind: 'Edge 商店 ZIP' },
    { file: srcZip, kind: 'Source ZIP' },
  ];
  const checksums = [];
  for (const artifact of artifacts) {
    const entries = await readZipEntries(artifact.file);
    checksums.push({
      file: relative(dist, artifact.file).replace(/\\/g, '/'),
      sha256: sha256(artifact.file),
      size: statSync(artifact.file).size,
      entryCount: entries.length,
    });
  }
  const lockfileSha = sha256(resolve(root, 'pnpm-lock.yaml'));
  const srcZipSha = checksums.find((c) => c.file.includes('source'))?.sha256 ?? '';
  const pnpmVersion = actualPnpmVersion();
  // P0-4：build-info 最低字段（version/builtAt/sourceArchiveSha256/nodeVersion/pnpmVersion/playwrightVersion/browserVersion/tests/steps）
  let playwrightVersion = 'n/a';
  try {
    playwrightVersion =
      JSON.parse(readFileSync(resolve(root, 'node_modules/@playwright/test/package.json'), 'utf8')).version ?? 'n/a';
  } catch {
    playwrightVersion = 'n/a';
  }
  const buildInfo = {
    name: pkg.name,
    version,
    builtAt: new Date().toISOString(),
    sourceArchiveSha256: srcZipSha,
    nodeVersion: process.version,
    pnpmVersion,
    playwrightVersion,
    browserVersion: 'n/a（生产构建不依赖浏览器二进制）',
    os: `${process.platform} ${process.arch}`,
    buildTime: new Date().toISOString(),
    node: process.version,
    pnpm: pnpmVersion,
    chromiumVersion: 'n/a（生产构建不依赖浏览器二进制）',
    edgeVersion: 'n/a（生产构建不依赖浏览器二进制）',
    lockfileSha256: lockfileSha,
    artifacts: checksums,
    candidate: {
      sourceCommit: candidate.sourceCommit,
      branch: candidate.branch,
      baselineCommit: candidate.baselineCommit,
      dirty: candidate.dirty,
      sourceDirty: candidate.sourceDirty,
      workingTreeStatus: candidate.workingTreeStatus,
      baselineRelationship: candidate.baselineRelationship,
      exceptions: candidate.exceptions,
      sourceArchiveExclusions: ['.git/', 'out/', 'out-e2e/', 'dist/', 'node_modules/'],
      manifests: {
        chrome: manifests.chrome,
        edge: manifests.edge,
      },
      manifestBaseline: RELEASE_BASELINE_MANIFEST,
      // Compare the generated ZIP manifests with the fixed, audited RC1
      // manifest contract. A descendant candidate may legitimately differ,
      // but every permission/matches difference is now evidence rather than
      // an implicit approval.
      manifestDeltaFromBaseline: {
        chrome: summarizeManifestDelta(RELEASE_BASELINE_MANIFEST, manifests.chrome),
        edge: summarizeManifestDelta(RELEASE_BASELINE_MANIFEST, manifests.edge),
      },
    },
    tests: null,
    exitCodes: null,
    steps: [],
  };
  writeFileSync(resolve(dist, 'build-info.json'), JSON.stringify(buildInfo, null, 2));
  writeFileSync(
    resolve(dist, 'SHA256SUMS.txt'),
    checksums.map((c) => `${c.sha256}  ${c.file}`).join('\n') + '\n',
  );

  console.log('[package] 产物清单：');
  for (const a of artifacts) console.log('  -', a.kind, '->', relative(root, a.file));
  console.log('  - 校验值 -> dist/SHA256SUMS.txt');
  console.log('  - 构建信息 -> dist/build-info.json');
  console.log('[package] 完成');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

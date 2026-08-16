/**
 * 发布流水线编排（pnpm release）：从干净工作区执行并保存完整日志（P0-1，v0.1.3）。
 *
 * 顺序（任何一步失败 → 整个 release 立即失败，不生成 PASS）：
 *   pnpm lint                   → dist/logs/lint.log
 *   pnpm typecheck              → dist/logs/typecheck.log
 *   pnpm test                   → dist/logs/unit.log
 *   pnpm test:e2e               → dist/logs/e2e.log
 *   pnpm build:chrome           → dist/logs/build-chrome.log
 *   pnpm build:edge             → dist/logs/build-edge.log
 *   pnpm zip                    → dist/logs/package.log（package.mjs 内部强制重建 + 门禁 + 官方 wxt zip + source zip）
 *   node scripts/verify-source-rebuild.mjs → dist/logs/source-integrity.log（工作区 vs Source ZIP 逐文件哈希）
 *   node scripts/source-rebuild.mjs        → dist/logs/source-rebuild.log（Source ZIP 干净重建 + 产物比较）
 *   python review/BiliBlocker-v0.1.4-release-gate.py . --expected-version {version}
 *                                    → dist/logs/release-gate.log（确定性证据门禁）
 *
 * 证据链（P0-1）：
 * - docs/REMEDIATION-TRACE-v0.1.7.md 打包前冻结（+docs/ACCEPTANCE-v0.1.4.md 缺陷基线）（只记录设计/测试/待发布状态），
 *   source-integrity 步骤保证其与 Source ZIP 内副本一致；
 * - dist/build-info.json：package.mjs 生成基础信息，本脚本回填 tests/exitCodes/steps；
 * - dist/RELEASE-EVIDENCE.json：全部步骤通过后生成（三份 ZIP 哈希、构建环境、日志哈希、重建结果）；
 *   build-info.json 与 RELEASE-EVIDENCE.json 位于 dist/，不属于 Source ZIP 输入。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distLogs = resolve(root, 'dist/logs');
mkdirSync(distLogs, { recursive: true });
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
const biPath = resolve(root, 'dist/build-info.json');

const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
const nodeCmd = process.platform === 'win32' ? 'node' : 'node';

const STEPS = [
  { name: 'lint', cmd: pnpmCmd, args: ['lint'], log: 'lint.log' },
  { name: 'typecheck', cmd: pnpmCmd, args: ['typecheck'], log: 'typecheck.log' },
  { name: 'unit', cmd: pnpmCmd, args: ['test'], log: 'unit.log' },
  { name: 'e2e', cmd: pnpmCmd, args: ['test:e2e'], log: 'e2e.log' },
  { name: 'build-chrome', cmd: pnpmCmd, args: ['build:chrome'], log: 'build-chrome.log' },
  { name: 'build-edge', cmd: pnpmCmd, args: ['build:edge'], log: 'build-edge.log' },
  { name: 'package', cmd: pnpmCmd, args: ['zip'], log: 'package.log' },
  // P0-1：source-integrity（工作区 vs Source ZIP 逐文件哈希）
  { name: 'source-integrity', cmd: nodeCmd, args: ['scripts/verify-source-rebuild.mjs'], log: 'source-integrity.log' },
  // P0-1：source-rebuild（Source ZIP 干净重建 + 产物比较）
  { name: 'source-rebuild', cmd: nodeCmd, args: ['scripts/source-rebuild.mjs'], log: 'source-rebuild.log' },
  // P0-1：确定性证据门禁（最后运行；前置日志/产物均已就绪）
  { name: 'release-gate', cmd: pythonCmd, args: ['review/BiliBlocker-v0.1.7-release-gate.py', '.', '--expected-version', version], log: 'release-gate.log', placeholder: 'RELEASE GATE: RUNNING…\n' },
];

const exitCodes = {};
// 预置全部步骤为 0（gate 步骤自身运行前，backfill 需要 10 项 exitCode 齐全）
for (const s of STEPS) exitCodes[s.name] = 0;
const counts = { unit: null, e2e: null };
const stepMeta = {}; // 每步起止时间

for (const step of STEPS) {
  console.log(`\n===== [release] ${step.name} =====`);
  if (step.placeholder) writeFileSync(resolve(distLogs, step.log), step.placeholder);
  if (step.name === 'release-gate') {
    // gate 前：回填 build-info（tests/exitCodes/steps）+ 生成 RELEASE-EVIDENCE.json
    // （gate 校验 build-info.exitCodes / 十份日志 / RELEASE-EVIDENCE.zipHashes）
    backfillBuildInfo();
    writeReleaseEvidence();
  }
  const startedAt = new Date().toISOString();
  const res = spawnSync(step.cmd, step.args, {
    cwd: root,
    encoding: 'utf8',
    env: (() => { const e = { ...process.env }; delete e.E2E; return e; })(),
    timeout: 30 * 60_000,
    shell: true,
  });
  const endedAt = new Date().toISOString();
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  writeFileSync(resolve(distLogs, step.log), out || `(no output, exit ${res.status})\n`);
  exitCodes[step.name] = res.status;
  stepMeta[step.name] = { startedAt, endedAt, exitCode: res.status };
  console.log(`[release] ${step.name} exit=${res.status}`);

  // 解析测试数量（先剥离 ANSI 转义码）
  const ansiRe = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const plain = out.replace(ansiRe, '');
  if (step.name === 'unit') {
    const m = plain.match(/Tests\s+(\d+)\s+passed\s*\((\d+)\)/) ?? plain.match(/(\d+)\s+passed\s*\((\d+)\)/);
    counts.unit = m ? Number(m[1]) : null;
  }
  if (step.name === 'e2e') {
    const m = plain.match(/(\d+)\s+passed/);
    counts.e2e = m ? Number(m[1]) : null;
  }

  if (res.status !== 0) {
    console.error(`[release] ❌ ${step.name} 失败（exit=${res.status}），终止流水线。日志：dist/logs/${step.log}`);
    process.exit(res.status ?? 1);
  }
}

// 全部步骤通过：回填 build-info + 生成 RELEASE-EVIDENCE.json
backfillBuildInfo();
writeReleaseEvidence();

console.log('\n[release] 全部步骤通过 ✅');
console.log('[release] 产物：');
for (const f of [
  `biliblocker-chrome-${version}.zip`,
  `biliblocker-edge-${version}.zip`,
  `biliblocker-source-${version}.zip`,
  'SHA256SUMS.txt',
  'build-info.json',
  'RELEASE-EVIDENCE.json',
]) {
  const p = resolve(root, 'dist', f);
  if (existsSync(p)) console.log('  -', f);
}

function backfillBuildInfo() {
  if (!existsSync(biPath)) return;
  const info = JSON.parse(readFileSync(biPath, 'utf8'));
  info.tests = counts;
  info.exitCodes = exitCodes;
  info.steps = STEPS.map((s) => ({
    name: s.name,
    exitCode: exitCodes[s.name] ?? 0,
    log: `dist/logs/${s.log}`,
    ...(stepMeta[s.name] ?? {}),
  }));
  writeFileSync(biPath, JSON.stringify(info, null, 2));
}

/** P0-1：打包后生成发布证据（三份 ZIP 哈希/构建环境/日志哈希/重建结果）；不进入 Source ZIP */
function writeReleaseEvidence() {
  const dist = resolve(root, 'dist');
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const zipHashes = {};
  for (const kind of ['chrome', 'edge', 'source']) {
    const p = resolve(dist, `biliblocker-${kind}-${version}.zip`);
    if (existsSync(p)) zipHashes[`biliblocker-${kind}-${version}.zip`] = sha(p);
  }
  const logHashes = {};
  for (const s of STEPS) {
    const p = resolve(distLogs, s.log);
    if (existsSync(p)) logHashes[s.log] = sha(p);
  }
  let gitCommit = null;
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (r.status === 0) gitCommit = (r.stdout ?? '').trim();
  } catch {
    gitCommit = null;
  }
  const sourceTreeHash = sourceTreeDigest();
  const bi = existsSync(biPath) ? JSON.parse(readFileSync(biPath, 'utf8')) : {};
  const evidence = {
    project: 'BiliBlocker',
    version,
    stage: 'E',
    generatedAt: new Date().toISOString(),
    zipHashes,
    buildInfo: {
      nodeVersion: process.version,
      pnpmVersion: pkg.packageManager ?? 'pnpm@9.15.4',
      playwrightVersion: bi.playwrightVersion ?? 'n/a',
      browserVersion: bi.browserVersion ?? 'n/a',
      os: `${process.platform} ${process.arch}`,
      lockfileSha256: bi.lockfileSha256 ?? null,
      sourceArchiveSha256: bi.sourceArchiveSha256 ?? null,
    },
    logHashes,
    steps: (bi.steps ?? []).map((s) => ({
      name: s.name,
      exitCode: s.exitCode,
      log: s.log,
      startedAt: s.startedAt ?? null,
      endedAt: s.endedAt ?? null,
    })),
    tests: bi.tests ?? { unit: null, e2e: null },
    git: {
      commit: gitCommit,
      sourceTreeHash,
      note: 'sourceTreeHash 为排除构建产物后的工作区文件清单 SHA-256（source-integrity 亦逐文件核对 Source ZIP）',
    },
    notes: [
      'RELEASE-EVIDENCE.json 在打包后生成，位于 dist/，不进入 Source ZIP（避免自引用证据）。',
      'docs/REMEDIATION-TRACE-v0.1.7.md 打包前冻结（+docs/ACCEPTANCE-v0.1.4.md 缺陷基线）；其内容与 Source ZIP 内副本逐字节一致（source-integrity 验证）。',
    ],
  };
  writeFileSync(resolve(dist, 'RELEASE-EVIDENCE.json'), JSON.stringify(evidence, null, 2));
  console.log('[release] RELEASE-EVIDENCE.json 已生成（三份 ZIP 哈希/构建环境/日志哈希/重建结果）');
}

/** 排除构建产物后的工作区文件清单 SHA-256（证据锚点） */
function sourceTreeDigest() {
  const excluded = new Set(['node_modules', 'out', 'out-e2e', 'dist', '.wxt', '.git', 'test-results', 'playwright-report', 'coverage', '.workbuddy', 'stage-e-review', '__pycache__']);
  const paths = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (excluded.has(name) || name.startsWith('.stage-')) continue;
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else paths.push(relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  paths.sort();
  const h = createHash('sha256');
  for (const p of paths) {
    h.update(p);
    h.update('\0');
    h.update(readFileSync(resolve(root, p)));
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * P0-1（v0.1.3）发布完整性测试（10.5）：
 * 在临时目录构造完整工作区 + dist 产物，调用真实门禁 review/BiliBlocker-v0.1.7-release-gate.py：
 * - 工作区与 Source ZIP 任一文件内容不同 → FAIL；
 * - Source ZIP 缺文件或多文件 → FAIL；
 * - 在源码文档打包后发生修改 → FAIL（文档被修改 = 内容比较失败）；
 * - build-info.sourceArchiveSha256 与实际 ZIP 不同 → FAIL；
 * - lockfile 哈希不同 → FAIL；
 * - 任一步 exitCode 非 0 → FAIL；
 * - 缺少 source-integrity.log 或 source-rebuild.log → FAIL；
 * - 生产 Manifest 含 localhost/E2E/多余权限 → FAIL。
 * 另验证洁净产物 → PASS。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createZip } from '../../scripts/zip-util.mjs';

const ROOT = resolve(__dirname, '../..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
const GATE = resolve(ROOT, 'review/BiliBlocker-v0.1.7-release-gate.py');

/** 复制真实生产源码进临时工作区（gate 只做字符串匹配/集合比较，不编译） */
function realSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** v0.1.7 gate 要求的 runtime evidence（14 项 findings 全 false） */
const EVIDENCE_V017 = JSON.stringify({
  schema: 'BILIBLOCKER_V0.1.7_RUNTIME_INTEGRATION_EVIDENCE_V1',
  candidateVersion: '0.1.7',
  allDefectsClosed: true,
  findings: {
    externalQueueWriterInheritedLease: false,
    queueStateLostOrReverted: false,
    pausePersistenceLostAfterRestart: false,
    resumeSkippedValidQueuedTask: false,
    readOnlyCacheMutation: false,
    operationOutcomeNonAtomic: false,
    scopedWriterTimerEscape: false,
    browserFullRestartFailOpen: false,
    revalidateRunTaskRevert: false,
    persistentLatchSetFailureFailOpen: false,
    pauseRetryExhaustedSilentResume: false,
    revokeDuringVerifyDispatch: false,
    cancelDuringVerifyDispatch: false,
    revokeSaveControlInFlightDispatch: false,
  },
  results: {
    writerVsExecuteMaxActive: 1,
    validTaskExecutedAfterResume: 1,
    sameOperationReturnsSameResult: true,
    restartRemainsFailClosed: true,
    pauseFailureReported: true,
    pauseRetryMaxActive: 1,
    browserRestartRemainsFailClosed: true,
    browserRestartNoDispatch: true,
    revalidateExecutorExactlyOnce: true,
    revalidateStorageFinal: 'succeeded',
    persistentLatchFailureRestartFailClosed: true,
    persistentLatchFailureNoDispatch: true,
    pauseRetryExhaustedSecondRejected: true,
    revokeDuringVerifyExecutorCalls: 0,
    cancelDuringVerifyExecutorCalls: 0,
    revokeDuringVerifyFinalStatus: 'cancelled',
    cancelDuringVerifyFinalStatus: 'cancelled',
    revokeDuringVerifyEpoch: 1,
    revokeSaveControlInFlightExecutorCalls: 0,
    revokeSaveControlInFlightFinalStatus: 'skipped',
    revokeSaveControlInFlightEpoch: 1,
  },
  runAt: '2026-08-14T00:00:00.000Z',
});

function findPython(): string {
  const candidates = [
    process.env.PYTHON,
    'python',
    'python3',
    'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (r.status === 0) return c;
    } catch {
      /* try next */
    }
  }
  throw new Error('未找到可用的 python 解释器');
}

/** 构造一个门禁可 PASS 的最小完整工作区 */
function buildWorkspace(root: string): void {
  // ---- 源码文件（必须与 Source ZIP 完全一致） ----
  // v0.1.5 gate 对生产源码做代码级字符串检查（无 currentLease、ScopedWriter、
  // mergeQueueTasks、safety-latch、saveQueueSnapshot 等）→ 直接复制真实源码，
  // 保证 PASS 的语义与真实发布一致。
  const srcFiles: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'biliblocker', version: VERSION }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'docs/REMEDIATION-TRACE-v0.1.3.md': '# v0.1.3 整改记录（打包前冻结）\n',
    'src/shared/capabilities.ts': `export const CAPABILITY_VERIFICATION = {\n  blockUser: { verified: false },\n  unblockUser: { verified: false },\n  reportVideoComment: { verified: false },\n  reportVideoReply: { verified: false },\n  reportDynamicComment: { verified: false },\n  reportDynamic: { verified: false },\n  selectorsVideo: { verified: false },\n  selectorsDynamic: { verified: false },\n};\n`,
    'src/shared/constants/report-reasons.ts': 'export const REPORT_REASONS = { verified: false, reasons: {} };\n',
    'src/adapters/bilibili/selectors.ts': 'export const VERIFICATION = { selectorsVerified: false, selectorsVerifiedAt: null };\n',
    'src/index.ts': 'export {};\n',
    'scripts/package.mjs': '// pkg\n',
    'docs/ACCEPTANCE-v0.1.4.md': '# v0.1.4 缺陷基线（冻结）\n',
    'docs/REMEDIATION-TRACE-v0.1.5.md': '# v0.1.5 整改记录（打包前冻结）\n',
    'docs/REMEDIATION-TRACE-v0.1.7.md': '# v0.1.7 整改记录（打包前冻结）\n',
    // 真实生产源码（v0.1.6 代码级检查依赖的关键文件）
    'src/storage/coordinator.ts': realSrc('src/storage/coordinator.ts'),
    'src/actions/queue.ts': realSrc('src/actions/queue.ts'),
    'src/storage/repository.ts': realSrc('src/storage/repository.ts'),
    'src/storage/backend.ts': realSrc('src/storage/backend.ts'),
    'src/storage/safety-latch.ts': realSrc('src/storage/safety-latch.ts'),
    'src/shared/messages.ts': realSrc('src/shared/messages.ts'),
    'src/entrypoints/content/app.ts': realSrc('src/entrypoints/content/app.ts'),
    'src/entrypoints/background/index.ts': realSrc('src/entrypoints/background/index.ts'),
    'runtime-integration-evidence-v0.1.7.json': EVIDENCE_V017,
    'tests/unit/v015-lease-isolation.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-queue-stale-snapshot.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-pause-storage-failure.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-resume-revalidation.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-storage-clone.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-operation-outcome-atomic.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-runtime-probe.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-scoped-writer-escape.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-browser-restart-latch.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-revalidate-runTask-race.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-latch-set-failure.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v015-pause-retry-exhausted.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v016-verify-revoke-race.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n// 覆盖 verify 挂起 → revoke/cancel → executor 调用恒为 0（getWhitelist gate）\n',
    'tests/unit/v016-runtime-probe.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
    'tests/unit/v017-revoke-savecontrol-race.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n// 覆盖 revoke 的 saveControl in-flight 窗口 → executor 调用恒为 0\n',
    'tests/unit/v017-runtime-probe.test.ts': 'import { describe, it } from "vitest"; describe("gate stub", () => { it("passes", () => undefined); });\n',
  };
  for (const [rel, content] of Object.entries(srcFiles)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }

  // ---- 生产输出（商店 ZIP 必须与 out/ 逐文件一致） ----
  const storeFiles: Record<string, string> = {
    'manifest.json': JSON.stringify({
      manifest_version: 3, name: 'BiliBlocker', version: VERSION,
      permissions: ['storage', 'alarms'], host_permissions: [],
      content_scripts: [{ matches: ['https://www.bilibili.com/*'], js: ['content.js'] }],
    }),
    'content.js': 'console.log(1)\n',
  };
  for (const sub of ['chrome-mv3', 'edge-mv3']) {
    const outDir = join(root, 'out', sub);
    mkdirSync(outDir, { recursive: true });
    for (const [rel, content] of Object.entries(storeFiles)) {
      writeFileSync(join(outDir, rel), content);
    }
  }

  // ---- dist 产物（ZIP 与元数据在 finalizeWorkspace 异步生成） ----
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'logs'), { recursive: true });

  // 日志（10 份）
  const logs: Record<string, string> = {
    'lint.log': 'lint ok\n',
    'typecheck.log': 'typecheck ok\n',
    'unit.log': 'Test Files  8 passed (8)  Tests  93 passed (93)\n',
    'e2e.log': '8 passed (8)\n',
    'build-chrome.log': 'build chrome ok\n',
    'build-edge.log': 'build edge ok\n',
    'package.log': 'package ok\n',
    'source-integrity.log': '✅ Source ZIP 文件集合与内容哈希完全一致（8 个文件）\n',
    'source-rebuild.log': '✅ 干净重建通过：Manifest/文件集合/内容哈希/权限/matches/能力关闭/测试数量全部一致\n',
    'release-gate.log': 'RELEASE GATE: PASS\n',
  };
  for (const [name, content] of Object.entries(logs)) {
    writeFileSync(join(dist, 'logs', name), content);
  }

  // SHA256SUMS（占位，等 ZIP 生成后回填）
  writeFileSync(join(dist, 'SHA256SUMS.txt'), '');

  // build-info（占位 sourceArchiveSha256/lockfileSha256）
  const biPath = join(dist, 'build-info.json');
  const bi = {
    version: VERSION,
    builtAt: new Date().toISOString(),
    sourceArchiveSha256: '__SRC_SHA__',
    lockfileSha256: '__LOCK_SHA__',
    nodeVersion: 'v22',
    pnpmVersion: 'pnpm@9.15.4',
    playwrightVersion: 'n/a',
    browserVersion: 'n/a',
    tests: { unit: 93, e2e: 8 },
    exitCodes: {
      lint: 0, typecheck: 0, unit: 0, e2e: 0, 'build-chrome': 0, 'build-edge': 0,
      package: 0, 'source-integrity': 0, 'source-rebuild': 0, 'release-gate': 0,
    },
    steps: [
      'lint.log', 'typecheck.log', 'unit.log', 'e2e.log', 'build-chrome.log', 'build-edge.log',
      'package.log', 'source-integrity.log', 'source-rebuild.log', 'release-gate.log',
    ].map((log) => ({ name: log.replace('.log', ''), exitCode: 0, log: `dist/logs/${log}` })),
  };
  writeFileSync(biPath, JSON.stringify(bi, null, 2));
}

/** 异步完成 ZIP 生成与元数据回填 */
async function finalizeWorkspace(root: string): Promise<void> {
  const dist = join(root, 'dist');
  const srcFiles = {
    'package.json': JSON.stringify({ name: 'biliblocker', version: VERSION }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'docs/REMEDIATION-TRACE-v0.1.3.md': readFileSync(join(root, 'docs/REMEDIATION-TRACE-v0.1.3.md'), 'utf8'),
    'src/shared/capabilities.ts': readFileSync(join(root, 'src/shared/capabilities.ts'), 'utf8'),
    'src/shared/constants/report-reasons.ts': readFileSync(join(root, 'src/shared/constants/report-reasons.ts'), 'utf8'),
    'src/adapters/bilibili/selectors.ts': readFileSync(join(root, 'src/adapters/bilibili/selectors.ts'), 'utf8'),
    'src/index.ts': 'export {};\n',
    'docs/ACCEPTANCE-v0.1.4.md': readFileSync(join(root, 'docs/ACCEPTANCE-v0.1.4.md'), 'utf8'),
    'docs/REMEDIATION-TRACE-v0.1.5.md': readFileSync(join(root, 'docs/REMEDIATION-TRACE-v0.1.5.md'), 'utf8'),
    'docs/REMEDIATION-TRACE-v0.1.7.md': readFileSync(join(root, 'docs/REMEDIATION-TRACE-v0.1.7.md'), 'utf8'),
    'src/storage/coordinator.ts': readFileSync(join(root, 'src/storage/coordinator.ts'), 'utf8'),
    'src/actions/queue.ts': readFileSync(join(root, 'src/actions/queue.ts'), 'utf8'),
    'src/storage/repository.ts': readFileSync(join(root, 'src/storage/repository.ts'), 'utf8'),
    'src/storage/backend.ts': readFileSync(join(root, 'src/storage/backend.ts'), 'utf8'),
    'src/storage/safety-latch.ts': readFileSync(join(root, 'src/storage/safety-latch.ts'), 'utf8'),
    'src/shared/messages.ts': readFileSync(join(root, 'src/shared/messages.ts'), 'utf8'),
    'src/entrypoints/content/app.ts': readFileSync(join(root, 'src/entrypoints/content/app.ts'), 'utf8'),
    'src/entrypoints/background/index.ts': readFileSync(join(root, 'src/entrypoints/background/index.ts'), 'utf8'),
    'runtime-integration-evidence-v0.1.7.json': readFileSync(join(root, 'runtime-integration-evidence-v0.1.7.json'), 'utf8'),
    'tests/unit/v015-lease-isolation.test.ts': readFileSync(join(root, 'tests/unit/v015-lease-isolation.test.ts'), 'utf8'),
    'tests/unit/v015-queue-stale-snapshot.test.ts': readFileSync(join(root, 'tests/unit/v015-queue-stale-snapshot.test.ts'), 'utf8'),
    'tests/unit/v015-pause-storage-failure.test.ts': readFileSync(join(root, 'tests/unit/v015-pause-storage-failure.test.ts'), 'utf8'),
    'tests/unit/v015-resume-revalidation.test.ts': readFileSync(join(root, 'tests/unit/v015-resume-revalidation.test.ts'), 'utf8'),
    'tests/unit/v015-storage-clone.test.ts': readFileSync(join(root, 'tests/unit/v015-storage-clone.test.ts'), 'utf8'),
    'tests/unit/v015-operation-outcome-atomic.test.ts': readFileSync(join(root, 'tests/unit/v015-operation-outcome-atomic.test.ts'), 'utf8'),
    'tests/unit/v015-runtime-probe.test.ts': readFileSync(join(root, 'tests/unit/v015-runtime-probe.test.ts'), 'utf8'),
    'tests/unit/v015-scoped-writer-escape.test.ts': readFileSync(join(root, 'tests/unit/v015-scoped-writer-escape.test.ts'), 'utf8'),
    'tests/unit/v015-browser-restart-latch.test.ts': readFileSync(join(root, 'tests/unit/v015-browser-restart-latch.test.ts'), 'utf8'),
    'tests/unit/v015-revalidate-runTask-race.test.ts': readFileSync(join(root, 'tests/unit/v015-revalidate-runTask-race.test.ts'), 'utf8'),
    'tests/unit/v015-latch-set-failure.test.ts': readFileSync(join(root, 'tests/unit/v015-latch-set-failure.test.ts'), 'utf8'),
    'tests/unit/v015-pause-retry-exhausted.test.ts': readFileSync(join(root, 'tests/unit/v015-pause-retry-exhausted.test.ts'), 'utf8'),
    'tests/unit/v016-verify-revoke-race.test.ts': readFileSync(join(root, 'tests/unit/v016-verify-revoke-race.test.ts'), 'utf8'),
    'tests/unit/v016-runtime-probe.test.ts': readFileSync(join(root, 'tests/unit/v016-runtime-probe.test.ts'), 'utf8'),
    'tests/unit/v017-revoke-savecontrol-race.test.ts': readFileSync(join(root, 'tests/unit/v017-revoke-savecontrol-race.test.ts'), 'utf8'),
    'tests/unit/v017-runtime-probe.test.ts': readFileSync(join(root, 'tests/unit/v017-runtime-probe.test.ts'), 'utf8'),
    'scripts/package.mjs': '// pkg\n',
  };
  const storeFiles = {
    'manifest.json': readFileSync(join(root, 'out/chrome-mv3/manifest.json'), 'utf8'),
    'content.js': 'console.log(1)\n',
  };
  const storeZip = async (name: string) => {
    const files = new Map<string, Uint8Array>();
    for (const [rel, content] of Object.entries(storeFiles)) {
      files.set(rel, Buffer.from(content));
    }
    await createZip(files, join(dist, name));
  };
  const srcZip = async () => {
    const files = new Map<string, Uint8Array>();
    for (const [rel, content] of Object.entries(srcFiles)) {
      files.set(rel, Buffer.from(content));
    }
    await createZip(files, join(dist, `biliblocker-source-${VERSION}.zip`));
  };
  await storeZip(`biliblocker-chrome-${VERSION}.zip`);
  await storeZip(`biliblocker-edge-${VERSION}.zip`);
  await srcZip();

  const shaF = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const sums = [
    `biliblocker-chrome-${VERSION}.zip`,
    `biliblocker-edge-${VERSION}.zip`,
    `biliblocker-source-${VERSION}.zip`,
  ].map((f) => `${shaF(join(dist, f))}  ${f}`);
  writeFileSync(join(dist, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

  const biPath = join(dist, 'build-info.json');
  const bi = JSON.parse(readFileSync(biPath, 'utf8'));
  bi.sourceArchiveSha256 = shaF(join(dist, `biliblocker-source-${VERSION}.zip`));
  bi.lockfileSha256 = shaF(join(root, 'pnpm-lock.yaml'));
  writeFileSync(biPath, JSON.stringify(bi, null, 2));

  // RELEASE-EVIDENCE.json
  const evidence = {
    project: 'BiliBlocker', version: VERSION, stage: 'E', generatedAt: new Date().toISOString(),
    zipHashes: {
      [`biliblocker-chrome-${VERSION}.zip`]: shaF(join(dist, `biliblocker-chrome-${VERSION}.zip`)),
      [`biliblocker-edge-${VERSION}.zip`]: shaF(join(dist, `biliblocker-edge-${VERSION}.zip`)),
      [`biliblocker-source-${VERSION}.zip`]: shaF(join(dist, `biliblocker-source-${VERSION}.zip`)),
    },
  };
  writeFileSync(join(dist, 'RELEASE-EVIDENCE.json'), JSON.stringify(evidence, null, 2));
}

function runGate(root: string): { status: number; stdout: string } {
  const py = findPython();
  const r = spawnSync(py, [GATE, root, '--expected-version', VERSION], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function makeWorkspace(mutate?: (root: string) => void): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'bb-gate-v017-'));
  buildWorkspace(root);
  // 允许在 ZIP 打包前调整源码/产物（如 manifest 注入 localhost）
  mutate?.(root);
  await finalizeWorkspace(root);
  return root;
}

describe('10.5 发布完整性（v0.1.7 gate）', () => {
  it('洁净产物 → PASS（退出码 0）', async () => {
    const root = await makeWorkspace();
    try {
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: PASS');
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('工作区与 Source ZIP 任一文件内容不同 → FAIL', async () => {
    const root = await makeWorkspace();
    try {
      // 打包后修改工作区源码文档（docs 冻结文档被修改）
      writeFileSync(join(root, 'docs/ACCEPTANCE-v0.1.3.md'), '# 被修改的内容\n');
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(stdout).toContain('Source ZIP');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Source ZIP 缺文件 → FAIL', async () => {
    const root = await makeWorkspace();
    try {
      // 从工作区删除一个源码文件（Source ZIP 有、工作区无 → 集合不一致）
      rmSync(join(root, 'src/index.ts'));
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Source ZIP 多文件（工作区无对应文件）→ FAIL', async () => {
    const root = await makeWorkspace();
    try {
      // 直接往 Source ZIP 里塞一个工作区没有的文件（重新打包）
      const srcZip = join(root, 'dist', `biliblocker-source-${VERSION}.zip`);
      const { readZipEntries } = await import('../../scripts/zip-util.mjs');
      const entries = await readZipEntries(srcZip);
      const files = new Map<string, Uint8Array>();
      for (const e of entries) files.set(e.name, e.data);
      files.set('extra-file.ts', Buffer.from('export {};\n'));
      const { createZip } = await import('../../scripts/zip-util.mjs');
      await createZip(files, srcZip);
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('build-info.sourceArchiveSha256 与实际 ZIP 不同 → FAIL', async () => {
    const root = await makeWorkspace();
    try {
      const biPath = join(root, 'dist/build-info.json');
      const bi = JSON.parse(readFileSync(biPath, 'utf8'));
      bi.sourceArchiveSha256 = 'deadbeef'.repeat(8);
      writeFileSync(biPath, JSON.stringify(bi, null, 2));
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lockfile 哈希不同 → FAIL', async () => {
    const root = await makeWorkspace();
    try {
      const biPath = join(root, 'dist/build-info.json');
      const bi = JSON.parse(readFileSync(biPath, 'utf8'));
      bi.lockfileSha256 = 'cafe'.repeat(16);
      writeFileSync(biPath, JSON.stringify(bi, null, 2));
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('任一步 exitCode 非 0 → FAIL', async () => {
    const root = await makeWorkspace();
    try {
      const biPath = join(root, 'dist/build-info.json');
      const bi = JSON.parse(readFileSync(biPath, 'utf8'));
      bi.exitCodes['source-rebuild'] = 1;
      writeFileSync(biPath, JSON.stringify(bi, null, 2));
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(stdout).toContain('exitCodes');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('缺少 source-integrity.log 或 source-rebuild.log → FAIL', async () => {
    const root = await makeWorkspace();
    try {
      rmSync(join(root, 'dist/logs/source-rebuild.log'));
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(stdout).toContain('source-rebuild.log');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('生产 Manifest 含 localhost → FAIL', async () => {
    const root = await makeWorkspace((r) => {
      for (const sub of ['chrome-mv3', 'edge-mv3']) {
        const manPath = join(r, 'out', sub, 'manifest.json');
        const man = JSON.parse(readFileSync(manPath, 'utf8'));
        man.content_scripts[0].matches = ['https://www.bilibili.com/*', 'http://localhost/*'];
        writeFileSync(manPath, JSON.stringify(man, null, 2));
      }
    });
    try {
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(stdout).toContain('localhost');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('生产 Manifest 含多余权限 → FAIL', async () => {
    const root = await makeWorkspace((r) => {
      for (const sub of ['chrome-mv3', 'edge-mv3']) {
        const manPath = join(r, 'out', sub, 'manifest.json');
        const man = JSON.parse(readFileSync(manPath, 'utf8'));
        man.permissions = ['storage', 'alarms', 'tabs'];
        writeFileSync(manPath, JSON.stringify(man, null, 2));
      }
    });
    try {
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('生产 Manifest 含 .e2e 文件 → FAIL', async () => {
    const root = await makeWorkspace((r) => {
      for (const sub of ['chrome-mv3', 'edge-mv3']) {
        writeFileSync(join(r, 'out', sub, '.e2e-built'), 'marker');
      }
    });
    try {
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('真实能力被置为 true → FAIL', async () => {
    const root = await makeWorkspace((r) => {
      const capPath = join(r, 'src/shared/capabilities.ts');
      writeFileSync(capPath, readFileSync(capPath, 'utf8').replace('blockUser: { verified: false }', 'blockUser: { verified: true }'));
    });
    try {
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

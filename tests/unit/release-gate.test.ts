/**
 * release-gate：发布门禁脚本（review/release_gate.py）必须：
 * - 对洁净产物返回 PASS（退出码 0）；
 * - 人为加入 localhost 或 .e2e-built 时返回 FAIL（非 0 退出码）。
 * 在临时目录构造完整 dist 树后调用真实脚本验证。
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
// VERSION 与门禁脚本一致：取自 package.json（唯一来源）
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

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

function validManifest(extraMatches: string[] = []): string {
  return JSON.stringify({
    manifest_version: 3,
    name: 'BiliBlocker',
    version: VERSION,
    permissions: ['storage', 'alarms'],
    host_permissions: [],
    content_scripts: [
      { matches: ['https://www.bilibili.com/*', ...extraMatches], js: ['content.js'] },
    ],
  });
}

async function buildDistTree(root: string, opts: { localhost?: boolean; e2eMarker?: boolean } = {}): Promise<void> {
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'logs'), { recursive: true });

  // 商店 ZIP（含合法 manifest 与内容脚本）
  const storeZip = (_name: string) => {
    const manifest = validManifest(opts.localhost ? ['http://localhost/*'] : []);
    const files = new Map<string, Uint8Array>();
    files.set('manifest.json', Buffer.from(manifest));
    files.set('content.js', Buffer.from('console.log(1)'));
    if (opts.e2eMarker) files.set('.e2e-built', Buffer.from('marker'));
    return files;
  };
  await createZip(storeZip('chrome'), join(dist, `biliblocker-chrome-${VERSION}.zip`));
  await createZip(storeZip('edge'), join(dist, `biliblocker-edge-${VERSION}.zip`));

  // Source ZIP（最小可校验结构）
  const srcFiles = new Map<string, Uint8Array>();
  srcFiles.set('package.json', Buffer.from(JSON.stringify({ name: 'biliblocker', version: VERSION })));
  srcFiles.set('pnpm-lock.yaml', Buffer.from('lockfileVersion: \'9.0\'\n'));
  srcFiles.set('src/index.ts', Buffer.from('export {};\n'));
  srcFiles.set('scripts/package.mjs', Buffer.from('// pkg\n'));
  await createZip(srcFiles, join(dist, `biliblocker-source-${VERSION}.zip`));

  // 日志（门禁要求非空且含通过统计；P0-4 要求 8 份日志）
  writeFileSync(join(dist, 'logs/lint.log'), 'lint ok\n');
  writeFileSync(join(dist, 'logs/typecheck.log'), 'typecheck ok\n');
  writeFileSync(join(dist, 'logs/unit.log'), 'Test Files  8 passed (8)  Tests  93 passed (93)\n');
  writeFileSync(join(dist, 'logs/e2e.log'), '8 passed (8)\n');
  writeFileSync(join(dist, 'logs/build-chrome.log'), 'build chrome ok\n');
  writeFileSync(join(dist, 'logs/build-edge.log'), 'build edge ok\n');
  writeFileSync(join(dist, 'logs/package.log'), 'package ok\n');
  writeFileSync(join(dist, 'logs/release-gate.log'), 'pending\n');

  // 校验值（真实计算）
  const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const lines = [
    `biliblocker-chrome-${VERSION}.zip`,
    `biliblocker-edge-${VERSION}.zip`,
    `biliblocker-source-${VERSION}.zip`,
  ].map((f) => `${sha(join(dist, f))}  ${f}`);
  writeFileSync(join(dist, 'SHA256SUMS.txt'), lines.join('\n') + '\n');

  // P0-4：build-info 最低字段
  writeFileSync(
    join(dist, 'build-info.json'),
    JSON.stringify({
      version: VERSION,
      builtAt: new Date().toISOString(),
      sourceArchiveSha256: 'x',
      nodeVersion: 'v22',
      pnpmVersion: 'pnpm@9.15.4',
      playwrightVersion: 'n/a',
      browserVersion: 'n/a',
      tests: { unit: 93, e2e: 8 },
      steps: [
        { name: 'lint', exitCode: 0, log: 'dist/logs/lint.log' },
        { name: 'typecheck', exitCode: 0, log: 'dist/logs/typecheck.log' },
        { name: 'unit', exitCode: 0, log: 'dist/logs/unit.log' },
        { name: 'e2e', exitCode: 0, log: 'dist/logs/e2e.log' },
        { name: 'build-chrome', exitCode: 0, log: 'dist/logs/build-chrome.log' },
        { name: 'build-edge', exitCode: 0, log: 'dist/logs/build-edge.log' },
        { name: 'package', exitCode: 0, log: 'dist/logs/package.log' },
        { name: 'release-gate', exitCode: 0, log: 'dist/logs/release-gate.log' },
      ],
    }),
  );
}

function runGate(root: string): { status: number; stdout: string } {
  const py = findPython();
  const r = spawnSync(py, [resolve(ROOT, 'review/release_gate.py'), root], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('release-gate', () => {
  it('洁净产物 → PASS（退出码 0）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-gate-dist-'));
    try {
      await buildDistTree(root);
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: PASS');
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('人为加入 localhost matches → FAIL（非 0 退出码）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-gate-dist-'));
    try {
      await buildDistTree(root, { localhost: true });
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('人为加入 .e2e-built 文件 → FAIL（非 0 退出码）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-gate-dist-'));
    try {
      await buildDistTree(root, { e2eMarker: true });
      const { status, stdout } = runGate(root);
      expect(stdout).toContain('RELEASE GATE: FAIL');
      expect(status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

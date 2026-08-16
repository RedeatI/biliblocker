/**
 * release-manifest：生产 Chrome/Edge manifest 只包含 Bilibili。
 * 直接测试生产门禁纯逻辑（scripts/production-gate.mjs），用临时目录构造 manifest fixture。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertProductionClean,
  EXPECTED_CONTENT_MATCHES,
  EXPECTED_DESCRIPTION,
  EXPECTED_HOST_PERMISSIONS,
  EXPECTED_PERMISSIONS,
} from '../../scripts/production-gate.mjs';

// 版本与 package.json 保持一致（门禁脚本从 package.json 读取）
const VERSION = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version as string;

function makeOutDir(overrides: {
  matches?: string[];
  permissions?: string[];
  host_permissions?: string[];
  description?: string;
  e2eMarker?: boolean;
  version?: string;
  extraFileContent?: { name: string; content: string };
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-gate-'));
  const manifest = {
    manifest_version: 3,
    name: 'BiliBlocker',
    description: overrides.description ?? EXPECTED_DESCRIPTION,
    version: overrides.version ?? VERSION,
    permissions: overrides.permissions ?? EXPECTED_PERMISSIONS,
    host_permissions: overrides.host_permissions ?? EXPECTED_HOST_PERMISSIONS,
    content_scripts: [{ matches: overrides.matches ?? EXPECTED_CONTENT_MATCHES, js: ['content.js'] }],
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'content.js'), 'console.log("ok")');
  if (overrides.e2eMarker) writeFileSync(join(dir, '.e2e-built'), 'marker');
  if (overrides.extraFileContent) {
    writeFileSync(join(dir, overrides.extraFileContent.name), overrides.extraFileContent.content);
  }
  return dir;
}

describe('release-manifest：生产 manifest 门禁', () => {
  it('标准生产 manifest 通过（Chrome/Edge 语义一致）', () => {
    const dir = makeOutDir({});
    try {
      const r = assertProductionClean(dir, 'chrome', VERSION);
      expect(r.matches).toEqual(EXPECTED_CONTENT_MATCHES);
      expect(r.permissions).toEqual(EXPECTED_PERMISSIONS);
      expect(r.hostPerms).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非 Bilibili matches（localhost）必须失败', () => {
    const dir = makeOutDir({ matches: ['https://www.bilibili.com/*', 'http://localhost/*'] });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/localhost|matches/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('127.0.0.1 matches 必须失败', () => {
    const dir = makeOutDir({ matches: ['https://www.bilibili.com/*', 'http://127.0.0.1/*'] });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/127\.0\.0\.1|matches/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非 https://www.bilibili.com/* 的合法域名（如 youtube）必须失败', () => {
    const dir = makeOutDir({ matches: ['https://www.youtube.com/*'] });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/matches/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.e2e-built 标记必须失败', () => {
    const dir = makeOutDir({ e2eMarker: true });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/e2e-built/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件内容含 .e2e-built 标记必须失败（全文件扫描）', () => {
    const dir = makeOutDir({ extraFileContent: { name: 'background.js', content: '/* .e2e-built */ console.log(1)' } });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/e2e-built/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非预期 permissions（如 cookies）必须失败', () => {
    const dir = makeOutDir({ permissions: ['storage', 'alarms', 'cookies'] });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/permission/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非预期 host_permissions（如 api.bilibili.com）必须失败', () => {
    const dir = makeOutDir({ host_permissions: ['https://api.bilibili.com/*'] });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/host_permission/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manifest.version 与 package version 不一致必须失败', () => {
    const dir = makeOutDir({ version: '9.9.9' });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manifest 描述不得把默认关闭且未验证的官方能力宣传为现成功能', () => {
    const dir = makeOutDir({ description: '一键拉黑并举报机器人账号' });
    try {
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow(/description|产品边界/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录不存在必须失败（不跳过构建）', () => {
    expect(() => assertProductionClean(join(tmpdir(), 'bb-missing-' + Date.now()), 'chrome', VERSION)).toThrow(
      /不存在/,
    );
  });

  it('E2E 与生产共享同一门禁：E2E 输出目录（out-e2e）不含 localhost 也会被拒绝？——否，门禁仅用于生产路径', () => {
    // out-e2e 不属于生产打包输入；门禁只作用于 out/chrome-mv3、out/edge-mv3（由 package.mjs 保证）
    const dir = makeOutDir({ matches: ['https://www.bilibili.com/*', 'http://localhost/*'] });
    try {
      // 该目录含 localhost → 生产门禁必须拒绝（即使它叫 out-e2e 也不允许被当作生产产物）
      expect(() => assertProductionClean(dir, 'chrome', VERSION)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

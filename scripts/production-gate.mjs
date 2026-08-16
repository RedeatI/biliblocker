/**
 * 生产产物洁净门禁（P0-1）：打包前/打包后检查生产输出。
 * 纯逻辑模块，可被 package.mjs 与单元测试共同引用。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export const EXPECTED_PERMISSIONS = ['storage', 'alarms'];
export const EXPECTED_HOST_PERMISSIONS = [];
export const EXPECTED_CONTENT_MATCHES = ['https://www.bilibili.com/*'];
export const EXPECTED_DESCRIPTION =
  '在本地标记、折叠并可恢复地管理 Bilibili 评论与动态中的疑似广告和垃圾内容';

/**
 * 校验生产输出目录洁净。
 * @throws 任一检查失败时抛出带原因的错误。
 */
export function assertProductionClean(outDir, browser, version) {
  const dir = resolve(outDir);
  if (!existsSync(dir)) {
    throw new Error(`[gate] ${outDir} 不存在：必须先执行生产构建（不得用 E2E 构建冒充）`);
  }
  if (existsSync(resolve(dir, '.e2e-built'))) {
    throw new Error(`[gate] ${outDir} 含 .e2e-built 标记：禁止打包 E2E 产物`);
  }
  const manifestPath = resolve(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`[gate] ${outDir} 缺少 manifest.json`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.description !== EXPECTED_DESCRIPTION) {
    throw new Error(
      `[gate] ${outDir} manifest.description 与已审核产品边界不一致：${JSON.stringify(manifest.description)}`,
    );
  }

  // 内容脚本 matches：必须恰好为 https://www.bilibili.com/*
  const cs = manifest.content_scripts ?? [];
  if (cs.length !== 1) {
    throw new Error(`[gate] ${outDir} content_scripts 数量异常（${cs.length}）`);
  }
  const matches = cs[0]?.matches ?? [];
  const bad = matches.filter((m) => !EXPECTED_CONTENT_MATCHES.includes(m));
  const missing = EXPECTED_CONTENT_MATCHES.filter((m) => !matches.includes(m));
  if (bad.length > 0 || missing.length > 0) {
    throw new Error(
      `[gate] ${outDir} content_scripts matches 不合法：${JSON.stringify(matches)}（期望 ${JSON.stringify(EXPECTED_CONTENT_MATCHES)}）`,
    );
  }
  const joined = matches.join('|');
  if (/localhost|127\.0\.0\.1|\.e2e/i.test(joined)) {
    throw new Error(`[gate] ${outDir} matches 含测试域名：${joined}`);
  }

  // 权限
  const permissions = manifest.permissions ?? [];
  const hostPerms = manifest.host_permissions ?? [];
  for (const p of permissions) {
    if (!EXPECTED_PERMISSIONS.includes(p)) {
      throw new Error(`[gate] ${outDir} 出现非预期 permission：${p}`);
    }
  }
  for (const p of hostPerms) {
    if (!EXPECTED_HOST_PERMISSIONS.includes(p)) {
      throw new Error(`[gate] ${outDir} 出现非预期 host_permission：${p}`);
    }
  }
  if (version && manifest.version !== version) {
    throw new Error(`[gate] ${outDir} manifest.version=${manifest.version} != 期望版本 ${version}`);
  }

  // 全文件扫描 E2E 痕迹（跳过 .map 避免误报）
  const scan = (dirPath) => {
    for (const name of readdirSync(dirPath)) {
      const p = join(dirPath, name);
      const st = statSync(p);
      if (st.isDirectory()) scan(p);
      else if (!name.endsWith('.map')) {
        const text = readFileSync(p, 'utf8');
        if (text.includes('.e2e-built')) {
          throw new Error(`[gate] ${outDir} 文件 ${relative(dir, p)} 含 .e2e-built 标记`);
        }
      }
    }
  };
  scan(dir);
  return { matches, permissions, hostPerms };
}

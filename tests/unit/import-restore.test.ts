/**
 * P1-4（v0.1.2）：完整 JSON 导入必须恢复 settings。
 * export → mutate → import → 完整恢复。
 */
import { describe, expect, it } from 'vitest';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { parseImportText, toEntities, serializeForExport } from '@/rules/import-export';
import { DEFAULT_SETTINGS } from '@/shared/constants/defaults';

async function makeRepo(initial: Record<string, unknown> = {}) {
  const backend = inMemoryBackend(initial);
  const repo = new StorageRepository(backend);
  await repo.init();
  return { backend, repo };
}

describe('P1-4 完整 JSON 导入恢复 settings', () => {
  it('export → mutate → import → settings 完整恢复', async () => {
    const { repo } = await makeRepo();
    // 1. 修改设置并导出
    await repo.updateSettings({
      enabled: false,
      videoCommentsEnabled: true,
      dynamicsEnabled: false,
      suspiciousHandling: 'hide',
      quickActionDisplay: 'always',
      autoReportAuthorized: true,
      defaultReportReason: 12,
      autoProcessVerified: true,
      operationDelayMs: 5000,
    });
    const exported = await repo.exportAll();
    const json = serializeForExport(exported);
    const parsed = parseImportText(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.data) throw new Error('解析失败');

    // 2. 变更设置（模拟被覆盖前状态）
    await repo.updateSettings({ enabled: true, operationDelayMs: 1000 });

    // 3. toEntities 必须保留 settings（P1-4 核心）
    const entities = toEntities(parsed.data);
    expect(entities.settings).toBeDefined();
    expect(entities.settings?.enabled).toBe(false);
    expect(entities.settings?.operationDelayMs).toBe(5000);

    // 4. 导入恢复
    await repo.importAll({
      settings: entities.settings,
      rules: entities.rules,
      blocked: entities.blocked,
      verified: entities.verified,
      whitelist: entities.whitelist,
    });
    const restored = await repo.getSettings();
    expect(restored).toEqual(exported.settings);
  });

  it('toEntities 无 settings 字段时返回 undefined（部分导入不破坏设置）', () => {
    const parsed = parseImportText(JSON.stringify({
      app: 'biliblocker',
      schemaVersion: 1,
      rules: [],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.data) throw new Error('解析失败');
    const entities = toEntities(parsed.data);
    expect(entities.settings).toBeUndefined();
  });

  it('settings 缺字段时用默认值补全', () => {
    const parsed = parseImportText(JSON.stringify({
      schemaVersion: 1,
      settings: { enabled: false },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.data) throw new Error('解析失败');
    const entities = toEntities(parsed.data);
    expect(entities.settings?.enabled).toBe(false);
    expect(entities.settings?.videoCommentsEnabled).toBe(DEFAULT_SETTINGS.videoCommentsEnabled);
  });
});

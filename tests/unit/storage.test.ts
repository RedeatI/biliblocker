/**
 * 存储仓储测试：默认播种、名单增删、去重、日志上限、清除与导出。
 */
import { describe, expect, it } from 'vitest';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import type { StorageBackend } from '@/storage/backend';
import { DEFAULT_RULES } from '@/rules/default-rules';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  NEW_INSTALL_SETTINGS,
  STORAGE_KEYS,
} from '@/shared/constants/defaults';

async function makeRepo(initial: Record<string, unknown> = {}) {
  const backend = inMemoryBackend(initial);
  const repo = new StorageRepository(backend);
  await repo.init();
  return { backend, repo };
}

describe('StorageRepository', () => {
  it('首次 init 播种默认设置与默认规则', async () => {
    const { repo } = await makeRepo();
    const settings = await repo.getSettings();
    const rules = await repo.getRules();
    expect(settings.enabled).toBe(true);
    expect(settings.suspiciousHandling).toBe('collapse');
    expect(settings.autoReportAuthorized).toBe(false);
    expect(rules.length).toBeGreaterThanOrEqual(4);
  });

  it('生产首次播种直接写入关闭 + 只标记，不暴露开启态中间值', async () => {
    const backend = inMemoryBackend();
    const repo = new StorageRepository(backend, { seedSettings: NEW_INSTALL_SETTINGS });
    await repo.init();
    expect(await repo.getSettings()).toEqual(NEW_INSTALL_SETTINGS);
  });

  it('只读上下文在 meta 已写但安全 settings 尚未落盘时继续等待', async () => {
    const base = inMemoryBackend();
    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    let observedIncomplete!: () => void;
    const incompleteSeen = new Promise<void>((resolve) => {
      observedIncomplete = resolve;
    });
    let incompleteReported = false;
    const gated: StorageBackend = {
      async get(keys) {
        const result = await base.get(keys);
        if (
          !incompleteReported &&
          result[STORAGE_KEYS.meta] !== undefined &&
          result[STORAGE_KEYS.settings] === undefined
        ) {
          incompleteReported = true;
          observedIncomplete();
        }
        return result;
      },
      async set(items) {
        if (items[STORAGE_KEYS.settings] !== undefined) await settingsGate;
        await base.set(items);
      },
      remove: (keys) => base.remove(keys),
    };
    const writer = new StorageRepository(gated, { seedSettings: NEW_INSTALL_SETTINGS });
    const reader = new StorageRepository(gated, { allowWrites: false });
    const writerInit = writer.init();
    let readerReady = false;
    const readerInit = reader.init().then(() => {
      readerReady = true;
    });

    await incompleteSeen;
    expect(readerReady).toBe(false);
    releaseSettings();
    await Promise.all([writerInit, readerInit]);
    expect(await reader.getSettings()).toEqual(NEW_INSTALL_SETTINGS);
  });

  it('升级时保留已有设置，不用新安装默认值覆盖', async () => {
    const existing = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      suspiciousHandling: 'collapse' as const,
      autoReportAuthorized: true,
      defaultReportReason: 1,
    };
    const backend = inMemoryBackend({ 'bb.settings': existing });
    const repo = new StorageRepository(backend, { seedSettings: NEW_INSTALL_SETTINGS });
    await repo.init();
    expect(await repo.getSettings()).toEqual(existing);
  });

  it('设置更新并持久化', async () => {
    const { repo } = await makeRepo();
    await repo.updateSettings({ autoProcessVerified: true });
    const settings = await repo.getSettings();
    expect(settings.autoProcessVerified).toBe(true);
  });

  it('黑名单/已确认机器人/白名单增删', async () => {
    const { repo } = await makeRepo();
    await repo.addBlocked({ uid: 1, username: 'a', source: 'manual' });
    await repo.addVerified({ uid: 1, username: 'a', source: 'manual' });
    await repo.addWhitelist({ uid: 1 });
    expect(await repo.getBlocked()).toHaveLength(1);
    expect(await repo.getVerified()).toHaveLength(1);
    expect(await repo.getWhitelist()).toHaveLength(1);
    await repo.removeBlocked(1);
    await repo.removeVerified(1);
    await repo.removeWhitelist(1);
    expect(await repo.getBlocked()).toHaveLength(0);
    expect(await repo.getVerified()).toHaveLength(0);
    expect(await repo.getWhitelist()).toHaveLength(0);
  });

  it('同一 UID 重复添加不重复（P0-4 6.3：普通添加为 no-op，保留原条目）', async () => {
    const { repo } = await makeRepo();
    await repo.addBlocked({ uid: 1, source: 'manual' });
    await repo.addBlocked({ uid: 1, source: 'import' });
    const list = await repo.getBlocked();
    expect(list).toHaveLength(1);
    // v0.1.3：add 遇到已存在 UID 默认 no-op，不覆盖原 source/reason/blockedAt
    expect(list[0]!.source).toBe('manual');
  });

  it('去重记录 TTL 过期后失效', async () => {
    const { repo } = await makeRepo();
    await repo.markDedup('block:1', 50);
    expect(await repo.isDedupHit('block:1')).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(await repo.isDedupHit('block:1')).toBe(false);
  });

  it('审计日志追加并受上限约束', async () => {
    const { repo } = await makeRepo();
    for (let i = 0; i < LIMITS.MAX_AUDIT + 50; i++) {
      await repo.appendAudit({ uid: i, trigger: 'manual', matchedRuleIds: [], localHidden: true });
    }
    const logs = await repo.getAuditLogs();
    expect(logs.length).toBeLessThanOrEqual(LIMITS.MAX_AUDIT);
    await repo.clearAudit();
    expect(await repo.getAuditLogs()).toHaveLength(0);
  }, 120_000); // 压力测试：MAX_AUDIT+50 次 RMW 追加在慢速干净重建环境可能 >15s，单独放宽超时

  it('exportAll 返回必要字段且不含日志', async () => {
    const { repo } = await makeRepo();
    await repo.addBlocked({ uid: 1, source: 'manual' });
    const exported = await repo.exportAll();
    expect(exported.settings).toBeDefined();
    expect(exported.rules).toBeDefined();
    expect(exported.blocked).toHaveLength(1);
    expect('audit' in exported).toBe(false);
  });

  it('clearAllData 清空全部', async () => {
    const { repo } = await makeRepo();
    await repo.addBlocked({ uid: 1, source: 'manual' });
    await repo.clearAllData();
    expect(await repo.getBlocked()).toHaveLength(0);
    // 再次 init 会重新播种
    await repo.init();
    expect((await repo.getSettings()).enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect((await repo.getRules()).length).toBe(DEFAULT_RULES.length);
  });

  it('resetToDefaults 恢复默认', async () => {
    const { repo } = await makeRepo();
    await repo.updateSettings({ enabled: false });
    await repo.addBlocked({ uid: 1, source: 'manual' });
    await repo.resetToDefaults();
    expect((await repo.getSettings()).enabled).toBe(true);
    expect(await repo.getBlocked()).toHaveLength(0);
  });

  it('importAll 替换数据', async () => {
    const { repo } = await makeRepo();
    await repo.importAll({
      settings: { ...DEFAULT_SETTINGS, operationDelayMs: 5000 },
      rules: [],
      blocked: [{ uid: 7, source: 'import', blockedAt: 0 }],
    });
    expect((await repo.getSettings()).operationDelayMs).toBe(5000);
    expect(await repo.getRules()).toHaveLength(0);
    expect(await repo.getBlocked()).toHaveLength(1);
  });
});

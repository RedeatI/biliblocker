/**
 * P1-1 storage 一致性测试：
 * - invalidate / applyExternalChanges 缓存失效；
 * - 批量原子写入（addBlockedBatch 等）返回新增/重复/无效数量，无效时不部分写入；
 * - 同实例内并发 RMW 不丢失更新。
 */
import { describe, expect, it } from 'vitest';
import { StorageRepository } from '@/storage/repository';
import { inMemoryBackend } from '@/storage/backend';
import { STORAGE_KEYS } from '@/shared/constants/defaults';

async function makeRepo(initial: Record<string, unknown> = {}) {
  const backend = inMemoryBackend(initial);
  const repo = new StorageRepository(backend);
  await repo.init();
  return { backend, repo };
}

describe('P1-1 缓存一致性', () => {
  it('applyExternalChanges 遍历全部变化键并使缓存失效', async () => {
    const { repo } = await makeRepo();
    await repo.addBlocked({ uid: 1, source: 'manual' });
    expect((await repo.getBlocked()).length).toBe(1);

    // 外部直接写入 storage（绕过 repo）：缓存必须失效
    await repo['backend'].set({ 'bb.blocked': [{ uid: 2, source: 'import', blockedAt: 1 }] });
    expect((await repo.getBlocked()).length).toBe(1); // 缓存未失效：读到旧值
    const keys = repo.applyExternalChanges({ 'bb.blocked': { newValue: [{ uid: 2, source: 'import', blockedAt: 1 }] } });
    expect(keys).toEqual(['bb.blocked']);
    expect((await repo.getBlocked()).length).toBe(1);
    expect((await repo.getBlocked())[0]?.uid).toBe(2);
  });

  it('invalidate() 使指定键缓存失效', async () => {
    const { repo } = await makeRepo();
    await repo.addBlocked({ uid: 3, source: 'manual' });
    await repo['backend'].set({ 'bb.blocked': [{ uid: 4, source: 'import', blockedAt: 1 }] });
    repo.invalidate([STORAGE_KEYS.blocked]);
    expect((await repo.getBlocked())[0]?.uid).toBe(4);
  });

  it('同实例内并发 addBlocked 不丢失更新（每键互斥）', async () => {
    const { repo } = await makeRepo();
    await Promise.all([
      repo.addBlocked({ uid: 11, source: 'manual' }),
      repo.addBlocked({ uid: 12, source: 'manual' }),
      repo.addBlocked({ uid: 13, source: 'manual' }),
    ]);
    const list = await repo.getBlocked();
    expect(list.map((b) => b.uid).sort()).toEqual([11, 12, 13]);
  });

  it('同实例内并发 appendAudit 不丢失记录', async () => {
    const { repo } = await makeRepo();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repo.appendAudit({ uid: 100 + i, trigger: 'manual', matchedRuleIds: [], localHidden: false }),
      ),
    );
    const logs = await repo.getAuditLogs();
    expect(logs.length).toBe(10);
  });
});

describe('P1-4 批量原子写入', () => {
  it('addBlockedBatch：全部有效 → 一次写入并返回新增/重复数量', async () => {
    const { repo } = await makeRepo();
    await repo.addBlocked({ uid: 1, source: 'manual' });
    const r = await repo.addBlockedBatch([
      { uid: 1, source: 'import' }, // 重复
      { uid: 2, source: 'import' }, // 新增
      { uid: 3, source: 'import' }, // 新增
    ]);
    expect(r).toEqual({ added: 2, duplicate: 1, invalid: 0 });
    const list = await repo.getBlocked();
    expect(list.map((b) => b.uid).sort()).toEqual([1, 2, 3]);
  });

  it('含无效条目（uid<=0 / NaN）→ 整包拒绝，不部分写入', async () => {
    const { repo } = await makeRepo();
    const r = await repo.addBlockedBatch([
      { uid: 5, source: 'import' },
      { uid: -1, source: 'import' },
      { uid: 6, source: 'import' },
    ]);
    expect(r.invalid).toBe(1);
    expect(r.added).toBe(0);
    const list = await repo.getBlocked();
    expect(list).toHaveLength(0); // 无部分写入
  });

  it('addVerifiedBatch / addWhitelistBatch 同样原子', async () => {
    const { repo } = await makeRepo();
    const v = await repo.addVerifiedBatch([{ uid: 1, source: 'import' }, { uid: 1, source: 'import' }]);
    expect(v).toEqual({ added: 1, duplicate: 1, invalid: 0 });
    const w = await repo.addWhitelistBatch([{ uid: 2 }, { uid: -9 }]);
    expect(w.invalid).toBe(1);
    expect((await repo.getWhitelist())).toHaveLength(0);
  });

  it('importAll 多键一次性提交；名单含无效项时整包拒绝', async () => {
    const { repo } = await makeRepo();
    await expect(
      repo.importAll({ blocked: [{ uid: 1, source: 'import' }], whitelist: [{ uid: -5 }] }),
    ).rejects.toThrow(/无效条目/);
    expect((await repo.getBlocked())).toHaveLength(0);
    expect((await repo.getWhitelist())).toHaveLength(0);
    // 全有效：多键同时写入
    await repo.importAll({
      blocked: [{ uid: 1, source: 'import' }],
      verified: [{ uid: 2, source: 'import' }],
      whitelist: [{ uid: 3 }],
    });
    expect((await repo.getBlocked())[0]?.uid).toBe(1);
    expect((await repo.getVerified())[0]?.uid).toBe(2);
    expect((await repo.getWhitelist())[0]?.uid).toBe(3);
  });
});

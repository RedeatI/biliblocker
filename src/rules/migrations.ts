/**
 * 数据迁移框架：schemaVersion 升级时原地迁移各存储键。
 * 迁移函数必须幂等（可重复执行不产生副作用）。
 */
import type { StorageBackend } from '../storage/backend';

interface Migration {
  from: number;
  to: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  migrate: (raw: Record<string, any>) => Promise<Record<string, any>> | Record<string, any>;
}

// 未来版本在此追加迁移：{ from: 1, to: 2, migrate: (raw) => ({ ...raw, ... }) }
const MIGRATIONS: Migration[] = [];

export async function runMigrations(
  currentVersion: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any>,
  _backend: StorageBackend,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  let data = raw;
  let version = currentVersion;
  for (const migration of MIGRATIONS) {
    if (version < migration.to && migration.from === version) {
      data = await migration.migrate(data);
      version = migration.to;
    }
  }
  return data;
}

/**
 * StorageRepository：对 chrome.storage.local 的类型化访问入口。
 * 所有数据读取/写入都经由这里，schema 变更走 migrations。
 *
 * P1-1 storage 一致性：
 * - invalidate(keys) / applyExternalChanges(changes)：外部（其他上下文）写入后使缓存失效；
 * - 本实例内 RMW 使用每键互斥（串行队列），避免同上下文并发丢失更新；
 *   跨上下文（多 tab/设置页）的名单/审计/队列 RMW 统一通过 background 的
 *   StorageCoordinator（BB_MUTATE_LIST / BB_COMMIT_ACTION 等消息）串行执行。
 * - addBlockedBatch/addVerifiedBatch/addWhitelistBatch：一次写入并返回新增/重复/无效数量，
 *   全部校验通过才提交，失败不部分写入。
 *
 * P1-2（v0.1.2）：KeyMutex 提取到 src/storage/key-mutex.ts（尾队列正确清理）。
 *
 * P1-3（v0.1.2）统一写并发模型：
 * - write() 先写 backend、成功后再更新 cache（backend 失败时 cache 保持旧值）；
 * - revision/CAS：settings/rules 携带 expectedRevision，过期覆盖被拒绝。
 *
 * P0-4/P1-1（v0.1.3）写入单所有者：
 * - 非 background 上下文（content/popup/options）以 allowWrites=false 构造，
 *   所有写方法抛错（「只读存储实例」），写入必须经 background 的 StorageCoordinator。
 * - 删除跨倒计时长生命周期事务（transactions Map / beginTx / commitTx / rollbackTx）；
 *   一键动作改为 BB_COMMIT_ACTION 单次原子提交。
 * - 普通「添加」遇到已存在 UID 时为 no-op（保留原 blockedAt/addedAt/source/reason），
 *   只有明确的 update 命令才允许覆盖；无 update 命令时 add 永不变更既有条目。
 *
 * P0-5（v0.1.3）：队列安全状态（bb.queueControl）读写。
 */
import type { StorageBackend } from './backend';
import {
  BlockedUser,
  Rule,
  Settings,
  VerifiedMachine,
  WhitelistedUser,
  AuditEntry,
  ActionTask,
  QueueControlState,
  UnknownOutcomeRecord,
} from '../shared/types';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_QUEUE_CONTROL,
  DEFAULT_SETTINGS,
  LIMITS,
  OPERATION_OUTCOME,
  STORAGE_KEYS,
  UNKNOWN_OUTCOME,
} from '../shared/constants/defaults';
import { runMigrations } from '../rules/migrations';
import { DEFAULT_RULES } from '../rules/default-rules';
import { shortId, toNumber } from '../shared/utils';
import { KeyMutex } from './key-mutex';

interface Meta {
  schemaVersion: number;
  seededAt: number;
  lastMigratedAt: number | null;
}

/** P0-1（v0.1.4）：显式全局写租约（协调器在锁内以租约传递内部写权，禁止共享布尔绕过） */
export interface WriteLease {
  readonly token: symbol;
}

/** P0-5（v0.1.4）：operationId 幂等结果（持久化；有限 TTL/容量） */
export interface OperationOutcomeRecord {
  /** 请求绑定指纹（tab/frame/nonce/uid/contentId/hash）；不同绑定复用同一 operationId 时拒绝 */
  binding: string;
  result: Record<string, unknown>;
  ts: number;
}

export interface StorageRepositoryOptions {
  /**
   * 是否允许本实例写入（默认 true）。
   * 只有 background 的 StorageCoordinator 使用可写实例；
   * content/popup/options 必须传 false（写入收归 background 单所有者）。
   */
  allowWrites?: boolean;
  /** 仅当 settings 键不存在时使用；生产 background 用它原子播种安全的新装默认值。 */
  seedSettings?: Settings;
}

export class StorageRepository {
  private cache = new Map<string, unknown>();
  private mutex = new KeyMutex();
  /** 全局写锁（P1-3）：settings/rules/名单/审计/导入/reset/clear 全部串行 */
  private globalWriteMutex = new KeyMutex();
  private readonly allowWrites: boolean;
  private readonly seedSettings: Settings;

  constructor(
    private readonly backend: StorageBackend,
    options: StorageRepositoryOptions = {},
  ) {
    this.allowWrites = options.allowWrites ?? true;
    this.seedSettings = structuredClone(options.seedSettings ?? DEFAULT_SETTINGS);
  }

  /** 只读实例上任何写调用立即失败（写入必须经 background 的 StorageCoordinator） */
  private assertWritable(): void {
    if (!this.allowWrites) {
      throw new Error('只读存储实例：所有写入必须经 background 的 StorageCoordinator 协调');
    }
  }

  /**
   * P0-4（v0.1.3）：协调器专用多键原子写入。
   * 调用方（StorageCoordinator）必须已持有全局写锁；一次 backend.set 写入
   * 多个 Storage key（名单+队列），全部成功或全部失败；成功后同步缓存。
   */
  async commitSnapshot(items: Record<string, unknown>): Promise<void> {
    this.assertWritable();
    await this.backend.set(items);
    for (const k of Object.keys(items)) this.cache.set(k, structuredClone(items[k]));
  }

  /**
   * P1-3 全局写锁：所有扩展写操作（含 importAll/reset/clear）经此串行，
   * 与普通写互斥、固定锁顺序防死锁。background 的 BB_MUTATE_LIST 统一调用本方法。
   *
   * P0-1（v0.1.4）：回调接收显式 WriteLease（锁令牌）。协调器内部嵌套写必须
   * 通过该租约直接执行，绝不使用共享布尔「已持锁」状态让无关外部命令绕过锁。
   */
  async withGlobalWrite<T>(fn: (lease: WriteLease) => Promise<T>): Promise<T> {
    return this.globalWriteMutex.run('global', async () => {
      const lease: WriteLease = { token: Symbol('bb-global-write-lease') };
      return fn(lease);
    });
  }

  /** 初始化：迁移 + 首次播种默认数据（仅可写实例）；只读实例等待 background 播种完成 */
  async init(): Promise<void> {
    if (!this.allowWrites) {
      await this.waitForSeeded();
      this.cache.clear();
      return;
    }
    const raw = await this.backend.get([
      STORAGE_KEYS.meta,
      STORAGE_KEYS.settings,
      STORAGE_KEYS.rules,
      STORAGE_KEYS.blocked,
      STORAGE_KEYS.verified,
      STORAGE_KEYS.whitelist,
      STORAGE_KEYS.queue,
      STORAGE_KEYS.audit,
      STORAGE_KEYS.dedup,
      STORAGE_KEYS.unknownOutcomes,
      STORAGE_KEYS.operationOutcomes,
      STORAGE_KEYS.queueControl,
      STORAGE_KEYS.revisions,
    ]);
    const meta = (raw[STORAGE_KEYS.meta] as Meta | undefined) ?? {
      schemaVersion: 0,
      seededAt: 0,
      lastMigratedAt: null,
    };

    // 迁移（原地修改 raw 中的各键）
    const migrated = await runMigrations(meta.schemaVersion, raw, this.backend);
    const newMeta: Meta = { ...meta, schemaVersion: CURRENT_SCHEMA_VERSION, lastMigratedAt: Date.now() };
    await this.backend.set({ [STORAGE_KEYS.meta]: newMeta });

    // 播种（关键：一律写入副本，禁止把共享 DEFAULT_* 常量引用写入 storage，
    // 否则读取方原地修改（如 pause/revoke 改 control 字段）会污染所有实例）
    if (migrated[STORAGE_KEYS.settings] === undefined) {
      await this.backend.set({ [STORAGE_KEYS.settings]: structuredClone(this.seedSettings) });
    }
    if (migrated[STORAGE_KEYS.rules] === undefined) {
      await this.backend.set({ [STORAGE_KEYS.rules]: [...DEFAULT_RULES] });
    }
    for (const key of [STORAGE_KEYS.blocked, STORAGE_KEYS.verified, STORAGE_KEYS.whitelist, STORAGE_KEYS.queue, STORAGE_KEYS.audit, STORAGE_KEYS.dedup]) {
      if (migrated[key] === undefined) await this.backend.set({ [key]: [] });
    }
    if (migrated[STORAGE_KEYS.revisions] === undefined) {
      await this.backend.set({ [STORAGE_KEYS.revisions]: {} });
    }
    if (migrated[STORAGE_KEYS.queueControl] === undefined) {
      await this.backend.set({ [STORAGE_KEYS.queueControl]: structuredClone(DEFAULT_QUEUE_CONTROL) });
    }
    if (migrated[STORAGE_KEYS.unknownOutcomes] === undefined) {
      await this.backend.set({ [STORAGE_KEYS.unknownOutcomes]: [] });
    }
    if (migrated[STORAGE_KEYS.operationOutcomes] === undefined) {
      await this.backend.set({ [STORAGE_KEYS.operationOutcomes]: {} });
    }
    this.cache.clear();
  }

  /** 只读实例（content/popup/options）：等待 background 完成迁移与播种，避免并发写入竞争 */
  private async waitForSeeded(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const raw = await this.backend.get([STORAGE_KEYS.meta, STORAGE_KEYS.settings]);
      const meta = raw[STORAGE_KEYS.meta] as Meta | undefined;
      if (meta && meta.schemaVersion >= CURRENT_SCHEMA_VERSION && raw[STORAGE_KEYS.settings] !== undefined) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('存储尚未初始化（background 尚未完成迁移/播种），请稍后重试');
  }

  // ---------- P1-1：缓存一致性 ----------

  /** 使指定键的缓存失效（不指定则全部失效） */
  invalidate(keys?: string[]): void {
    if (!keys || keys.length === 0) {
      this.cache.clear();
      return;
    }
    for (const k of keys) this.cache.delete(k);
  }

  /** 外部变化（storage.onChanged）应用到本实例：遍历全部变化键并失效缓存 */
  applyExternalChanges(changes: Record<string, { newValue?: unknown }>): string[] {
    const keys = Object.keys(changes);
    for (const key of keys) {
      this.cache.delete(key);
      // 可选：直接把新值写入缓存，避免后续重复读（P1-2：存独立 clone）
      if (changes[key]?.newValue !== undefined) {
        this.cache.set(key, structuredClone(changes[key].newValue));
      }
    }
    return keys;
  }

  // ---------- 基础读写 ----------

  /**
   * P1-2（v0.1.5）：读取返回结构化克隆，不暴露内部 cache 引用。
   * - cache 存储独立 clone（write/commitSnapshot 存副本）；
   * - 调用者修改返回对象/数组不会改变 cache，也不会改变 backend；
   * - read-only 实例通过本方法返回的逻辑视图同样不可被旁路修改。
   */
  private async read<T>(key: string, fallback: T): Promise<T> {
    if (this.cache.has(key)) return structuredClone(this.cache.get(key) as T);
    const raw = await this.backend.get([key]);
    const value = (raw[key] as T | undefined) ?? fallback;
    this.cache.set(key, structuredClone(value));
    return structuredClone(value);
  }

  private async write<T>(key: string, value: T): Promise<void> {
    // P1-3：先写 backend，成功后再更新 cache（backend 失败时 cache 保持旧值）
    // P1-2：cache 存储独立 clone（防调用方后续修改 value 污染缓存）
    await this.backend.set({ [key]: value });
    this.cache.set(key, structuredClone(value));
  }

  /**
   * P1-2（v0.1.5）：内部 RMW 快速路径。
   * - 返回缓存引用（不克隆）：fn 必须为**纯函数**（不得修改传入数组/对象）；
   * - next 由纯 fn 构造（新数组/新对象，不外泄给外部调用者），
   *   因此 backend.set 后 cache 可直接存 next 引用（无需再次克隆）——
   *   避免高频追加（如审计日志）出现 O(n²) structuredClone 性能退化；
   * - 公开读取（read()）仍返回克隆，外部调用者永远拿不到内部引用。
   */
  private async mutateList<T>(key: string, fn: (list: T[]) => T[]): Promise<T[]> {
    this.assertWritable();
    return this.mutex.run(key, async () => {
      let list: T[];
      if (this.cache.has(key)) {
        list = this.cache.get(key) as T[];
      } else {
        const raw = await this.backend.get([key]);
        const value = (raw[key] as T[] | undefined) ?? [];
        this.cache.set(key, value);
        list = value;
      }
      const next = fn(list); // 纯函数契约：不得修改 list
      // next 由纯 fn 构造（新数组/对象）且不外泄给调用者 → 无需再克隆
      await this.backend.set({ [key]: next });
      this.cache.set(key, next);
      return next;
    });
  }

  // ---------- Settings（P1-3：revision/CAS 拒绝过期覆盖） ----------
  getSettings(): Promise<Settings> {
    return this.read(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  }

  /** 当前设置 revision（乐观并发控制） */
  async getSettingsRevision(): Promise<number> {
    return this.revisionFor(STORAGE_KEYS.settings);
  }

  /**
   * 更新设置。
   * @param expectedRevision 期望的当前 revision；不匹配（过期覆盖）时抛出
   */
  async updateSettings(patch: Partial<Settings>, expectedRevision?: number): Promise<Settings> {
    this.assertWritable();
    return this.mutex.run(STORAGE_KEYS.settings, async () => {
      const current = await this.read<Settings>(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
      await this.assertRevision(STORAGE_KEYS.settings, expectedRevision);
      const next = { ...current, ...patch };
      await this.write(STORAGE_KEYS.settings, next);
      await this.bumpRevision(STORAGE_KEYS.settings);
      return next;
    });
  }

  // ---------- Rules（P1-3：revision/CAS） ----------
  getRules(): Promise<Rule[]> {
    return this.read(STORAGE_KEYS.rules, DEFAULT_RULES);
  }

  async getRulesRevision(): Promise<number> {
    return this.revisionFor(STORAGE_KEYS.rules);
  }

  async saveRules(rules: Rule[], expectedRevision?: number): Promise<void> {
    this.assertWritable();
    await this.mutex.run(STORAGE_KEYS.rules, async () => {
      await this.assertRevision(STORAGE_KEYS.rules, expectedRevision);
      const trimmed = rules.slice(0, LIMITS.MAX_RULES);
      await this.write(STORAGE_KEYS.rules, trimmed);
      await this.bumpRevision(STORAGE_KEYS.rules);
    });
  }

  // ---------- revision/CAS（P1-3） ----------

  private async revisionFor(key: string): Promise<number> {
    const map = await this.read<Record<string, number>>(STORAGE_KEYS.revisions, {});
    return map[key] ?? 0;
  }

  private async assertRevision(key: string, expectedRevision?: number): Promise<void> {
    if (expectedRevision === undefined) return; // 未提供期望 revision：不强制 CAS（兼容旧调用）
    const current = await this.revisionFor(key);
    if (current !== expectedRevision) {
      throw new Error(`并发冲突：${key} 的版本已变化（期望 ${expectedRevision}，实际 ${current}），拒绝过期覆盖`);
    }
  }

  private async bumpRevision(key: string): Promise<void> {
    await this.mutex.run(STORAGE_KEYS.revisions, async () => {
      const map = await this.read<Record<string, number>>(STORAGE_KEYS.revisions, {});
      const next = { ...map, [key]: (map[key] ?? 0) + 1 };
      await this.write(STORAGE_KEYS.revisions, next);
    });
  }

  // ---------- 黑名单（P1-1：支持事务 operationId） ----------
  getBlocked(): Promise<BlockedUser[]> {
    return this.read(STORAGE_KEYS.blocked, []);
  }

  /** 添加黑名单；已存在同 UID 时为 no-op（保留原 blockedAt/source/reason，P0-4 6.3） */
  async addBlocked(entry: Omit<BlockedUser, 'blockedAt'>): Promise<void> {
    const now = Date.now();
    await this.mutateList<BlockedUser>(STORAGE_KEYS.blocked, (list) => {
      const existed = list.some((b) => b.uid === entry.uid);
      // P0-4（v0.1.3）：普通添加遇到已存在 UID 默认 no-op，绝不覆盖原条目
      if (existed) return list;
      const next = [...list];
      next.push({ ...entry, blockedAt: now });
      return next.slice(-LIMITS.MAX_BLOCKED);
    });
  }

  async removeBlocked(uid: number): Promise<void> {
    await this.mutateList<BlockedUser>(STORAGE_KEYS.blocked, (list) => list.filter((b) => b.uid !== uid));
  }

  /**
   * 批量添加黑名单（P1-4）：一次写入。
   * @returns 新增/重复/无效数量（重复 = 与现有名单或批内重复）；存在无效条目时整体拒绝。
   */
  async addBlockedBatch(
    items: Array<Omit<BlockedUser, 'blockedAt'>>,
  ): Promise<{ added: number; duplicate: number; invalid: number }> {
    const result = validateUidItems(items);
    if (result.invalid > 0) return result;
    const now = Date.now();
    await this.mutateList<BlockedUser>(STORAGE_KEYS.blocked, (list) => {
      const seen = new Set(list.map((b) => b.uid));
      const next = [...list];
      let added = 0;
      let duplicate = 0;
      for (const i of items) {
        if (seen.has(i.uid)) {
          duplicate++;
          continue;
        }
        seen.add(i.uid);
        next.push({ ...i, blockedAt: now });
        added++;
      }
      result.added = added;
      result.duplicate = duplicate;
      return next.slice(-LIMITS.MAX_BLOCKED);
    });
    return result;
  }

  // ---------- 已确认机器人名单（P1-1：支持事务 operationId） ----------
  getVerified(): Promise<VerifiedMachine[]> {
    return this.read(STORAGE_KEYS.verified, []);
  }

  /** 添加已确认机器人名单；已存在同 UID 时为 no-op（保留原 addedAt/source，P0-4 6.3） */
  async addVerified(entry: Omit<VerifiedMachine, 'addedAt'>): Promise<void> {
    const now = Date.now();
    await this.mutateList<VerifiedMachine>(STORAGE_KEYS.verified, (list) => {
      const existed = list.some((v) => v.uid === entry.uid);
      if (existed) return list;
      const next = [...list];
      next.push({ ...entry, addedAt: now });
      return next.slice(-LIMITS.MAX_VERIFIED);
    });
  }

  async removeVerified(uid: number): Promise<void> {
    await this.mutateList<VerifiedMachine>(STORAGE_KEYS.verified, (list) => list.filter((v) => v.uid !== uid));
  }

  async addVerifiedBatch(
    items: Array<Omit<VerifiedMachine, 'addedAt'>>,
  ): Promise<{ added: number; duplicate: number; invalid: number }> {
    const result = validateUidItems(items);
    if (result.invalid > 0) return result;
    const now = Date.now();
    await this.mutateList<VerifiedMachine>(STORAGE_KEYS.verified, (list) => {
      const seen = new Set(list.map((v) => v.uid));
      const next = [...list];
      let added = 0;
      let duplicate = 0;
      for (const i of items) {
        if (seen.has(i.uid)) {
          duplicate++;
          continue;
        }
        seen.add(i.uid);
        next.push({ ...i, addedAt: now });
        added++;
      }
      result.added = added;
      result.duplicate = duplicate;
      return next.slice(-LIMITS.MAX_VERIFIED);
    });
    return result;
  }

  // ---------- 白名单（P1-1：支持事务 operationId） ----------
  getWhitelist(): Promise<WhitelistedUser[]> {
    return this.read(STORAGE_KEYS.whitelist, []);
  }

  /** 添加白名单；已存在同 UID 时为 no-op（保留原 addedAt，P0-4 6.3） */
  async addWhitelist(entry: Omit<WhitelistedUser, 'addedAt'>): Promise<void> {
    const now = Date.now();
    await this.mutateList<WhitelistedUser>(STORAGE_KEYS.whitelist, (list) => {
      const existed = list.some((w) => w.uid === entry.uid);
      if (existed) return list;
      const next = [...list];
      next.push({ ...entry, addedAt: now });
      return next.slice(-LIMITS.MAX_WHITELIST);
    });
  }

  async removeWhitelist(uid: number): Promise<void> {
    await this.mutateList<WhitelistedUser>(STORAGE_KEYS.whitelist, (list) => list.filter((w) => w.uid !== uid));
  }

  async addWhitelistBatch(
    items: Array<Omit<WhitelistedUser, 'addedAt'>>,
  ): Promise<{ added: number; duplicate: number; invalid: number }> {
    const result = validateUidItems(items);
    if (result.invalid > 0) return result;
    const now = Date.now();
    await this.mutateList<WhitelistedUser>(STORAGE_KEYS.whitelist, (list) => {
      const seen = new Set(list.map((w) => w.uid));
      const next = [...list];
      let added = 0;
      let duplicate = 0;
      for (const i of items) {
        if (seen.has(i.uid)) {
          duplicate++;
          continue;
        }
        seen.add(i.uid);
        next.push({ ...i, addedAt: now });
        added++;
      }
      result.added = added;
      result.duplicate = duplicate;
      return next.slice(-LIMITS.MAX_WHITELIST);
    });
    return result;
  }

  // ---------- 去重 ----------
  /** key 形如 "block:123" / "report:123:video_comment:rpid:1"；value 为 {ts, ttl} */
  async isDedupHit(key: string): Promise<boolean> {
    const map = await this.read<Record<string, { ts: number; ttl: number }>>(STORAGE_KEYS.dedup, {});
    const entry = map[key];
    if (!entry) return false;
    if (Date.now() - entry.ts > entry.ttl) {
      // 只读实例（非 background）不得写入清理；background 内调用方位于协调器锁内
      if (this.allowWrites) {
        const next = { ...map };
        delete next[key];
        await this.write(STORAGE_KEYS.dedup, next);
      }
      return false;
    }
    return true;
  }

  async markDedup(key: string, ttl: number): Promise<void> {
    this.assertWritable();
    const map = await this.read<Record<string, { ts: number; ttl: number }>>(STORAGE_KEYS.dedup, {});
    const next = { ...map };
    // 简单清理：仅保留 5000 条以内的记录
    const entries = Object.entries(next).sort((a, b) => b[1].ts - a[1].ts);
    const kept = new Map(entries.slice(0, 5000));
    kept.set(key, { ts: Date.now(), ttl });
    await this.write(STORAGE_KEYS.dedup, Object.fromEntries(kept));
  }

  async clearDedup(key: string): Promise<void> {
    this.assertWritable();
    const map = await this.read<Record<string, { ts: number; ttl: number }>>(STORAGE_KEYS.dedup, {});
    const next = { ...map };
    delete next[key];
    await this.write(STORAGE_KEYS.dedup, next);
  }

  // ---------- 队列 ----------
  getQueueTasks(): Promise<ActionTask[]> {
    return this.read(STORAGE_KEYS.queue, []);
  }

  async saveQueueTasks(tasks: ActionTask[]): Promise<void> {
    this.assertWritable();
    await this.write(STORAGE_KEYS.queue, tasks);
  }

  // ---------- P0-5：队列安全状态（跨 SW 重启持久） ----------
  getQueueControl(): Promise<QueueControlState> {
    // 关键：fallback 必须深拷贝，禁止返回共享的 DEFAULT_QUEUE_CONTROL 引用
    // （调用方 pause()/revoke() 会原地修改 control 字段，共享引用会污染其他实例）
    return this.read(STORAGE_KEYS.queueControl, structuredClone(DEFAULT_QUEUE_CONTROL));
  }

  async saveQueueControl(state: QueueControlState): Promise<void> {
    this.assertWritable();
    await this.write(STORAGE_KEYS.queueControl, state);
  }

  // ---------- P0-4（v0.1.4）：unknown_outcome 持久证据（tombstone） ----------

  getUnknownOutcomes(): Promise<UnknownOutcomeRecord[]> {
    return this.read(STORAGE_KEYS.unknownOutcomes, []);
  }

  /**
   * 记录/更新「结果未知」证据（按 taskId 幂等 upsert：已存在则保留原记录，
   * 不重复、不丢失）。未核对的记录不因 TTL 删除；已核对记录按
   * UNKNOWN_OUTCOME.ACKNOWLEDGED_TTL_MS 清理；容量上限 MAX_RECORDS。
   */
  async recordUnknownOutcome(record: UnknownOutcomeRecord): Promise<void> {
    this.assertWritable();
    await this.mutex.run(STORAGE_KEYS.unknownOutcomes, async () => {
      const list = await this.read<UnknownOutcomeRecord[]>(STORAGE_KEYS.unknownOutcomes, []);
      const existing = list.find((r) => r.taskId === record.taskId);
      if (existing) return; // 幂等：同一 task 只保留第一条（markedAt/cause 不覆盖）
      const now = Date.now();
      const pruned = list.filter(
        (r) => r.acknowledgedAt === undefined || now - r.acknowledgedAt < UNKNOWN_OUTCOME.ACKNOWLEDGED_TTL_MS,
      );
      const next = [...pruned, record].slice(-UNKNOWN_OUTCOME.MAX_RECORDS);
      await this.write(STORAGE_KEYS.unknownOutcomes, next);
    });
  }

  /** 用户显式「已人工核对/已知晓」：仅标记 acknowledgedAt，绝不改写成 cancelled/succeeded */
  async acknowledgeUnknownOutcome(taskId: string): Promise<void> {
    this.assertWritable();
    await this.mutex.run(STORAGE_KEYS.unknownOutcomes, async () => {
      const list = await this.read<UnknownOutcomeRecord[]>(STORAGE_KEYS.unknownOutcomes, []);
      const next = list.map((r) =>
        r.taskId === taskId && r.acknowledgedAt === undefined ? { ...r, acknowledgedAt: Date.now() } : r,
      );
      await this.write(STORAGE_KEYS.unknownOutcomes, next);
    });
  }

  /** P0-4：审计清空时保留结果未知条目（reset/clear 也不静默删除不可逆操作证据） */
  async retainUnknownAudit(): Promise<AuditEntry[]> {
    this.assertWritable();
    return this.mutex.run(STORAGE_KEYS.audit, async () => {
      const list = await this.read<AuditEntry[]>(STORAGE_KEYS.audit, []);
      const next = list.filter((e) => e.outcomeUnknown === true);
      await this.write(STORAGE_KEYS.audit, next);
      return next;
    });
  }

  // ---------- P0-5（v0.1.4）：operationId 幂等结果 ----------

  async getOperationOutcome(operationId: string): Promise<OperationOutcomeRecord | null> {
    const map = await this.read<Record<string, OperationOutcomeRecord>>(STORAGE_KEYS.operationOutcomes, {});
    const entry = map[operationId];
    if (!entry) return null;
    if (Date.now() - entry.ts > OPERATION_OUTCOME.TTL_MS) {
      // 过期：清理（仅可写实例；协调器锁内调用）
      if (this.allowWrites) {
        const next = { ...map };
        delete next[operationId];
        await this.write(STORAGE_KEYS.operationOutcomes, next);
      }
      return null;
    }
    return entry;
  }

  /**
   * P1-3（v0.1.5）：读取 operationOutcomes 原始 map（供协调器在锁内计算下一个
   * 原子快照时使用——TTL/容量清理与新增记录一起进入同一次 commitSnapshot）。
   */
  async getOperationOutcomesRaw(): Promise<Record<string, OperationOutcomeRecord>> {
    return this.read<Record<string, OperationOutcomeRecord>>(STORAGE_KEYS.operationOutcomes, {});
  }

  async saveOperationOutcome(operationId: string, record: OperationOutcomeRecord): Promise<void> {
    this.assertWritable();
    const map = await this.read<Record<string, OperationOutcomeRecord>>(STORAGE_KEYS.operationOutcomes, {});
    const now = Date.now();
    const entries = Object.entries(map)
      .filter(([, v]) => now - v.ts < OPERATION_OUTCOME.TTL_MS)
      .sort((a, b) => b[1].ts - a[1].ts);
    const kept = new Map(entries.slice(0, OPERATION_OUTCOME.MAX_RECORDS - 1));
    kept.set(operationId, record);
    await this.write(STORAGE_KEYS.operationOutcomes, Object.fromEntries(kept));
  }

  // ---------- 审计日志 ----------
  getAuditLogs(): Promise<AuditEntry[]> {
    return this.read(STORAGE_KEYS.audit, []);
  }

  async appendAudit(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<void> {
    await this.mutateList<AuditEntry>(STORAGE_KEYS.audit, (list) => {
      // P1-2（v0.1.5）：纯函数（不修改传入 list）——mutateList 快速路径契约
      const full: AuditEntry = { ...entry, id: shortId('audit'), ts: Date.now() };
      return [...list, full].slice(-LIMITS.MAX_AUDIT);
    });
  }

  async clearAudit(): Promise<void> {
    this.assertWritable();
    await this.write(STORAGE_KEYS.audit, []);
  }

  // ---------- 数据管理 ----------
  async resetToDefaults(): Promise<void> {
    this.assertWritable();
    await this.backend.set({
      [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS },
      [STORAGE_KEYS.rules]: [...DEFAULT_RULES],
      [STORAGE_KEYS.blocked]: [],
      [STORAGE_KEYS.verified]: [],
      [STORAGE_KEYS.whitelist]: [],
      [STORAGE_KEYS.dedup]: {},
      [STORAGE_KEYS.queue]: [],
      [STORAGE_KEYS.queueControl]: structuredClone(DEFAULT_QUEUE_CONTROL),
      [STORAGE_KEYS.revisions]: {},
    });
    this.cache.clear();
  }

  async clearAllData(): Promise<void> {
    this.assertWritable();
    await this.backend.remove([
      STORAGE_KEYS.settings,
      STORAGE_KEYS.rules,
      STORAGE_KEYS.blocked,
      STORAGE_KEYS.verified,
      STORAGE_KEYS.whitelist,
      STORAGE_KEYS.dedup,
      STORAGE_KEYS.queue,
      STORAGE_KEYS.audit,
      STORAGE_KEYS.meta,
      STORAGE_KEYS.revisions,
      STORAGE_KEYS.queueControl,
    ]);
    this.cache.clear();
  }

  /**
   * 导入全套数据（规则 + 名单 + 设置）。
   * P1-1：多键一次性提交；任一名单含无效项时整包拒绝（不部分写入）。
   * 名单条目允许缺少 blockedAt/addedAt（导入数据），写入时补默认时间。
   */
  async importAll(data: {
    settings?: Settings;
    rules?: Rule[];
    blocked?: Array<Omit<BlockedUser, 'blockedAt'> & { blockedAt?: number }>;
    verified?: Array<Omit<VerifiedMachine, 'addedAt'> & { addedAt?: number }>;
    whitelist?: Array<Omit<WhitelistedUser, 'addedAt'> & { addedAt?: number }>;
  }): Promise<void> {
    this.assertWritable();
    // 校验：任何名单含无效项 → 整体拒绝
    if (data.blocked && validateUidItems(data.blocked).invalid > 0) {
      throw new Error('导入失败：黑名单包含无效条目');
    }
    if (data.verified && validateUidItems(data.verified).invalid > 0) {
      throw new Error('导入失败：已确认机器人名单包含无效条目');
    }
    if (data.whitelist && validateUidItems(data.whitelist).invalid > 0) {
      throw new Error('导入失败：白名单包含无效条目');
    }
    const now = Date.now();
    const items: Record<string, unknown> = {};
    if (data.settings) items[STORAGE_KEYS.settings] = data.settings;
    if (data.rules) items[STORAGE_KEYS.rules] = data.rules.slice(0, LIMITS.MAX_RULES);
    if (data.blocked) {
      items[STORAGE_KEYS.blocked] = data.blocked
        .map((b) => ({ ...b, blockedAt: b.blockedAt ?? now }))
        .slice(-LIMITS.MAX_BLOCKED);
    }
    if (data.verified) {
      items[STORAGE_KEYS.verified] = data.verified
        .map((v) => ({ ...v, addedAt: v.addedAt ?? now }))
        .slice(-LIMITS.MAX_VERIFIED);
    }
    if (data.whitelist) {
      items[STORAGE_KEYS.whitelist] = data.whitelist
        .map((w) => ({ ...w, addedAt: w.addedAt ?? now }))
        .slice(-LIMITS.MAX_WHITELIST);
    }
    await this.backend.set(items);
    for (const k of Object.keys(items)) this.cache.delete(k);
  }

  /** 导出全套数据（不含日志正文与去重记录） */
  async exportAll(): Promise<{
    schemaVersion: number;
    exportedAt: number;
    settings: Settings;
    rules: Rule[];
    blocked: BlockedUser[];
    verified: VerifiedMachine[];
    whitelist: WhitelistedUser[];
  }> {
    const [settings, rules, blocked, verified, whitelist] = await Promise.all([
      this.getSettings(),
      this.getRules(),
      this.getBlocked(),
      this.getVerified(),
      this.getWhitelist(),
    ]);
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: Date.now(),
      settings,
      rules,
      blocked,
      verified,
      whitelist,
    };
  }
}

/** 校验 UID 列表：全部有效返回 invalid=0；否则返回 invalid 数量且不提交 */
function validateUidItems<T extends { uid: number }>(items: T[]): { added: number; duplicate: number; invalid: number } {
  const invalid = items.filter((i) => toNumber(i.uid) === null || i.uid <= 0).length;
  return { added: 0, duplicate: 0, invalid };
}

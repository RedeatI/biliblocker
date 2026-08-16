/**
 * 设置页全局状态（轻量响应式 store，避免引入 Pinia 依赖）。
 * 数据读取经 StorageRepository（chrome.storage.local）。
 *
 * P1-1（v0.1.3）：本页存储实例为只读；所有写入（settings/rules/名单/审计/导入/
 * reset/clear）统一经 background 的 BB_MUTATE_LIST（StorageCoordinator 全局写锁）
 * 串行执行（跨上下文防丢失更新）；storage.onChanged 时使缓存失效并刷新。
 */
import { reactive } from 'vue';
import type {
  AuditEntry,
  BlockedUser,
  Rule,
  Settings,
  VerifiedMachine,
  WhitelistedUser,
} from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants/defaults';
import { StorageRepository } from '../../storage/repository';
import { chromeStorageBackend } from '../../storage/backend';
import { parseImportText, toEntities } from '../../rules/import-export';

// P1-1（v0.1.3）：options 只读存储；所有写入经 background 的 StorageCoordinator
export const repo = new StorageRepository(chromeStorageBackend(), { allowWrites: false });

export interface AppState {
  ready: boolean;
  settings: Settings;
  rules: Rule[];
  blocked: BlockedUser[];
  verified: VerifiedMachine[];
  whitelist: WhitelistedUser[];
  audit: AuditEntry[];
}

export const state = reactive<AppState>({
  ready: false,
  settings: { ...DEFAULT_SETTINGS },
  rules: [],
  blocked: [],
  verified: [],
  whitelist: [],
  audit: [],
});

let initialized = false;

export async function initStore(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await repo.init();
  await refreshAll();
  // 跨页面实时同步（设置页/弹窗/内容脚本共享同一 storage；P1-1 遍历全部变化键）
  browser.storage.onChanged.addListener((changes) => {
    repo.applyExternalChanges(changes as Record<string, { newValue?: unknown }>);
    void refreshAll();
  });
  state.ready = true;
}

export async function refreshAll(): Promise<void> {
  const [settings, rules, blocked, verified, whitelist, audit] = await Promise.all([
    repo.getSettings(),
    repo.getRules(),
    repo.getBlocked(),
    repo.getVerified(),
    repo.getWhitelist(),
    repo.getAuditLogs(),
  ]);
  state.settings = settings;
  state.rules = rules;
  state.blocked = blocked;
  state.verified = verified;
  state.whitelist = whitelist;
  state.audit = audit;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  // P1-3：settings 写收归 background（全局写锁 + CAS 拒绝过期覆盖）
  await mutate({ op: 'updateSettings', patch, expectedRevision: await repo.getSettingsRevision() });
  await refreshAll();
}

export async function saveRules(rules: Rule[]): Promise<void> {
  // P1-3：rules 写收归 background（全局写锁 + CAS 拒绝过期覆盖）
  await mutate({ op: 'saveRules', rules, expectedRevision: await repo.getRulesRevision() });
  await refreshAll();
}

// ---------- 名单（P1-1：经 background 串行执行） ----------

/** 发送名单变更到 background；失败抛错 */
async function mutate(op: unknown): Promise<Record<string, unknown>> {
  const res = (await browser.runtime.sendMessage({
    type: 'BB_MUTATE_LIST',
    mutation: op,
  })) as Record<string, unknown>;
  if (res?.ok !== true) {
    throw new Error(String(res?.message ?? '名单变更失败'));
  }
  return res;
}

export async function addBlocked(entry: Omit<BlockedUser, 'blockedAt'>): Promise<void> {
  await mutate({ op: 'addBlocked', ...entry });
  await refreshAll();
}
export async function removeBlocked(uid: number): Promise<void> {
  await mutate({ op: 'removeBlocked', uid });
  await refreshAll();
}
export async function addVerified(entry: Omit<VerifiedMachine, 'addedAt'>): Promise<void> {
  await mutate({ op: 'addVerified', ...entry });
  await refreshAll();
}
export async function removeVerified(uid: number): Promise<void> {
  await mutate({ op: 'removeVerified', uid });
  await refreshAll();
}
export async function addWhitelist(entry: Omit<WhitelistedUser, 'addedAt'>): Promise<void> {
  await mutate({ op: 'addWhitelist', ...entry });
  await refreshAll();
}
export async function removeWhitelist(uid: number): Promise<void> {
  await mutate({ op: 'removeWhitelist', uid });
  await refreshAll();
}

// P1-4：批量一次写入并返回新增/重复/无效数量
export interface BatchResult {
  added: number;
  duplicate: number;
  invalid: number;
}

export async function addBlockedBatch(
  items: Array<Omit<BlockedUser, 'blockedAt'>>,
): Promise<BatchResult> {
  const res = await mutate({ op: 'addBlockedBatch', items });
  await refreshAll();
  return { added: Number(res.added ?? 0), duplicate: Number(res.duplicate ?? 0), invalid: Number(res.invalid ?? 0) };
}

export async function addVerifiedBatch(
  items: Array<Omit<VerifiedMachine, 'addedAt'>>,
): Promise<BatchResult> {
  const res = await mutate({ op: 'addVerifiedBatch', items });
  await refreshAll();
  return { added: Number(res.added ?? 0), duplicate: Number(res.duplicate ?? 0), invalid: Number(res.invalid ?? 0) };
}

export async function addWhitelistBatch(
  items: Array<Omit<WhitelistedUser, 'addedAt'>>,
): Promise<BatchResult> {
  const res = await mutate({ op: 'addWhitelistBatch', items });
  await refreshAll();
  return { added: Number(res.added ?? 0), duplicate: Number(res.duplicate ?? 0), invalid: Number(res.invalid ?? 0) };
}

// ---------- 日志 ----------
export async function clearAudit(): Promise<void> {
  // P1-1（v0.1.3）：审计清空收归 background（与 appendAudit/reset/clear 互斥）
  await mutate({ op: 'clearAudit' });
  await refreshAll();
}

// ---------- 导入导出 ----------
export function exportJson(): string {
  return JSON.stringify(
    {
      app: 'biliblocker',
      schemaVersion: 1,
      exportedAt: Date.now(),
      settings: state.settings,
      rules: state.rules,
      blocked: state.blocked,
      verified: state.verified,
      whitelist: state.whitelist,
    },
    null,
    2,
  );
}

export interface ImportResult {
  ok: boolean;
  message: string;
}

export async function importJson(text: string): Promise<ImportResult> {
  const parsed = parseImportText(text);
  if (!parsed.ok || !parsed.data) return { ok: false, message: parsed.error ?? '解析失败' };
  const entities = toEntities(parsed.data);
  try {
    await mutate({ op: 'importAll', data: entities });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  await refreshAll();
  return { ok: true, message: '导入成功' };
}

export async function resetDefaults(): Promise<void> {
  await mutate({ op: 'resetDefaults' });
  await refreshAll();
}

export async function clearAll(): Promise<void> {
  await mutate({ op: 'clearAll' });
  await refreshAll();
}

/**
 * 存储后端抽象。
 * - chromeStorageBackend：真实环境（chrome.storage.local，MV3 Promise API）
 * - inMemoryBackend：单元测试用（P1-2 v0.1.5：structured-clone 语义，与真实浏览器一致）
 * 核心业务代码只依赖 StorageBackend 接口，不在业务层直接调用 chrome.* 。
 */

export interface StorageBackend {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

interface StorageLike {
  get(keys: string[]): Promise<Record<string, unknown>> | Promise<unknown>;
  set(items: Record<string, unknown>): Promise<void> | void;
  remove(keys: string[]): Promise<void> | void;
}

/** 使用 WXT 提供的 browser（webextension-polyfill）封装 chrome.storage.local */
export function chromeStorageBackend(): StorageBackend {
  // 延迟获取，避免在非扩展环境（如 vitest node 环境）引用 browser 报错
  const g = globalThis as unknown as {
    browser?: { storage?: { local?: StorageLike } };
    chrome?: { storage?: { local?: StorageLike } };
  };
  const storage = g.browser?.storage?.local ?? g.chrome?.storage?.local;
  if (!storage) {
    throw new Error('chrome.storage.local 不可用（请在扩展环境中运行）');
  }
  return {
    async get(keys) {
      return (await storage.get(keys)) as Record<string, unknown>;
    },
    async set(items) {
      await storage.set(items);
    },
    async remove(keys) {
      await storage.remove(keys);
    },
  };
}

/**
 * 内存后端（测试用）。
 * P1-2（v0.1.5）：必须模拟 WebExtension storage 的 structured-clone 语义——
 * initial/set 输入 structuredClone、get 输出 structuredClone，
 * 调用方修改传入/返回对象不得影响 store（与真实 chrome.storage.local 一致）。
 */
export function inMemoryBackend(initial: Record<string, unknown> = {}): StorageBackend {
  const store = new Map<string, unknown>();
  for (const [k, v] of Object.entries(initial)) store.set(k, structuredClone(v));
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of keys) store.delete(k);
    },
  };
}

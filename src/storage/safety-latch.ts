/**
 * P0-3（v0.1.5）：安全暂停 latch（fail-closed）。
 *
 * 背景：风控暂停持久化失败时，只写 lastError 不够——新 Service Worker 启动后
 * 必须能够证明「上次暂停尚未安全清除」，否则默认 fail-closed（不 pump、不派发），
 * 直到用户显式恢复。
 *
 * 双通道设计（对应浏览器存储分层）：
 * - session latch（chrome.storage.session）：覆盖 SW 重启（session 在 SW 重启间存活）；
 * - local 持久 latch（chrome.storage.local）：覆盖**浏览器完全重启**
 *   （storage.session 在浏览器完全重启时被清空，local 不清空）。
 *
 * 复验（阶段 E 第二轮）要求：
 * - 浏览器完全重启后，若无法证明上次暂停已安全清除 → 默认 fail-closed，并要求用户显式确认。
 *   仅依赖 session latch 会 fail-open（session 随浏览器完全重启清空、local control
 *   因写失败仍 paused:false）→ 本模块新增 local 持久通道 + composite 组合。
 *
 * latch 语义：
 * - pause() 风控响应一出现 → 立即 set()（session + local 持久双写；fail-closed 优先于任何持久化）；
 * - local 写成功前不得报告「已持久化」；local 写失败时保持 latch 并有限重试；
 * - resume()/用户显式恢复成功 → clear()（双通道清除，证明暂停已安全清除）；
 * - background 启动（queue.start()）先读 composite.isSet()（任一通道 set 即 fail-closed）。
 *
 * 真实环境注入 compositeSafetyLatch(chromeStorageSessionLatch(), chromeStorageLocalLatch())；
 * 单元测试注入内存实现（跨实例共享引用）。
 */
export interface SafetyLatch {
  /** 当前是否处于「待确认暂停」状态（true = 必须 fail-closed） */
  isSet(): Promise<boolean>;
  set(): Promise<void>;
  clear(): Promise<void>;
}

interface StorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void> | void;
}

const SESSION_LATCH_KEY = 'bb.pauseSafetyLatch';
/** 复验（P0-3）：local 持久 latch 键——浏览器完全重启后仍可读取，覆盖 session 清空 */
export const PERSISTENT_LATCH_KEY = 'bb.pauseSafetyLatchPersistent';

/** 真实环境：chrome.storage.session（SW 重启存活；浏览器完全重启清空） */
export function chromeStorageSessionLatch(): SafetyLatch {
  const g = globalThis as unknown as {
    chrome?: { storage?: { session?: StorageLike } };
  };
  const session = g.chrome?.storage?.session;
  if (!session) {
    throw new Error('chrome.storage.session 不可用（安全暂停 latch 需要 session storage）');
  }
  return storageKeyLatch(session, SESSION_LATCH_KEY);
}

/** 真实环境：chrome.storage.local 持久 latch（跨浏览器完全重启）——复验 P0-3 */
export function chromeStorageLocalLatch(): SafetyLatch {
  const g = globalThis as unknown as {
    chrome?: { storage?: { local?: StorageLike } };
  };
  const local = g.chrome?.storage?.local;
  if (!local) {
    throw new Error('chrome.storage.local 不可用（持久安全 latch 需要 local storage）');
  }
  return storageKeyLatch(local, PERSISTENT_LATCH_KEY);
}

/**
 * 复验（P0-3）：组合 latch——isSet() 返回任一通道 set；
 * set() 双写（先 session 后 local 持久，任一失败即抛——必须证明已跨浏览器持久）；
 * clear() 双清。
 */
export function compositeSafetyLatch(...latches: SafetyLatch[]): SafetyLatch {
  return {
    async isSet() {
      for (const l of latches) {
        if (await l.isSet()) return true;
      }
      return false;
    },
    async set() {
      for (const l of latches) {
        await l.set();
      }
    },
    async clear() {
      for (const l of latches) {
        await l.clear();
      }
    },
  };
}

function storageKeyLatch(storage: StorageLike, key: string): SafetyLatch {
  return {
    async isSet() {
      const raw = await storage.get([key]);
      return raw[key] === true;
    },
    async set() {
      await storage.set({ [key]: true });
    },
    async clear() {
      await storage.set({ [key]: false });
    },
  };
}

/** 内存 latch（单元测试/探针）：跨实例共享引用，模拟 session 在 SW 重启间存活 */
export function inMemoryLatch(initial = false): SafetyLatch {
  let value = initial;
  return {
    async isSet() {
      return value;
    },
    async set() {
      value = true;
    },
    async clear() {
      value = false;
    },
  };
}

/** 测试辅助：可观察值的 latch */
export function observableLatch(initial = false): SafetyLatch & { current: () => boolean } {
  let value = initial;
  return {
    async isSet() {
      return value;
    },
    async set() {
      value = true;
    },
    async clear() {
      value = false;
    },
    current: () => value,
  };
}

/**
 * 测试辅助：在 happy-dom/单元环境中 stub chrome.*（供 ContentApp 等导入 wxt/browser 的模块使用）。
 * 必须在导入被测模块之前 import 本文件（ESM import 顺序保证先执行本文件副作用）。
 */
export const storageData = new Map<string, unknown>();
export const sentMessages: unknown[] = [];

type SendImpl = (msg: unknown) => Promise<Record<string, unknown>>;
let sendImpl: SendImpl = async (msg) => {
  const m = msg as { type?: string };
  if (m.type === 'BB_COMMIT_ACTION') {
    return { ok: true, enqueued: 0, localBlockedAdded: true, localVerifiedAdded: true };
  }
  return { ok: true };
};

export function setSendMessageImpl(fn: SendImpl): void {
  sendImpl = fn;
}

export function resetStub(): void {
  storageData.clear();
  sentMessages.length = 0;
}

const backend = {
  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (storageData.has(k)) out[k] = storageData.get(k);
    }
    return out;
  },
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) storageData.set(k, v);
  },
  async remove(keys: string[]): Promise<void> {
    for (const k of keys) storageData.delete(k);
  },
};

const g = globalThis as unknown as Record<string, unknown>;
g.chrome = {
  storage: { local: backend, onChanged: { addListener: () => undefined } },
  runtime: {
    sendMessage: async (msg: unknown) => {
      sentMessages.push(msg);
      return sendImpl(msg);
    },
    onMessage: { addListener: () => undefined },
    onMessageExternal: { addListener: () => undefined },
    openOptionsPage: async () => undefined,
  },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  tabs: {
    query: async () => [],
    get: async () => ({}),
    sendMessage: async () => undefined,
  },
};

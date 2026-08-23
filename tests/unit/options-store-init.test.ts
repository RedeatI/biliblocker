import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const LOAD_ERROR = '设置状态未知：读取本地数据失败，请重试。';

async function loadStore() {
  const addListener = vi.fn();
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      onChanged: { addListener },
    },
    runtime: { sendMessage: vi.fn() },
  });
  vi.resetModules();
  const store = await import('@/entrypoints/options/store');
  vi.spyOn(store.repo, 'getSettings').mockResolvedValue({ ...store.state.settings });
  vi.spyOn(store.repo, 'getRules').mockResolvedValue([]);
  vi.spyOn(store.repo, 'getBlocked').mockResolvedValue([]);
  vi.spyOn(store.repo, 'getVerified').mockResolvedValue([]);
  vi.spyOn(store.repo, 'getWhitelist').mockResolvedValue([]);
  vi.spyOn(store.repo, 'getAuditLogs').mockResolvedValue([]);
  return { ...store, addListener };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Options 初始化真实状态', () => {
  it('读取失败时 fail closed，且同一页面可重试恢复', async () => {
    const store = await loadStore();
    const init = vi
      .spyOn(store.repo, 'init')
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined);

    await store.initStore();

    expect(store.state.ready).toBe(false);
    expect(store.state.loading).toBe(false);
    expect(store.state.loadError).toBe(LOAD_ERROR);
    expect(store.addListener).not.toHaveBeenCalled();

    await store.initStore();

    expect(init).toHaveBeenCalledTimes(2);
    expect(store.state.ready).toBe(true);
    expect(store.state.loading).toBe(false);
    expect(store.state.loadError).toBeNull();
    expect(store.addListener).toHaveBeenCalledTimes(1);
  });

  it('合并并发初始化，不重复读取或注册监听器', async () => {
    const store = await loadStore();
    let finishInit: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finishInit = resolve;
    });
    const init = vi.spyOn(store.repo, 'init').mockReturnValue(pending);

    const first = store.initStore();
    const second = store.initStore();
    expect(store.state.loading).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);

    finishInit?.();
    await Promise.all([first, second]);

    expect(store.state.ready).toBe(true);
    expect(store.addListener).toHaveBeenCalledTimes(1);
  });

  it('在设置页呈现状态未知与重试操作', () => {
    const source = readFileSync('src/entrypoints/options/App.vue', 'utf8');
    expect(source).toContain('state.loadError');
    expect(source).toContain('role="alert"');
    expect(source).toContain('重试读取');
    expect(source).toContain('state.loading');
  });
});

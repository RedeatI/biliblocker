import { describe, expect, it, vi } from 'vitest';
import { togglePopupMaster } from '@/entrypoints/popup/controller';

describe('popup 主开关的零请求契约', () => {
  it('新装关闭态只打开 welcome，不调用页面 fetch/XHR 或官方适配器', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const getSettingsRevision = vi.fn(async () => 0);
    const fetchSpy = vi.fn();
    const xhrOpen = vi.fn();
    const originalFetch = globalThis.fetch;
    const OriginalXHR = globalThis.XMLHttpRequest;
    globalThis.fetch = fetchSpy as typeof fetch;
    globalThis.XMLHttpRequest = class {
      open = xhrOpen;
    } as unknown as typeof XMLHttpRequest;

    try {
      await expect(togglePopupMaster({ enabled: false }, { sendMessage, getSettingsRevision }))
        .resolves.toBe('open_welcome');
      expect(sendMessage).toHaveBeenCalledWith({ type: 'BB_OPEN_OPTIONS', target: 'welcome' });
      expect(getSettingsRevision).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrOpen).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.XMLHttpRequest = OriginalXHR;
    }
  });
});

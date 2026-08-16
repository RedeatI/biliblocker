/**
 * RC4 零官方请求回归：新装/升级关闭态，以及 0.1.7 的 enabled + flag_only
 * 本地模式，都不能让内容脚本访问 Bilibili API；延迟计时器也不能留下旁路。
 */
// @vitest-environment happy-dom
import './helpers/stub-chrome';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentApp } from '@/entrypoints/content/app';
import { DEFAULT_SETTINGS, NEW_INSTALL_SETTINGS } from '@/shared/constants/defaults';
import { resetStub, storageData } from './helpers/stub-chrome';
import type { ExtractedContent, Settings } from '@/shared/types';

function seedStorage(settings: Settings): void {
  storageData.set('bb.meta', { schemaVersion: 1, seededAt: 1, lastMigratedAt: null });
  storageData.set('bb.settings', settings);
  storageData.set('bb.rules', []);
  storageData.set('bb.blocked', []);
  storageData.set('bb.verified', []);
  storageData.set('bb.whitelist', []);
  storageData.set('bb.queue', []);
  storageData.set('bb.dedup', {});
  storageData.set('bb.revisions', {});
  storageData.set('bb.audit', []);
  storageData.set('bb.queueControl', {
    paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null,
    requiresExplicitResume: false, authorizationEpoch: 0,
    recentAttempts: { block: [], report: [], unblock: [] },
  });
}

async function start(settings: Settings): Promise<ContentApp> {
  resetStub();
  seedStorage(settings);
  const app = new ContentApp();
  await app.init();
  return app;
}

describe('RC4 运行时官方请求门禁', () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it.each([
    ['new install disabled', NEW_INSTALL_SETTINGS],
    ['upgrade keeps disabled', { ...DEFAULT_SETTINGS, enabled: false, suspiciousHandling: 'collapse' } as Settings],
    ['enabled flag_only with every endpoint unverified', { ...DEFAULT_SETTINGS, enabled: true, suspiciousHandling: 'flag_only' } as Settings],
  ])('%s: init and delayed navigation timers make zero official requests', async (_name, settings) => {
    const app = await start(settings);
    // Covers observer's delayed batches and its SPA poll, not only synchronous init().
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((app as unknown as { currentMid: number | null }).currentMid).toBeNull();
    (app as unknown as { observer?: { stop(): void } }).observer?.stop();
  });

  it('disabled content-script task dispatch is rejected before auth or official adapters', async () => {
    const app = await start(NEW_INSTALL_SETTINGS);
    const internals = app as unknown as {
      auth: { checkLogin: ReturnType<typeof vi.fn> };
      blockAdapter: { block: ReturnType<typeof vi.fn> };
      executeTask(task: unknown): Promise<{ ok: boolean; errorType?: string }>;
      observer?: { stop(): void };
    };
    const authSpy = vi.spyOn(internals.auth, 'checkLogin');
    const blockSpy = vi.spyOn(internals.blockAdapter, 'block');

    const result = await internals.executeTask({ type: 'block', uid: 42 });

    expect(result).toMatchObject({ ok: false, errorType: 'capability_not_verified' });
    expect(authSpy).not.toHaveBeenCalled();
    expect(blockSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    internals.observer?.stop();
  });

  it('enabled + flag_only local action keeps its local commit path and makes zero official requests', async () => {
    const app = await start({ ...DEFAULT_SETTINGS, enabled: true, suspiciousHandling: 'flag_only' });
    const internals = app as unknown as {
      showCountdownDual(): Promise<string>;
      runActionFlow(extracted: ExtractedContent, plan: unknown): Promise<void>;
      auth: { checkLogin: ReturnType<typeof vi.fn> };
      observer?: { stop(): void };
    };
    const authSpy = vi.spyOn(internals.auth, 'checkLogin');
    vi.spyOn(internals, 'showCountdownDual').mockResolvedValue('confirmed');
    const node = document.createElement('div');
    document.body.appendChild(node);
    const extracted: ExtractedContent = {
      contentType: 'video_comment', pageScope: 'video_page', uid: 7, username: 'local', text: 'x',
      links: [], linkDomains: [], contentId: 'r7', rootContentId: 'r7', videoId: '1', origDynamicId: null, node,
    };

    await internals.runActionFlow(extracted, {
      fold: true, commitLocalBlock: true, commitVerified: true,
      enqueueOfficialBlock: true, enqueueReport: true, source: 'one_click',
    });

    expect(authSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    internals.observer?.stop();
  });
});

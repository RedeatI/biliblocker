/**
 * P0-2/P0-4（v0.1.3）本地关闭态集成测试（10.1）：
 * 生产环境全部真实能力为 false 时，一键本地折叠/名单操作仍可完成：
 * - 全部 capability=false、未登录：一键本地折叠和名单操作仍可完成；
 * - 全部 capability=false、未登录：auth.checkLogin 调用次数为 0；
 * - 全部 capability=false：零官方任务仍显示倒计时（不绕过取消窗口）；
 * - 倒计时取消：DOM/blocked/verified/queue 均无变化；
 * - 纯本地 commit 失败：不 commit、不显示成功、DOM 恢复；
 * - 零官方任务最终文案明确「未发送任何请求」。
 */
// @vitest-environment happy-dom
import './helpers/stub-chrome';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentApp } from '@/entrypoints/content/app';
import { PlaceholderController, type PlaceholderCallbacks } from '@/ui/placeholder/controller';
import { DEFAULT_SETTINGS } from '@/shared/constants/defaults';
import { resetStub, sentMessages, setSendMessageImpl, storageData } from './helpers/stub-chrome';
import type { ExtractedContent, Settings } from '@/shared/types';

/** 页面中寻找 Toast 宿主（shadow DOM），读取当前提示文本 */
function toastTexts(): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll('div')) {
    if (el.shadowRoot) {
      out.push(el.shadowRoot.textContent ?? '');
    }
  }
  return out;
}

function stubCallbacks(): PlaceholderCallbacks {
  return {
    onView: () => undefined,
    onReleaseOnce: () => undefined,
    onWhitelist: () => undefined,
    onShowRules: () => undefined,
    onOneClick: () => undefined,
    onHideSimilar: () => undefined,
    canOfficial: () => true,
  };
}

function seedStorage(settings: Partial<Settings> = {}): void {
  storageData.set('bb.meta', { schemaVersion: 1, seededAt: 1, lastMigratedAt: null });
  storageData.set('bb.settings', { ...DEFAULT_SETTINGS, ...settings });
  storageData.set('bb.blocked', []);
  storageData.set('bb.verified', []);
  storageData.set('bb.whitelist', []);
  storageData.set('bb.queue', []);
  storageData.set('bb.dedup', {});
  storageData.set('bb.revisions', {});
  storageData.set('bb.audit', []);
  storageData.set('bb.queueControl', {
    paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null,
    requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] },
  });
}

async function makeApp(settings: Partial<Settings> = {}, loginMid: number | null = null): Promise<ContentApp> {
  resetStub();
  seedStorage(settings);
  const app = new ContentApp();
  await (app as unknown as { repo: { init(): Promise<void> } }).repo.init();
  const anyApp = app as unknown as {
    settings: Settings;
    currentMid: number | null;
    loginOk: boolean;
    whitelistSet: Set<number>;
    blockedSet: Set<number>;
    verifiedSet: Set<number>;
    placeholder: PlaceholderController;
    frameNonce: string;
    runActionFlow(extracted: ExtractedContent, plan: unknown): Promise<void>;
    showCountdownDual(message: string, ms: number): Promise<'confirmed' | 'cancelled_all' | 'cancelled_official_only'>;
    auth: { checkLogin(force?: boolean): Promise<{ isLogin: boolean; mid: number | null }> };
  };
  anyApp.settings = await (app as unknown as { repo: { getSettings(): Promise<Settings> } }).repo.getSettings();
  anyApp.currentMid = loginMid;
  anyApp.loginOk = false;
  anyApp.whitelistSet = new Set();
  anyApp.blockedSet = new Set();
  anyApp.verifiedSet = new Set();
  anyApp.placeholder = new PlaceholderController(stubCallbacks());
  anyApp.frameNonce = 'test-nonce';
  return app;
}

function makeExtracted(uid: number, contentId: string | null): ExtractedContent {
  const node = document.createElement('div');
  node.className = 'reply-item';
  node.innerHTML = `<a class="user-name" href="//space.bilibili.com/${uid}">用户</a><div class="reply-content">内容</div>`;
  document.body.appendChild(node);
  return {
    contentType: 'video_comment', pageScope: 'video_page', uid, username: '用户', text: '内容',
    links: [], linkDomains: [], contentId, rootContentId: contentId, videoId: '1', origDynamicId: null, node,
  };
}

const ONE_CLICK = { fold: true, commitLocalBlock: true, commitVerified: true, enqueueOfficialBlock: true, enqueueReport: true, source: 'one_click' };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('10.1 本地关闭态（全部 capability=false、未登录）', () => {
  it('一键本地折叠和名单操作仍可完成；checkLogin 调用次数为 0', async () => {
    const app = await makeApp({ operationDelayMs: 100 }, null);
    const anyApp = app as unknown as { showCountdownDual(): Promise<string>; auth: { checkLogin: ReturnType<typeof vi.fn> } };
    const countdownSpy = vi.spyOn(anyApp, 'showCountdownDual').mockResolvedValue('confirmed' as never);
    const checkLoginSpy = vi.spyOn(anyApp.auth, 'checkLogin');
    const extracted = makeExtracted(10001, 'rpid-1');

    await (app as unknown as { runActionFlow(e: ExtractedContent, p: unknown): Promise<void> }).runActionFlow(extracted, ONE_CLICK);

    // 零官方任务仍显示倒计时
    expect(countdownSpy).toHaveBeenCalledTimes(1);
    // auth.checkLogin 调用次数为 0（能力过滤后零官方任务 → 不检查登录）
    expect(checkLoginSpy).not.toHaveBeenCalled();
    // 提交了 BB_COMMIT_ACTION：官方任务为空、本地动作保留
    const commit = sentMessages.find((m) => (m as { type?: string }).type === 'BB_COMMIT_ACTION') as {
      officialTasks: unknown[]; localActions: { commitLocalBlock: boolean; commitVerified: boolean };
    };
    expect(commit).toBeDefined();
    expect(commit.officialTasks).toHaveLength(0);
    expect(commit.localActions).toEqual({ commitLocalBlock: true, commitVerified: true });
    // 本地名单生效（模拟 background 成功后内容脚本缓存更新）
    expect((app as unknown as { blockedSet: Set<number> }).blockedSet.has(10001)).toBe(true);
    expect((app as unknown as { verifiedSet: Set<number> }).verifiedSet.has(10001)).toBe(true);
  });

  it('零官方任务最终文案明确「未发送任何请求」', async () => {
    const app = await makeApp({ operationDelayMs: 100 });
    vi.spyOn(app as unknown as { showCountdownDual(): Promise<string> }, 'showCountdownDual').mockResolvedValue('confirmed' as never);
    const extracted = makeExtracted(10002, 'rpid-2');
    await (app as unknown as { runActionFlow(e: ExtractedContent, p: unknown): Promise<void> }).runActionFlow(extracted, ONE_CLICK);
    const all = toastTexts().join('|');
    expect(all).toContain('未发送任何请求');
    expect(all).not.toContain('已加入队列');
  });

  it('倒计时取消：DOM/blocked/verified/queue 均无变化', async () => {
    const app = await makeApp({ operationDelayMs: 100 });
    vi.spyOn(app as unknown as { showCountdownDual(): Promise<string> }, 'showCountdownDual').mockResolvedValue('cancelled_all' as never);
    const extracted = makeExtracted(10003, 'rpid-3');

    await (app as unknown as { runActionFlow(e: ExtractedContent, p: unknown): Promise<void> }).runActionFlow(extracted, ONE_CLICK);

    // 未发送任何提交
    expect(sentMessages.some((m) => (m as { type?: string }).type === 'BB_COMMIT_ACTION')).toBe(false);
    // DOM 恢复（折叠被撤销）
    expect(extracted.node.style.display).toBe('');
    // blocked/verified/queue 均无变化
    expect((app as unknown as { blockedSet: Set<number> }).blockedSet.size).toBe(0);
    expect(storageData.get('bb.blocked')).toEqual([]);
    expect(storageData.get('bb.verified')).toEqual([]);
    expect(storageData.get('bb.queue')).toEqual([]);
  });

  it('纯本地 commit 失败：不 commit、不显示成功、DOM 恢复', async () => {
    setSendMessageImpl(async () => {
      throw new Error('background unavailable');
    });
    const app = await makeApp({ operationDelayMs: 100 });
    vi.spyOn(app as unknown as { showCountdownDual(): Promise<string> }, 'showCountdownDual').mockResolvedValue('confirmed' as never);
    const extracted = makeExtracted(10004, 'rpid-4');

    await (app as unknown as { runActionFlow(e: ExtractedContent, p: unknown): Promise<void> }).runActionFlow(extracted, ONE_CLICK);

    // 不 commit：名单/队列无写入
    expect((app as unknown as { blockedSet: Set<number> }).blockedSet.size).toBe(0);
    expect(storageData.get('bb.blocked')).toEqual([]);
    expect(storageData.get('bb.queue')).toEqual([]);
    // DOM 恢复
    expect(extracted.node.style.display).toBe('');
    // 显示失败提示（非成功）
    const all = toastTexts().join('|');
    expect(all).toContain('本地提交失败');
    expect(all).not.toContain('已加入队列');
  });

  it('仅折叠查看（无名单/官方副作用）按公式 fold||… 仍提供可取消倒计时，但确认后无任何写入', async () => {
    const app = await makeApp({ operationDelayMs: 100 });
    const anyApp = app as unknown as { showCountdownDual(): Promise<string> };
    const countdownSpy = vi.spyOn(anyApp, 'showCountdownDual').mockResolvedValue('confirmed' as never);
    const extracted = makeExtracted(10005, 'rpid-5');
    await (app as unknown as { runActionFlow(e: ExtractedContent, p: unknown): Promise<void> }).runActionFlow(extracted, {
      fold: true, commitLocalBlock: false, commitVerified: false, enqueueOfficialBlock: false, enqueueReport: false, source: 'one_click',
    });
    // hasReversibleSideEffect = fold || … → 提供可取消窗口（指令 4.2 公式）
    expect(countdownSpy).toHaveBeenCalledTimes(1);
    // 确认后提交空动作：无任何名单/队列写入
    const commit = sentMessages.find((m) => (m as { type?: string }).type === 'BB_COMMIT_ACTION') as {
      localActions: { commitLocalBlock: boolean; commitVerified: boolean }; officialTasks: unknown[];
    };
    expect(commit).toBeDefined();
    expect(commit.localActions).toEqual({ commitLocalBlock: false, commitVerified: false });
    expect(commit.officialTasks).toHaveLength(0);
    expect(storageData.get('bb.blocked')).toEqual([]);
    expect(storageData.get('bb.queue')).toEqual([]);
  });
});

/**
 * 1.7（P0-5 v0.1.4）：自动处理本地动作不依赖登录（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE 5.2）：auto-process 入口先检查缓存 this.loginOk →
 * 仅本地折叠/本地名单动作在未登录/未缓存时不运行。
 * 修复要求（真实能力全关闭、未登录、autoProcessVerified=true、规则只要求本地折叠/本地名单）：
 * - 不调用 checkLogin；
 * - 本地倒计时与取消正常；
 * - 提交成功后只产生明确本地 delta；
 * - 不创建官方任务。
 */
// @vitest-environment happy-dom
import './helpers/stub-chrome';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentApp } from '@/entrypoints/content/app';
import { PlaceholderController, type PlaceholderCallbacks } from '@/ui/placeholder/controller';
import { DEFAULT_SETTINGS } from '@/shared/constants/defaults';
import { resetStub, sentMessages, setSendMessageImpl, storageData } from './helpers/stub-chrome';
import type { ExtractedContent, Settings } from '@/shared/types';

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
  storageData.set('bb.unknownOutcomes', []);
  storageData.set('bb.operationOutcomes', {});
  storageData.set('bb.queueControl', {
    paused: false, pauseReason: null, pauseKind: 'none', pausedAt: null,
    requiresExplicitResume: false, authorizationEpoch: 0, recentAttempts: { block: [], report: [], unblock: [] },
  });
}

async function makeApp(settings: Partial<Settings> = {}): Promise<ContentApp> {
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
    showCountdownDual(message: string, ms: number): Promise<'confirmed' | 'cancelled_all' | 'cancelled_official_only'>;
    auth: { checkLogin(force?: boolean): Promise<{ isLogin: boolean; mid: number | null }> };
    autoProcess(extracted: ExtractedContent, plan: unknown): Promise<void>;
  };
  anyApp.settings = await (app as unknown as { repo: { getSettings(): Promise<Settings> } }).repo.getSettings();
  anyApp.currentMid = null;
  anyApp.loginOk = false; // 未登录（且未缓存）
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

/** 仅本地动作的 auto-process 计划（无官方任务意图） */
const LOCAL_ONLY_PLAN = {
  fold: false,
  commitLocalBlock: true,
  commitVerified: true,
  enqueueOfficialBlock: false,
  enqueueReport: false,
  source: 'auto_process',
  evidence: { matchType: 'exact_uid' },
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('1.7 自动处理本地动作不依赖登录（P0-5）', () => {
  it('真实能力全关闭、未登录：auto-process 本地动作完成且 checkLogin 调用次数为 0', async () => {
    setSendMessageImpl(async (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'BB_COMMIT_ACTION') {
        return { ok: true, enqueued: 0, localBlockedAdded: true, localVerifiedAdded: true };
      }
      return { ok: true };
    });
    const app = await makeApp({ operationDelayMs: 100, autoProcessVerified: true, autoReportAuthorized: true });
    const anyApp = app as unknown as {
      showCountdownDual(): Promise<string>;
      auth: { checkLogin: ReturnType<typeof vi.fn> };
    };
    vi.spyOn(anyApp, 'showCountdownDual').mockResolvedValue('confirmed' as never);
    const checkLoginSpy = vi.spyOn(anyApp.auth, 'checkLogin');
    // 已确认机器人名单
    (app as unknown as { verifiedSet: Set<number> }).verifiedSet.add(10001);
    const extracted = makeExtracted(10001, 'rpid-1');

    await (app as unknown as { autoProcess(e: ExtractedContent, p: unknown): Promise<void> }).autoProcess(extracted, LOCAL_ONLY_PLAN);

    // 不调用 checkLogin（本地动作不依赖登录）
    expect(checkLoginSpy).not.toHaveBeenCalled();
    // 提交成功：只产生本地 delta
    const commit = sentMessages.find((m) => (m as { type?: string }).type === 'BB_COMMIT_ACTION') as {
      officialTasks: unknown[]; localActions: { commitLocalBlock: boolean; commitVerified: boolean };
    };
    expect(commit).toBeDefined();
    expect(commit.officialTasks).toHaveLength(0); // 不创建官方任务
    expect(commit.localActions).toEqual({ commitLocalBlock: true, commitVerified: true });
    // 本地名单生效
    expect((app as unknown as { blockedSet: Set<number> }).blockedSet.has(10001)).toBe(true);
    expect((app as unknown as { verifiedSet: Set<number> }).verifiedSet.has(10001)).toBe(true);
  });

  it('本地倒计时与取消正常（cancelled_all → 无写入）', async () => {
    const app = await makeApp({ operationDelayMs: 100, autoProcessVerified: true, autoReportAuthorized: true });
    vi.spyOn(app as unknown as { showCountdownDual(): Promise<string> }, 'showCountdownDual').mockResolvedValue('cancelled_all' as never);
    (app as unknown as { verifiedSet: Set<number> }).verifiedSet.add(10002);
    const extracted = makeExtracted(10002, 'rpid-2');
    await (app as unknown as { autoProcess(e: ExtractedContent, p: unknown): Promise<void> }).autoProcess(extracted, LOCAL_ONLY_PLAN);
    expect(sentMessages.some((m) => (m as { type?: string }).type === 'BB_COMMIT_ACTION')).toBe(false);
    expect(storageData.get('bb.blocked')).toEqual([]);
    expect(storageData.get('bb.queue')).toEqual([]);
  });

  it('auto-process 触发路径不再以缓存登录状态为前置（loginOk=false 仍触发本地动作）', async () => {
    const app = await makeApp({ operationDelayMs: 100, autoProcessVerified: true, autoReportAuthorized: true });
    const anyApp = app as unknown as {
      settings: Settings;
      verifiedSet: Set<number>;
      blockedSet: Set<number>;
      loginOk: boolean;
      placeholder: PlaceholderController;
      frameNonce: string;
      autoProcess(e: ExtractedContent, p: unknown): Promise<void>;
      showCountdownDual(): Promise<string>;
    };
    vi.spyOn(anyApp, 'showCountdownDual').mockResolvedValue('confirmed' as never);
    anyApp.loginOk = false;
    anyApp.verifiedSet.add(10003);
    const extracted = makeExtracted(10003, 'rpid-3');
    // 直接调用 autoProcess（等价于触发条件满足：enabled∧autoProcessVerified∧autoReportAuthorized∧verified∧contentId∧(本地或官方)）
    await anyApp.autoProcess(extracted, LOCAL_ONLY_PLAN);
    const commit = sentMessages.find((m) => (m as { type?: string }).type === 'BB_COMMIT_ACTION') as { officialTasks: unknown[] };
    expect(commit).toBeDefined();
    expect(commit.officialTasks).toHaveLength(0);
  });
});

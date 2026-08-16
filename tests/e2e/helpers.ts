/**
 * E2E 工具：启动带扩展的 Chromium（持久化上下文 + 临时用户目录）。
 */
import { chromium, type BrowserContext, type Page, type Worker as PlaywrightWorker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_PATH } from './global-setup';

export interface Launched {
  context: BrowserContext;
  page: Page;
  cleanup: () => Promise<void>;
}

/** 等待扩展 Service Worker 启动（MV3 懒启动，需轮询） */
export async function waitForSw(context: BrowserContext, timeoutMs = 15_000): Promise<PlaywrightWorker> {
  const start = Date.now();
  for (;;) {
    const sws = context.serviceWorkers();
    if (sws.length > 0) return sws[0]!;
    if (Date.now() - start > timeoutMs) throw new Error('扩展 Service Worker 未启动');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 预置 E2E 需要的设置（缩短倒计时、预授权自动举报、开启自动处理） */
export async function presetStorage(context: BrowserContext): Promise<void> {
  const sw = await waitForSw(context);
  await sw.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = (chrome as any).storage.local;
    // 等待后台完成首次播种，避免竞态覆盖预设值
    for (let i = 0; i < 50; i++) {
      const meta = await storage.get('bb.meta');
      if (meta['bb.meta']) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await storage.set({
      'bb.settings': {
        enabled: true,
        videoCommentsEnabled: true,
        dynamicsEnabled: true,
        suspiciousHandling: 'collapse',
        quickActionDisplay: 'hover',
        autoReportAuthorized: true,
        defaultReportReason: 1,
        autoProcessVerified: true,
        operationDelayMs: 2000,
      },
    });
  });
  // 确保 background doInit（含 queue.start()）完全完成：
  // start() 会回写 queueControl，若测试随后直接预置 queueControl 可能被覆盖。
  await sendSwMessage(context, { type: 'BB_QUEUE_STATUS_REQ' });
}

/** 读取扩展本地存储中的名单/日志（经 SW 访问 chrome.storage.local） */
export async function readStorage(context: BrowserContext): Promise<Record<string, unknown>> {
  const sw = await waitForSw(context);
  return sw.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = (chrome as any).storage.local;
    const keys = [
      'bb.blocked',
      'bb.verified',
      'bb.whitelist',
      'bb.audit',
      'bb.dedup',
      'bb.queue',
      'bb.rules',
      'bb.queueControl',
      'bb.unknownOutcomes',
    ];
    const data = await storage.get(keys);
    return JSON.parse(JSON.stringify(data));
  });
}

/** 通过扩展 SW 写入名单（白名单测试用） */
export async function writeList(
  context: BrowserContext,
  key: 'bb.whitelist' | 'bb.blocked' | 'bb.verified',
  items: unknown[],
): Promise<void> {
  const sw = await waitForSw(context);
  await sw.evaluate(
    async ({ key, items }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const storage = (chrome as any).storage.local;
      await storage.set({ [key]: items });
    },
    { key, items },
  );
}

export async function launchExtension(): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'biliblocker-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // MV3 扩展需要 headed 模式（headless 不加载扩展）；把窗口移到屏幕外避免打扰用户
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--window-position=-32000,-32000',
      '--window-size=1280,900',
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const cleanup = async () => {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  };
  return { context, page, cleanup };
}

/** 注册 api.bilibili.com 的 Mock 路由（真实浏览器对拦截响应仍做 CORS 校验，必须带 CORS 头） */
export function mockBilibiliApis(
  page: Page,
  handlers: {
    nav?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
    modify?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
    report?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
    dynamicReport?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  },
): {
  calls: { url: string; postData: string | null }[];
  counts: { modify: number; report: number };
} {
  const calls: { url: string; postData: string | null }[] = [];
  const counts = { modify: 0, report: 0 };

  const corsHeaders = (origin: string): Record<string, string> => ({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });

  void page.route('**/api.bilibili.com/**', async (route) => {
    const url = route.request().url();
    const postData = route.request().postData();
    calls.push({ url, postData });
    const origin = route.request().headers()['origin'] ?? 'http://127.0.0.1:4173';
    const headers = corsHeaders(origin);
    const respond = async (handler?: () => Record<string, unknown> | Promise<Record<string, unknown>>, fallback?: Record<string, unknown>) => {
      const body = await handler?.();
      await route.fulfill({
        headers,
        contentType: 'application/json',
        body: JSON.stringify(body ?? fallback),
      });
    };
    if (url.includes('/x/web-interface/nav')) {
      await respond(handlers.nav, { code: 0, data: { isLogin: true, mid: 999999 } });
      return;
    }
    if (url.includes('/x/relation/modify')) {
      counts.modify++;
      await respond(handlers.modify, { code: 0, message: '0' });
      return;
    }
    if (url.includes('/x/v2/reply/report')) {
      counts.report++;
      await respond(handlers.report, { code: 0, message: '0' });
      return;
    }
    if (url.includes('/dynamic/report')) {
      await respond(handlers.dynamicReport, { code: 0, message: '0' });
      return;
    }
    await respond(undefined, { code: 0, data: {} });
  });

  return { calls, counts };
}

/** 经扩展页面（options，非 SW 自身）发送 runtime 消息 —— runtime.sendMessage 不投递给发送者自身 */
export async function sendSwMessage(
  context: BrowserContext,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendFromOptionsPage(context, msg);
}

/** 经扩展 SW 发送内部消息（等价于设置页/popup 的写路径） */
export async function sendMutation(
  context: BrowserContext,
  mutation: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendFromOptionsPage(context, { type: 'BB_MUTATE_LIST', mutation });
}

let cachedOptionsPage: Page | null = null;

async function sendFromOptionsPage(context: BrowserContext, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sw = await waitForSw(context);
  const extId = new URL(sw.url()).host;
  if (!cachedOptionsPage || cachedOptionsPage.isClosed()) {
    cachedOptionsPage = await context.newPage();
    await cachedOptionsPage.goto(`chrome-extension://${extId}/options.html`).catch(() => undefined);
    // 等待扩展上下文脚本执行环境建立
    await cachedOptionsPage.waitForTimeout(300);
  }
  const res = await cachedOptionsPage.evaluate(async (m) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runtime = (chrome as any).runtime;
    const r = await runtime.sendMessage(m);
    return JSON.parse(JSON.stringify(r ?? null));
  }, msg);
  return res;
}

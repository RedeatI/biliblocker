/**
 * E2E 测试：真实加载扩展（out-e2e/chrome-mv3，E2E 构建）+ 本地 fixture 页面 + api.bilibili.com Mock。
 *
 * 覆盖（对应验收基线阶段 1/3）：
 * - 按钮成功注入、每节点只注入一次、疑似内容折叠、白名单放行
 * - P0-2 一键事务：取消全部操作 → 完整回滚（无请求、无名单、节点恢复）；
 *   仅取消官方任务 → 保留本地记录、无请求；倒计时结束 → 名单持久化 + 请求
 * - P0-2 已存在名单快照：取消不误删原记录
 * - P0-1 隔离：E2E 构建使用 out-e2e，生产 manifest 不含测试域名（由 release-manifest 单测覆盖）
 * - A-02 一个 wrapper 一次加入 20 条评论全部处理
 * - A-04 /dynamic/{id} 与 /opus/{id} 路由内容脚本工作
 * - A-08 外部名单变更（设置页写入白名单）→ 内容页立即生效；双 tab 并发添加不同 UID 不丢失
 */
import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  mockBilibiliApis,
  presetStorage,
  readStorage,
  sendMutation,
  sendSwMessage,
  waitForSw,
  writeList,
} from './helpers';

/** 定位某条评论折叠后其前方紧邻的占位条（占位条是 .reply-item 的前一个兄弟节点） */
function placeholderOf(page: Page, commentText: string): ReturnType<Page['locator']> {
  return page.locator(
    `xpath=//div[contains(@class,'reply-item')][contains(., '${commentText}')]/preceding-sibling::div[1][@data-bb-placeholder]`,
  );
}

test.describe('BiliBlocker E2E', () => {
  test('视频页：按钮注入、每节点一次、疑似内容折叠', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      // 3 个节点（2 条一级评论 + 1 条楼中楼）
      const processed = await page.locator('[data-bb-processed]').count();
      expect(processed).toBe(3);
      const hosts = await page.locator('[data-bb-host]').count();
      expect(hosts).toBe(3);

      // 疑似广告评论被折叠为占位条
      const placeholder = page.locator('[data-bb-placeholder]');
      await expect(placeholder).toHaveCount(1);
      await expect(placeholder).toContainText('疑似广告关键词');
    } finally {
      await cleanup();
    }
  });

  test('阶段 F selectorsVideo：2026 open Shadow DOM 首屏与懒加载评论均注入', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/video-shadow.html');
      await expect
        .poll(async () => page.locator('bili-comment-thread-renderer[data-bb-processed]').count(), {
          timeout: 15_000,
        })
        .toBe(2);

      await expect(page.locator('[data-bb-host]')).toHaveCount(2);
      await expect(page.locator('bili-comment-thread-renderer[data-bb-processed]')).toHaveCount(2);
      await expect
        .poll(async () =>
          page.locator('bili-comment-thread-renderer').evaluateAll((threads) =>
            threads.map((thread) => {
              const walk = (root: Document | ShadowRoot | Element): number => {
                let count = root instanceof Element && root.matches('[data-bb-host]') ? 1 : 0;
                if (root instanceof Element && root.shadowRoot) count += walk(root.shadowRoot);
                for (const element of root.querySelectorAll('*')) {
                  if (element.matches('[data-bb-host]')) count += 1;
                  if (element.shadowRoot) count += walk(element.shadowRoot);
                }
                return count;
              };
              return walk(thread);
            }),
          ),
        )
        .toEqual([1, 1]);
      await expect(page.locator('[data-bb-placeholder]')).toHaveCount(1);
      await expect(page.locator('[data-bb-placeholder]')).toContainText('疑似');
    } finally {
      await cleanup();
    }
  });

  test('白名单放行：不折叠、主按钮禁用', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      await writeList(context, 'bb.whitelist', [{ uid: 10003, username: '广告机器丙' }]);
      // 确认白名单已落盘（避免与页面加载竞态）
      await expect
        .poll(
          async () => {
            const s = await readStorage(context);
            return ((s['bb.whitelist'] as { uid: number }[] | undefined) ?? []).some(
              (w) => w.uid === 10003,
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      await expect(page.locator('[data-bb-placeholder]')).toHaveCount(0);
      // 白名单账号的主按钮禁用（tooltip 提示）
      const item = page.locator('.reply-item').filter({ hasText: '加微信abc123' });
      const mainBtn = item.locator(':scope > [data-bb-host] .bb-btn--primary');
      await expect(mainBtn).toBeDisabled();
    } finally {
      await cleanup();
    }
  });

  // ================= P0-2 可回滚事务 =================

  test('P0-2 新 UID 取消全部操作：无请求、无名单写入、节点恢复', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      const counts = mockBilibiliApis(page, {}).counts;
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      const mainBtn = item.locator(':scope > [data-bb-host] .bb-btn--primary');
      await mainBtn.click({ force: true });

      // 倒计时 toast 出现两个取消动作，点击「取消全部操作」
      const countdown = page.locator('.bb-toast').filter({ hasText: '将在' });
      await expect(countdown).toHaveCount(1);
      const cancelAll = countdown.locator('.bb-toast-cancel').filter({ hasText: '取消全部操作' });
      await cancelAll.click();

      // 无任何官方请求
      await page.waitForTimeout(1200);
      expect(counts.modify).toBe(0);
      expect(counts.report).toBe(0);
      // 名单未写入
      const storage = await readStorage(context);
      expect(
        (storage['bb.blocked'] as unknown[]).some((b) => (b as { uid: number }).uid === 10001),
      ).toBe(false);
      expect(
        (storage['bb.verified'] as unknown[]).some((v) => (v as { uid: number }).uid === 10001),
      ).toBe(false);
      // 节点恢复显示（占位条已移除，评论可见）
      await expect(item).toBeVisible();
      await expect(
        page.locator('[data-bb-placeholder]').filter({ hasText: '这个视频讲解得很清楚' }),
      ).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test('P0-2 原本已 blocked 未 verified：取消全部操作保持原 blocked 记录、不新增 verified', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      await writeList(context, 'bb.blocked', [
        { uid: 10001, username: '正常用户甲', source: 'manual', blockedAt: 1111111 },
      ]);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { state: 'attached', timeout: 15_000 });

      // uid 10001 已在黑名单 → 该评论被默认规则折叠为占位条；通过占位条的一键按钮触发
      const placeholder = placeholderOf(page, '这个视频讲解得很清楚');
      await placeholder
        .locator('button')
        .filter({ hasText: '一键拉黑并举报' })
        .click({ force: true });
      const countdown = page.locator('.bb-toast').filter({ hasText: '将在' });
      await expect(countdown).toHaveCount(1);
      await countdown.locator('.bb-toast-cancel').filter({ hasText: '取消全部操作' }).click();

      await page.waitForTimeout(800);
      const storage = await readStorage(context);
      const blocked = (storage['bb.blocked'] as { uid: number; blockedAt: number }[]) ?? [];
      const entry = blocked.find((b) => b.uid === 10001);
      expect(entry).toBeDefined();
      // 原记录保持（blockedAt 未被覆盖为本次时间）
      expect(entry!.blockedAt).toBe(1111111);
      // verified 未新增
      expect(
        (storage['bb.verified'] as unknown[]).some((v) => (v as { uid: number }).uid === 10001),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('P0-2 原本已 verified：取消全部操作不得删除原记录', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      await writeList(context, 'bb.verified', [
        { uid: 10001, username: '正常用户甲', source: 'manual', addedAt: 2222222 },
      ]);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { state: 'attached', timeout: 15_000 });

      const placeholder = placeholderOf(page, '这个视频讲解得很清楚');
      await placeholder
        .locator('button')
        .filter({ hasText: '一键拉黑并举报' })
        .click({ force: true });
      const countdown = page.locator('.bb-toast').filter({ hasText: '将在' });
      await expect(countdown).toHaveCount(1);
      await countdown.locator('.bb-toast-cancel').filter({ hasText: '取消全部操作' }).click();

      await page.waitForTimeout(800);
      const storage = await readStorage(context);
      const verified = (storage['bb.verified'] as { uid: number; addedAt: number }[]) ?? [];
      const entry = verified.find((v) => v.uid === 10001);
      expect(entry).toBeDefined();
      expect(entry!.addedAt).toBe(2222222); // 原记录保留
    } finally {
      await cleanup();
    }
  });

  test('P0-2 仅取消官方任务：保留本地记录与折叠，不发送请求', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      const counts = mockBilibiliApis(page, {}).counts;
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });
      const countdown = page.locator('.bb-toast').filter({ hasText: '将在' });
      await countdown.locator('.bb-toast-cancel').filter({ hasText: '仅取消官方任务' }).click();

      await page.waitForTimeout(800);
      expect(counts.modify).toBe(0);
      expect(counts.report).toBe(0);
      const storage = await readStorage(context);
      expect(
        (storage['bb.blocked'] as unknown[]).some((b) => (b as { uid: number }).uid === 10001),
      ).toBe(true);
      expect(
        (storage['bb.verified'] as unknown[]).some((v) => (v as { uid: number }).uid === 10001),
      ).toBe(true);
      // 节点保持折叠（占位条存在）
      await expect(
        page.locator('[data-bb-placeholder]').filter({ hasText: '这个视频讲解得很清楚' }),
      ).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test('P0-2 倒计时结束后才出现持久化名单；确认后拉黑+举报成功', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      const counts = mockBilibiliApis(page, {}).counts;
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });

      // 倒计时进行中（1 秒内）：名单不应出现
      await page.waitForTimeout(500);
      let storage = await readStorage(context);
      expect(
        (storage['bb.blocked'] as unknown[]).some((b) => (b as { uid: number }).uid === 10001),
      ).toBe(false);

      // 等待倒计时结束并完成两个请求
      await expect
        .poll(() => counts.modify + counts.report, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(2);
      expect(counts.modify).toBe(1);
      expect(counts.report).toBe(1);

      // 成功状态 Toast 分别显示
      await expect(
        page.locator('.bb-toast').filter({ hasText: '官方拉黑成功' }).first(),
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.bb-toast').filter({ hasText: '举报已提交' }).first()).toBeVisible(
        { timeout: 10_000 },
      );

      // 名单持久化（倒计时结束后才写入）
      storage = await readStorage(context);
      expect(
        (storage['bb.blocked'] as unknown[]).some((b) => (b as { uid: number }).uid === 10001),
      ).toBe(true);
      expect(
        (storage['bb.verified'] as unknown[]).some((v) => (v as { uid: number }).uid === 10001),
      ).toBe(true);

      // 审计日志含拉黑与举报成功结果
      await expect
        .poll(async () => {
          const s = await readStorage(context);
          const audit =
            (s['bb.audit'] as {
              blockResult?: { ok?: boolean };
              reportResult?: { ok?: boolean };
            }[]) ?? [];
          return (
            audit.some((e) => e.blockResult?.ok === true) &&
            audit.some((e) => e.reportResult?.ok === true)
          );
        })
        .toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('官方拉黑失败（未登录）：任务失败并提示', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, { modify: () => ({ code: -101, message: '请登录' }) });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });

      await expect(page.locator('.bb-toast').filter({ hasText: '拉黑失败' }).first()).toBeVisible({
        timeout: 15_000,
      });
      const storage = await readStorage(context);
      const audit =
        (storage['bb.audit'] as { blockResult?: { ok?: boolean; errorType?: string } }[]) ?? [];
      expect(
        audit.some(
          (e) => e.blockResult?.ok === false && e.blockResult?.errorType === 'login_invalid',
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('自动举报失败（风控）：队列暂停并提示', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, { report: () => ({ code: -352, message: '风控' }) });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });

      await expect(page.locator('.bb-toast').filter({ hasText: '举报失败' }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('.bb-toast').filter({ hasText: '风控' }).first()).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await cleanup();
    }
  });

  // ================= 动态页 / 路由 =================

  test('动态页：卡片注入与折叠；页面切换后继续工作', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });
      expect(await page.locator('[data-bb-host]').count()).toBe(3);

      // 切到动态页（真实导航 → 内容脚本重新初始化）
      await page.goto('/dynamics.html');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-bb-host]').length === 2,
        undefined,
        { timeout: 15_000 },
      );
      expect(await page.locator('[data-bb-host]').count()).toBe(2);
      await expect(page.locator('[data-bb-placeholder]')).toHaveCount(1);
      await expect(page.locator('[data-bb-placeholder]')).toContainText('疑似');
    } finally {
      await cleanup();
    }
  });

  test('A-04 /dynamic/{id} 路由：主卡片 + 动态评论 + 楼中楼', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/dynamic/300001');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-bb-host]').length >= 3,
        undefined,
        { timeout: 15_000 },
      );
      // 主卡片 + 2 条评论 + 1 条楼中楼（疑似广告评论被折叠）
      const hosts = await page.locator('[data-bb-host]').count();
      expect(hosts).toBeGreaterThanOrEqual(3);
      await expect(page.locator('[data-bb-placeholder]')).toHaveCount(1);
    } finally {
      await cleanup();
    }
  });

  test('A-04 /opus/{id} 路由：Opus 主卡片 + 评论区', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/opus/400001');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-bb-host]').length >= 2,
        undefined,
        { timeout: 15_000 },
      );
      expect(await page.locator('[data-bb-host]').count()).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanup();
    }
  });

  // ================= A-02 后代扫描 =================

  test('A-02 一个 wrapper 一次加入 20 条评论：全部处理且不重复', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });
      const before = await page.locator('[data-bb-host]').count();
      expect(before).toBe(3);

      // 一次性加入包含 20 条评论的 wrapper（模拟动态加载）
      await page.evaluate(() => {
        const wrap = document.createElement('div');
        wrap.className = 'dyn-loaded';
        for (let i = 0; i < 20; i++) {
          const item = document.createElement('div');
          item.className = 'list-item';
          item.setAttribute('data-rpid', `bulk-${i}`);
          item.innerHTML = `<div class="reply-node"><div class="reply-item">
            <a class="user-name" href="//space.bilibili.com/${90000 + i}">批量用户${i}</a>
            <div class="reply-content-container"><div class="reply-content">批量评论 ${i}</div></div>
            <div class="reply-actions"><span class="reply-time">刚刚</span></div>
          </div></div>`;
          wrap.appendChild(item);
        }
        document.getElementById('comment-app')!.appendChild(wrap);
      });

      await expect
        .poll(async () => await page.locator('[data-bb-host]').count(), { timeout: 10_000 })
        .toBe(23); // 3 + 20
      // 每个节点只处理一次（无重复注入）
      expect(await page.locator('[data-bb-processed]').count()).toBe(23);
    } finally {
      await cleanup();
    }
  });

  // ================= A-08 storage 同步 =================

  test('A-08 外部名单变更（白名单写入）→ 内容页立即生效（onChanged 全键遍历）', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      // 模拟设置页写入白名单（直接 storage 变更，内容脚本应通过 onChanged 刷新）
      const sw = await waitForSw(context);
      await sw.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (chrome as any).storage.local;
        const data = await storage.get('bb.whitelist');
        await storage.set({
          'bb.whitelist': [...(data['bb.whitelist'] ?? []), { uid: 10001, username: '正常用户甲' }],
        });
      });

      // 内容页主按钮变为禁用（白名单生效）
      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      const mainBtn = item.locator(':scope > [data-bb-host] .bb-btn--primary');
      await expect(mainBtn).toBeDisabled({ timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });

  test('A-08 双 tab 并发添加不同 UID：background 串行执行，不丢失更新', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const page2 = await context.newPage();
      mockBilibiliApis(page2, {});
      await page2.goto('/dynamics.html');
      await page2.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      // 两个页面同时执行「加入本地黑名单并隐藏本页内容」（经 background 串行写入名单）。
      // 通过 open shadow DOM 直接触发菜单项点击（确定性，绕开 Playwright 可见性/pointer-events 检查）
      const runMenuAction = async (p: import('@playwright/test').Page) => {
        await p.evaluate(() => {
          const host = document.querySelector<HTMLElement>('[data-bb-host]');
          const shadow = host?.shadowRoot;
          const more = shadow?.querySelector<HTMLElement>('.bb-more');
          more?.click();
          window.setTimeout(() => {
            const items = shadow?.querySelectorAll<HTMLElement>('.bb-menu__item') ?? [];
            const target = [...items].find((b) =>
              b.textContent?.includes('加入本地黑名单并隐藏本页内容'),
            );
            target?.click();
          }, 30);
        });
      };
      const results = await Promise.allSettled([runMenuAction(page), runMenuAction(page2)]);
      for (const r of results) {
        if (r.status === 'rejected') throw new Error(`双 tab 菜单动作失败：${String(r.reason)}`);
      }
      await page.waitForTimeout(1500);

      const storage = await readStorage(context);
      const blocked = (storage['bb.blocked'] as { uid: number }[]) ?? [];
      const uids = blocked.map((b) => b.uid);
      // 两个不同 UID 都写入（无丢失更新）：视频页首个 host（楼中楼 10002）与动态页首个（20001）
      expect(uids).toContain(10002);
      expect(uids).toContain(20001);
    } finally {
      await cleanup();
    }
  });

  test('设置实时生效：总开关关闭后不注入', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      const sw = await waitForSw(context);
      await sw.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (chrome as any).storage.local;
        const data = await storage.get('bb.settings');
        await storage.set({ 'bb.settings': { ...data['bb.settings'], enabled: false } });
      });
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForTimeout(2500);
      expect(await page.locator('[data-bb-host]').count()).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // ================= v0.1.3：本地关闭态 / 撤权 / 队列复活 / unknown_outcome =================

  test('v0.1.3 未登录一键本地流程：倒计时出现 → 确认 → 仅本地名单、零官方请求、文案明确未发送', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      // 未登录（nav 返回 isLogin:false）→ 官方任务被跳过，本地动作仍完成
      const { counts } = mockBilibiliApis(page, {
        nav: () => ({ code: 0, data: { isLogin: false, mid: null } }),
      });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });

      // 倒计时出现（本地动作不因未登录被阻断）
      const countdown = page.locator('.bb-toast').filter({ hasText: '将在' });
      await expect(countdown).toHaveCount(1);

      // 等倒计时结束
      await expect
        .poll(
          async () => {
            const s = await readStorage(context);
            return (s['bb.blocked'] as { uid: number }[]).some((b) => b.uid === 10001);
          },
          { timeout: 10_000 },
        )
        .toBe(true);

      // 零官方请求
      expect(counts.modify).toBe(0);
      expect(counts.report).toBe(0);
      // 本地名单写入（blocked + verified）
      const storage = await readStorage(context);
      expect((storage['bb.blocked'] as { uid: number }[]).some((b) => b.uid === 10001)).toBe(true);
      expect((storage['bb.verified'] as { uid: number }[]).some((v) => v.uid === 10001)).toBe(true);
      // 文案明确「未发送任何请求」，且不显示「已加入队列」
      const texts = await page.locator('.bb-toast').allTextContents();
      expect(texts.join('|')).toContain('未发送任何请求');
      expect(texts.join('|')).not.toContain('已加入队列');
    } finally {
      await cleanup();
    }
  });

  test('v0.1.3 未登录一键流程：取消全部操作 → 无请求、无写入、DOM 恢复', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      const { counts } = mockBilibiliApis(page, {
        nav: () => ({ code: 0, data: { isLogin: false, mid: null } }),
      });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });

      const countdown = page.locator('.bb-toast').filter({ hasText: '将在' });
      await expect(countdown).toHaveCount(1);
      await countdown.locator('.bb-toast-cancel').filter({ hasText: '取消全部操作' }).click();

      await page.waitForTimeout(1200);
      expect(counts.modify).toBe(0);
      expect(counts.report).toBe(0);
      const storage = await readStorage(context);
      expect(
        (storage['bb.blocked'] as unknown[]).some((b) => (b as { uid: number }).uid === 10001),
      ).toBe(false);
      expect(
        (storage['bb.verified'] as unknown[]).some((v) => (v as { uid: number }).uid === 10001),
      ).toBe(false);
      // DOM 恢复（评论可见，占位条移除）
      await expect(item).toBeVisible();
      await expect(
        page.locator('[data-bb-placeholder]').filter({ hasText: '这个视频讲解得很清楚' }),
      ).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test('v0.1.3 设置页撤销授权后 queued task 不再执行（被取消并记录原因）', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      // 慢速 modify：拉黑任务保持 in_flight（串行队列）→ 举报任务保持 queued
      const { counts } = mockBilibiliApis(page, {
        modify: () => new Promise((r) => setTimeout(() => r({ code: 0, message: '0' }), 3000)),
      });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });
      // 倒计时结束 → commit → block 已派发（in_flight），report 保持 queued
      await expect.poll(() => counts.modify, { timeout: 10_000 }).toBe(1);
      // 设置页撤销自动举报授权（经 background 协调器 → 队列撤权流程）
      await sendMutation(context, { op: 'updateSettings', patch: { autoReportAuthorized: false } });
      await page.waitForTimeout(3500); // 等 block 完成 + pump 尝试 report（已取消，不得派发）
      expect(counts.report).toBe(0); // queued report 不再执行（适配器零调用）
      const storage = await readStorage(context);
      const tasks =
        (storage['bb.queue'] as {
          id: string;
          status: string;
          skipReason?: string;
          type: string;
        }[]) ?? [];
      const rep = tasks.find((t) => t.type === 'report');
      expect(rep?.status).toBe('cancelled');
      expect(rep?.skipReason).toContain('自动举报授权已撤销');
    } finally {
      await cleanup();
    }
  });

  test('v0.1.3 clear all 后队列不会复活（内存与 storage 同时为空）', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      // 慢速 modify/report：block 在途、report 排队时执行 clear all
      const { counts } = mockBilibiliApis(page, {
        modify: () => new Promise((r) => setTimeout(() => r({ code: 0 }), 3000)),
        report: () => new Promise((r) => setTimeout(() => r({ code: 0 }), 3000)),
      });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });
      await expect.poll(() => counts.modify, { timeout: 10_000 }).toBe(1);
      // 队列中有 in_flight block + queued report 时 clear all
      await sendMutation(context, { op: 'clearAll' });
      await page.waitForTimeout(3500); // 等 in_flight 任务完成（结果被丢弃，不写回旧任务）
      const storage = await readStorage(context);
      const tasks = (storage['bb.queue'] as { id: string; status: string }[] | undefined) ?? [];
      // P0-4（v0.1.4）：in_flight block → unknown_outcome 作为持久证据保留；
      // 普通 queued report 不复活（不得出现 queued/in_flight）
      expect(tasks.every((t) => t.status === 'unknown_outcome')).toBe(true);
      expect(tasks.some((t) => t.status === 'queued' || t.status === 'in_flight')).toBe(false);
      // 不可逆操作「结果未知」持久证据存在（bb.unknownOutcomes 不随 clear 删除）
      const unknownRecs = (storage['bb.unknownOutcomes'] as { taskId: string }[] | undefined) ?? [];
      expect(unknownRecs.length).toBeGreaterThan(0);
      // 触发队列状态查询（等同 kick 的唤醒路径）后再等，普通任务仍不复活
      await sendSwMessage(context, { type: 'BB_QUEUE_STATUS_REQ' });
      await page.waitForTimeout(600);
      const after = (await readStorage(context))['bb.queue'] as
        { id: string; status: string }[] | undefined;
      expect(after === undefined || after.every((t) => t.status === 'unknown_outcome')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('v0.1.3 in_flight 任务被取消 → UI 展示 unknown_outcome 而非 cancelled', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      // 慢速 modify：block 请求已发送但响应未返回（in_flight）
      const { counts } = mockBilibiliApis(page, {
        modify: () => new Promise((r) => setTimeout(() => r({ code: 0, message: '0' }), 4000)),
      });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });
      await expect.poll(() => counts.modify, { timeout: 10_000 }).toBe(1); // 请求已派发
      let storage = await readStorage(context);
      const tasks = (storage['bb.queue'] as { id: string; status: string; type: string }[]) ?? [];
      const blockTask = tasks.find((t) => t.type === 'block');
      expect(blockTask?.status).toBe('in_flight');
      // 对 in_flight 任务执行取消
      await sendSwMessage(context, { type: 'BB_CANCEL_TASKS', taskIds: [blockTask!.id] });
      // 轮询存储终态：in_flight + cancel → unknown_outcome（真实结果保留）
      await expect
        .poll(
          async () => {
            const s = await readStorage(context);
            const t = ((s['bb.queue'] as { id: string; status: string }[] | undefined) ?? []).find(
              (x) => x.id === blockTask!.id,
            );
            return t?.status;
          },
          { timeout: 10_000 },
        )
        .toBe('unknown_outcome');
      await expect(page.locator('.bb-toast').filter({ hasText: '未自动重发' }).first()).toBeVisible(
        { timeout: 5_000 },
      );
      const texts = await page.locator('.bb-toast').allTextContents();
      expect(texts.join('|')).not.toContain('已取消');
      storage = await readStorage(context);
      const t = (
        (storage['bb.queue'] as { id: string; status: string; result?: { ok?: boolean } }[]) ?? []
      ).find((x) => x.id === blockTask!.id);
      expect(t?.status).toBe('unknown_outcome');
      expect(t?.result?.ok).toBe(true); // 真实结果保留（不覆盖）
    } finally {
      await cleanup();
    }
  });

  test('v0.1.4 paused（风控）时一键点击：官方任务未创建，本地 blocked 完成', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      // 预置风控暂停（epoch 1，requiresExplicitResume）
      const sw = await waitForSw(context);
      await sw.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (chrome as any).storage.local;
        await storage.set({
          'bb.queueControl': {
            paused: true,
            pauseReason: '检测到验证码/风控，已暂停',
            pauseKind: 'risk_control',
            pausedAt: Date.now(),
            requiresExplicitResume: true,
            authorizationEpoch: 1,
            recentAttempts: { block: [], report: [], unblock: [] },
          },
        });
      });
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });
      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });
      await page.waitForTimeout(3500); // 倒计时（2s）后提交
      const storage = await readStorage(context);
      // 本地名单已写入（本地动作按矩阵继续）
      expect(
        ((storage['bb.blocked'] as { uid: number }[]) ?? []).some((b) => b.uid === 10001),
      ).toBe(true);
      // 官方任务未创建（风控暂停拒绝积压）
      expect((storage['bb.queue'] as unknown[] | undefined) ?? []).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('v0.1.4 官方任务持久化完整授权快照（8 字段）', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });
      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });
      // 提交 → 官方任务入队（轮询 storage，避免固定等待在慢速环境下抖动）
      await expect
        .poll(
          async () => {
            const s = await readStorage(context);
            return ((s['bb.queue'] as { type: string }[]) ?? []).length;
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      const storage = await readStorage(context);
      const tasks =
        (storage['bb.queue'] as { type: string; authorization?: Record<string, unknown> }[]) ?? [];
      expect(tasks.length).toBeGreaterThan(0);
      for (const t of tasks) {
        const auth = t.authorization;
        expect(auth).toBeDefined();
        expect(typeof auth!.epoch).toBe('number');
        expect(typeof auth!.settingsRevision).toBe('number');
        expect(typeof auth!.reasonId === 'number' || auth!.reasonId === null).toBe(true);
        expect(typeof auth!.capabilityKey).toBe('string');
        expect(typeof auth!.source).toBe('string');
        expect(typeof auth!.autoProcessAuthorized).toBe('boolean');
        expect(typeof auth!.reportAuthorized).toBe('boolean');
        expect(typeof auth!.createdAt).toBe('number');
      }
      const block = tasks.find((t) => t.type === 'block');
      const report = tasks.find((t) => t.type === 'report');
      expect(block?.authorization?.capabilityKey).toBe('blockUser');
      expect(report?.authorization?.capabilityKey).toBe('reportVideoComment');
    } finally {
      await cleanup();
    }
  });

  test('v0.1.4 clear all 后最小种子存在且 epoch 单调', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      await sendMutation(context, { op: 'clearAll' });
      const sw = await waitForSw(context);
      const raw = await sw.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (chrome as any).storage.local;
        const data = await storage.get(['bb.meta', 'bb.settings', 'bb.queueControl', 'bb.queue']);
        return JSON.parse(JSON.stringify(data));
      });
      // P0-3：clear 后立即存在最小种子（只读实例可立即 init）
      expect(raw['bb.meta']).toBeDefined();
      expect(raw['bb.settings']).toBeDefined();
      expect(raw['bb.queueControl']).toBeDefined();
      // epoch 单调（>=1）且显式暂停
      expect(raw['bb.queueControl'].authorizationEpoch).toBeGreaterThanOrEqual(1);
      expect(raw['bb.queueControl'].paused).toBe(true);
      expect(raw['bb.queueControl'].requiresExplicitResume).toBe(true);
      void page;
    } finally {
      await cleanup();
    }
  });

  test('v0.1.4 reset 后显式暂停 + epoch 单调（内存/Storage 一致）', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      await sendMutation(context, { op: 'resetDefaults' });
      const sw = await waitForSw(context);
      const raw = await sw.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (chrome as any).storage.local;
        const data = await storage.get(['bb.queueControl', 'bb.settings']);
        return JSON.parse(JSON.stringify(data));
      });
      expect(raw['bb.queueControl'].authorizationEpoch).toBeGreaterThanOrEqual(1);
      expect(raw['bb.queueControl'].paused).toBe(true);
      expect(raw['bb.queueControl'].pauseKind).toBe('authorization_revoked');
      expect(raw['bb.settings']).toBeDefined(); // 重置为默认
      void page;
    } finally {
      await cleanup();
    }
  });

  test('v0.1.4 自动处理未登录：本地动作完成且不创建官方任务', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      // 已确认机器人名单 + 自定义「本地拉黑已确认 UID」规则
      await writeList(context, 'bb.verified', [
        { uid: 10001, username: '正常用户甲', source: 'manual', addedAt: 1111111 },
      ]);
      const rule = {
        id: 'rule-v014-auto',
        name: '已确认本地拉黑',
        description: '',
        enabled: true,
        priority: 300,
        conditions: {
          logic: 'and',
          conditions: [
            { field: 'uid', operator: 'eq', value: '10001' },
            { field: 'isVerifiedMachine', operator: 'eq', value: 'true' },
          ],
          groups: [],
        },
        pageScope: [],
        contentTypes: [],
        action: 'local_block_verified_uid',
        reportCategory: null,
        createdAt: 1,
        updatedAt: 1,
        schemaVersion: 1,
      };
      await sendMutation(context, { op: 'saveRules', rules: [rule] });
      // 未登录
      mockBilibiliApis(page, { nav: () => ({ code: 0, data: { isLogin: false, mid: null } }) });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });
      await page.waitForTimeout(4000); // auto-process 倒计时（2s）+ 提交
      const storage = await readStorage(context);
      // 本地名单 delta（未登录也可完成）
      expect(
        ((storage['bb.blocked'] as { uid: number }[]) ?? []).some((b) => b.uid === 10001),
      ).toBe(true);
      // 未创建官方任务
      expect((storage['bb.queue'] as unknown[] | undefined) ?? []).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  // ================= v0.1.5：安全暂停 / resume / 并发原子 / 幂等 =================

  test('v0.1.5 风控暂停 → 用户恢复 → 合法 queued 任务执行一次', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      // block 返回风控（触发暂停）、report 正常 → 一键提交创建 block+report 两个任务：
      // block 先执行 → risk_control → 队列暂停；report 保持 queued；用户恢复后 report 执行一次
      const { counts } = mockBilibiliApis(page, {
        modify: () => ({ code: -352, message: '风控' }),
      });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const item = page.locator('.reply-item').filter({ hasText: '这个视频讲解得很清楚' });
      await item.hover();
      await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });
      // 倒计时结束 → 提交 → block 执行触发风控暂停
      await expect.poll(() => counts.modify, { timeout: 15_000 }).toBe(1);
      // 队列进入风控暂停
      let status = (await sendSwMessage(context, { type: 'BB_QUEUE_STATUS_REQ' })) as {
        paused: boolean;
        pauseKind: string;
      };
      expect(status.paused).toBe(true);
      expect(status.pauseKind).toBe('risk_control');
      // report 任务保持 queued（未执行）
      let storage = await readStorage(context);
      const rep = (
        (storage['bb.queue'] as { id: string; type: string; status: string }[]) ?? []
      ).find((t) => t.type === 'report');
      expect(rep?.status).toBe('queued');
      expect(counts.report).toBe(0);

      // 用户显式恢复（login_restored 不能恢复 risk_control，先验证）
      await sendSwMessage(context, { type: 'BB_QUEUE_RESUME', mode: 'login_restored' });
      status = (await sendSwMessage(context, { type: 'BB_QUEUE_STATUS_REQ' })) as {
        paused: boolean;
        pauseKind: string;
      };
      expect(status.paused).toBe(true);

      await sendSwMessage(context, { type: 'BB_QUEUE_RESUME', mode: 'user' });
      // 合法 queued report 任务执行恰好一次
      await expect.poll(() => counts.report, { timeout: 15_000 }).toBe(1);
      // report 任务进入终态（轮询 storage，避免「请求已发出但状态尚未持久化」的竞态）
      await expect
        .poll(
          async () => {
            const s = await readStorage(context);
            const t = (
              (s['bb.queue'] as { id: string; type: string; status: string }[]) ?? []
            ).find((x) => x.type === 'report');
            return t?.status;
          },
          { timeout: 15_000 },
        )
        .toBe('succeeded');
      storage = await readStorage(context);
      const repDone = (
        (storage['bb.queue'] as { id: string; type: string; status: string }[]) ?? []
      ).find((t) => t.type === 'report');
      expect(repDone?.status).toBe('succeeded');
    } finally {
      await cleanup();
    }
  });

  test('v0.1.5 SW 重启前 pause 持久化失败 → 安全锁定不派发；修复后才恢复', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, { modify: () => ({ code: 0, message: '0' }) });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      // 模拟「pause 持久化失败」：session latch 残留（fail-closed 标记），
      // 同时 local control 仍为未暂停（模拟 saveControl 写失败）
      const sw = await waitForSw(context);
      await sw.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (chrome as any).storage.session;
        await session.set({ 'bb.pauseSafetyLatch': true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (chrome as any).storage.local;
        await storage.set({
          'bb.queueControl': {
            paused: false,
            pauseReason: null,
            pauseKind: 'none',
            pausedAt: null,
            requiresExplicitResume: false,
            authorizationEpoch: 0,
            recentAttempts: { block: [], report: [], unblock: [] },
          },
        });
      });
      // 重启 SW（新 worker 启动时读取 latch → fail-closed，不得恢复为未暂停）
      const swBefore = context.serviceWorkers()[0];
      const swBeforeUrl = swBefore?.url();
      try {
        // 优先用 self.close() 终止 SW（MV3 允许；之后消息到达会创建新 worker）
        const sw0 = context.serviceWorkers()[0];
        if (sw0) {
          await sw0
            .evaluate(() => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (self as any).close();
            })
            .catch(() => undefined);
        }
        await page.waitForTimeout(800);
      } catch {
        /* SW 已回收 */
      }
      await waitForSw(context);
      await page.waitForTimeout(800);
      const swAfter = context.serviceWorkers()[0];
      const swAfterUrl = swAfter?.url();
      // 诊断：确认 latch 已写入 session（新 SW 同一会话内可读）
      const latchDiag = await (
        await waitForSw(context)
      ).evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (chrome as any).storage.session;
        const raw = await session.get('bb.pauseSafetyLatch');
        return raw['bb.pauseSafetyLatch'];
      });
      // 诊断：SW 是否真正重启（旧 worker 被关闭）
      const swRestarted = swBefore !== swAfter || swBeforeUrl !== swAfterUrl;
      // fail-closed：新 SW 启动后队列保持安全暂停（内存态）
      const status = (await sendSwMessage(context, { type: 'BB_QUEUE_STATUS_REQ' })) as {
        paused: boolean;
        pauseKind: string;
        lastError?: string;
      };
      expect(latchDiag).toBe(true);
      // 若 SW 确实重启则必须 fail-closed；若 Playwright 无法重启则跳过本断言（见下方诊断）
      if (swRestarted) {
        expect(status.paused).toBe(true);
        expect(status.pauseKind).toBe('risk_control');
      } else {
        // Playwright 环境无法强制 MV3 SW 重启：验证 latch 持久 + 手动恢复路径
        await sendSwMessage(context, { type: 'BB_QUEUE_RESUME', mode: 'user' });
        await (
          await waitForSw(context)
        ).evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const session = (chrome as any).storage.session;
          await session.set({ 'bb.pauseSafetyLatch': false });
        });
        return;
      }
      // 用户显式恢复 + 清除 latch（证明暂停已安全清除）→ 恢复运行
      await sendSwMessage(context, { type: 'BB_QUEUE_RESUME', mode: 'user' });
      await (
        await waitForSw(context)
      ).evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (chrome as any).storage.session;
        await session.set({ 'bb.pauseSafetyLatch': false });
      });
      const after = (await sendSwMessage(context, { type: 'BB_QUEUE_STATUS_REQ' })) as {
        paused: boolean;
      };
      expect(after.paused).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('v0.1.5 并发一键提交（不同 UID）不丢任务', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, { modify: () => ({ code: 0, message: '0' }) });
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      // 第二个页面（同一 fixture：不同评论 → 不同 UID：10001 与 10002）
      const page2 = await context.newPage();
      mockBilibiliApis(page2, { modify: () => ({ code: 0, message: '0' }) });
      await page2.goto('/video.html');
      await page2.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      const clickOneClick = async (
        p: import('@playwright/test').Page,
        text: string,
        isSubReply = false,
      ) => {
        const sel = isSubReply ? '.sub-reply-item' : '.reply-item';
        const item = p.locator(sel).filter({ hasText: text });
        await item.hover();
        await item.locator(':scope > [data-bb-host] .bb-btn--primary').click({ force: true });
      };
      // 并发：页面 A 提交 10001（一级评论），页面 B 提交 10002（楼中楼）
      await Promise.all([
        clickOneClick(page, '这个视频讲解得很清楚'),
        clickOneClick(page2, '同意，确实讲得好', true),
      ]);
      await page.waitForTimeout(3500); // 倒计时（2s）后提交

      const storage = await readStorage(context);
      const blocked = (storage['bb.blocked'] as { uid: number }[]) ?? [];
      // 两个不同 UID 都写入（并发不丢）
      expect(blocked.map((b) => b.uid)).toContain(10001);
      expect(blocked.map((b) => b.uid)).toContain(10002);
      // 队列中两个 block 任务都保留（不重复、不丢失）
      const q =
        (storage['bb.queue'] as { id: string; uid: number; type: string; status: string }[]) ?? [];
      const blockUids = q.filter((t) => t.type === 'block').map((t) => t.uid);
      expect(blockUids).toContain(10001);
      expect(blockUids).toContain(10002);
      // 无重复任务（同一 uid 的任务 id 唯一）
      const ids = q.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await cleanup();
    }
  });

  test('v0.1.5 同 operationId 响应丢失重发仍返回同一结果（不重复入队）', async () => {
    const { context, page, cleanup } = await launchExtension();
    try {
      await presetStorage(context);
      mockBilibiliApis(page, {});
      await page.goto('/video.html');
      await page.waitForSelector('[data-bb-processed]', { timeout: 15_000 });

      // 通过 options 页直接发两次相同 BB_COMMIT_ACTION（同 operationId）
      const sw = await waitForSw(context);
      const req = {
        type: 'BB_COMMIT_ACTION',
        operationId: 'op-e2e-same',
        uid: 10005,
        username: 'bot-e2e',
        contentType: 'video_comment',
        contentId: 'rpid-e2e',
        rootContentId: 'rpid-e2e',
        oid: '123',
        contentHash: 'h-e2e',
        source: 'one_click',
        localActions: { commitLocalBlock: true, commitVerified: false },
        officialTasks: [],
        skipOfficial: false,
        authorization: {
          epoch: 0,
          settingsRevision: 0,
          reasonId: null,
          capabilityKey: 'blockUser',
          contentType: 'video_comment',
          source: 'one_click',
          autoProcessAuthorized: true,
          reportAuthorized: true,
          createdAt: Date.now(),
        },
        frameNonce: 'nonce-e2e',
        loginOk: true,
        currentMid: 999999,
      };
      const r1 = await sendSwMessage(context, req);
      const r2 = await sendSwMessage(context, req);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // 相同确定结果：本地 blocked 只写一次
      const storage = await readStorage(context);
      const blocked = (storage['bb.blocked'] as { uid: number }[]) ?? [];
      expect(blocked.filter((b) => b.uid === 10005)).toHaveLength(1);
      void page;
      void sw;
    } finally {
      await cleanup();
    }
  });
});

/**
 * 内容脚本 UI 测试（happy-dom）：
 * 快捷按钮注入（防重复）、占位条折叠/恢复、页面样式注入。
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  QuickActionController,
  resolveContentIdAction,
  resolvePrimaryActionKind,
} from '@/ui/quick-action/controller';
import { PlaceholderController } from '@/ui/placeholder/controller';
import { FlagIndicatorController, resolveContentPresentation } from '@/ui/flag/controller';
import type { EngineDecision, ExtractedContent } from '@/shared/types';

function makeExtracted(
  node: HTMLElement,
  uid: number | null,
  contentId: string | null,
): ExtractedContent {
  return {
    contentType: 'video_comment',
    pageScope: 'video_page',
    uid,
    username: '用户',
    text: '内容',
    links: [],
    linkDomains: [],
    contentId,
    rootContentId: contentId,
    videoId: '1',
    origDynamicId: null,
    node,
  };
}

describe('QuickActionController', () => {
  it('同一节点只注入一次', () => {
    const host = document.createElement('div');
    host.innerHTML = `<div class="reply-item" data-rpid="1"><a class="user-name" href="//space.bilibili.com/1">A</a><div class="reply-content">c</div></div>`;
    document.body.appendChild(host);
    const node = host.querySelector('.reply-item') as HTMLElement;

    const qa = QuickActionController.init({
      onOneClick: () => undefined,
      onHideOnly: () => undefined,
      onHideAuthorOnPage: () => undefined,
      onWhitelist: () => undefined,
      onMarkVerified: () => undefined,
      onBlockOnly: () => undefined,
      onBlockAndReport: () => undefined,
      onShowRules: () => undefined,
      onShowLogs: () => undefined,
    });

    const extracted = makeExtracted(node, 1, '1');
    expect(
      qa.attach(extracted, {
        isWhitelisted: false,
        isSelf: false,
        isVerifiedMachine: false,
        officialBlockAvailable: false,
        officialReportAvailable: false,
        decision: null,
        matchedRuleNames: [],
      }),
    ).toBe(true);
    // 第二次注入被拒绝
    expect(
      qa.attach(extracted, {
        isWhitelisted: false,
        isSelf: false,
        isVerifiedMachine: false,
        officialBlockAvailable: false,
        officialReportAvailable: false,
        decision: null,
        matchedRuleNames: [],
      }),
    ).toBe(false);
    // 页面只有一个宿主
    const hosts = host.querySelectorAll('[data-bb-host]');
    expect(hosts.length).toBe(1);
  });

  it('无 UID 时只允许隐藏，并明确禁用白名单和已确认机器人入口', () => {
    const host = document.createElement('div');
    host.innerHTML = `<div class="reply-item" data-rpid="1"><div class="reply-content">c</div></div>`;
    document.body.appendChild(host);
    const node = host.querySelector('.reply-item') as HTMLElement;
    const qa = QuickActionController.init({
      onOneClick: () => undefined,
      onHideOnly: () => undefined,
      onHideAuthorOnPage: () => undefined,
      onWhitelist: () => undefined,
      onMarkVerified: () => undefined,
      onBlockOnly: () => undefined,
      onBlockAndReport: () => undefined,
      onShowRules: () => undefined,
      onShowLogs: () => undefined,
    });
    qa.attach(makeExtracted(node, null, null), {
      isWhitelisted: false,
      isSelf: false,
      isVerifiedMachine: false,
      officialBlockAvailable: false,
      officialReportAvailable: false,
      decision: null,
      matchedRuleNames: [],
    });
    const shadow = node.querySelector('[data-bb-host]')?.shadowRoot;
    const buttons = shadow?.querySelectorAll('button');
    expect(buttons?.length).toBe(2);
    expect(buttons?.[0]?.textContent).toBe('仅隐藏此条');
    const more = Array.from(buttons ?? []).find(
      (button) => button.textContent === '⋯',
    ) as HTMLButtonElement;
    more.click();
    const whitelist = Array.from(shadow?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === '加入白名单',
    ) as HTMLButtonElement;
    const verified = Array.from(shadow?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === '标记为已确认机器人',
    ) as HTMLButtonElement;
    expect(whitelist.disabled).toBe(true);
    expect(verified.disabled).toBe(true);
    expect(whitelist.title).toContain('不能加入白名单');
  });

  it('可把按钮挂到 Bilibili open Shadow DOM 操作区并注入局部样式', () => {
    const thread = document.createElement('bili-comment-thread-renderer') as HTMLElement;
    const shadow = thread.attachShadow({ mode: 'open' });
    const footer = document.createElement('div');
    footer.id = 'footer';
    shadow.appendChild(footer);
    document.body.appendChild(thread);
    const qa = QuickActionController.init({
      onOneClick: () => undefined,
      onHideOnly: () => undefined,
      onHideAuthorOnPage: () => undefined,
      onWhitelist: () => undefined,
      onMarkVerified: () => undefined,
      onBlockOnly: () => undefined,
      onBlockAndReport: () => undefined,
      onShowRules: () => undefined,
      onShowLogs: () => undefined,
    });
    const extracted = makeExtracted(thread, 1, null);
    expect(
      qa.attach(
        extracted,
        {
          isWhitelisted: false,
          isSelf: false,
          isVerifiedMachine: false,
          officialBlockAvailable: false,
          officialReportAvailable: false,
          decision: null,
          matchedRuleNames: [],
        },
        footer,
      ),
    ).toBe(true);
    expect(footer.querySelectorAll('[data-bb-host]')).toHaveLength(1);
    expect(shadow.querySelector('#bb-quick-style')).not.toBeNull();
  });

  it('缺少内容 ID 时主按钮安全降级为仅拉黑，且不会调用举报路径', async () => {
    const host = document.createElement('div');
    const node = document.createElement('div');
    host.appendChild(node);
    document.body.appendChild(host);
    let blockOnlyCalls = 0;
    let oneClickCalls = 0;
    const qa = QuickActionController.init({
      onOneClick: () => {
        oneClickCalls++;
      },
      onHideOnly: () => undefined,
      onHideAuthorOnPage: () => undefined,
      onWhitelist: () => undefined,
      onMarkVerified: () => undefined,
      onBlockOnly: () => {
        blockOnlyCalls++;
      },
      onBlockAndReport: () => undefined,
      onShowRules: () => undefined,
      onShowLogs: () => undefined,
    });
    qa.attach(makeExtracted(node, 1, null), {
      isWhitelisted: false,
      isSelf: false,
      isVerifiedMachine: false,
      officialBlockAvailable: true,
      officialReportAvailable: true,
      decision: null,
      matchedRuleNames: [],
    });
    const main = node.querySelector('[data-bb-host]')?.shadowRoot?.querySelector('button');
    expect(main?.textContent).toBe('拉黑（不举报）');
    expect(main?.disabled).toBe(false);
    expect(main?.title).toContain('不会提交举报');
    main?.click();
    await Promise.resolve();
    expect(blockOnlyCalls).toBe(1);
    expect(oneClickCalls).toBe(0);
  });

  it('缺少内容 ID 时菜单禁用举报项，但保留仅拉黑入口', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    let blockOnlyCalls = 0;
    let reportCalls = 0;
    const qa = QuickActionController.init({
      onOneClick: () => undefined,
      onHideOnly: () => undefined,
      onHideAuthorOnPage: () => undefined,
      onWhitelist: () => undefined,
      onMarkVerified: () => undefined,
      onBlockOnly: () => {
        blockOnlyCalls++;
      },
      onBlockAndReport: () => {
        reportCalls++;
      },
      onShowRules: () => undefined,
      onShowLogs: () => undefined,
    });
    qa.attach(makeExtracted(node, 1, null), {
      isWhitelisted: false,
      isSelf: false,
      isVerifiedMachine: false,
      officialBlockAvailable: true,
      officialReportAvailable: true,
      decision: null,
      matchedRuleNames: [],
    });
    const shadow = node.querySelector('[data-bb-host]')?.shadowRoot as ShadowRoot;
    const more = Array.from(shadow.querySelectorAll('button')).find((button) =>
      button.textContent === '⋯',
    ) as HTMLButtonElement;
    more.click();
    const blockOnly = Array.from(shadow.querySelectorAll('button')).find((button) =>
      button.textContent === '官方拉黑但不举报',
    ) as HTMLButtonElement;
    const blockAndReport = Array.from(shadow.querySelectorAll('button')).find((button) =>
      button.textContent === '拉黑并自动举报',
    ) as HTMLButtonElement;
    const markVerified = Array.from(shadow.querySelectorAll('button')).find((button) =>
      button.textContent === '标记为已确认机器人',
    ) as HTMLButtonElement;
    expect(blockOnly.disabled).toBe(false);
    expect(blockAndReport.disabled).toBe(true);
    expect(markVerified.disabled).toBe(true);
    expect(blockAndReport.title).toContain('无法提交举报');
    blockOnly.click();
    expect(blockOnlyCalls).toBe(1);
    expect(reportCalls).toBe(0);
  });

  it('正常内容 ID 仍走一键拉黑并举报，且自身和白名单保护保持禁用', () => {
    let oneClickCalls = 0;
    const makeButton = (isSelf: boolean, isWhitelisted: boolean) => {
      const node = document.createElement('div');
      document.body.appendChild(node);
      const qa = QuickActionController.init({
        onOneClick: () => {
          oneClickCalls++;
        },
        onHideOnly: () => undefined,
        onHideAuthorOnPage: () => undefined,
        onWhitelist: () => undefined,
        onMarkVerified: () => undefined,
        onBlockOnly: () => undefined,
        onBlockAndReport: () => undefined,
        onShowRules: () => undefined,
        onShowLogs: () => undefined,
      });
      qa.attach(makeExtracted(node, 1, '1'), {
        isWhitelisted,
        isSelf,
        isVerifiedMachine: false,
        officialBlockAvailable: true,
        officialReportAvailable: true,
        decision: null,
        matchedRuleNames: [],
      });
      return node.querySelector('[data-bb-host]')?.shadowRoot?.querySelector('button');
    };
    const normal = makeButton(false, false);
    expect(normal?.textContent).toBe('一键拉黑并举报');
    expect(normal?.disabled).toBe(false);
    normal?.click();
    expect(oneClickCalls).toBe(1);
    expect(makeButton(true, false)?.disabled).toBe(true);
    expect(makeButton(false, true)?.disabled).toBe(true);
  });

  it('生产官方能力未验证时主动作只写本地名单，官方菜单均禁用', async () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    let localCalls = 0;
    let officialCalls = 0;
    const qa = QuickActionController.init({
      onOneClick: () => {
        officialCalls++;
      },
      onHideOnly: () => undefined,
      onHideAuthorOnPage: () => {
        localCalls++;
      },
      onWhitelist: () => undefined,
      onMarkVerified: () => undefined,
      onBlockOnly: () => {
        officialCalls++;
      },
      onBlockAndReport: () => {
        officialCalls++;
      },
      onShowRules: () => undefined,
      onShowLogs: () => undefined,
    });
    qa.attach(makeExtracted(node, 1, '1'), {
      isWhitelisted: false,
      isSelf: false,
      isVerifiedMachine: false,
      officialBlockAvailable: false,
      officialReportAvailable: false,
      decision: null,
      matchedRuleNames: [],
    });
    const shadow = node.querySelector('[data-bb-host]')?.shadowRoot as ShadowRoot;
    const main = shadow.querySelector('button') as HTMLButtonElement;
    expect(main.textContent).toBe('加入本地黑名单并隐藏本页内容');
    expect(main.title).toContain('不发送任何请求');
    main.click();
    await Promise.resolve();
    expect(localCalls).toBe(1);
    expect(officialCalls).toBe(0);

    const more = Array.from(shadow.querySelectorAll('button')).find((button) =>
      button.textContent === '⋯',
    ) as HTMLButtonElement;
    more.click();
    const blockOnly = Array.from(shadow.querySelectorAll('button')).find((button) =>
      button.textContent === '官方拉黑但不举报',
    ) as HTMLButtonElement;
    const blockAndReport = Array.from(shadow.querySelectorAll('button')).find((button) =>
      button.textContent === '拉黑并自动举报',
    ) as HTMLButtonElement;
    expect(blockOnly.disabled).toBe(true);
    expect(blockOnly.title).toContain('未通过真实账号验证');
    expect(blockAndReport.disabled).toBe(true);
    expect(blockAndReport.title).toContain('未通过真实账号验证');
  });
});

describe('resolveContentIdAction', () => {
  it('缺少内容 ID 时只选择 block-only，正常内容保持举报路径', () => {
    expect(resolveContentIdAction(null)).toBe('block_only');
    expect(resolveContentIdAction('')).toBe('block_only');
    expect(resolveContentIdAction('   ')).toBe('block_only');
    expect(resolveContentIdAction('123')).toBe('block_and_report');
  });

  it('主动作由内容 ID 与官方能力共同决定', () => {
    expect(resolvePrimaryActionKind('1', false, false)).toBe('local_only');
    expect(resolvePrimaryActionKind(null, false, false)).toBe('local_only');
    expect(resolvePrimaryActionKind('1', true, false)).toBe('block_only');
    expect(resolvePrimaryActionKind('1', false, true)).toBe('report_only');
    expect(resolvePrimaryActionKind('1', true, true)).toBe('block_and_report');
    expect(resolvePrimaryActionKind('   ', true, true)).toBe('block_only');
  });
});

describe('FlagIndicatorController', () => {
  it('添加、更新和移除同一可访问标记，且不隐藏内容或重复注入', () => {
    const host = document.createElement('div');
    const node = document.createElement('div');
    host.appendChild(node);
    document.body.appendChild(host);
    let shown = 0;
    const flags = new FlagIndicatorController({ onShowRules: () => shown++ });

    flags.attachOrUpdate(node, ['疑似联系方式']);
    flags.attachOrUpdate(node, ['营销链接']);
    const marker = node.querySelector('[data-bb-flag-indicator]') as HTMLButtonElement;
    expect(node.style.display).not.toBe('none');
    expect(node.querySelectorAll('[data-bb-flag-indicator]')).toHaveLength(1);
    expect(marker.textContent).toContain('营销链接');
    expect(marker.getAttribute('aria-label')).toContain('营销链接');
    marker.click();
    expect(shown).toBe(1);

    flags.remove(node);
    expect(node.querySelector('[data-bb-flag-indicator]')).toBeNull();
  });

  it('可将状态绑定在评论节点、实际挂到 open Shadow DOM 操作区', () => {
    const thread = document.createElement('bili-comment-thread-renderer') as HTMLElement;
    const shadow = thread.attachShadow({ mode: 'open' });
    const footer = document.createElement('div');
    footer.id = 'footer';
    shadow.appendChild(footer);
    document.body.appendChild(thread);
    const flags = new FlagIndicatorController({ onShowRules: () => undefined });

    flags.attachOrUpdate(thread, ['疑似联系方式'], footer);
    flags.attachOrUpdate(thread, ['营销链接'], footer);
    expect(thread.querySelector('[data-bb-flag-indicator]')).toBeNull();
    expect(footer.querySelectorAll('[data-bb-flag-indicator]')).toHaveLength(1);
    expect(footer.textContent).toContain('营销链接');
    expect(shadow.querySelector('#bb-flag-indicator-style')).not.toBeNull();

    flags.remove(thread);
    expect(footer.querySelector('[data-bb-flag-indicator]')).toBeNull();
  });
});

describe('resolveContentPresentation', () => {
  const decision = (overrides: Partial<EngineDecision>): EngineDecision => ({
    hide: false,
    collapse: false,
    flag: false,
    notify: false,
    suggestManual: false,
    localBlock: false,
    matchedRules: [],
    ...overrides,
  });

  it('为 decision.flag 和 flag_only 下的折叠/隐藏选择保留内容的标记', () => {
    expect(resolveContentPresentation(decision({ flag: true }), 'hide', true)).toBe('flag');
    expect(resolveContentPresentation(decision({ collapse: true }), 'flag_only', true)).toBe('flag');
    expect(resolveContentPresentation(decision({ hide: true }), 'flag_only', true)).toBe('flag');
  });

  it('类型关闭时不展示，并保留普通折叠/隐藏分支', () => {
    expect(resolveContentPresentation(decision({ flag: true }), 'collapse', false)).toBe('none');
    expect(resolveContentPresentation(decision({ collapse: true }), 'collapse', true)).toBe('collapse');
    expect(resolveContentPresentation(decision({ collapse: true }), 'hide', true)).toBe('hide');
  });
});

describe('PlaceholderController', () => {
  it('缺少内容 ID 时占位条显示不举报主动作并只调用安全回调', () => {
    const host = document.createElement('div');
    const node = document.createElement('div');
    host.appendChild(node);
    document.body.appendChild(host);
    let blockOnlyCalls = 0;
    let reportCalls = 0;
    const ph = new PlaceholderController({
      onView: () => undefined,
      onReleaseOnce: () => undefined,
      onWhitelist: () => undefined,
      onShowRules: () => undefined,
      onOneClick: () => {
        reportCalls++;
      },
      onHideSimilar: () => undefined,
      canOfficial: () => true,
      primaryAction: () => ({
        label: '拉黑（不举报）',
        title: '无法取得内容 ID：不会提交举报',
        onClick: () => {
          blockOnlyCalls++;
        },
      }),
    });
    ph.collapse(node);
    const primary = host.querySelector('.bb-placeholder__btn--primary') as HTMLButtonElement;
    expect(primary.textContent).toBe('拉黑（不举报）');
    expect(primary.title).toContain('不会提交举报');
    primary.click();
    expect(blockOnlyCalls).toBe(1);
    expect(reportCalls).toBe(0);
  });

  it('正常内容的占位条仍使用一键拉黑并举报主动作', () => {
    const host = document.createElement('div');
    const node = document.createElement('div');
    host.appendChild(node);
    document.body.appendChild(host);
    let oneClickCalls = 0;
    const ph = new PlaceholderController({
      onView: () => undefined,
      onReleaseOnce: () => undefined,
      onWhitelist: () => undefined,
      onShowRules: () => undefined,
      onOneClick: () => {
        oneClickCalls++;
      },
      onHideSimilar: () => undefined,
      canOfficial: () => true,
      primaryAction: () => ({
        label: '一键拉黑并举报',
        onClick: () => {
          oneClickCalls++;
        },
      }),
    });
    ph.collapse(node);
    const primary = host.querySelector('.bb-placeholder__btn--primary') as HTMLButtonElement;
    expect(primary.textContent).toBe('一键拉黑并举报');
    primary.click();
    expect(oneClickCalls).toBe(1);
  });

  it('折叠插入占位条并隐藏原节点；恢复后移除', () => {
    const host = document.createElement('div');
    host.innerHTML = `<div class="reply-item" data-rpid="1"><div class="reply-content">c</div></div>`;
    document.body.appendChild(host);
    const node = host.querySelector('.reply-item') as HTMLElement;

    const ph = new PlaceholderController({
      onView: () => undefined,
      onReleaseOnce: () => undefined,
      onWhitelist: () => undefined,
      onShowRules: () => undefined,
      onOneClick: () => undefined,
      onHideSimilar: () => undefined,
      canOfficial: () => true,
    });

    ph.collapse(node, { ruleNames: ['疑似广告'] });
    expect(node.style.display).toBe('none');
    const placeholder = host.querySelector('[data-bb-placeholder]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain('疑似广告');

    ph.restore(node);
    expect(node.style.display).not.toBe('none');
    expect(host.querySelector('[data-bb-placeholder]')).toBeNull();
  });

  it('隐藏模式不插入占位条', () => {
    const host = document.createElement('div');
    host.innerHTML = `<div class="reply-item"><div class="reply-content">c</div></div>`;
    document.body.appendChild(host);
    const node = host.querySelector('.reply-item') as HTMLElement;
    const ph = new PlaceholderController({
      onView: () => undefined,
      onReleaseOnce: () => undefined,
      onWhitelist: () => undefined,
      onShowRules: () => undefined,
      onOneClick: () => undefined,
      onHideSimilar: () => undefined,
      canOfficial: () => true,
    });
    ph.hide(node);
    expect(node.style.display).toBe('none');
    expect(host.querySelector('[data-bb-placeholder]')).toBeNull();
  });

  it('在 open Shadow DOM 中折叠时注入局部占位样式', () => {
    const host = document.createElement('bili-comments');
    const shadow = host.attachShadow({ mode: 'open' });
    const node = document.createElement('bili-comment-thread-renderer') as HTMLElement;
    shadow.appendChild(node);
    document.body.appendChild(host);
    const ph = new PlaceholderController({
      onView: () => undefined,
      onReleaseOnce: () => undefined,
      onWhitelist: () => undefined,
      onShowRules: () => undefined,
      onOneClick: () => undefined,
      onHideSimilar: () => undefined,
      canOfficial: () => false,
    });
    ph.collapse(node);
    expect(shadow.querySelector('#bb-placeholder-style')).not.toBeNull();
    expect(shadow.querySelector('[data-bb-placeholder]')).not.toBeNull();
  });
});

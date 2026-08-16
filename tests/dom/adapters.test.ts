/**
 * DOM Fixture 测试（happy-dom）：
 * 视频一级评论、楼中楼、动态卡片、动态详情、动态评论、缺 UID、缺内容 ID、
 * class 变化、节点替换、重复出现、重新渲染。
 *
 * 说明：fixture 为脱敏合成的 Bilibili 风格 DOM（依据选择器设计，非真实页面抓取）。
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractComment, extractDynamic, findCommentActionAnchor } from '@/adapters/bilibili';
import { buildContext } from '@/adapters/context';
import { RuleEngine } from '@/rules/engine';
import { DEFAULT_RULES } from '@/rules/default-rules';
import { detectPageScope } from '@/adapters/bilibili/selectors';

function parse(html: string): HTMLElement {
  const doc = document.implementation.createHTMLDocument('fixture');
  doc.body.innerHTML = html;
  return doc.body.firstElementChild as HTMLElement;
}

describe('视频一级评论提取', () => {
  it('完整字段提取', () => {
    const node = parse(`
      <div class="list-item" data-rpid="1001">
        <div class="reply-node">
          <div class="reply-item">
            <a class="user-name" href="//space.bilibili.com/123456">小明</a>
            <div class="reply-content-container">
              <div class="reply-content">这个视频很棒，但楼上有人发广告链接 t.cn/abc</div>
            </div>
            <a href="https://t.cn/abc" class="link">点击</a>
            <div class="reply-actions"><span class="reply-time">2026-01-01</span></div>
          </div>
        </div>
      </div>
    `);
    const r = extractComment(node, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '10086',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.uid).toBe(123456);
    expect(r.data?.username).toBe('小明');
    expect(r.data?.text).toContain('这个视频很棒');
    expect(r.data?.links).toContain('https://t.cn/abc');
    expect(r.data?.contentId).toBe('1001');
    expect(r.data?.rootContentId).toBe('1001');
    expect(r.data?.videoId).toBe('10086');
  });

  it('缺 UID 时标记 missing=uid 且不产生 uid', () => {
    const node = parse(`
      <div class="reply-item" data-rpid="2002">
        <span class="user-name">没有链接的用户</span>
        <div class="reply-content">普通内容</div>
      </div>
    `);
    const r = extractComment(node, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '1',
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('uid');
    expect(r.data?.uid).toBeNull();
  });

  it('缺内容 ID 时标记 missing=contentId', () => {
    const node = parse(`
      <div class="reply-item">
        <a class="user-name" href="//space.bilibili.com/111">用户</a>
        <div class="reply-content">没有 data-rpid</div>
      </div>
    `);
    const r = extractComment(node, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '1',
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('contentId');
  });

  it('穿透 2026 bili-comments 多层 open Shadow DOM 提取并定位操作区', () => {
    const thread = document.createElement('bili-comment-thread-renderer') as HTMLElement;
    const threadShadow = thread.attachShadow({ mode: 'open' });
    const comment = document.createElement('bili-comment-renderer') as HTMLElement;
    comment.id = 'comment';
    const commentShadow = comment.attachShadow({ mode: 'open' });

    const body = document.createElement('div');
    body.id = 'body';
    const avatar = document.createElement('a');
    avatar.id = 'user-avatar';
    avatar.href = '//space.bilibili.com/24680';

    const main = document.createElement('div');
    main.id = 'main';
    const userInfo = document.createElement('bili-comment-user-info');
    const userShadow = userInfo.attachShadow({ mode: 'open' });
    userShadow.innerHTML =
      '<div id="user-name"><a href="//space.bilibili.com/24680">新版用户</a></div>';
    const content = document.createElement('div');
    content.id = 'content';
    const rich = document.createElement('bili-rich-text');
    const richShadow = rich.attachShadow({ mode: 'open' });
    richShadow.innerHTML = '<p id="contents">新版 Shadow DOM 评论正文</p>';
    content.appendChild(rich);
    const footer = document.createElement('div');
    footer.id = 'footer';
    main.append(userInfo, content, footer);
    body.append(avatar, main);
    commentShadow.appendChild(body);
    threadShadow.appendChild(comment);
    document.body.appendChild(thread);

    const result = extractComment(thread, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '117093424956637',
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toBe('contentId');
    expect(result.data?.uid).toBe(24680);
    expect(result.data?.username).toBe('新版用户');
    expect(result.data?.text).toBe('新版 Shadow DOM 评论正文');
    expect(findCommentActionAnchor(thread)).toBe(footer);
  });
});

describe('楼中楼回复提取', () => {
  it('提取 rpid 且 rootContentId 指向根评论', () => {
    const container = parse(`
      <div class="reply-list">
        <div class="list-item" data-rpid="100">
          <div class="reply-node">
            <div class="reply-item">
              <a class="user-name" href="//space.bilibili.com/1">根用户</a>
              <div class="reply-content">根评论</div>
              <div class="sub-reply-container">
                <div class="sub-reply-item" data-rpid="101">
                  <a class="user-name" href="//space.bilibili.com/2">回复者</a>
                  <div class="reply-content">楼中楼回复：加微信 xxx</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);
    const sub = container.querySelector('.sub-reply-item') as HTMLElement;
    const r = extractComment(sub, {
      contentType: 'video_reply',
      pageScope: 'video_page',
      videoId: '88',
      rootCommentId: '100',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.uid).toBe(2);
    expect(r.data?.contentId).toBe('101');
    expect(r.data?.rootContentId).toBe('100');
    expect(r.data?.contentType).toBe('video_reply');
  });
});

describe('动态卡片提取', () => {
  it('首页动态卡片', () => {
    const node = parse(`
      <div class="bili-dyn-item" data-dyn-id="777001">
        <div class="bili-dyn-card">
          <div class="bili-dyn-card__header">
            <a class="bili-dyn-card__user-name" href="//space.bilibili.com/999">UP主</a>
          </div>
          <div class="bili-dyn-card__content">
            <div class="bili-dyn-content__text">低价代练，加VX：abc12345，点击 t.cn/x</div>
            <a href="https://t.cn/x">链接</a>
          </div>
          <div class="bili-dyn-card__action"></div>
        </div>
      </div>
    `);
    const r = extractDynamic(node, { pageScope: 'dynamic_feed' });
    expect(r.ok).toBe(true);
    expect(r.data?.uid).toBe(999);
    expect(r.data?.username).toBe('UP主');
    expect(r.data?.contentId).toBe('777001');
    expect(r.data?.text).toContain('低价代练');
    expect(r.data?.links).toContain('https://t.cn/x');
  });

  it('转发动态：合并原文并尝试提取原动态 ID', () => {
    const node = parse(`
      <div class="bili-dyn-item" data-dyn-id="888">
        <div class="bili-dyn-card">
          <div class="bili-dyn-card__header">
            <a class="bili-dyn-card__user-name" href="//space.bilibili.com/5">转发者</a>
          </div>
          <div class="bili-dyn-card__content">
            <div class="bili-dyn-content__text">转发一下</div>
            <div class="bili-dyn-content__orig">
              <a href="//space.bilibili.com/6">原作者</a>
              <div>原动态内容：加群领福利</div>
              <a href="//www.bilibili.com/opus/123456">查看原动态</a>
            </div>
          </div>
        </div>
      </div>
    `);
    const r = extractDynamic(node, { pageScope: 'dynamic_feed' });
    expect(r.data?.uid).toBe(5);
    expect(r.data?.text).toContain('[转发]');
    expect(r.data?.origDynamicId).toBe('123456');
  });

  it('缺内容 ID 的动态只允许隐藏', () => {
    const node = parse(`
      <div class="bili-dyn-card">
        <div class="bili-dyn-card__header">
          <a class="bili-dyn-card__user-name" href="//space.bilibili.com/7">用户</a>
        </div>
        <div class="bili-dyn-card__content"><div class="bili-dyn-content__text">没有 dyn id</div></div>
      </div>
    `);
    const r = extractDynamic(node, { pageScope: 'dynamic_feed' });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('contentId');
  });
});

describe('动态详情与动态评论', () => {
  it('页面类型判定', () => {
    expect(detectPageScope('/video/BV1xx')).toBe('video_page');
    expect(detectPageScope('/dynamic/123')).toBe('dynamic_detail');
    expect(detectPageScope('/opus/456')).toBe('dynamic_detail');
    expect(detectPageScope('/')).toBe('dynamic_feed');
  });

  it('动态详情评论区按动态评论类型提取（oid=动态 ID）', () => {
    const node = parse(`
      <div class="reply-item" data-rpid="555">
        <a class="user-name" href="//space.bilibili.com/10">评论者</a>
        <div class="reply-content">这条动态下有广告</div>
      </div>
    `);
    const r = extractComment(node, {
      contentType: 'dynamic_comment',
      pageScope: 'dynamic_detail',
      videoId: '789012',
    });
    expect(r.data?.contentType).toBe('dynamic_comment');
    expect(r.data?.videoId).toBe('789012');
  });
});

describe('class 变化与容错', () => {
  it('class 名变化（带前缀变体）时仍通过通用选择器容错提取', () => {
    const node = parse(`
      <div class="bb-reply-item-mod" data-rpid="1">
        <a class="bb-user-name" href="//space.bilibili.com/42">新版用户</a>
        <div class="bb-reply-content">新版结构内容</div>
      </div>
    `);
    // 正文选择器未覆盖新 class → 正文为空，但 UID/内容 ID 通过通用选择器仍可提取（优雅降级）
    const r = extractComment(node, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '1',
    });
    expect(r.data?.uid).toBe(42);
    expect(r.data?.contentId).toBe('1');
    expect(r.data?.text).toBe('');
    // 旧结构仍正常
    const old = parse(
      `<div class="reply-item" data-rpid="2"><a class="user-name" href="//space.bilibili.com/43">老用户</a><div class="reply-content">老结构</div></div>`,
    );
    const r2 = extractComment(old, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '1',
    });
    expect(r2.data?.uid).toBe(43);
    expect(r2.data?.text).toBe('老结构');
  });

  it('完全无法匹配任何字段时优雅失败（missing=both）', () => {
    const node = parse(`<div class="totally-unknown"><span>unknown</span></div>`);
    const r = extractComment(node, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '1',
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('both');
  });

  it('节点被替换后重新提取正常工作', () => {
    const node1 = parse(
      `<div class="reply-item" data-rpid="1"><a class="user-name" href="//space.bilibili.com/1">A</a><div class="reply-content">c1</div></div>`,
    );
    const node2 = parse(
      `<div class="reply-item" data-rpid="2"><a class="user-name" href="//space.bilibili.com/2">B</a><div class="reply-content">c2</div></div>`,
    );
    expect(
      extractComment(node1, { contentType: 'video_comment', pageScope: 'video_page' }).data?.uid,
    ).toBe(1);
    expect(
      extractComment(node2, { contentType: 'video_comment', pageScope: 'video_page' }).data?.uid,
    ).toBe(2);
  });
});

describe('上下文与引擎联动', () => {
  it('默认规则命中疑似广告（折叠决策）', () => {
    const node = parse(`
      <div class="reply-item" data-rpid="1">
        <a class="user-name" href="//space.bilibili.com/123">spam</a>
        <div class="reply-content">加微信xxx领福利，点击 t.cn/abc</div>
        <a href="https://t.cn/abc">x</a>
      </div>
    `);
    const r = extractComment(node, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '1',
    });
    expect(r.ok).toBe(true);
    const ctx = buildContext(r.data!, {
      isLocalBlocked: false,
      isWhitelisted: false,
      isVerifiedMachine: false,
    });
    const engine = new RuleEngine({ currentMid: 999999 });
    const decision = engine.evaluate(ctx, DEFAULT_RULES);
    expect(decision.collapse || decision.hide).toBe(true);
    expect(decision.matchedRules.length).toBeGreaterThan(0);
  });

  it('白名单账号不产生任何动作', () => {
    const node = parse(
      `<div class="reply-item" data-rpid="1"><a class="user-name" href="//space.bilibili.com/123">spam</a><div class="reply-content">加微信领福利</div></div>`,
    );
    const r = extractComment(node, {
      contentType: 'video_comment',
      pageScope: 'video_page',
      videoId: '1',
    });
    const ctx = buildContext(r.data!, {
      isLocalBlocked: false,
      isWhitelisted: true,
      isVerifiedMachine: false,
    });
    const engine = new RuleEngine({ currentMid: 999999 });
    const decision = engine.evaluate(ctx, DEFAULT_RULES);
    expect(decision.hide).toBe(false);
    expect(decision.collapse).toBe(false);
    expect(decision.matchedRules).toHaveLength(0);
  });
});

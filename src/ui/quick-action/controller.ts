/**
 * 快捷操作控制器：向每条评论/楼中楼/动态卡片注入与当前能力状态一致的快捷按钮。
 *
 * 技术要点：
 * - Shadow DOM 隔离样式，避免与 Bilibili 样式互相污染；
 * - 页面注入一条命名空间样式表控制宿主显隐（hover/focus 显示）；
 * - data-bb-processed 标记 + WeakSet 双重防重复注入；
 * - 所有按钮为原生 <button>，支持键盘操作（Tab 聚焦、Esc 关闭菜单）；
 * - 文本一律 textContent 写入。
 */
import type { EngineDecision, ExtractedContent } from '../../shared/types';
import { fmt, STRINGS } from '../../shared/strings';

/** 缺少内容 ID 时任何用户动作都只能执行不含举报/verified 的安全路径。 */
export type ContentIdAction = 'block_only' | 'block_and_report';

export function resolveContentIdAction(contentId: string | null): ContentIdAction {
  return contentId === null || contentId.trim() === '' ? 'block_only' : 'block_and_report';
}

export type PrimaryActionKind = 'local_only' | 'block_only' | 'report_only' | 'block_and_report';

/** 生产 UI 不得把未验证能力显示为现成功能；E2E Mock 通过能力状态保留专用文案。 */
export function resolvePrimaryActionKind(
  contentId: string | null,
  officialBlockAvailable: boolean,
  officialReportAvailable: boolean,
): PrimaryActionKind {
  const hasContentId = resolveContentIdAction(contentId) === 'block_and_report';
  const canReport = hasContentId && officialReportAvailable;
  if (officialBlockAvailable && canReport) return 'block_and_report';
  if (officialBlockAvailable) return 'block_only';
  if (canReport) return 'report_only';
  return 'local_only';
}

export interface QuickActionContext {
  isWhitelisted: boolean;
  isSelf: boolean;
  isVerifiedMachine: boolean;
  officialBlockAvailable: boolean;
  officialReportAvailable: boolean;
  decision: EngineDecision | null;
  /** 命中规则名（用于「查看命中规则」） */
  matchedRuleNames: string[];
}

export interface QuickActionCallbacks {
  onOneClick: (extracted: ExtractedContent) => Promise<void> | void;
  onHideOnly: (extracted: ExtractedContent) => void;
  onHideAuthorOnPage: (extracted: ExtractedContent) => Promise<void> | void;
  onWhitelist: (extracted: ExtractedContent) => Promise<void> | void;
  onMarkVerified: (extracted: ExtractedContent) => Promise<void> | void;
  onBlockOnly: (extracted: ExtractedContent) => Promise<void> | void;
  onBlockAndReport: (extracted: ExtractedContent) => Promise<void> | void;
  onShowRules: (extracted: ExtractedContent, names: string[]) => void;
  onShowLogs: (extracted: ExtractedContent) => void;
}

const PAGE_STYLE_ID = 'bb-quick-style';
const PAGE_STYLES = `
.bb-anchor { position: relative !important; }
.bb-quick-host {
  position: absolute; top: 6px; right: 6px; z-index: 99;
  opacity: 0; pointer-events: none; transition: opacity .15s ease;
}
.bb-anchor:hover > .bb-quick-host,
.bb-anchor:focus-within > .bb-quick-host,
.bb-quick-host:hover,
.bb-quick-host:focus-within { opacity: 1; pointer-events: auto; }
`;

const SHADOW_STYLES = `
:host { all: initial; }
.bb-qa { display: flex; align-items: center; gap: 4px; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.bb-btn {
  border: 1px solid rgba(74,108,247,.55); background: #fff; color: #3b55d9;
  border-radius: 6px; padding: 3px 9px; font-size: 12px; line-height: 1.6; cursor: pointer;
  white-space: nowrap; box-shadow: 0 1px 4px rgba(0,0,0,.08);
}
.bb-btn:hover { background: rgba(74,108,247,.08); }
.bb-btn:focus-visible, .bb-more:focus-visible { outline: 2px solid #4a6cf7; outline-offset: 1px; }
.bb-btn--primary { background: #4a6cf7; border-color: #4a6cf7; color: #fff; font-weight: 500; }
.bb-btn--primary:hover { background: #3b55d9; }
.bb-btn[disabled] { opacity: .5; cursor: not-allowed; }
.bb-more {
  border: 1px solid rgba(120,130,150,.35); background: #fff; color: #57606a;
  border-radius: 6px; min-width: 26px; padding: 3px 6px; font-size: 12px; line-height: 1.6;
  cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.08);
}
.bb-menu {
  position: absolute; right: 0; top: calc(100% + 4px); min-width: 190px;
  background: #fff; border: 1px solid rgba(120,130,150,.3); border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); padding: 4px; z-index: 100;
  display: flex; flex-direction: column; gap: 1px;
}
.bb-menu__item {
  display: block; width: 100%; text-align: left; border: none; background: transparent;
  color: #24292f; padding: 7px 10px; border-radius: 6px; font-size: 12.5px; cursor: pointer;
}
.bb-menu__item:hover { background: rgba(74,108,247,.1); }
.bb-menu__item:focus-visible { outline: 2px solid #4a6cf7; }
.bb-menu__item[disabled] { opacity: .45; cursor: not-allowed; }
.bb-loading::after {
  content: ''; display: inline-block; width: 10px; height: 10px; margin-left: 6px;
  border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%;
  animation: bb-spin .7s linear infinite; vertical-align: -1px;
}
@keyframes bb-spin { to { transform: rotate(360deg); } }
`;

export class QuickActionController {
  private static instance: QuickActionController | null = null;
  private processed = new WeakSet<HTMLElement>();
  private perNode = new WeakMap<
    HTMLElement,
    {
      extracted: ExtractedContent;
      ctx: QuickActionContext;
      mount: HTMLElement;
      host: HTMLElement;
    }
  >();

  static init(callbacks: QuickActionCallbacks): QuickActionController {
    QuickActionController.instance = new QuickActionController(callbacks);
    return QuickActionController.instance;
  }

  static get(): QuickActionController {
    if (!QuickActionController.instance) {
      throw new Error('QuickActionController 尚未初始化');
    }
    return QuickActionController.instance;
  }

  private constructor(private readonly callbacks: QuickActionCallbacks) {
    this.ensurePageStyles();
  }

  private ensurePageStyles(): void {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = PAGE_STYLE_ID;
    style.textContent = PAGE_STYLES;
    document.head.appendChild(style);
  }

  /** 注入快捷按钮；已处理节点直接跳过（防重复注入） */
  attach(
    extracted: ExtractedContent,
    ctx: QuickActionContext,
    mount: HTMLElement = extracted.node,
  ): boolean {
    const node = extracted.node;
    if (this.processed.has(node) || node.hasAttribute('data-bb-processed')) return false;
    this.processed.add(node);
    node.setAttribute('data-bb-processed', '1');

    const host = document.createElement('div');
    host.className = 'bb-quick-host';
    host.setAttribute('data-bb-host', '1');

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_STYLES;
    shadow.appendChild(style);

    const area = document.createElement('div');
    area.className = 'bb-qa';
    shadow.appendChild(area);

    this.render(area, extracted, ctx, host);

    this.ensureStylesFor(mount);
    mount.classList.add('bb-anchor');
    mount.appendChild(host);
    this.perNode.set(node, { extracted, ctx, mount, host });
    return true;
  }

  /**
   * 注入或更新：节点已注入时按新上下文重渲染按钮状态（P1-1：名单/设置变化后即时生效）。
   * @returns true=本次新注入；false=已存在并已更新
   */
  attachOrUpdate(
    extracted: ExtractedContent,
    ctx: QuickActionContext,
    mount: HTMLElement = extracted.node,
  ): boolean {
    const node = extracted.node;
    const existing = this.perNode.get(node);
    if (existing) {
      const area = existing.host.shadowRoot?.querySelector('.bb-qa') as HTMLElement | null;
      if (existing.host.isConnected && existing.mount === mount && area) {
        this.perNode.set(node, { ...existing, extracted, ctx });
        this.render(area, extracted, ctx, existing.host);
        return false;
      }
      existing.host.remove();
      node.removeAttribute('data-bb-processed');
      this.processed.delete(node);
    }
    return this.attach(extracted, ctx, mount);
  }

  getContext(node: HTMLElement): { extracted: ExtractedContent; ctx: QuickActionContext } | null {
    const entry = this.perNode.get(node);
    return entry ? { extracted: entry.extracted, ctx: entry.ctx } : null;
  }

  private ensureStylesFor(mount: HTMLElement): void {
    const root = mount.getRootNode();
    if (!(root instanceof ShadowRoot) || root.querySelector(`#${PAGE_STYLE_ID}`)) return;
    const style = document.createElement('style');
    style.id = PAGE_STYLE_ID;
    style.textContent = PAGE_STYLES;
    root.prepend(style);
  }

  private render(
    area: HTMLElement,
    extracted: ExtractedContent,
    ctx: QuickActionContext,
    host: HTMLElement,
  ): void {
    area.replaceChildren();
    const { uid, contentId } = extracted;

    if (uid === null) {
      // 无 UID 时仍保留更多菜单，让不可用的名单入口以禁用状态和原因呈现，
      // 而不是悄悄消失；唯一可执行动作是仅隐藏此条。
      const hideBtn = this.button(STRINGS.quickAction.hideOnly, false, () => {
        this.callbacks.onHideOnly(extracted);
      });
      hideBtn.title = STRINGS.quickAction.noUid;
      area.appendChild(hideBtn);
    } else {
      // 主按钮：标签与回调都由真实 capability 状态驱动。
      const primaryKind = resolvePrimaryActionKind(
        contentId,
        ctx.officialBlockAvailable,
        ctx.officialReportAvailable,
      );
      const primaryLabel =
        primaryKind === 'local_only'
          ? STRINGS.quickAction.localOnly
          : primaryKind === 'block_only'
            ? STRINGS.quickAction.blockNoReport
            : primaryKind === 'report_only'
              ? STRINGS.quickAction.localAndReport
              : STRINGS.quickAction.oneClick;
      const mainBtn = this.button(
        primaryLabel,
        true,
        () =>
          this.withLoading(mainBtn, () =>
            primaryKind === 'local_only'
              ? this.callbacks.onHideAuthorOnPage(extracted)
              : primaryKind === 'block_only'
                ? this.callbacks.onBlockOnly(extracted)
                : this.callbacks.onOneClick(extracted),
          ),
      );
      if (ctx.isSelf) {
        mainBtn.disabled = true;
        mainBtn.title = STRINGS.quickAction.self;
      } else if (ctx.isWhitelisted) {
        mainBtn.disabled = true;
        mainBtn.title = STRINGS.quickAction.whitelisted;
      } else if (primaryKind === 'local_only') {
        mainBtn.title = STRINGS.quickAction.localOnlyTitle;
      } else if (primaryKind === 'block_only') {
        mainBtn.title =
          resolveContentIdAction(contentId) === 'block_only'
            ? STRINGS.quickAction.noContentIdBlockOnly
            : STRINGS.quickAction.reportCapabilityUnavailable;
      } else if (primaryKind === 'report_only') {
        mainBtn.title = STRINGS.quickAction.blockCapabilityUnavailable;
      } else {
        mainBtn.title = STRINGS.quickAction.oneClick;
      }
      area.appendChild(mainBtn);
    }

    // 更多菜单
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'bb-more';
    moreBtn.setAttribute('aria-label', STRINGS.quickAction.menuTitle);
    moreBtn.textContent = '⋯';
    moreBtn.title = STRINGS.quickAction.more;

    let menu: HTMLElement | null = null;
    const closeMenu = () => {
      // isConnected 防护：blur/focusout 期间节点可能已被移动，remove() 对已脱离文档的节点会抛错
      try {
        if (menu?.isConnected) menu.remove();
      } catch {
        /* 菜单可能已被外部移除 */
      }
      menu = null;
    };
    const toggleMenu = () => {
      if (menu) return closeMenu();
      menu = this.buildMenu(extracted, ctx, closeMenu);
      shadowRootOf(host)?.appendChild(menu);
    };
    moreBtn.addEventListener('click', toggleMenu);
    moreBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
    area.appendChild(moreBtn);

    // 点击外部关闭菜单（shadow 感知：host.contains 不穿透 shadow root，
    // 需沿 getRootNode().host 上溯，否则点击菜单项时的 focusout 会误关菜单）
    const isInsideHost = (node: Node | null): boolean => {
      let cur: Node | null = node;
      while (cur) {
        if (cur === host) return true;
        const root = cur.getRootNode();
        if (root instanceof ShadowRoot && root.host) cur = root.host;
        else return false;
      }
      return false;
    };
    host.addEventListener('focusout', (e) => {
      if (menu && !isInsideHost(e.relatedTarget as Node | null)) closeMenu();
    });
  }

  private buildMenu(
    extracted: ExtractedContent,
    ctx: QuickActionContext,
    closeMenu: () => void,
  ): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'bb-menu';
    menu.setAttribute('role', 'menu');

    const { uid } = extracted;
    const item = (
      label: string,
      handler: () => void,
      disabled?: boolean,
      title?: string,
    ): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bb-menu__item';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = label;
      if (disabled) btn.disabled = true;
      if (title) btn.title = title;
      btn.addEventListener('click', () => {
        // closeMenu 可能因 shadow 节点在 blur 期间被移动而抛错；必须保证 handler 执行
        try {
          closeMenu();
        } catch {
          /* 菜单可能已被外部移除 */
        }
        handler();
      });
      return btn;
    };

    menu.appendChild(
      item(STRINGS.quickAction.hideOnly, () => this.callbacks.onHideOnly(extracted)),
    );
    menu.appendChild(
      item(
        STRINGS.quickAction.hideAuthorOnPage,
        () => {
          void this.callbacks.onHideAuthorOnPage(extracted);
        },
        uid === null,
        STRINGS.quickAction.noUid,
      ),
    );
    menu.appendChild(
      item(
        STRINGS.quickAction.whitelist,
        () => {
          void this.callbacks.onWhitelist(extracted);
        },
        uid === null || ctx.isWhitelisted,
        uid === null
          ? STRINGS.quickAction.noUid
          : ctx.isWhitelisted
            ? '该账号已在白名单'
            : undefined,
      ),
    );
    menu.appendChild(
      item(
        STRINGS.quickAction.markVerified,
        () => {
          void this.callbacks.onMarkVerified(extracted);
        },
        uid === null || resolveContentIdAction(extracted.contentId) === 'block_only',
        uid === null ? STRINGS.quickAction.noUid : STRINGS.quickAction.noContentId,
      ),
    );
    menu.appendChild(
      item(
        STRINGS.quickAction.blockOnly,
        () => {
          void this.callbacks.onBlockOnly(extracted);
        },
        uid === null || !ctx.officialBlockAvailable,
        uid === null ? STRINGS.quickAction.noUid : STRINGS.quickAction.blockCapabilityUnavailable,
      ),
    );
    menu.appendChild(
      item(
        STRINGS.quickAction.blockAndReport,
        () => {
          void this.callbacks.onBlockAndReport(extracted);
        },
        uid === null ||
          resolveContentIdAction(extracted.contentId) === 'block_only' ||
          !ctx.officialBlockAvailable ||
          !ctx.officialReportAvailable,
        uid === null
          ? STRINGS.quickAction.noUid
          : resolveContentIdAction(extracted.contentId) === 'block_only'
            ? STRINGS.quickAction.noContentId
            : !ctx.officialBlockAvailable
              ? STRINGS.quickAction.blockCapabilityUnavailable
              : STRINGS.quickAction.reportCapabilityUnavailable,
      ),
    );
    menu.appendChild(
      item(STRINGS.quickAction.showRules, () =>
        this.callbacks.onShowRules(extracted, ctx.matchedRuleNames),
      ),
    );
    menu.appendChild(
      item(STRINGS.quickAction.showLogs, () => this.callbacks.onShowLogs(extracted)),
    );

    return menu;
  }

  private button(label: string, primary: boolean, handler: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = primary ? 'bb-btn bb-btn--primary' : 'bb-btn';
    btn.textContent = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', handler);
    return btn;
  }

  private withLoading(btn: HTMLButtonElement, action: () => Promise<void> | void): void {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const original = btn.textContent;
    btn.textContent = fmt(STRINGS.quickAction.processing, {});
    btn.classList.add('bb-loading');
    btn.disabled = true;
    const finish = () => {
      btn.textContent = original;
      btn.classList.remove('bb-loading');
      btn.disabled = false;
      delete btn.dataset.busy;
    };
    Promise.resolve(action())
      .catch(() => undefined)
      .finally(finish);
  }
}

function shadowRootOf(host: HTMLElement): ShadowRoot | null {
  return host.shadowRoot;
}

/**
 * 占位条控制器：折叠/隐藏内容时插入占位条（页面 DOM，样式经命名空间隔离）。
 * 所有文本使用 textContent 写入，禁止 innerHTML 注入未转义页面文本。
 */
import { fmt, STRINGS } from '../../shared/strings';

export interface PlaceholderCallbacks {
  onView: (node: HTMLElement) => void;
  onReleaseOnce: (node: HTMLElement) => void;
  onWhitelist: (node: HTMLElement) => void;
  onShowRules: (node: HTMLElement) => void;
  onOneClick: (node: HTMLElement) => void;
  onHideSimilar: (node: HTMLElement) => void;
  canOfficial: (node: HTMLElement) => boolean;
  /** 由调用方按当前提取结果选择主动作；缺少内容 ID 时可改为安全的 block-only。 */
  primaryAction?: (node: HTMLElement) => PlaceholderPrimaryAction | null;
}

export interface PlaceholderPrimaryAction {
  label: string;
  title?: string;
  onClick: () => void;
}

const STYLE_ID = 'bb-placeholder-style';
const STYLES = `
.bb-placeholder {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  margin: 8px 0; padding: 8px 12px; border-radius: 6px;
  background: rgba(74,108,247,.08); border: 1px dashed rgba(74,108,247,.45);
  font-size: 13px; color: #57606a; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.bb-placeholder__text { flex: 1 1 auto; min-width: 120px; }
.bb-placeholder__btn {
  border: 1px solid rgba(74,108,247,.5); background: transparent; color: #3b55d9;
  border-radius: 5px; padding: 3px 10px; font-size: 12px; cursor: pointer;
}
.bb-placeholder__btn:hover { background: rgba(74,108,247,.12); }
.bb-placeholder__btn--primary {
  background: #4a6cf7; border-color: #4a6cf7; color: #fff;
}
.bb-placeholder__btn--primary:hover { background: #3b55d9; }
.bb-placeholder__btn:focus-visible { outline: 2px solid #4a6cf7; outline-offset: 1px; }
`;

const state = new WeakMap<HTMLElement, { hidden: boolean; placeholder: HTMLElement | null }>();

export class PlaceholderController {
  constructor(private readonly callbacks: PlaceholderCallbacks) {
    this.ensureStyles();
  }

  private ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  /** 折叠（保留可展开的占位条） */
  collapse(node: HTMLElement, opts: { ruleNames?: string[] } = {}): void {
    this.apply(node, {
      placeholder: true,
      label: opts.ruleNames?.length
        ? `${STRINGS.placeholder.collapsedByRules}（${opts.ruleNames.slice(0, 2).join('、')}）`
        : STRINGS.placeholder.collapsedByRules,
    });
  }

  /** 完全隐藏（无占位条） */
  hide(node: HTMLElement): void {
    this.apply(node, { placeholder: false });
  }

  /** 恢复显示并移除占位条 */
  restore(node: HTMLElement): void {
    const st = state.get(node);
    node.style.display = '';
    st?.placeholder?.remove();
    state.delete(node);
  }

  isHandled(node: HTMLElement): boolean {
    return state.has(node);
  }

  private apply(node: HTMLElement, opts: { placeholder: boolean; label?: string }): void {
    if (state.get(node)?.hidden && opts.placeholder) return;
    const existing = state.get(node);
    existing?.placeholder?.remove();

    node.style.display = 'none';
    if (!opts.placeholder) {
      state.set(node, { hidden: true, placeholder: null });
      return;
    }

    this.ensureStylesFor(node);

    const placeholder = document.createElement('div');
    placeholder.className = 'bb-placeholder';
    placeholder.setAttribute('data-bb-placeholder', '1');

    const text = document.createElement('span');
    text.className = 'bb-placeholder__text';
    text.textContent = opts.label ?? STRINGS.placeholder.collapsedByRules;
    placeholder.appendChild(text);

    const mkBtn = (label: string, primary: boolean, handler: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = primary
        ? 'bb-placeholder__btn bb-placeholder__btn--primary'
        : 'bb-placeholder__btn';
      btn.textContent = label;
      btn.addEventListener('click', handler);
      return btn;
    };

    placeholder.appendChild(
      mkBtn(STRINGS.placeholder.view, false, () => this.callbacks.onView(node)),
    );
    placeholder.appendChild(
      mkBtn(STRINGS.placeholder.releaseOnce, false, () => this.callbacks.onReleaseOnce(node)),
    );
    placeholder.appendChild(
      mkBtn(STRINGS.placeholder.whitelist, false, () => this.callbacks.onWhitelist(node)),
    );
    placeholder.appendChild(
      mkBtn(STRINGS.placeholder.rules, false, () => this.callbacks.onShowRules(node)),
    );
    const primaryAction = this.callbacks.primaryAction?.(node);
    if (primaryAction) {
      const primary = mkBtn(primaryAction.label, true, primaryAction.onClick);
      if (primaryAction.title) primary.title = primaryAction.title;
      placeholder.appendChild(primary);
    } else if (this.callbacks.canOfficial(node)) {
      placeholder.appendChild(
        mkBtn(STRINGS.placeholder.oneClick, true, () => this.callbacks.onOneClick(node)),
      );
    }
    placeholder.appendChild(
      mkBtn(STRINGS.placeholder.hideSimilar, false, () => this.callbacks.onHideSimilar(node)),
    );

    node.parentNode?.insertBefore(placeholder, node);
    state.set(node, { hidden: true, placeholder });
  }

  private ensureStylesFor(node: HTMLElement): void {
    const root = node.getRootNode();
    if (!(root instanceof ShadowRoot) || root.querySelector(`#${STYLE_ID}`)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    root.prepend(style);
  }
}

export function placeholderText(ruleNames: string[]): string {
  return fmt(STRINGS.placeholder.collapsedByRules, {
    names: ruleNames.slice(0, 2).join('、'),
  });
}

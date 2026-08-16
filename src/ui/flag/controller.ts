/**
 * 可疑内容标记控制器：保留原内容，仅提供命中原因的可访问入口。
 * 所有文字均以 textContent 写入；标记不触发官方操作，也不改变内容可见性。
 */
import { fmt, STRINGS } from '../../shared/strings';
import type { EngineDecision, Settings } from '../../shared/types';

export interface FlagIndicatorCallbacks {
  onShowRules: (node: HTMLElement) => void;
}

const STYLE_ID = 'bb-flag-indicator-style';
const STYLES = `
.bb-flag-anchor { position: relative !important; }
.bb-flag-indicator {
  position: absolute; top: 6px; left: 6px; z-index: 98;
  display: inline-flex; align-items: center; max-width: calc(100% - 12px);
  border: 1px solid rgba(187, 116, 0, .42); border-radius: 999px;
  padding: 2px 7px; background: rgba(255, 247, 230, .96); color: #8a5700;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, .08);
}
.bb-flag-indicator:hover { background: #fff0cf; }
.bb-flag-indicator:focus-visible { outline: 2px solid #4a6cf7; outline-offset: 2px; }
`;

interface FlagState {
  indicator: HTMLButtonElement;
  mount: HTMLElement;
}

/** 内容在当前设置下应采取的纯展示方式，不产生任何 DOM 或官方操作。 */
export type ContentPresentation = 'flag' | 'hide' | 'collapse' | 'none';

export function resolveContentPresentation(
  decision: Pick<EngineDecision, 'flag' | 'hide' | 'collapse'>,
  suspiciousHandling: Settings['suspiciousHandling'],
  typeEnabled: boolean,
): ContentPresentation {
  if (!typeEnabled) return 'none';
  if (
    decision.flag ||
    (suspiciousHandling === 'flag_only' && (decision.hide || decision.collapse))
  ) {
    return 'flag';
  }
  if (decision.hide || (decision.collapse && suspiciousHandling === 'hide')) return 'hide';
  if (decision.collapse && suspiciousHandling === 'collapse') return 'collapse';
  return 'none';
}

/** 每个 controller 独立保存状态，避免跨内容脚本会话泄漏。 */
export class FlagIndicatorController {
  private state = new WeakMap<HTMLElement, FlagState>();

  constructor(private readonly callbacks: FlagIndicatorCallbacks) {
    this.ensureStyles();
  }

  /** 注入或更新同一枚标记；重复求值不会创建重复节点。 */
  attachOrUpdate(node: HTMLElement, ruleNames: string[], mount: HTMLElement = node): void {
    const names = ruleNames.slice(0, 2);
    const title = names.length
      ? fmt(STRINGS.flag.showRules, { names: names.join('、') })
      : STRINGS.flag.showRulesGeneric;
    const label = names.length ? `${STRINGS.flag.label}：${names.join('、')}` : STRINGS.flag.label;
    const state = this.state.get(node);
    if (state && state.mount !== mount) {
      state.indicator.remove();
      state.mount.classList.remove('bb-flag-anchor');
      this.state.delete(node);
    }
    const known = this.state.get(node)?.indicator;
    const fallback = Array.from(mount.children).find((child) =>
      child.hasAttribute('data-bb-flag-indicator'),
    );
    const existing = known?.isConnected
      ? known
      : fallback instanceof HTMLButtonElement
        ? fallback
        : undefined;
    if (existing) {
      existing.textContent = label;
      existing.title = title;
      existing.setAttribute('aria-label', title);
      this.state.set(node, { indicator: existing, mount });
      return;
    }

    this.ensureStylesFor(mount);
    mount.classList.add('bb-flag-anchor');
    const indicator = document.createElement('button');
    indicator.type = 'button';
    indicator.className = 'bb-flag-indicator';
    indicator.setAttribute('data-bb-flag-indicator', '1');
    indicator.textContent = label;
    indicator.title = title;
    indicator.setAttribute('aria-label', title);
    indicator.addEventListener('click', () => this.callbacks.onShowRules(node));
    mount.appendChild(indicator);
    this.state.set(node, { indicator, mount });
  }

  /** 标记不再适用时立即移除，避免节点复用留下陈旧提示。 */
  remove(node: HTMLElement): void {
    const existing = this.state.get(node);
    existing?.indicator.remove();
    for (const child of Array.from(existing?.mount.children ?? node.children)) {
      if (child.hasAttribute('data-bb-flag-indicator')) child.remove();
    }
    this.state.delete(node);
    (existing?.mount ?? node).classList.remove('bb-flag-anchor');
  }

  private ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    document.head.appendChild(style);
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

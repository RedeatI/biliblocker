/**
 * Toast 管理器：Shadow DOM 隔离的全局提示层。
 * 支持：info/success/error/warning、倒计时进度条（可取消）、按 id 更新状态。
 */
import { STRINGS } from '../../shared/strings';

export type ToastLevel = 'info' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  level?: ToastLevel;
  title?: string;
  message?: string;
  /** 自动消失时间；0 表示不自动消失 */
  duration?: number;
  /** 倒计时秒数（显示进度条） */
  countdown?: number;
  onCancel?: () => void;
  cancelable?: boolean;
  /** P0-2：多个取消动作（替代单一取消按钮），例如「取消全部操作」「仅取消官方任务」 */
  cancelActions?: Array<{ label: string; handler: () => void }>;
}

export interface ToastHandle {
  id: number;
  update: (patch: Partial<ToastOptions> & { progress?: number }) => void;
  dismiss: () => void;
}

const STYLES = `
:host { all: initial; }
.bb-toast-wrap {
  position: fixed; top: 16px; right: 16px; z-index: 2147483646;
  display: flex; flex-direction: column; gap: 8px; max-width: 360px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.bb-toast {
  background: #1f2329; color: #f5f6f7; border-radius: 8px; padding: 10px 14px;
  box-shadow: 0 6px 24px rgba(0,0,0,.28); font-size: 13px; line-height: 1.5;
  opacity: 0; transform: translateX(24px); transition: opacity .18s ease, transform .18s ease;
  overflow: hidden; position: relative; max-width: 360px;
}
.bb-toast.show { opacity: 1; transform: translateX(0); }
.bb-toast.success { border-left: 3px solid #34c759; }
.bb-toast.error { border-left: 3px solid #ff3b30; }
.bb-toast.warning { border-left: 3px solid #ff9500; }
.bb-toast.info { border-left: 3px solid #4a6cf7; }
.bb-toast-title { font-weight: 600; margin-bottom: 2px; }
.bb-toast-msg { color: #d8dade; word-break: break-all; }
.bb-toast-bar { position: absolute; left: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.28); transition: width .1s linear; }
.bb-toast-cancel {
  margin-top: 8px; background: rgba(255,255,255,.12); color: #fff; border: none;
  border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer;
}
.bb-toast-cancel:hover { background: rgba(255,255,255,.2); }
.bb-toast-cancel:focus-visible { outline: 2px solid #4a6cf7; }
`;

export class ToastManager {
  private static instance: ToastManager | null = null;
  private host: HTMLElement | null = null;
  private wrap: HTMLElement | null = null;
  private nextId = 1;
  private handles = new Map<number, { el: HTMLElement; timer: number; cancelTimer?: number }>();

  static get(): ToastManager {
    if (!ToastManager.instance) ToastManager.instance = new ToastManager();
    return ToastManager.instance;
  }

  private ensure(): void {
    if (this.host?.isConnected) return;
    this.host = document.createElement('div');
    this.host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.appendChild(style);
    this.wrap = document.createElement('div');
    this.wrap.className = 'bb-toast-wrap';
    shadow.appendChild(this.wrap);
    document.documentElement.appendChild(this.host);
  }

  show(opts: ToastOptions = {}): ToastHandle {
    this.ensure();
    const id = this.nextId++;
    const el = document.createElement('div');
    const level = opts.level ?? 'info';
    el.className = `bb-toast ${level}`;

    const title = opts.title ?? '';
    const msg = opts.message ?? '';
    if (title) {
      const t = document.createElement('div');
      t.className = 'bb-toast-title';
      t.textContent = title;
      el.appendChild(t);
    }
    if (msg) {
      const m = document.createElement('div');
      m.className = 'bb-toast-msg';
      m.textContent = msg;
      el.appendChild(m);
    }

    let bar: HTMLElement | null = null;
    let cancelBtn: HTMLButtonElement | null = null;
    let interval: number | undefined;

    if (opts.countdown !== undefined && opts.countdown > 0) {
      bar = document.createElement('div');
      bar.className = 'bb-toast-bar';
      el.appendChild(bar);
      const start = Date.now();
      const total = opts.countdown * 1000;
      interval = window.setInterval(() => {
        const left = Math.max(0, total - (Date.now() - start));
        if (bar) bar.style.width = `${(left / total) * 100}%`;
        if (left <= 0 && interval !== undefined) {
          window.clearInterval(interval);
          interval = undefined;
        }
      }, 100);
    }

    if (opts.cancelActions && opts.cancelActions.length > 0) {
      for (const action of opts.cancelActions) {
        const btn = document.createElement('button');
        btn.className = 'bb-toast-cancel';
        btn.textContent = action.label;
        btn.type = 'button';
        btn.addEventListener('click', () => {
          action.handler();
          this.dismiss(id);
        });
        el.appendChild(btn);
      }
    } else if (opts.cancelable !== false && (opts.onCancel || opts.countdown !== undefined)) {
      cancelBtn = document.createElement('button');
      cancelBtn.className = 'bb-toast-cancel';
      cancelBtn.textContent = STRINGS.toast.cancel;
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => {
        opts.onCancel?.();
        this.dismiss(id);
      });
      el.appendChild(cancelBtn);
    }

    this.wrap!.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));

    let autoTimer = 0;
    if (opts.duration !== undefined && opts.duration > 0) {
      autoTimer = window.setTimeout(() => this.dismiss(id), opts.duration);
    }

    this.handles.set(id, { el, timer: autoTimer, cancelTimer: interval });

    return {
      id,
      update: (patch) => {
        if (patch.title !== undefined) {
          const t = el.querySelector('.bb-toast-title') as HTMLElement | null;
          if (t) t.textContent = patch.title;
        }
        if (patch.message !== undefined) {
          const m = el.querySelector('.bb-toast-msg') as HTMLElement | null;
          if (m) m.textContent = patch.message;
        }
        if (patch.level && el.classList) {
          el.classList.remove('success', 'error', 'warning', 'info');
          el.classList.add(patch.level);
        }
      },
      dismiss: () => this.dismiss(id),
    };
  }

  dismiss(id: number): void {
    const entry = this.handles.get(id);
    if (!entry) return;
    this.handles.delete(id);
    if (entry.cancelTimer !== undefined) window.clearInterval(entry.cancelTimer);
    if (entry.timer) window.clearTimeout(entry.timer);
    entry.el.classList.remove('show');
    window.setTimeout(() => entry.el.remove(), 220);
  }
}

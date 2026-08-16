/**
 * 页面观察器：MutationObserver（只处理新增节点、批处理 + 后代扫描）+ SPA 路由检测。
 *
 * P0-5 SPA 路由观察器：
 * - history 补丁全局只安装一次（RouterObserver 单例），导航绝不创建新的全局 history wrapper；
 * - 监听器使用具名函数，stop() 后完整卸载，回调立即失效；
 * - DOM observer 可以按页面范围重建，但 router observer 保持单例（每页仅一个 RouterObserver）。
 *
 * P1-2 MutationObserver 后代扫描：
 * - 对每个新增 HTMLElement：先检查自身，再在其内部用集中选择器查询目标后代；
 * - 查询范围限定在新增节点子树内，避免全 document 扫描；
 * - 同一节点（WeakSet）不得重复处理。
 * - 观察所有可达 open ShadowRoot；Bilibili 2026 评论组件的新增节点不会出现在 document observer 中。
 */
import { openShadowRootsWithin, querySelectorAllDeep } from '../../shared/composed-dom';

export interface PageObserverOptions {
  /** 判断节点是否为目标节点（评论/楼中楼/动态条目），返回 true 则进入批次 */
  isTarget: (node: HTMLElement) => boolean;
  /** 在新增子树内查找目标后代的集中选择器（逗号分隔列表；空数组 = 只查自身） */
  targetSelectors: string[];
  /** 批量回调（可异步，内部串行 await）；缺省为 no-op */
  onBatch?: (nodes: HTMLElement[]) => Promise<void> | void;
  /** SPA 路由变化回调 */
  onNavigate?: (url: string) => void;
  /** 初始扫描回调（页面加载/路由切换后，处理已存在节点） */
  onInitialScan?: () => Promise<void> | void;
}

const BATCH_MS = 40;
const MAX_BATCH = 300;
const NAVIGATION_POLL_MS = 800;

interface RouterSubscriber {
  onNavigate: (url: string) => void;
}

/**
 * 路由观察器（单例）：history 补丁全局只安装一次；具名监听器；
 * 支持 subscribe/unsubscribe；内部轮询兜底。
 */
class RouterObserver {
  private static instance: RouterObserver | null = null;

  private subscribers = new Set<RouterSubscriber>();
  private patched = false;
  private lastUrl = typeof location !== 'undefined' ? location.href : '';
  private pollTimer: number | null = null;

  private readonly onPopState = (): void => this.checkNavigation();
  private readonly onHistoryEvent = (): void => this.checkNavigation();

  static get(): RouterObserver {
    if (!RouterObserver.instance) RouterObserver.instance = new RouterObserver();
    return RouterObserver.instance;
  }

  private constructor() {
    this.patchHistoryOnce();
    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('bb-location-changed', this.onHistoryEvent);
    this.pollTimer = window.setInterval(() => this.checkNavigation(), NAVIGATION_POLL_MS);
  }

  /** 订阅导航；返回取消订阅函数 */
  subscribe(cb: (url: string) => void): () => void {
    const sub: RouterSubscriber = { onNavigate: cb };
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /** 供测试/调试：当前订阅者数量（不得随导航增长） */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** 仅测试使用：强制检查一次 */
  checkNow(): void {
    this.checkNavigation();
  }

  /** history 补丁全局只安装一次；所有实例共享，导航不创建新 wrapper */
  private patchHistoryOnce(): void {
    if (this.patched) return;
    this.patched = true;
    const wrap = (type: 'pushState' | 'replaceState'): void => {
      const original = history[type];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      history[type] = function (this: History, ...args: any[]) {
        const result = original.apply(this, args as never);
        window.dispatchEvent(new Event('bb-location-changed'));
        return result;
      };
    };
    wrap('pushState');
    wrap('replaceState');
  }

  private checkNavigation(): void {
    const url = location.href;
    if (url === this.lastUrl) return;
    this.lastUrl = url;
    for (const sub of [...this.subscribers]) {
      sub.onNavigate(url);
    }
  }
}

export class PageObserver {
  private observer: MutationObserver | null = null;
  private observedRoots = new WeakSet<Node>();
  private queue: HTMLElement[] = [];
  private flushTimer: number | undefined;
  private processing = false;
  private seen = new WeakSet<HTMLElement>();
  private stopped = false;
  private unsubscribeRouter: (() => void) | null = null;
  private router = RouterObserver.get();

  constructor(private readonly opts: PageObserverOptions) {}

  start(): void {
    this.stopped = false;
    this.observedRoots = new WeakSet<Node>();
    // 订阅全局单例路由观察器（具名回调，stop() 时完整卸载）
    if (!this.unsubscribeRouter) {
      this.unsubscribeRouter = this.router.subscribe((url) => {
        if (this.stopped) return;
        this.onNavigated(url);
      });
    }
    this.observer = new MutationObserver((mutations) => {
      if (this.stopped) return;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const added of mutation.addedNodes) {
          if (!(added instanceof HTMLElement)) continue;
          this.collectTargets(added);
        }
      }
    });
    this.observeRoot(document.body);
    this.observeOpenShadowRoots(document.body);
    this.scheduleFlush();
    void this.opts.onInitialScan?.();
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    this.unsubscribeRouter?.();
    this.unsubscribeRouter = null;
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.queue = [];
    // 停止后：即使 location 变化，回调也不会再被触发（stopped 短路 + 订阅已卸载）
  }

  /** 重新扫描当前页面（SPA 切换后调用） */
  rescan(): void {
    if (this.stopped) return;
    void this.opts.onInitialScan?.();
  }

  /**
   * P1-5（v0.1.2）：新增节点先检查自身，再在子树内用集中选择器查找目标后代。
   * - 节点自身为目标后仍继续扫描后代（不 return）；
   * - 不因父节点也是目标就跳过后代（合法嵌套后代必须处理）；
   * - 去重由 enqueue() 的 WeakSet（已注入标记）保证，同一节点只处理一次。
   */
  private collectTargets(node: HTMLElement): void {
    // 先注册新增子树中的 open shadow roots，后续懒加载评论才能进入同一个 observer。
    this.observeOpenShadowRoots(node);
    if (this.opts.isTarget(node)) {
      this.enqueue(node);
    }
    const selectors = this.opts.targetSelectors;
    if (selectors.length === 0) return;
    // 限定在新增节点子树内查询；WeakSet 去重防止重复处理
    let found: Element[];
    try {
      found = querySelectorAllDeep(node, selectors.join(','));
    } catch {
      return;
    }
    for (const el of found) {
      if (el instanceof HTMLElement) {
        this.enqueue(el);
      }
    }
  }

  private observeRoot(root: Node): void {
    if (!this.observer || this.observedRoots.has(root)) return;
    this.observer.observe(root, { childList: true, subtree: true });
    this.observedRoots.add(root);
  }

  private observeOpenShadowRoots(root: HTMLElement | ShadowRoot): void {
    if (root instanceof HTMLElement && root.shadowRoot) this.observeRoot(root.shadowRoot);
    for (const shadow of openShadowRootsWithin(root)) this.observeRoot(shadow);
  }

  private enqueue(node: HTMLElement): void {
    if (this.seen.has(node)) return;
    this.seen.add(node);
    this.queue.push(node);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.processing) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, BATCH_MS);
  }

  private async flush(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_BATCH);
        // 过滤已脱离文档的节点
        const live = batch.filter((n) => n.isConnected);
        if (live.length > 0) await this.opts.onBatch?.(live);
        if (this.queue.length > 0) await yieldToMainThread();
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0 && !this.stopped) this.scheduleFlush();
    }
  }

  private onNavigated(url: string): void {
    this.lastNavigatedUrl = url;
    this.opts.onNavigate?.(url);
  }

  private lastNavigatedUrl: string | null = null;

  /** 测试辅助：最近一次导航 URL */
  get lastNavigation(): string | null {
    return this.lastNavigatedUrl;
  }
}

function yieldToMainThread(): Promise<void> {
  return new Promise((r) => window.setTimeout(r, 0));
}

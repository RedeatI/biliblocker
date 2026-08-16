/**
 * 观察器测试（happy-dom）：
 * - A-01 真实 history.pushState SPA 连续导航（50 次，每次导航只触发一次回调，无监听器增长）
 * - P0-5 stop() 后回调失效、监听器完整卸载
 * - P1-2 wrapper 内批量新增目标节点（20 条）被后代扫描处理且不重复
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PageObserver } from '@/entrypoints/content/observer';

function waitFlush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 60));
}

describe('SPA 路由观察器（P0-5）', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('连续 50 次 pushState：每次导航只触发一次回调，无监听器增长', async () => {
    const navigations: string[] = [];
    const observer = new PageObserver({
      isTarget: () => false,
      targetSelectors: [],
      onNavigate: (url) => navigations.push(url),
      onInitialScan: () => undefined,
    });
    observer.start();
    try {
      for (let i = 1; i <= 50; i++) {
        window.history.pushState({}, '', `/video/${i}`);
      }
      await waitFlush();
      expect(navigations).toHaveLength(50);
      // 每次导航恰好一个回调：断言递增无重复
      for (let i = 0; i < navigations.length; i++) {
        expect(navigations[i]).toBe(`${location.origin}/video/${i + 1}`);
      }
    } finally {
      observer.stop();
    }
  });

  it('replaceState 触发导航；popstate 事件不产生重复回调（URL 未变）', async () => {
    const navigations: string[] = [];
    const observer = new PageObserver({
      isTarget: () => false,
      targetSelectors: [],
      onNavigate: (url) => navigations.push(url),
      onInitialScan: () => undefined,
    });
    observer.start();
    try {
      window.history.replaceState({}, '', '/dynamic/111');
      await waitFlush();
      window.history.pushState({}, '', '/dynamic/222');
      await waitFlush();
      expect(navigations).toHaveLength(2);
      expect(navigations[0]).toContain('/dynamic/111');
      expect(navigations[1]).toContain('/dynamic/222');

      // popstate 事件触发但 URL 未变：不得产生额外回调
      window.dispatchEvent(new PopStateEvent('popstate'));
      await waitFlush();
      expect(navigations).toHaveLength(2);
    } finally {
      observer.stop();
    }
  });

  it('stop() 后 pushState 不再触发回调（回调立即失效、订阅卸载）', async () => {
    const navigations: string[] = [];
    const observer = new PageObserver({
      isTarget: () => false,
      targetSelectors: [],
      onNavigate: (url) => navigations.push(url),
      onInitialScan: () => undefined,
    });
    observer.start();
    window.history.pushState({}, '', '/a');
    await waitFlush();
    expect(navigations).toHaveLength(1);

    observer.stop();
    const before = navigations.length;
    window.history.pushState({}, '', '/b');
    window.history.replaceState({}, '', '/c');
    await waitFlush();
    expect(navigations).toHaveLength(before); // 无新增
  });

  it('history 补丁全局只安装一次（多个实例共享，导航不创建新 wrapper）', async () => {
    const a: string[] = [];
    const b: string[] = [];
    const obsA = new PageObserver({
      isTarget: () => false,
      targetSelectors: [],
      onNavigate: (u) => a.push(u),
      onInitialScan: () => undefined,
    });
    const obsB = new PageObserver({
      isTarget: () => false,
      targetSelectors: [],
      onNavigate: (u) => b.push(u),
      onInitialScan: () => undefined,
    });
    obsA.start();
    obsB.start();
    try {
      // 两个实例各自收到一次（每实例一个订阅），说明没有重复 wrapper
      window.history.pushState({}, '', '/spa/1');
      await waitFlush();
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      // 停止 B 后只有 A 继续收到
      obsB.stop();
      window.history.pushState({}, '', '/spa/2');
      await waitFlush();
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(1);
    } finally {
      obsA.stop();
      obsB.stop();
    }
  });

  it('DOM observer 可重建，但路由订阅保持单例（subscriberCount 不随重建增长）', async () => {
    const navigations: string[] = [];
    const mkObserver = () =>
      new PageObserver({
        isTarget: () => false,
        targetSelectors: [],
        onNavigate: (u) => navigations.push(u),
        onInitialScan: () => undefined,
      });
    const first = mkObserver();
    first.start();
    first.stop();
    // 重建（模拟 SPA 页面切换时 app 重建 observer）
    const second = mkObserver();
    second.start();
    try {
      window.history.pushState({}, '', '/rebuild');
      await waitFlush();
      expect(navigations).toHaveLength(1);
      expect(navigations[0]).toContain('/rebuild');
    } finally {
      second.stop();
    }
  });
});

describe('MutationObserver 后代扫描（P1-2）', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"><div class="reply-list"></div></div>';
  });

  function makeReplyItem(uid: number, rpid: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'reply-item';
    item.setAttribute('data-rpid', rpid);
    const a = document.createElement('a');
    a.className = 'user-name';
    a.href = `//space.bilibili.com/${uid}`;
    a.textContent = `用户${uid}`;
    const c = document.createElement('div');
    c.className = 'reply-content';
    c.textContent = `评论内容 ${rpid}`;
    item.append(a, c);
    return item;
  }

  it('一个 wrapper 一次加入 20 条评论：全部处理且每个节点只处理一次', async () => {
    const processed: HTMLElement[] = [];
    const seenIds = new Set<string>();
    const observer = new PageObserver({
      isTarget: (n) => n.matches('.reply-item'),
      targetSelectors: ['.reply-item'],
      onBatch: async (nodes) => {
        for (const n of nodes) {
          if (processed.includes(n)) throw new Error('同一节点被重复处理');
          processed.push(n);
          const id = n.getAttribute('data-rpid') ?? '';
          if (seenIds.has(id)) throw new Error(`同一内容 ID 重复处理：${id}`);
          seenIds.add(id);
        }
      },
      onInitialScan: () => undefined,
    });
    observer.start();
    try {
      const wrapper = document.createElement('div');
      wrapper.className = 'new-wrapper';
      for (let i = 0; i < 20; i++) {
        wrapper.appendChild(makeReplyItem(10000 + i, `rpid-${i}`));
      }
      document.getElementById('app')!.appendChild(wrapper);
      await waitFlush();
      await waitFlush();
      expect(processed).toHaveLength(20);
      expect(seenIds.size).toBe(20);
    } finally {
      observer.stop();
    }
  });

  it('同一内容 ID 出现在不同节点（重复渲染）时不去重跨节点，但同节点不重复', async () => {
    const processed: string[] = [];
    const observer = new PageObserver({
      isTarget: (n) => n.matches('.reply-item'),
      targetSelectors: ['.reply-item'],
      onBatch: (nodes) => {
        for (const n of nodes) processed.push(n.getAttribute('data-rpid') ?? '');
      },
      onInitialScan: () => undefined,
    });
    observer.start();
    try {
      const app = document.getElementById('app')!;
      // 同一 wrapper 内同一 rpid 出现两次（不同节点）
      const wrapper = document.createElement('div');
      wrapper.appendChild(makeReplyItem(1, 'dup-1'));
      wrapper.appendChild(makeReplyItem(2, 'dup-1'));
      app.appendChild(wrapper);
      await waitFlush();
      await waitFlush();
      // 节点去重：wrapper 一次加入，两个节点都处理（各一次）
      expect(processed.filter((p) => p === 'dup-1')).toHaveLength(2);
    } finally {
      observer.stop();
    }
  });

  it('P1-5：节点自身为目标后仍扫描后代；嵌套后代均处理且不重复', async () => {
    const processed: string[] = [];
    const observer = new PageObserver({
      isTarget: (n) => n.matches('.reply-item'),
      targetSelectors: ['.reply-item'],
      onBatch: (nodes) => {
        for (const n of nodes) processed.push(n.getAttribute('data-rpid') ?? 'self');
      },
      onInitialScan: () => undefined,
    });
    observer.start();
    try {
      const item = makeReplyItem(3, 'self-item');
      // 内部再嵌一个 reply-item（楼中楼/嵌套回复场景）
      item.appendChild(makeReplyItem(4, 'nested'));
      document.getElementById('app')!.appendChild(item);
      await waitFlush();
      await waitFlush();
      // 自身与嵌套后代都被处理，且各自只处理一次
      expect(processed.filter((p) => p === 'self-item')).toHaveLength(1);
      expect(processed.filter((p) => p === 'nested')).toHaveLength(1);
    } finally {
      observer.stop();
    }
  });

  it('观察新增 web component 的 open Shadow DOM，并继续接收其中的懒加载评论', async () => {
    const processed: HTMLElement[] = [];
    const observer = new PageObserver({
      isTarget: (n) => n.matches('bili-comment-thread-renderer'),
      targetSelectors: ['bili-comment-thread-renderer'],
      onBatch: (nodes) => {
        processed.push(...nodes);
      },
      onInitialScan: () => undefined,
    });
    observer.start();
    try {
      const host = document.createElement('bili-comments');
      const shadow = host.attachShadow({ mode: 'open' });
      document.getElementById('app')!.appendChild(host);
      await waitFlush();

      const first = document.createElement('bili-comment-thread-renderer');
      shadow.appendChild(first);
      await waitFlush();
      expect(processed).toContain(first);

      const wrapper = document.createElement('div');
      const second = document.createElement('bili-comment-thread-renderer');
      wrapper.appendChild(second);
      shadow.appendChild(wrapper);
      await waitFlush();
      expect(processed.filter((node) => node === second)).toHaveLength(1);
    } finally {
      observer.stop();
    }
  });
});

/**
 * 1.1（P0-1 v0.1.5）：外部 QueueWriter 不得继承其他调用的 lease（先红后绿）。
 *
 * 缺陷基线（ACCEPTANCE P0-1）：coordinator 用实例级 `currentLease` 表示「当前持锁」，
 * 任何无关异步回调（pump/alarm/任务返回/queue.kick）只要发生在另一条 execute()
 * 尚未返回期间，就会继承该 lease 直接绕过全局锁 → backend 并发写 {maxActive:2}。
 *
 * 修复要求（方案 A：词法作用域 ScopedWriter）：
 * - 锁内操作显式接收 scoped writer（writerFor(lease) 只在当前调用栈内创建）；
 * - 外部 `coordinator.writer` 永远走公共 execute/全局队列；
 * - 不把 lease 保存到 coordinator/queue 单例字段；
 * - 两次外部调用都能追溯到独立锁所有权（withGlobalWrite 进入 2 次、事件严格串行）。
 *
 * 本测试使用真实生产接线：StorageRepository → StorageCoordinator → coordinator.writer
 * → ActionQueue/QueueWriter；structured-clone backend（真实 WebExtension storage 语义）。
 */
import { describe, expect, it } from 'vitest';
import { deferred, waitFor } from './helpers/v014-env';
import { cloneBackend, hangingBackend, makeRealEnv015, mkTask } from './helpers/v015-env';

describe('1.1 外部 QueueWriter 不得继承其他调用的 lease（P0-1）', () => {
  it('第一条 execute 在 backend.set 内等待时，外部 writer.saveTasks 不得并发写（maxActive=1，事件串行）', async () => {
    const gate = deferred();
    const events: string[] = [];
    // bb.blocked 的非空 set 挂起（第一条 execute：addBlocked 会写非空 bb.blocked）
    const backend = hangingBackend(
      cloneBackend(),
      (items) => Array.isArray(items['bb.blocked']) && (items['bb.blocked'] as unknown[]).length > 0,
      gate,
      events,
    );
    const env = await makeRealEnv015({}, undefined, { backend });

    // 第一条公共 execute 在 backend.set 内等待
    events.length = 0; // 清空 init/start 期间事件，确保下面等待的是本次 execute 的写
    const p1 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addBlocked', uid: 1, source: 'manual' } });
    await waitFor(() => events.some((e) => e.startsWith('start:bb.blocked')));

    // 等待期间：从无关异步调用直接执行 coordinator.writer.saveTasks()
    const p2 = env.coordinator.writer.saveTasks([mkTask('ext-1', 999)]);
    // 给外部 writer 一个进入的机会（v0.1.4 会利用 currentLease 直接写，产生重叠）
    await new Promise((r) => setTimeout(r, 30));

    gate.resolve();
    await Promise.all([p1, p2]);

    // 断言 1：最大活跃 backend 写入数恒为 1（不允许并发写）
    expect(backend.maxActive()).toBe(1);
    // 断言 2：事件严格串行（bb.blocked 的 end 先于 bb.queue 的 start，不存在重叠窗口）
    const blockedStart = events.indexOf('start:bb.blocked');
    const blockedEnd = events.indexOf('end:bb.blocked');
    const queueStart = events.indexOf('start:bb.queue');
    expect(blockedStart).toBeGreaterThanOrEqual(0);
    expect(queueStart).toBeGreaterThan(blockedEnd);
    // v0.1.4 中 bb.queue 的 start 会出现在 bb.blocked 的 end 之前（重叠）→ 断言失败 → red

    // 断言 3：两次外部调用都能追溯到独立锁所有权 → withGlobalWrite 进入 2 次
    //（addBlocked 1 次 + saveTasks 公共 execute 1 次；v0.1.4 中 saveTasks 继承 lease 只有 1 次）
    let withGlobalWriteEntries = 0;
    const origWith = env.repo.withGlobalWrite.bind(env.repo);
    (env.repo as unknown as { withGlobalWrite: unknown }).withGlobalWrite = (
      fn: (l: unknown) => Promise<unknown>,
    ) => {
      withGlobalWriteEntries++;
      return origWith(fn as never);
    };
    // 由于上面已经执行完 p1/p2，这里直接再跑一次并统计
    const p3 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addVerified', uid: 2, source: 'user_action' } });
    const p4 = env.coordinator.writer.saveTasks([mkTask('ext-2', 888)]);
    await Promise.all([p3, p4]);
    expect(withGlobalWriteEntries).toBe(2);

    // 断言 4：不存在实例级 currentLease / inLock / 其他共享「已持锁」布尔/对象
    const coordAny = env.coordinator as unknown as Record<string, unknown>;
    expect(coordAny.currentLease).toBeUndefined();
    expect(coordAny.inLock).toBeUndefined();
    const queueAny = env.queue as unknown as Record<string, unknown>;
    expect(queueAny.currentLease).toBeUndefined();
    expect(queueAny.inLock).toBeUndefined();

    // 数据完整性：两个外部调用都真正落盘
    const raw = await env.backend.get(['bb.blocked', 'bb.queue']);
    expect((raw['bb.blocked'] as { uid: number }[]).map((b) => b.uid)).toContain(1);
    expect((raw['bb.queue'] as { id: string }[]).map((t) => t.id)).toContain('ext-2');
  });

  it('QueueWriter 的每次调用都经独立锁所有权（锁外永不利用进行中的 execute）', async () => {
    const gate = deferred();
    const events: string[] = [];
    const backend = hangingBackend(
      cloneBackend(),
      (items) => Array.isArray(items['bb.verified']) && (items['bb.verified'] as unknown[]).length > 0,
      gate,
      events,
    );
    const env = await makeRealEnv015({}, undefined, { backend });

    events.length = 0; // 清空 init/start 期间事件
    const p1 = env.coordinator.execute({ kind: 'mutation', mutation: { op: 'addVerified', uid: 11, source: 'user_action' } });
    await waitFor(() => events.some((e) => e.startsWith('start:bb.verified')));

    // 无关异步来源：alarm kick 风格的 QueueWriter 写
    const p2 = env.coordinator.writer.saveControl({ ...env.queue.controlSnapshot(), paused: false });
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    await Promise.all([p1, p2]);

    expect(backend.maxActive()).toBe(1);
    const vStart = events.indexOf('start:bb.verified');
    const vEnd = events.indexOf('end:bb.verified');
    const cStart = events.indexOf('start:bb.queueControl');
    // queueControl 写必须在 verified 写结束后开始（无重叠）
    expect(cStart).toBeGreaterThan(vEnd);
    expect(cStart).toBeGreaterThan(vStart);
  });
});

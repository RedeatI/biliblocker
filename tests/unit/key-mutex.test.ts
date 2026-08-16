/**
 * P1-2（v0.1.2）：KeyMutex 尾队列清理测试。
 * 旧实现 `prev.then(() => gate)` 在 set 与比较处创建不同 Promise → 恒等比较永不相等
 * → tails Map 永不清理 → 内存泄漏。修复后高频不同 key 运行后 pendingCount 必须回到 0。
 */
import { describe, expect, it } from 'vitest';
import { KeyMutex } from '@/storage/key-mutex';

describe('P1-2 KeyMutex 尾队列清理', () => {
  it('高频不同 key 运行后 pendingCount 回到 0（不泄漏 tail）', async () => {
    const mutex = new KeyMutex();
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => mutex.run(`key-${i}`, async () => 1)),
    );
    expect(mutex.pendingCount()).toBe(0);
  });

  it('同一 key 并发排队后 pendingCount 回到 0', async () => {
    const mutex = new KeyMutex();
    await Promise.all(
      Array.from({ length: 50 }, () => mutex.run('same', async () => 1)),
    );
    expect(mutex.pendingCount()).toBe(0);
  });

  it('交错不同 key 运行后 pendingCount 回到 0', async () => {
    const mutex = new KeyMutex();
    const jobs: Promise<unknown>[] = [];
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 20; i++) {
        jobs.push(mutex.run(`k${(round + i) % 7}`, async () => 1));
      }
    }
    await Promise.all(jobs);
    expect(mutex.pendingCount()).toBe(0);
  });

  it('串行 run 同一 key 互斥（执行不交错）', async () => {
    const mutex = new KeyMutex();
    const order: string[] = [];
    const gate = (id: string) => mutex.run('k', async () => {
      order.push(`${id}-start`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`${id}-end`);
    });
    await Promise.all([gate('a'), gate('b'), gate('c')]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
    expect(mutex.pendingCount()).toBe(0);
  });
});

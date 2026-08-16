/**
 * 每键互斥（P1-2，v0.1.2）。
 *
 * 两个核心用法（storage/repository.ts 与 entrypoints/background/index.ts 统一使用本实现）：
 * - 同实例内串行化 read-modify-write，防止并发丢失更新；
 * - 所有写操作经固定 key 串行，避免死锁。
 *
 * P1-2 尾队列清理（修复泄漏）：
 * 必须保存 tail 引用再比较，否则 `prev.then(() => gate)` 每次创建新 Promise，
 * 恒等比较永远不相等 → tails 永不清理 → Map 无限增长。
 * 正确写法：
 *   const tail = prev.then(() => gate);
 *   this.tails.set(key, tail);
 *   ...
 *   if (this.tails.get(key) === tail) this.tails.delete(key);
 */
export class KeyMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      // 尾比较：仅当自己是最后一个排队者时才清理（P1-2）
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** 测试/诊断：当前排队中的 key 数（空闲时应回到 0） */
  pendingCount(): number {
    return this.tails.size;
  }
}

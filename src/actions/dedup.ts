/**
 * 去重注册表（基于 storage 持久化，跨页面/跨 SW 实例有效）。
 * 去重维度：UID + 内容类型 + 内容 ID + 举报理由 + 操作类型（block/report）。
 * 同一内容不得重复举报；同一 UID 不得因重复渲染重复拉黑。
 *
 * P1-1（v0.1.3）：写（mark/clear）必须经 DedupWriter → background 的
 * StorageCoordinator（与 reset/clear/import 互斥）；本类不再直接写 storage。
 */
import type { ContentType } from '../shared/types';
import { DEDUP_TTL } from '../shared/constants/defaults';
import type { StorageRepository } from '../storage/repository';

export interface DedupWriter {
  markDedup(key: string, ttl: number): Promise<void>;
  clearDedup(key: string): Promise<void>;
}

export class DeduplicationRegistry {
  constructor(
    private readonly repo: StorageRepository,
    private readonly writer: DedupWriter,
  ) {}

  // ---------- block ----------
  async isBlockDuplicate(uid: number): Promise<boolean> {
    return this.repo.isDedupHit(this.blockKey(uid));
  }

  async markBlocked(uid: number): Promise<void> {
    await this.writer.markDedup(this.blockKey(uid), DEDUP_TTL.BLOCK);
  }

  /** 解除拉黑后允许再次拉黑 */
  async clearBlock(uid: number): Promise<void> {
    await this.writer.clearDedup(this.blockKey(uid));
  }

  // ---------- report ----------
  async isReportDuplicate(
    uid: number,
    contentType: ContentType,
    contentId: string,
    reasonId: number,
  ): Promise<boolean> {
    return this.repo.isDedupHit(this.reportKey(uid, contentType, contentId, reasonId));
  }

  async markReported(
    uid: number,
    contentType: ContentType,
    contentId: string,
    reasonId: number,
  ): Promise<void> {
    await this.writer.markDedup(
      this.reportKey(uid, contentType, contentId, reasonId),
      DEDUP_TTL.REPORT,
    );
  }

  private blockKey(uid: number): string {
    return `block:${uid}`;
  }

  private reportKey(
    uid: number,
    contentType: ContentType,
    contentId: string,
    reasonId: number,
  ): string {
    return `report:${uid}:${contentType}:${contentId}:${reasonId}`;
  }
}

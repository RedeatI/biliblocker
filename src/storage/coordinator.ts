/**
 * StorageCoordinator（P0-1~P0-5 v0.1.4 / P0-1~P0-3、P1-1~P1-3 v0.1.5）：
 * background 单所有者的统一写协调器。
 *
 * 设计目标：
 * - 扩展内**唯一**可写 StorageRepository 实例由本协调器持有；
 *   content/popup/options 构造的 Repository 均为只读（allowWrites=false），
 *   任何写只能通过本协调器 execute() 派发（经消息协议进入 background）。
 * - **P0-1（v0.1.5）词法作用域 ScopedWriter**：删除实例级 `currentLease`。
 *   所有公共 execute() 无条件经 repo.withGlobalWrite((lease) => …) 获取全局锁
 *   （KeyMutex 串行）；锁内通过 `writerFor(lease)` 创建**仅当前调用栈有效**的
 *   scoped writer（queue/revoke/reset 等锁内操作显式接收），
 *   外部 `coordinator.writer` 永远走公共 execute/全局队列。
 *   任意无关异步回调（pump/alarm/任务返回/queue.kick）在任何 execute 进行期间
 *   都只能排队，绝不继承运行中请求的 lease；不存在实例级「已持锁」共享状态。
 * - **P0-2（v0.1.5）队列写基于锁内最新快照**：commitAction/pump/cancel/revoke/
 *   pause/retry/task result 都在锁内基于最新 queue/control 构造写内容；
 *   `pendingTasks()` 返回 structuredClone 快照（不暴露可变内部数组）；
 *   ActionQueue 内存只在 backend 成功后 adopt；旧数组引用绝不跨 await 覆盖。
 * - **P1-3（v0.1.5）operationId 结果原子提交**：成功路径的单次 commitSnapshot
 *   同时包含 blocked/verified/queue 与 bb.operationOutcomes[operationId]；
 *   拒绝类结果也写入确定绑定记录；outcome 写失败 → 整个操作持久化失败，
 *   绝不用 catch 吞掉 outcome 错误（同 operationId 重放返回完全相同结果）。
 * - **P0-5（v0.1.4）operationId 幂等**：commitAction 先查持久化 outcome；
 *   相同 operationId + 相同绑定指纹返回已保存结果；不同绑定复用被拒绝。
 * - **P0-3（v0.1.4）reset/clear 单调 epoch + 原子播种**。
 * - **P0-2（v0.1.4）授权快照贯通**。
 * - **5.1（v0.1.4）paused 禁止积压官方任务**。
 */
import type { ActionTask, AuthorizationSnapshot, QueueControlState, Settings, TaskSource } from '../shared/types';
import type { TaskInput } from '../shared/messages';
import type { StorageRepository, WriteLease } from './repository';
import type { ActionQueue, QueueWriter } from '../actions/queue';
import type { DeduplicationRegistry } from '../actions/dedup';
import { DEFAULT_SETTINGS, OPERATION_OUTCOME, STORAGE_KEYS } from '../shared/constants/defaults';
import { isCapabilityEnabled, canReportContentType } from '../shared/capabilities';
import { isValidReason, resolveDefaultReason } from '../shared/constants/report-reasons';
import { shortId } from '../shared/utils';
import type { ListMutation } from '../shared/messages';
import { DEFAULT_RULES } from '../rules/default-rules';
import type { OperationOutcomeRecord } from './repository';

/** P0-5：撤权/暂停种类（与 types.PauseKind 一致） */
export type CoordinatorPauseKind = 'none' | 'login' | 'risk_control' | 'user' | 'authorization_revoked';

export interface CommitActionRequest {
  operationId: string;
  uid: number;
  username?: string;
  contentType: 'video_comment' | 'video_reply' | 'dynamic' | 'dynamic_comment';
  contentId: string | null;
  rootContentId: string | null;
  oid: string | null;
  contentHash?: string;
  source: TaskSource;
  localActions: { commitLocalBlock: boolean; commitVerified: boolean };
  officialTasks: TaskInput[];
  skipOfficial: boolean;
  authorization: AuthorizationSnapshot;
  frameNonce: string;
  loginOk: boolean;
  currentMid: number | null;
}

export interface CommitActionResult {
  ok: boolean;
  code?:
    | 'committed'
    | 'disabled'
    | 'whitelisted'
    | 'self'
    | 'authorization_changed'
    | 'background_unavailable'
    | 'storage_failed'
    | 'replayed'
    | 'operationId_reused';
  reason?: string;
  /** 已入队官方任务数 */
  enqueued?: number;
  /** 本地实际新增数量 */
  localBlockedAdded?: boolean;
  localVerifiedAdded?: boolean;
  /** 官方任务被跳过原因（本地仍提交） */
  skipped?: string[];
}

export type CoordinatorCommand =
  | { kind: 'mutation'; mutation: ListMutation }
  | { kind: 'commitAction'; request: CommitActionRequest; origin?: { tabId?: number; frameId?: number } }
  | { kind: 'saveQueueTasks'; tasks: ActionTask[] }
  | { kind: 'saveQueueControl'; state: QueueControlState }
  | { kind: 'saveQueueSnapshot'; tasks: ActionTask[]; state: QueueControlState }
  | { kind: 'dedupMark'; key: string; ttl: number }
  | { kind: 'dedupClear'; key: string }
  | { kind: 'cancelTasks'; taskIds: string[] }
  | {
      kind: 'revoke';
      reason: string;
      /** 是否同时暂停队列（enabled=false / reset / clear 等全局撤权） */
      pause: boolean;
      pauseKind?: CoordinatorPauseKind;
      /** 仅撤销报告类任务（autoReportAuthorized 撤权） */
      reportOnly?: boolean;
      /** 仅撤销 auto_process 来源任务 */
      autoOnly?: boolean;
      /** 撤销后清空队列内存与存储（reset/clear） */
      clearQueue?: boolean;
      /** P0-4：unknown_outcome 证据的 cause（clearQueue 时使用） */
      cause?: 'sw_restart' | 'cancel_in_flight' | 'revoke' | 'reset' | 'clear';
    }
  | { kind: 'resumeQueue'; mode: 'user' | 'login_restored' }
  | { kind: 'setQueuePaused'; reason: string; pauseKind: CoordinatorPauseKind; requiresExplicitResume: boolean }
  | { kind: 'acknowledgeUnknownOutcome'; taskId: string };

export type CoordinatorResult = Record<string, unknown>;

export class StorageCoordinator {
  /** P0-1（v0.1.5）：不再有实例级 currentLease / inLock / 共享「已持锁」状态 */
  private queue: ActionQueue | null;
  private readonly dedup: DeduplicationRegistry | null;
  private readonly hooks: { onDataChanged?: () => void };

  /** 外部 QueueWriter：永远走公共 execute/全局队列（锁外排队；锁内由 scoped writer 处理） */
  readonly writer: QueueWriter;

  constructor(
    private readonly repo: StorageRepository,
    queue: ActionQueue | null,
    dedup: DeduplicationRegistry | null,
    hooks: { onDataChanged?: () => void } = {},
  ) {
    this.queue = queue;
    this.dedup = dedup;
    this.hooks = hooks;
    this.writer = {
      saveTasks: (tasks) => this.execute({ kind: 'saveQueueTasks', tasks }).then(() => undefined),
      saveControl: (state) => this.execute({ kind: 'saveQueueControl', state }).then(() => undefined),
      markDedup: (key, ttl) => this.execute({ kind: 'dedupMark', key, ttl }).then(() => undefined),
      clearDedup: (key) => this.execute({ kind: 'dedupClear', key }).then(() => undefined),
      recordUnknownOutcome: (record) =>
        this.execute({ kind: 'mutation', mutation: { op: 'appendUnknownOutcome', record: record as never } }).then(
          () => undefined,
        ),
      saveQueueSnapshot: (tasks, state) =>
        this.execute({ kind: 'saveQueueSnapshot', tasks, state }).then(() => undefined),
    };
  }

  /** P0-1：background 构造顺序（coordinator 先建、queue 后建）时注入 queue */
  attachQueue(queue: ActionQueue): void {
    this.queue = queue;
  }

  /**
   * 唯一写入口：**所有**公共 execute 无条件获取全局写锁（KeyMutex 串行）。
   * 回调接收显式 WriteLease；锁内通过 writerFor(lease) 创建**仅当前调用栈有效**的
   * scoped writer 执行内部嵌套写——绝不把 lease 保存到实例字段，绝不共享「已持锁」状态。
   */
  async execute(command: CoordinatorCommand): Promise<CoordinatorResult> {
    return this.repo.withGlobalWrite(async (lease) => {
      const scoped = this.writerFor(lease);
      return this.executeInner(command, scoped);
    });
  }

  /**
   * P0-1（v0.1.5）：词法作用域 ScopedWriter。
   * 只在当前 withGlobalWrite 回调调用栈内有效：直接写 repo（锁内嵌套写），
   * 不重新抢锁、不排队。queue/revoke/reset 等锁内操作显式接收本 writer。
   */
  private writerFor(lease: WriteLease): QueueWriter {
    void lease; // 令牌仅证明当前调用栈已持有全局锁（由 withGlobalWrite 保证）
    return {
      saveTasks: (tasks) => this.repo.saveQueueTasks(tasks),
      saveControl: (state) => this.repo.saveQueueControl(state),
      markDedup: (key, ttl) => this.repo.markDedup(key, ttl),
      clearDedup: (key) => this.repo.clearDedup(key),
      recordUnknownOutcome: (record) => this.repo.recordUnknownOutcome(record),
      saveQueueSnapshot: (tasks, state) =>
        this.repo.commitSnapshot({
          [STORAGE_KEYS.queue]: tasks,
          [STORAGE_KEYS.queueControl]: state,
        }),
    };
  }

  private async executeInner(command: CoordinatorCommand, writer: QueueWriter): Promise<CoordinatorResult> {
    switch (command.kind) {
      case 'mutation':
        return this.runMutation(command.mutation, writer);
      case 'commitAction':
        return this.commitAction(command.request, command.origin, writer) as unknown as CoordinatorResult;
      case 'saveQueueTasks':
        // P0-2（v0.1.5）：外部 writer 的保存基于**锁内最新持久快照**合并——
        // 防止持有旧数组引用的外部调用覆盖 commitAction 等已提交的更新
        //（如丢失 concurrent、把 in_flight 回退成 queued）。scoped writer 路径
        //（queue 锁内 persist/clearQueue）仍为全量替换，语义不受影响。
        await this.repo.saveQueueTasks(mergeQueueTasks(await this.repo.getQueueTasks(), command.tasks));
        return { ok: true };
      case 'saveQueueControl':
        await this.repo.saveQueueControl(command.state);
        return { ok: true };
      case 'saveQueueSnapshot':
        // P1-1（v0.1.5）：tasks 与 control 一次原子落盘（resume 恢复）
        await this.repo.commitSnapshot({
          [STORAGE_KEYS.queue]: command.tasks,
          [STORAGE_KEYS.queueControl]: command.state,
        });
        return { ok: true };
      case 'dedupMark':
        await this.repo.markDedup(command.key, command.ttl);
        return { ok: true };
      case 'dedupClear':
        await this.repo.clearDedup(command.key);
        return { ok: true };
      case 'cancelTasks':
        await this.queue?.cancel(command.taskIds, writer);
        return { ok: true };
      case 'revoke':
        await this.queue?.revoke(
          command.reason,
          {
            pause: command.pause,
            pauseKind: command.pauseKind,
            reportOnly: command.reportOnly,
            autoOnly: command.autoOnly,
            clearQueue: command.clearQueue,
            cause: command.cause,
          },
          writer,
        );
        return { ok: true };
      case 'resumeQueue':
        await this.queue?.resume(command.mode, writer);
        return { ok: true };
      case 'setQueuePaused':
        // P0-3（v0.1.5）：pause 必须可 await 且失败时显式失败（reject）
        await this.queue?.pause(command.reason, command.pauseKind, command.requiresExplicitResume, writer);
        return { ok: true };
      case 'acknowledgeUnknownOutcome':
        await this.repo.acknowledgeUnknownOutcome(command.taskId);
        return { ok: true };
      default:
        return { ok: false, message: '未知协调命令' };
    }
  }

  // ---------------- 普通名单/设置/审计写（原 BB_MUTATE_LIST 语义） ----------------

  private async runMutation(mutation: ListMutation, writer: QueueWriter): Promise<CoordinatorResult> {
    switch (mutation.op) {
      case 'addBlocked':
        await this.repo.addBlocked({ uid: mutation.uid, username: mutation.username, reason: mutation.reason, source: mutation.source });
        return { ok: true };
      case 'removeBlocked':
        await this.repo.removeBlocked(mutation.uid);
        return { ok: true };
      case 'addVerified':
        await this.repo.addVerified({ uid: mutation.uid, username: mutation.username, source: mutation.source });
        return { ok: true };
      case 'removeVerified':
        await this.repo.removeVerified(mutation.uid);
        return { ok: true };
      case 'addWhitelist':
        await this.repo.addWhitelist({ uid: mutation.uid, username: mutation.username });
        return { ok: true };
      case 'removeWhitelist':
        await this.repo.removeWhitelist(mutation.uid);
        return { ok: true };
      case 'addBlockedBatch': {
        const r = await this.repo.addBlockedBatch(mutation.items);
        return { ok: true, ...r };
      }
      case 'addVerifiedBatch': {
        const r = await this.repo.addVerifiedBatch(mutation.items);
        return { ok: true, ...r };
      }
      case 'addWhitelistBatch': {
        const r = await this.repo.addWhitelistBatch(mutation.items);
        return { ok: true, ...r };
      }
      case 'appendAudit':
        await this.repo.appendAudit(mutation.entry);
        return { ok: true };
      case 'appendUnknownOutcome':
        await this.repo.recordUnknownOutcome(mutation.record);
        return { ok: true };
      case 'clearAudit':
        // P0-4：用户显式清空审计，保留结果未知条目（不可逆操作证据）
        await this.repo.retainUnknownAudit();
        return { ok: true };
      case 'saveRules':
        await this.repo.saveRules(mutation.rules, mutation.expectedRevision);
        this.hooks.onDataChanged?.();
        return { ok: true };
      case 'updateSettings': {
        const before = await this.repo.getSettings();
        const next = await this.repo.updateSettings(mutation.patch, mutation.expectedRevision);
        await this.handleSettingsTransition(before, next, writer);
        this.hooks.onDataChanged?.();
        return { ok: true, settings: next };
      }
      case 'importAll': {
        // P0-5：导入覆盖设置 = 全局撤权（epoch 递增 + 队列清理），导入只含名单时不撤权
        if (mutation.data.settings) {
          await this.queue?.revoke(
            '导入数据覆盖了设置，现存队列已撤销',
            { pause: false, clearQueue: false },
            writer,
          );
        }
        await this.repo.importAll({
          settings: mutation.data.settings
            ? { ...DEFAULT_SETTINGS, ...mutation.data.settings }
            : undefined,
          rules: mutation.data.rules,
          blocked: mutation.data.blocked as never,
          verified: mutation.data.verified as never,
          whitelist: mutation.data.whitelist as never,
        });
        if (!mutation.data.settings) {
          // 名单类导入：白名单变化可能使排队任务失效 → 重新验证
          await this.queue?.revalidateQueued('名单已导入', writer);
        }
        this.hooks.onDataChanged?.();
        return { ok: true };
      }
      case 'resetDefaults':
        await this.resetAndClear('reset', writer);
        return { ok: true };
      case 'clearAll':
        await this.resetAndClear('clear', writer);
        return { ok: true };
      default:
        return { ok: false, message: '未知变更操作' };
    }
  }

  /**
   * P0-3（v0.1.4）：reset/clear 原子最终快照（同一锁内读取旧 epoch，一次 backend.set）。
   * P0-2（v0.1.5）：锁内基于最新快照构造写内容，绝不持有旧数组引用跨 await。
   */
  private async resetAndClear(kind: 'reset' | 'clear', writer: QueueWriter): Promise<void> {
    const reason = kind === 'reset' ? '已恢复默认设置，现存队列已撤销' : '已清空全部数据，现存队列已撤销';
    const oldControl = await this.repo.getQueueControl();
    const nextControl: QueueControlState = {
      paused: true,
      pauseReason: reason,
      pauseKind: 'authorization_revoked',
      pausedAt: Date.now(),
      requiresExplicitResume: true,
      authorizationEpoch: oldControl.authorizationEpoch + 1,
      recentAttempts: { block: [], report: [], unblock: [] },
    };

    // P0-4：in_flight → unknown_outcome + 持久证据（先落盘再清空）
    await this.queue?.markInFlightUnknown(kind === 'reset' ? 'reset' : 'clear', writer);
    const keptUnknowns = (this.queue?.pendingTasks() ?? []).filter((t) => t.status === 'unknown_outcome');

    // P0-3：单次原子写入最终快照（全部成功或全部失败）
    const items: Record<string, unknown> = {
      [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS },
      [STORAGE_KEYS.rules]: [...DEFAULT_RULES],
      [STORAGE_KEYS.blocked]: [],
      [STORAGE_KEYS.verified]: [],
      [STORAGE_KEYS.whitelist]: [],
      [STORAGE_KEYS.dedup]: {},
      [STORAGE_KEYS.queue]: keptUnknowns,
      [STORAGE_KEYS.queueControl]: nextControl,
      [STORAGE_KEYS.revisions]: {},
      // 审计：保留 outcomeUnknown（不可逆操作证据）；reset 与 clear 一致
      [STORAGE_KEYS.audit]: (await this.repo.getAuditLogs()).filter((e) => e.outcomeUnknown === true),
      // clear 需重建最小种子（meta 保留 schema 版本）
      [STORAGE_KEYS.meta]: { schemaVersion: 1, seededAt: Date.now(), lastMigratedAt: Date.now() },
    };

    await this.repo.commitSnapshot(items);
    // 内存队列采用与存储一致的快照（backend 成功后）
    this.queue?.adoptTasks(keptUnknowns);
    this.queue?.adoptControl(nextControl);
    this.queue?.resetGeneration();
    this.hooks.onDataChanged?.();
  }

  /** P0-5：settings 撤权事件 → 统一队列撤权流程 */
  private async handleSettingsTransition(before: Settings, next: Settings, writer: QueueWriter): Promise<void> {
    if (before.enabled && !next.enabled) {
      await this.queue?.revoke(
        '总开关已关闭，现存任务已撤销',
        { pause: true, pauseKind: 'authorization_revoked' },
        writer,
      );
      return;
    }
    if (before.autoReportAuthorized && !next.autoReportAuthorized) {
      await this.queue?.revoke('自动举报授权已撤销，现存举报任务已取消', { pause: false, reportOnly: true }, writer);
    }
    if (before.autoProcessVerified && !next.autoProcessVerified) {
      await this.queue?.revoke('自动处理已关闭，现存自动任务已取消', { pause: false, autoOnly: true }, writer);
    }
    // 默认举报理由失效或清空
    const oldValid = before.defaultReportReason !== null;
    const newValid = next.defaultReportReason !== null;
    if (oldValid && !newValid) {
      await this.queue?.revoke('默认举报理由已清空/失效，现存举报任务已取消', { pause: false, reportOnly: true }, writer);
    } else if (next.defaultReportReason !== null && before.defaultReportReason !== next.defaultReportReason) {
      await this.queue?.revoke('默认举报理由已变更，现存举报任务已取消', { pause: false, reportOnly: true }, writer);
    }
  }

  // ---------------- P0-4/P0-2/P0-5：BB_COMMIT_ACTION 原子提交 ----------------

  /**
   * 一键动作原子提交（短生命周期、单所有者）。
   * - P1-3（v0.1.5）：成功路径的单次 commitSnapshot 同时包含 blocked/verified/queue
   *   delta 与 bb.operationOutcomes[operationId]（原子）；拒绝类结果也写入确定绑定记录；
   *   outcome 写失败 → 整个操作持久化失败（绝不用 catch 吞掉）。
   * - P0-2（v0.1.5）：锁内基于最新快照构造写内容；pendingTasks() 返回克隆。
   * - P0-5（v0.1.4）：operationId 幂等；paused（风控/撤权）拒绝创建官方任务。
   */
  private async commitAction(
    req: CommitActionRequest,
    origin: { tabId?: number; frameId?: number } = {},
    writer: QueueWriter,
  ): Promise<CommitActionResult> {
    // ---- P0-5：operationId 幂等（先查持久化 outcome） ----
    const binding = this.operationBinding(req, origin);
    const existing = await this.repo.getOperationOutcome(req.operationId);
    if (existing) {
      if (existing.binding !== binding) {
        return { ok: false, code: 'operationId_reused', reason: 'operationId 已被不同请求复用，已拒绝' };
      }
      return existing.result as unknown as CommitActionResult;
    }

    const settings = await this.repo.getSettings();
    const control = await this.repo.getQueueControl();
    const whitelist = await this.repo.getWhitelist();

    // ---- 重新验证（拒绝类结果也需要确定绑定记录，原子写 outcome） ----
    if (!settings.enabled) {
      return this.saveOutcomeAtomic(req, binding, writer, { ok: false, code: 'disabled', reason: '总开关已关闭，未执行任何操作' });
    }
    if (req.currentMid !== null && req.uid === req.currentMid) {
      return this.saveOutcomeAtomic(req, binding, writer, { ok: false, code: 'self', reason: '不能操作自己的账号' });
    }
    if (whitelist.some((w) => w.uid === req.uid)) {
      return this.saveOutcomeAtomic(req, binding, writer, { ok: false, code: 'whitelisted', reason: '该账号已在白名单，未执行任何操作' });
    }
      // 授权纪元：撤权发生在倒计时期间 → 整体拒绝（本地也不写）
      // 防御：缺少授权快照（undefined）同样整体拒绝，绝不访问 undefined 字段
      if (req.authorization === undefined || req.authorization.epoch !== control.authorizationEpoch) {
        return this.saveOutcomeAtomic(req, binding, writer, {
          ok: false,
          code: 'authorization_changed',
          reason: '授权状态已变化（缺少/过期授权快照），未执行任何操作',
        });
      }
    // P0-2：官方任务必须有完整授权快照（消息 schema 已保证；此处防御性拒绝）
    if (req.officialTasks.length > 0 && !isCompleteAuthorization(req.authorization)) {
      return this.saveOutcomeAtomic(req, binding, writer, {
        ok: false,
        code: 'authorization_changed',
        reason: '缺少完整授权快照，拒绝创建官方任务',
      });
    }

    // ---- 本地动作 ----
    const localBlocked = req.localActions.commitLocalBlock;
    // 防御性发布门禁：即使调用方绕过消息 parser，也不能在缺少内容 ID 时写 verified。
    let localVerified = req.localActions.commitVerified && Boolean(req.contentId?.trim());
    if (req.source === 'auto_process' && !settings.autoProcessVerified) {
      localVerified = false;
    }

    // ---- 官方任务（能力/理由/授权/暂停逐项重新验证） ----
    const skipped: string[] = [];
    let officialToEnqueue: TaskInput[] = [];
    if (!req.skipOfficial && req.officialTasks.length > 0) {
      // 5.1（v0.1.4）：paused（风控/撤权/需显式恢复）→ 拒绝创建官方任务（本地仍按矩阵）
      if (
        control.paused &&
        (control.pauseKind === 'risk_control' ||
          control.pauseKind === 'authorization_revoked' ||
          control.requiresExplicitResume)
      ) {
        skipped.push(`队列已暂停（${control.pauseReason ?? control.pauseKind}），官方任务未创建`);
      } else if (!req.loginOk) {
        skipped.push('需要登录（官方任务跳过，本地动作仍完成）');
      } else {
        officialToEnqueue = req.officialTasks.filter((t) => {
          const v = this.validateOfficialTask(t, settings);
          if (!v.ok) skipped.push(v.reason);
          return v.ok;
        });
      }
    }

    // ---- 计算精确 delta（锁内最新快照） ----
    const [blockedBefore, verifiedBefore] = await Promise.all([
      this.repo.getBlocked(),
      this.repo.getVerified(),
    ]);
    const blockedAdd = localBlocked && !blockedBefore.some((b) => b.uid === req.uid);
    const verifiedAdd = localVerified && !verifiedBefore.some((v) => v.uid === req.uid);

    // P0-2：授权快照显式传给 planEnqueue/buildTask（每任务持久化独立快照）
    const created =
      officialToEnqueue.length > 0
        ? (await this.queue?.planEnqueue(
            officialToEnqueue,
            { tabId: origin.tabId, frameId: origin.frameId ?? 0, frameNonce: req.frameNonce },
            req.authorization,
          )) ?? []
        : [];

    const result: CommitActionResult = {
      ok: true,
      code: 'committed',
      enqueued: created.length,
      localBlockedAdded: blockedAdd,
      localVerifiedAdded: verifiedAdd,
      skipped,
    };

    // ---- P1-3：单次 commitSnapshot 原子包含 名单 delta + 队列 delta + outcome ----
    const items: Record<string, unknown> = {};
    if (blockedAdd) {
      items[STORAGE_KEYS.blocked] = [
        ...blockedBefore,
        {
          uid: req.uid,
          username: req.username,
          reason: req.source === 'auto_process' ? '自动处理：已确认机器人' : '用户一键确认',
          source: req.source === 'auto_process' ? 'auto_process' : 'user_action',
          blockedAt: Date.now(),
        },
      ].slice(-20_000);
    }
    if (verifiedAdd) {
      items[STORAGE_KEYS.verified] = [
        ...verifiedBefore,
        { uid: req.uid, username: req.username, source: 'user_action', addedAt: Date.now() },
      ].slice(-20_000);
    }
    let latestQueueSnapshot: ActionTask[] = [];
    if (created.length > 0) {
      // P0-2（v0.1.5）：锁内读取**最新持久队列快照**追加 created——
      // 绝不持有内存旧数组引用跨 await 覆盖（外部 writer 已保存的并发更新不得被回退/丢失）
      latestQueueSnapshot = await this.repo.getQueueTasks();
      items[STORAGE_KEYS.queue] = [...latestQueueSnapshot, ...created];
    }
    // P1-3：outcome 与副作用同一次 backend.set（原子）；写失败 → 整体失败
    items[STORAGE_KEYS.operationOutcomes] = await this.nextOutcomesMap(req.operationId, binding, result);
    try {
      await this.repo.commitSnapshot(items);
    } catch (e) {
      return {
        ok: false,
        code: 'storage_failed',
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    // 内存队列采用与存储一致的快照（backend 成功后；P0-2 adopt 语义）。
    // 复验（P0-2）：合并式 adopt——pump 在锁外可能已把某任务推进为 in_flight，
    // 绝不用存储快照把运行中任务回退成 queued。
    if (created.length > 0) {
      this.queue?.adoptTasksMerged([...latestQueueSnapshot, ...created]);
      this.queue?.kick();
    }
    return result;
  }

  /**
   * P1-3（v0.1.5）：拒绝类结果也需要确定的绑定记录（原子写 outcome）。
   * 写入失败 → 返回持久化失败（而非假装幂等承诺已建立）。
   */
  private async saveOutcomeAtomic(
    req: CommitActionRequest,
    binding: string,
    writer: QueueWriter,
    result: CommitActionResult,
  ): Promise<CommitActionResult> {
    void writer;
    try {
      const map = await this.nextOutcomesMap(req.operationId, binding, result);
      await this.repo.commitSnapshot({ [STORAGE_KEYS.operationOutcomes]: map });
    } catch (e) {
      return {
        ok: false,
        code: 'storage_failed',
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    return result;
  }

  /** P1-3：计算下一个 operationOutcomes map（TTL 清理 + 容量上限 + 新记录） */
  private async nextOutcomesMap(
    operationId: string,
    binding: string,
    result: CommitActionResult,
  ): Promise<Record<string, OperationOutcomeRecord>> {
    const map = await this.repo.getOperationOutcomesRaw();
    const now = Date.now();
    const record: OperationOutcomeRecord = {
      binding,
      result: result as unknown as Record<string, unknown>,
      ts: now,
    };
    const entries = Object.entries(map)
      .filter(([, v]) => now - v.ts < OPERATION_OUTCOME.TTL_MS)
      .sort((a, b) => b[1].ts - a[1].ts);
    const kept = new Map(entries.slice(0, OPERATION_OUTCOME.MAX_RECORDS - 1));
    kept.set(operationId, record);
    return Object.fromEntries(kept);
  }

  /** P0-5：operationId 绑定指纹（不同请求复用同一 operationId 时拒绝） */
  private operationBinding(req: CommitActionRequest, origin: { tabId?: number; frameId?: number }): string {
    const tasksSig = req.officialTasks.map((t) => `${t.type}:${t.uid}:${t.contentId ?? ''}:${t.reasonId ?? ''}`).join('|');
    return [origin.tabId ?? '', origin.frameId ?? '', req.frameNonce, req.uid, req.contentId ?? '', req.contentHash ?? '', tasksSig].join(':');
  }

  /** 派发前/提交时对官方任务的逐项验证（能力 + 授权 + 理由 + 来源开关） */
  private validateOfficialTask(
    t: TaskInput,
    settings: Settings,
  ): { ok: true } | { ok: false; reason: string } {
    // P0-2：auto_process 开关必须位于任何任务类型成功返回之前
    if (t.source === 'auto_process' && !settings.autoProcessVerified) {
      return { ok: false, reason: '自动处理已关闭（跳过）' };
    }
    if (t.type === 'block') {
      if (!isCapabilityEnabled('blockUser')) {
        return { ok: false, reason: '官方拉黑能力未验证（跳过）' };
      }
      return { ok: true };
    }
    if (t.type === 'unblock') {
      if (!isCapabilityEnabled('unblockUser')) {
        return { ok: false, reason: '解除拉黑能力未验证（跳过）' };
      }
      return { ok: true };
    }
    if (t.type === 'report') {
      if (!t.contentId?.trim()) {
        return { ok: false, reason: '举报任务缺少内容 ID（跳过）' };
      }
      if (!settings.autoReportAuthorized) {
        return { ok: false, reason: '自动举报授权已撤销（跳过）' };
      }
      if (t.contentType === undefined) {
        return { ok: false, reason: '举报任务缺少内容类型（跳过）' };
      }
      // canReportContentType 已包含：能力验证 ∧ REPORT_REASONS.verified（生产）；
      // E2E/Mock 构建整体放行（编译隔离）
      if (!canReportContentType(t.contentType)) {
        return { ok: false, reason: `举报能力/内容类型未验证（${t.contentType}，跳过）` };
      }
      if (t.reasonId === undefined || !isValidReason(t.contentType, t.reasonId)) {
        return { ok: false, reason: '举报理由已失效（跳过）' };
      }
      if (resolveDefaultReason(t.contentType, settings.defaultReportReason) === null) {
        return { ok: false, reason: '当前默认举报理由无效（跳过）' };
      }
      return { ok: true };
    }
    return { ok: false, reason: '未知任务类型（跳过）' };
  }

  /** 供 background 使用：生成一次性 operationId（提交请求幂等标识） */
  newOperationId(): string {
    return shortId('op');
  }
}

/** P0-2：授权快照完整性（官方任务必填字段） */
function isCompleteAuthorization(auth: CommitActionRequest['authorization']): boolean {
  return (
    typeof auth.epoch === 'number' &&
    typeof auth.settingsRevision === 'number' &&
    typeof auth.source === 'string' &&
    typeof auth.autoProcessAuthorized === 'boolean' &&
    typeof auth.reportAuthorized === 'boolean' &&
    typeof auth.createdAt === 'number' &&
    auth.capabilityKey !== undefined
  );
}

/**
 * P0-2（v0.1.5）：外部 writer 保存的队列与**锁内最新持久快照**合并。
 *
 * 规则（防止旧快照覆盖新状态，同时不破坏正常的全量替换语义）：
 * - 以外部传入的任务为准（按 id 覆盖/新增）；
 * - 外部快照未提及、但锁内最新持久队列中**仍活跃**的任务（queued/in_flight/
 *   unknown_outcome）保留——这是 commitAction 并发创建的任务、或并发更新的状态，
 *   不能被持有旧引用的外部调用覆盖掉（丢失 concurrent / 把 in_flight 回退成 queued）；
 * - 终态任务（succeeded/failed/cancelled/skipped）以外部为准：TTL 清理、
 *   用户取消、撤权等由队列自身（scoped writer 全量替换路径）正确表达。
 */
function mergeQueueTasks(latest: ActionTask[], incoming: ActionTask[]): ActionTask[] {
  const byId = new Map<string, ActionTask>();
  for (const t of incoming) byId.set(t.id, t);
  const preserved: ActionTask[] = [];
  for (const t of latest) {
    if (byId.has(t.id)) continue;
    if (t.status === 'queued' || t.status === 'in_flight' || t.status === 'unknown_outcome') {
      preserved.push(t);
    }
  }
  return [...preserved, ...incoming];
}

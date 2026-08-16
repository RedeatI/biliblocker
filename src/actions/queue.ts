/**
 * ActionQueue：拉黑/举报任务队列（运行于 background，持久化于 storage）。
 *
 * v0.1.7（P0-5b / P1-7~P1-9）：
 * - P0-5b：runTask 派发前二次确认补**内存 epoch 比较**
 *   （task.authorization.epoch !== this.control.authorizationEpoch）——revoke 的 epoch+1
 *   是同步内存修改（先于 saveControl await），存储写 in-flight 窗口内 cache 仍旧 epoch、
 *   check-latest-again 会返回 ok、任务仍 queued；内存 epoch 比较必然捕获该子窗口，
 *   executor 调用恒为 0（撤权发起后绝不继续派发）。
 * - P1-7：Source 打包/gate 排除 __pycache__（review/__pycache__/*.pyc 曾进入 Source ZIP）。
 * - P1-8：gate 的 Source↔工作区比较容忍 runtime-integration-evidence*.json 运行副产物（runAt）。
 * - P1-9：v017-runtime-probe 新增 revokeSaveControlInFlightDispatch 探针（挂起 revoke 的 saveControl）。
 *
 * v0.1.6（P0-5 / P1-4~P1-6）：
 * - P0-5：verifyTaskEligible 的 epoch 检查移至所有 await **之后**（check-latest-again），
 *   返回前用锁内最新 control（repo.getQueueControl()）重比 authorization.epoch；
 *   runTask 设置 in_flight **之前**二次确认 task.status==='queued' && !revocationRequested，
 *   否则不派发（保留已确立终态）——撤权/取消在 verify 挂起窗口内发生时 executor 调用恒为 0。
 * - P1-4：enqueue 标记 @internal（仅测试/遗留），生产路径统一 planEnqueue（coordinator 锁内原子）。
 * - P1-5：runTask 捕获持久化异常（saveControl/persistIfCurrent），任务转 failed 并记录
 *   lastError，不产生 unhandled rejection / orphaned promise。
 * - P1-6：revoke 先落盘 epoch（安全性关键；失败回滚内存并显式失败）；任务落盘失败显式记录，
 *   重启后 queued 任务因 epoch 不匹配被 skipped（绝不派发）。
 *
 * v0.1.5（P0-1~P0-3 / P1-1）：
 * - P0-1：所有写经注入 writer；锁内操作（coordinator 调用本队列时）显式接收
 *   scoped writer（当前调用栈内有效），锁外调用永远走 deps.writer（公共 execute 排队）；
 *   不再依赖协调器的实例级 currentLease（该字段已在 v0.1.5 删除）。
 * - P0-2：pendingTasks() 返回 structuredClone 快照（不暴露可变内部数组）；
 *   队列内存只在 backend 成功后 adopt（commitAction/reset/clear 由协调器保证）；
 *   外部 writer 保存的旧快照经协调器锁内合并，不会覆盖更新的队列状态。
 * - P0-3：pause() 失败时显式 reject（不得静默成功）；先设置安全 latch
 *   （fail-closed，覆盖 SW 重启）再写 local control；local 写失败保持 latch 并有限重试；
 *   start() 先读 latch，无法证明上次暂停已安全清除则 fail-closed（不 pump）；
 *   只有用户显式恢复（resume）才清除 latch。
 * - P1-1：resume 重验时使用 controlOverride（paused:false）——忽略「正在解除的
 *   这一个 pause」，但 epoch/capability/理由/白名单/总开关仍必须校验；
 *   合法任务继续执行恰好一次，无效任务因真实失效原因转 skipped。
 *
 * v0.1.3（P0-3/P0-5/P1-1）：
 * - 取消状态机：queued + cancel → cancelled；in_flight + cancel/revoke → unknown_outcome
 *   （真实结果保留、不覆盖、不自动重发、写审计并要求人工核对）；succeeded 永不显示为已取消。
 * - 撤权统一 revoke()（authorizationEpoch++）；risk_control 只能用户显式恢复。
 * - 速率预算 crash-safe：每次实际发送尝试先持久化（发送前），SW 重启后恢复。
 *
 * v0.1.4（P0-1~P0-5）：
 * - 所有写经 QueueWriter → background 的 StorageCoordinator。
 * - P0-2 派发前完整校验（autoProcessVerified 前置；capability；authorization 逐项比较）。
 * - P0-4 unknown_outcome 持久证据（幂等 upsert）。
 * - P0-5 pause() 可 await。
 */
import type {
  ActionTask,
  AuthorizationSnapshot,
  CapabilityKeyName,
  PauseKind,
  QueueControlState,
  QueueStatus,
  TaskResult,
  TaskType,
  UnknownOutcomeRecord,
} from '../shared/types';
import type { TaskInput } from '../shared/messages';
import { DEFAULT_QUEUE_CONTROL, QUEUE } from '../shared/constants/defaults';
import { shortId } from '../shared/utils';
import { isCapabilityEnabled, canReportContentType, capabilityForTaskType } from '../shared/capabilities';
import { isValidReason, resolveDefaultReason } from '../shared/constants/report-reasons';
import type { StorageRepository } from '../storage/repository';
import type { DeduplicationRegistry } from './dedup';
import type { SafetyLatch } from '../storage/safety-latch';

export interface TaskExecutor {
  /** 实际执行一个任务（由内容脚本/测试桩实现） */
  execute(task: ActionTask): Promise<TaskResult>;
}

/** 队列/去重/控制/unknown 证据写统一经 background 的 StorageCoordinator */
export interface QueueWriter {
  saveTasks(tasks: ActionTask[]): Promise<void>;
  saveControl(state: QueueControlState): Promise<void>;
  markDedup(key: string, ttl: number): Promise<void>;
  clearDedup(key: string): Promise<void>;
  /** P0-4：不可逆操作「结果未知」持久证据（幂等 upsert） */
  recordUnknownOutcome(record: UnknownOutcomeRecord): Promise<void>;
  /**
   * P1-1（v0.1.5）：队列与安全控制**一次原子落盘**（resume 恢复使用）。
   * 可选：老 writer 桩不实现时回退为 saveTasks + saveControl 两次调用。
   */
  saveQueueSnapshot?(tasks: ActionTask[], state: QueueControlState): Promise<void>;
}

export interface QueueDeps {
  repo: StorageRepository;
  dedup: DeduplicationRegistry;
  /** 协调写入口（background 注入 coordinator-backed writer；测试可注入直写桩） */
  writer: QueueWriter;
  executor: TaskExecutor;
  /** P0-3（v0.1.5）：安全暂停 latch（fail-closed，跨 SW 重启）；可空 */
  latch?: SafetyLatch;
  now?: () => number;
  onTaskDone?: (task: ActionTask) => void;
  onQueueStateChange?: (status: QueueStatus) => void;
}

export interface RevokeOptions {
  /** 是否同时暂停队列（enabled=false / reset / clear 等全局撤权） */
  pause?: boolean;
  pauseKind?: PauseKind;
  /** 仅撤销报告类任务（autoReportAuthorized 撤权） */
  reportOnly?: boolean;
  /** 仅撤销 auto_process 来源任务（autoProcessVerified 撤权） */
  autoOnly?: boolean;
  /** 撤销后清空队列内存与存储（reset/clear） */
  clearQueue?: boolean;
  /** P0-4：unknown_outcome 证据的 cause（默认 revoke） */
  cause?: UnknownOutcomeRecord['cause'];
}

/** P0-3：暂停持久化的有限重试参数 */
const PAUSE_RETRY = { MAX_ATTEMPTS: 3, BASE_DELAY_MS: 500 } as const;

export class ActionQueue {
  private tasks: ActionTask[] = [];
  private control: QueueControlState = { ...DEFAULT_QUEUE_CONTROL };
  private pumping = false;
  /** 队列代际：clearQueue/reset 后递增；进行中的 runTask 检测到代际变化则丢弃结果不持久化 */
  private generation = 0;
  private readonly now: () => number;
  private lastError: string | undefined;
  /** P0-3：pause 持久化失败后的有限重试计时器（避免测试环境悬挂） */
  private pauseRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** P0-3（复验）：pause 持久化是否仍未成功（阻止相同原因 pause 早退 return） */
  private pausePersistPending = false;

  constructor(private readonly deps: QueueDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** P0-5：控制状态快照（协调器/测试读取当前纪元等） */
  controlSnapshot(): QueueControlState {
    return structuredClone(this.control);
  }

  /**
   * P0-2（v0.1.5）：当前任务列表**快照**（结构化克隆，绝不暴露可变内部数组）。
   * 协调器原子提交时用快照构造存储内容；调用方修改返回数组不影响内部状态。
   */
  pendingTasks(): ActionTask[] {
    return structuredClone(this.tasks);
  }

  /** P0-4：采用与存储一致的新任务列表（协调器 commitSnapshot 成功后调用；不重复持久化） */
  adoptTasks(tasks: ActionTask[]): void {
    this.tasks = tasks;
  }

  /**
   * 复验（阶段 E 第二轮 / P0-2）：合并式 adopt——以 snapshot 为准，
   * 但内存中**正在进行**（in_flight，runTask 已把请求发出）的任务绝不被旧快照
   * 回退成 queued（保留原对象引用，runTask 结果仍能写回）。
   * 用于 commitAction 等「存储快照 + 追加」场景（pump 在锁外可能已推进状态）。
   */
  adoptTasksMerged(snapshot: ActionTask[]): void {
    const curById = new Map(this.tasks.map((t) => [t.id, t]));
    const out = snapshot.map((t) => {
      const cur = curById.get(t.id);
      if (cur && cur.status === 'in_flight' && t.status === 'queued') return cur;
      return t;
    });
    this.tasks = out;
  }

  /** P0-3（v0.1.4）：采用与存储一致的新控制状态（reset/clear 原子快照成功后调用） */
  adoptControl(state: QueueControlState): void {
    this.control = state;
  }

  /** P0-3（v0.1.4）：代际递增（reset/clear 后内存与存储同时清空，进行中的任务结果被丢弃） */
  resetGeneration(): void {
    this.generation += 1;
  }

  /**
   * 启动：从 storage 恢复队列与控制状态并触发泵。
   * P0-3（v0.1.5）：**先读安全 latch**——若上次暂停未能证明已安全清除
   * （session latch 存在），强制 fail-closed（paused=true、不 pump），
   * 只有用户显式恢复后才允许继续；绝不默认恢复为未暂停。
   * P0-3（v0.1.4）：in_flight（SW 中断）→ unknown_outcome + 持久证据，绝不自动重发。
   */
  async start(): Promise<void> {
    // P0-3：先读安全 latch
    let safetyLatched = false;
    if (this.deps.latch) {
      try {
        safetyLatched = await this.deps.latch.isSet();
      } catch {
        // latch 读取失败：按存在处理（fail-closed 优先）
        safetyLatched = true;
      }
    }
    const stored = await this.deps.repo.getQueueTasks();
    this.pruneTerminal(stored);
    this.tasks = stored;
    this.control = await this.deps.repo.getQueueControl();

    if (safetyLatched) {
      // 无法证明上次暂停已安全清除 → fail-closed（不写存储：存储可能仍不可用）
      this.control = {
        ...this.control,
        paused: true,
        pauseReason: this.control.pauseReason ?? '上次暂停状态未能安全清除（存储写入失败），请确认后手动恢复',
        pauseKind: this.control.pauseKind === 'none' ? 'risk_control' : this.control.pauseKind,
        requiresExplicitResume: true,
      };
      this.lastError = '检测到未清除的安全暂停锁：队列保持 fail-closed，不派发任何任务';
      this.emitState();
      return;
    }

    const recoveredUnknown: ActionTask[] = [];
    for (const t of this.tasks) {
      if (t.status === 'in_flight') {
        t.status = 'unknown_outcome';
        t.revocationRequested = true;
        t.result = {
          ok: false,
          status: 'unknown_outcome',
          errorType: 'unknown',
          message: '请求可能已发送但结果未知（SW 中断恢复），请人工核对，未自动重发',
          attemptedAt: this.now(),
        };
        await this.recordUnknown(t, 'sw_restart');
        recoveredUnknown.push(t);
      } else if (t.status === 'queued') {
        // P0-2：旧版本任务无授权快照 → 转 skipped，绝不直接派发
        if (!t.authorization) {
          t.status = 'skipped';
          t.skipReason = '任务缺少授权快照（旧版本任务），已跳过';
          t.result = {
            ok: false,
            status: 'skipped',
            errorType: 'authorization_changed',
            message: t.skipReason,
            attemptedAt: this.now(),
          };
          continue;
        }
        t.attempts = Math.min(t.attempts, Math.max(0, t.maxAttempts - 1));
      }
    }
    await this.deps.writer.saveTasks(this.pendingTasks());
    // 速率预算/暂停状态已在 storage，无需重置；显式持久化一次保证与内存一致
    await this.deps.writer.saveControl(this.control);
    for (const t of recoveredUnknown) {
      this.deps.onTaskDone?.(t);
    }
    if (this.control.paused) {
      this.emitState(); // 保持暂停，不 pump
      return;
    }
    void this.pump();
  }

  /** 公开 kick：alarms 唤醒时推进到期任务 */
  kick(): void {
    void this.pump();
  }

  /**
   * @internal P1-4（v0.1.6）：仅测试/遗留场景使用——直接 push+persist，**绕过**
   * coordinator 的锁内原子提交与 operationOutcome 记录。生产路径（content/background）
   * 必须经 `planEnqueue`（由 StorageCoordinator.commitAction 在全局写锁内原子落盘）。
   * 入队（按类型进入各自队列）；暂停/撤权状态下禁止新任务。
   */
  async enqueue(
    inputs: TaskInput[],
    origin: { tabId?: number; frameId?: number; frameNonce?: string } = {},
    authorization?: AuthorizationSnapshot,
  ): Promise<ActionTask[]> {
    if (!canEnqueueOfficialTask(this.control)) {
      return [];
    }
    const created = await this.planEnqueue(inputs, origin, authorization);
    if (created.length > 0) {
      this.tasks.push(...created);
      await this.persist();
    }
    void this.pump();
    return created;
  }

  /**
   * P0-4（v0.1.3）：规划入队（去重 + pending 检查），不持久化、不写入内存。
   * 由 StorageCoordinator.commitAction 在全局写锁内调用，与名单写入一次原子落盘。
   */
  async planEnqueue(
    inputs: TaskInput[],
    origin: { tabId?: number; frameId?: number; frameNonce?: string } = {},
    authorization?: AuthorizationSnapshot,
  ): Promise<ActionTask[]> {
    const created: ActionTask[] = [];
    for (const input of inputs) {
      // 已在队列中（排队中/执行中/TTL 内成功）或本批次已规划 → 不重复入队
      if (this.isSameTaskPending(input, created)) continue;
      if (input.type === 'block') {
        if (await this.deps.dedup.isBlockDuplicate(input.uid)) continue;
      }
      if (input.type === 'report') {
        if (
          input.contentId &&
          input.reasonId !== undefined &&
          (await this.deps.dedup.isReportDuplicate(
            input.uid,
            input.contentType ?? 'video_comment',
            input.contentId,
            input.reasonId,
          ))
        ) {
          continue;
        }
      }
      created.push(this.buildTask(input, origin, authorization));
    }
    return created;
  }

  private buildTask(
    input: TaskInput,
    origin: { tabId?: number; frameId?: number; frameNonce?: string },
    baseAuth?: AuthorizationSnapshot,
  ): ActionTask {
    return {
      id: shortId(input.type === 'report' ? 'rep' : 'blk'),
      groupId: input.groupId ?? shortId('grp'),
      type: input.type,
      uid: input.uid,
      username: input.username,
      contentType: input.contentType,
      contentId: input.contentId,
      rootContentId: input.rootContentId,
      oid: input.oid,
      reasonId: input.reasonId,
      source: input.source,
      createdAt: this.now(),
      attempts: 0,
      maxAttempts: input.type === 'report' ? 1 : QUEUE.MAX_NETWORK_RETRIES + 1,
      nextAttemptAt: this.now(),
      status: 'queued',
      tabId: origin.tabId,
      frameId: origin.frameId ?? 0,
      frameNonce: origin.frameNonce,
      contentHash: input.contentHash,
      authorization: baseAuth ? adaptAuthorizationForTask(baseAuth, input) : undefined,
    };
  }

  /** 相同操作是否已在队列中（排队/执行中/TTL 内已成功；含本批次已规划任务） */
  private isSameTaskPending(input: TaskInput, batch: ActionTask[] = []): boolean {
    return [...this.tasks, ...batch].some((t) => {
      if (t.status !== 'queued' && t.status !== 'in_flight' && t.status !== 'succeeded') return false;
      if (t.type !== input.type || t.uid !== input.uid) return false;
      if (input.type === 'report') {
        return (
          t.contentType === input.contentType &&
          t.contentId === input.contentId &&
          t.reasonId === input.reasonId
        );
      }
      return true;
    });
  }

  // ---------------- P0-3/P0-4/P0-5：取消与撤权状态机 ----------------

  /**
   * 取消任务（P0-3 状态机）：
   * - queued + cancel → cancelled（确认未发送，executor 从未被调用）
   * - in_flight + cancel → unknown_outcome + 持久证据（可能已发送；真实结果仍保留）
   * - succeeded 等终态不改变（举报成功永远不显示为已取消）
   * P0-1（v0.1.5）：writer 参数为协调器锁内注入的 scoped writer（可空，缺省用 deps.writer）。
   */
  async cancel(taskIds: string[], writer?: QueueWriter): Promise<void> {
    const w = writer ?? this.deps.writer;
    const ids = new Set(taskIds);
    let changed = false;
    for (const t of this.tasks) {
      if (!ids.has(t.id)) continue;
      if (t.status === 'queued') {
        t.status = 'cancelled';
        t.skipReason = '用户取消（确认未发送）';
        t.result = { ok: false, status: 'cancelled', errorType: 'cancelled', message: '用户取消，确认未发送', attemptedAt: this.now() };
        changed = true;
      } else if (t.status === 'in_flight') {
        t.status = 'unknown_outcome';
        t.revocationRequested = true;
        t.skipReason = '请求可能已发送（结果未知），已请求人工核对';
        await this.recordUnknown(t, 'cancel_in_flight', w);
        changed = true;
      }
    }
    if (changed) {
      await this.persist(w);
      this.emitState();
    }
  }

  /**
   * P0-5：统一撤权流程。
   * epoch++；queued → cancelled（记录具体原因）；in_flight → unknown_outcome
   * **先写持久证据再清理**；可选暂停/清空；落盘后才返回。
   * P1-6（v0.1.6）：**epoch 先落盘**（安全性关键）——即使后续任务落盘失败，
   * 重启后 queued 任务也会因 epoch 不匹配被 skipped（绝不派发）；
   * epoch 落盘自身失败 → 回滚内存 epoch 并显式失败（不留下「内存已撤权、存储未撤权」）。
   */
  async revoke(reason: string, opts: RevokeOptions = {}, writer?: QueueWriter): Promise<void> {
    const w = writer ?? this.deps.writer;
    // P1-6：先落盘 epoch（撤权语义的持久锚点）
    this.control.authorizationEpoch += 1;
    try {
      await w.saveControl(this.control);
    } catch (e) {
      // 回滚内存 epoch（存储仍为旧值），显式失败；调用方不得继续
      this.control.authorizationEpoch -= 1;
      const msg = `撤权 epoch 持久化失败（已回滚）：${e instanceof Error ? e.message : String(e)}`;
      this.lastError = msg;
      throw new Error(msg);
    }
    let changed = false;
    for (const t of this.tasks) {
      if (!this.inRevokeScope(t, opts)) continue;
      if (t.status === 'queued') {
        t.status = 'cancelled';
        t.skipReason = reason;
        t.result = { ok: false, status: 'cancelled', errorType: 'cancelled', message: reason, attemptedAt: this.now() };
        changed = true;
      } else if (t.status === 'in_flight') {
        t.status = 'unknown_outcome';
        t.revocationRequested = true;
        t.skipReason = `${reason}（请求可能已发送，结果未知，请人工核对）`;
        await this.recordUnknown(t, opts.cause ?? 'revoke', w);
        changed = true;
      }
    }
    if (opts.clearQueue) {
      // P0-4：只清空普通任务；unknown_outcome 任务保留（终态证据，TTL 清理）
      this.generation += 1;
      this.tasks = this.tasks.filter((t) => t.status === 'unknown_outcome');
      this.control.recentAttempts = { block: [], report: [], unblock: [] };
    }
    if (opts.pause) {
      this.control.paused = true;
      this.control.pauseReason = reason;
      this.control.pauseKind = opts.pauseKind ?? 'authorization_revoked';
      this.control.pausedAt = this.now();
      this.control.requiresExplicitResume = true;
    }
    // P1-6：任务状态落盘（epoch 已安全持久化；失败时内存/存储可能不一致，
    // 但重启后 queued 任务因 epoch 不匹配被 skipped，绝不派发）→ 显式失败并记录
    try {
      // 落盘（先于调用方返回；clearQueue 后只写 unknown 证据任务，旧任务不复活）
      await this.persist(w);
      await w.saveControl(this.control);
    } catch (e) {
      const msg = `撤权任务落盘失败（epoch 已安全持久化，重启后旧任务将 skipped）：${e instanceof Error ? e.message : String(e)}`;
      this.lastError = msg;
      throw new Error(msg);
    }
    if (changed) this.emitState();
  }

  /**
   * P0-4（v0.1.4）：把 in_flight 任务批量转为 unknown_outcome 并写入持久证据
   * （reset/clear 原子快照流程调用；返回后调用方清空队列）。
   */
  async markInFlightUnknown(cause: UnknownOutcomeRecord['cause'], writer?: QueueWriter): Promise<void> {
    const w = writer ?? this.deps.writer;
    for (const t of this.tasks) {
      if (t.status !== 'in_flight') continue;
      t.status = 'unknown_outcome';
      t.revocationRequested = true;
      t.skipReason = t.skipReason ?? `${cause === 'reset' ? '重置' : '清空'}（请求可能已发送，结果未知，请人工核对）`;
      await this.recordUnknown(t, cause, w);
    }
  }

  /** P0-4：写入不可逆操作「结果未知」持久证据（幂等 upsert；同一 task 只记一次） */
  private async recordUnknown(t: ActionTask, cause: UnknownOutcomeRecord['cause'], writer?: QueueWriter): Promise<void> {
    const w = writer ?? this.deps.writer;
    const record: UnknownOutcomeRecord = {
      taskId: t.id,
      groupId: t.groupId,
      type: t.type,
      uid: t.uid,
      contentId: t.contentId,
      reasonId: t.reasonId,
      dispatchedAt: t.status === 'unknown_outcome' ? t.createdAt : undefined,
      markedAt: this.now(),
      cause,
    };
    await w.recordUnknownOutcome(record);
  }

  private inRevokeScope(t: ActionTask, opts: RevokeOptions): boolean {
    if (opts.reportOnly && t.type !== 'report') return false;
    if (opts.autoOnly && t.source !== 'auto_process') return false;
    return true;
  }

  /** reset/clear 后同步内存控制状态（storage 已重置为默认）——已由 adoptControl 取代，保留兼容 */
  resetToDefaults(): void {
    this.tasks.length = 0;
    this.generation += 1;
    this.control = { ...DEFAULT_QUEUE_CONTROL };
  }

  /**
   * 恢复前重新验证全部 queued 任务（不满足当前授权/能力/理由 → skipped）。
   * P0-2（v0.1.5）：基于快照计算，不改动内部数组，由调用方决定 adopt/persist。
   * 复验（阶段 E 第二轮）：applyTasksIfChanged 改为**按 id 就地合并**——
   * 只对「当前仍 queued」的任务应用验证结果；已被 pump 拿走（in_flight）
   * 或已确立终态的任务绝不被旧快照回退；runTask 持有的对象引用保持有效。
   */
  async revalidateQueued(reason: string, writer?: QueueWriter): Promise<void> {
    const w = writer ?? this.deps.writer;
    const next = await this.buildRevalidated(reason, undefined);
    const changed = this.applyTasksIfChanged(next);
    if (changed) {
      await this.persist(w);
      this.emitState();
    }
  }

  /**
   * P1-1（v0.1.5）：重验 queued 任务（可选 controlOverride——恢复时忽略「正在解除的
   * 这一个 pause」，但总开关/epoch/capability/理由/白名单仍校验）。
   * 返回更新后的任务快照，不修改内部数组、不持久化。
   */
  private async buildRevalidated(
    reason: string,
    controlOverride: QueueControlState | undefined,
  ): Promise<ActionTask[]> {
    const tasks = this.pendingTasks();
    for (const t of tasks) {
      if (t.status !== 'queued') continue;
      const v = await this.verifyTaskEligible(t, controlOverride);
      if (!v.ok) {
        t.status = 'skipped';
        t.skipReason = `${reason}：${v.reason}`;
        t.result = {
          ok: false,
          status: 'skipped',
          errorType: 'authorization_changed',
          message: t.skipReason,
          attemptedAt: this.now(),
        };
      }
    }
    return tasks;
  }

  /**
   * 复验（阶段 E 第二轮 / P0-2）：按 id 就地合并 revalidate 结果。
   * - 只把「当前仍 queued」的任务应用 next 中的验证结果（queued→skipped）；
   * - 当前已是 in_flight（pump/runTask 正在执行）或终态/取消的任务**绝不被回退**；
   * - 就地修改 this.tasks 对象（不整体替换数组），进行中 runTask 的引用保持有效，
   *   其结果仍能正确写回；新创建任务只由 commitAction/enqueue 追加。
   * 返回是否存在实际变化。
   */
  private applyTasksIfChanged(next: ActionTask[]): boolean {
    const nextById = new Map(next.map((t) => [t.id, t]));
    let changed = false;
    for (const cur of this.tasks) {
      const n = nextById.get(cur.id);
      if (!n) continue;
      // 已被 pump 拿走或已确立终态：绝不用旧快照覆盖
      if (cur.status !== 'queued') continue;
      if (n.status !== 'queued' || n.skipReason !== cur.skipReason) {
        cur.status = n.status;
        cur.skipReason = n.skipReason;
        cur.result = n.result;
        changed = true;
      }
    }
    return changed;
  }

  // ---------------- P0-3（v0.1.5）：暂停/恢复（crash-safe） ----------------

  /**
   * P0-3（v0.1.5）：暂停队列（crash-safe）。
   * - 风控响应一出现 → 立即内存 fail-closed（paused=true）并停止 pump/新任务创建；
   * - 先设置安全 latch（fail-closed，覆盖 SW 重启），再写 local control；
   * - local 写成功前不得报告「已持久化」；local 写失败 → 保持 latch、有限重试、**reject**；
   * - 调用者（background/UI）收到显式失败，绝无静默成功。
   * 复验（阶段 E 第二轮）：
   * - 相同原因 pause 在持久化未完成时**不得早退 return**（早退会假装已持久化）；
   * - retry 走公共 writer（锁外排队重新抢锁），绝不携带锁内 scoped writer 逃逸。
   */
  async pause(
    reason: string,
    kind: PauseKind = 'user',
    requiresExplicitResume = false,
    writer?: QueueWriter,
  ): Promise<void> {
    const w = writer ?? this.deps.writer;
    // 复验：相同原因早退仅当「本次暂停已持久化成功」才允许；
    // 若上次持久化失败（pausePersistPending）仍在重试窗口内，必须重新尝试（否则静默假装成功）
    if (
      this.control.paused &&
      this.control.pauseReason === reason &&
      this.control.pauseKind === kind &&
      !this.pausePersistPending
    ) {
      return;
    }

    // 1) 内存 fail-closed（立即生效：pump 循环与 commitAction 都检查 control.paused）
    this.control.paused = true;
    this.control.pauseReason = reason;
    this.control.pauseKind = kind;
    this.control.pausedAt = this.now();
    this.control.requiresExplicitResume = requiresExplicitResume;
    this.emitState();

    // 2) 安全 latch（先于 local 写；session 覆盖 SW 重启；持久通道覆盖浏览器完全重启）
    // E2-P0-3A（复验第三轮）：latch.set() 失败**不阻断** local control 写入——
    // control(paused:true) 本身就是跨浏览器重启的持久证据；latch 只是增强层。
    // 若 latch 失败，先记录并继续写 control；control 成功则跨重启 fail-closed 已保证，
    // 但 pause 仍须显式失败（安全锁不完整，调用者需知情）。
    let latchFailed: unknown = undefined;
    if (this.deps.latch) {
      try {
        await this.deps.latch.set();
      } catch (e) {
        latchFailed = e;
        this.lastError = `安全暂停锁设置失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // 3) local 持久化（即使 latch 失败也必须执行——它是跨浏览器重启的真正持久证据）
    this.pausePersistPending = true;
    try {
      await w.saveControl(this.control);
      this.pausePersistPending = false;
    } catch (e) {
      // local 写失败：保持 latch；安排有限重试（经公共 writer 排队，绝不逃逸 scoped writer）；显式失败（reject）
      const msg = `暂停状态持久化失败：${e instanceof Error ? e.message : String(e)}`;
      this.lastError = msg;
      this.schedulePauseRetry();
      throw new Error(msg);
    }
    // 成功：不自动清除 latch（直到用户显式 resume 才清除）。
    // E2-P0-3A：control 已持久化（跨重启 fail-closed 有保证），但 latch 曾失败 → 仍显式失败
    if (latchFailed !== undefined) {
      throw new Error(this.lastError);
    }
  }

  /**
   * P0-3（复验）：local 写失败后的有限重试。
   * **必须经公共 writer（this.deps.writer → coordinator.execute 排队重新抢锁）**——
   * 绝不使用调用 pause() 时传入的锁内 scoped writer（定时器逃逸会绕过 globalWriteMutex，
   * 与另一条 execute 的 backend.set 重叠 → maxActive=2）。
   * 成功后复位 pauseRetryTimer（允许后续新的 pause 失败再次安排 retry）。
   * E2-P0-3B（复验第三轮）：**重试耗尽 ≠ 持久化成功**——耗尽分支保持
   * pausePersistPending=true（相同原因 pause 不得早退），只有 saveControl 真正成功
   * 或队列已恢复（resume）才清 pending。
   */
  private schedulePauseRetry(): void {
    if (this.pauseRetryTimer) return;
    let attempt = 0;
    const tryWrite = async (): Promise<void> => {
      if (attempt >= PAUSE_RETRY.MAX_ATTEMPTS) {
        // E2-P0-3B：重试次数耗尽 ≠ 已持久化成功 → 保持 pausePersistPending=true
        //（相同原因 pause 不得早退静默成功）；仅复位 timer 允许后续新 pause 再安排重试
        this.pauseRetryTimer = null;
        return;
      }
      if (!this.control.paused) {
        // 已恢复（resume/清除）：持久化意图已放弃，允许后续新 pause
        this.pauseRetryTimer = null;
        this.pausePersistPending = false;
        return;
      }
      attempt++;
      try {
        await this.deps.writer.saveControl(this.control);
        this.lastError = undefined; // 重试成功：持久化完成（latch 保持，直到用户显式恢复）
        this.pausePersistPending = false;
        this.pauseRetryTimer = null; // 复位：后续新的 pause 失败仍能再次安排
      } catch {
        this.pauseRetryTimer = setTimeout(() => void tryWrite(), PAUSE_RETRY.BASE_DELAY_MS * attempt);
      }
    };
    this.pauseRetryTimer = setTimeout(() => void tryWrite(), PAUSE_RETRY.BASE_DELAY_MS);
  }

  /**
   * P1-1（v0.1.5）：恢复队列（保留合法 queued 任务）。
   * - risk_control / authorization_revoked：只能用户显式恢复（mode='user'）；
   * - 重验时使用 candidateControl（paused:false）——忽略正在解除的这一个 pause；
   * - 合法任务继续 queued 并执行恰好一次；无效任务因真实失效原因转 skipped；
   * - 队列与 control 经 saveQueueSnapshot **一次原子落盘**（writer 支持时）；
   * - 成功后才清除安全 latch（证明上次暂停已安全清除）。
   */
  async resume(mode: 'user' | 'login_restored', writer?: QueueWriter): Promise<void> {
    const w = writer ?? this.deps.writer;
    if (!this.control.paused) return;
    const kind = this.control.pauseKind;
    if ((kind === 'risk_control' || kind === 'authorization_revoked') && mode !== 'user') {
      return; // 仅用户显式恢复
    }
    // P1-1：恢复时忽略「正在解除的 pause」，其余条件全部保留
    const candidateControl: QueueControlState = {
      ...this.control,
      paused: false,
      pauseReason: null,
      pauseKind: 'none',
      pausedAt: null,
      requiresExplicitResume: false,
    };
    const updatedTasks = await this.buildRevalidated('恢复前重新验证', candidateControl);
    // 复验（P0-2）：resume 与 revalidate 同族——buildRevalidated 的旧克隆跨 await 期间
    // pump 可能已把任务改为 in_flight；**合并式**应用（只改当前仍 queued 的任务），
    // 绝不用旧克隆全量替换把 in_flight 回退成 queued。
    this.applyTasksIfChanged(updatedTasks);
    const mergedTasks = this.pendingTasks(); // 合并后的最新快照（含 runTask 已推进的 in_flight）
    // 一次原子落盘（tasks + control）
    if (w.saveQueueSnapshot) {
      await w.saveQueueSnapshot(mergedTasks, candidateControl);
    } else {
      await w.saveTasks(mergedTasks);
      await w.saveControl(candidateControl);
    }
    // backend 成功后 adopt（P0-2）；mergedTasks 与内存一致
    this.adoptTasks(mergedTasks);
    this.control = candidateControl;
    this.pausePersistPending = false;
    // 成功恢复 → 清除安全 latch（证明暂停已安全清除）
    if (this.deps.latch) {
      try {
        await this.deps.latch.clear();
      } catch {
        // latch 清除失败：不阻塞恢复，但记录（用户已显式恢复，逻辑上已解除）
        this.lastError = '安全暂停锁清除失败（session 可能不可用）';
      }
    }
    this.emitState();
    void this.pump();
  }

  getStatus(): QueueStatus {
    return {
      running: this.pumping,
      paused: this.control.paused,
      pausedReason: this.control.pauseReason ?? undefined,
      pauseKind: this.control.pauseKind,
      authorizationEpoch: this.control.authorizationEpoch,
      queued: this.tasks.filter((t) => t.status === 'queued').length,
      inFlight: this.tasks.filter((t) => t.status === 'in_flight').length,
      lastError: this.lastError,
    };
  }

  /** 当前活动任务数（测试/监控用） */
  getActiveTaskCount(): number {
    return this.tasks.filter((t) => t.status === 'queued' || t.status === 'in_flight').length;
  }

  // ---------------- 队列泵 ----------------

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.tasks.some((t) => t.status === 'queued') && !this.control.paused) {
        const due = this.tasks
          .filter((t) => t.status === 'queued' && t.nextAttemptAt <= this.now())
          .sort((a, b) => a.createdAt - b.createdAt);
        if (due.length === 0) {
          if (this.tasks.some((t) => t.status === 'queued')) {
            const earliest = Math.min(
              ...this.tasks.filter((t) => t.status === 'queued').map((t) => t.nextAttemptAt),
            );
            await new Promise((r) => setTimeout(r, Math.min(30_000, Math.max(250, earliest - this.now()))));
            continue;
          }
          break;
        }
        const types: TaskType[] = ['block', 'report', 'unblock'];
        for (const type of types) {
          const task = due.find((t) => t.type === type);
          if (task && this.allowRate(type)) {
            await this.runTask(task);
            if (this.control.paused) break;
          }
        }
        if (this.control.paused) break;
      }
    } finally {
      this.pumping = false;
    }
  }

  private allowRate(type: TaskType): boolean {
    if (type === 'block') return this.allowBucket('block', QUEUE.MAX_BLOCK_PER_MINUTE);
    if (type === 'report') return this.allowBucket('report', QUEUE.MAX_REPORT_PER_MINUTE);
    return true;
  }

  /** 速率预算：基于持久化 recentAttempts（跨 SW 重启恢复） */
  private allowBucket(type: 'block' | 'report', maxPerMinute: number): boolean {
    const now = this.now();
    const bucket = this.control.recentAttempts[type].filter((ts) => now - ts < 60_000);
    this.control.recentAttempts[type] = bucket;
    if (bucket.length >= maxPerMinute) {
      const delay = 60_000 - (now - bucket[0]!);
      this.deferEarliest(type, delay);
      return false;
    }
    return true;
  }

  private deferEarliest(type: TaskType, delayMs: number): void {
    const task = this.tasks
      .filter((t) => t.type === type && t.status === 'queued')
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0];
    if (task) task.nextAttemptAt = this.now() + delayMs;
  }

  /**
   * P0-2（v0.1.4）：派发前逐项重新验证（统一门禁）。
   * P1-1（v0.1.5）：可选 controlOverride——resume 重验时忽略「正在解除的 pause」，
   * 但总开关、epoch、settings revision、白名单、capability、理由等全部保留校验。
   * P0-5（v0.1.6）：**epoch 比较置于所有 await 之后（check-latest-again）**——
   * 返回前用锁内最新 control（repo.getQueueControl()）重新比较 task.authorization.epoch，
   * 消除跨 await 陈旧结论（revoke/cancel 在 verify 挂起窗口内发生也能被捕获）。
   * 顺序：暂停（可忽略）→ 总开关 → auto_process 来源开关 → authorization 必填 →
   * 远端状态读取（settingsRevision/whitelist，统一 await 段）→ 同步校验（revision/白名单/
   * 能力键/类型能力/理由）→ **末尾重读 epoch**。
   */
  private async verifyTaskEligible(
    task: ActionTask,
    controlOverride?: QueueControlState,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const control = controlOverride ?? this.control;
    if (control.paused) {
      return { ok: false, reason: `队列已暂停（${control.pauseReason ?? ''}）` };
    }
    const settings = await this.deps.repo.getSettings();
    if (!settings.enabled) return { ok: false, reason: '总开关已关闭' };
    // P0-2：auto_process 开关必须位于所有任务类型成功返回之前
    if (task.source === 'auto_process') {
      if (!settings.autoProcessVerified) {
        return { ok: false, reason: '自动处理已关闭' };
      }
      if (task.authorization?.autoProcessAuthorized !== true) {
        return { ok: false, reason: '任务授权快照未开启自动处理' };
      }
    }
    // P0-2：官方任务必须携带完整授权快照（缺失 → 绝不直接派发）
    if (!task.authorization) {
      return { ok: false, reason: '任务缺少授权快照' };
    }
    // 早期 epoch 检查（入口时基于内存 control）：保持「epoch 失效」的报错优先级
    // （能力/理由等后续检查不掩盖撤权事实）；跨 await 的陈旧窗口由函数**末尾**
    // 的 check-latest-again（P0-5）以锁内最新 control 兜底。
    if (task.authorization.epoch !== control.authorizationEpoch) {
      return { ok: false, reason: '授权状态已变化（epoch 不匹配），旧任务不再执行' };
    }
    // 远端状态统一读取（一个 await 段；epoch 检查不在此处——见函数末尾）
    const [currentRevision, whitelist] = await Promise.all([
      this.deps.repo.getSettingsRevision(),
      this.deps.repo.getWhitelist(),
    ]);
    // settings revision 不一致 → 按安全策略跳过（重新验证当前设置后仍需全项通过）
    if (task.authorization.settingsRevision !== currentRevision) {
      return { ok: false, reason: '设置已变化（revision 不匹配），旧任务不再执行' };
    }
    if (whitelist.some((w) => w.uid === task.uid)) {
      return { ok: false, reason: '账号已加入白名单' };
    }
    // 能力键与快照一致性（block/unblock/report 各自独立）
    const expectedKey = capabilityForTaskType(task.type, task.contentType);
    if (task.authorization.capabilityKey !== expectedKey) {
      return { ok: false, reason: `任务授权能力键不匹配（快照=${task.authorization.capabilityKey}，期望=${expectedKey}）` };
    }
    if (task.type === 'block') {
      if (!isCapabilityEnabled('blockUser')) return { ok: false, reason: '官方拉黑能力未验证' };
    } else if (task.type === 'unblock') {
      if (!isCapabilityEnabled('unblockUser')) return { ok: false, reason: '解除拉黑能力未验证' };
    } else if (task.type === 'report') {
      if (!settings.autoReportAuthorized) return { ok: false, reason: '自动举报授权已撤销' };
      if (task.authorization.reportAuthorized !== true) {
        return { ok: false, reason: '任务授权快照未授权举报' };
      }
      if (task.contentType === undefined) return { ok: false, reason: '任务缺少内容类型' };
      // canReportContentType 已包含：能力验证 ∧ REPORT_REASONS.verified（生产）；
      // E2E/Mock 构建整体放行（编译隔离）
      if (!canReportContentType(task.contentType)) {
        return { ok: false, reason: `举报能力/内容类型未验证（${task.contentType}）` };
      }
      if (task.reasonId === undefined || !isValidReason(task.contentType, task.reasonId)) {
        return { ok: false, reason: '举报理由已失效' };
      }
      if (resolveDefaultReason(task.contentType, settings.defaultReportReason) === null) {
        return { ok: false, reason: '当前默认举报理由无效' };
      }
    } else {
      return { ok: false, reason: '未知任务类型' };
    }
    // P0-5（v0.1.6）：check-latest-again——epoch 比较置于所有 await 之后，
    // 用「锁内最新」control（存储中的当前值）重新比较 authorization.epoch：
    // revoke/恢复在 verify 挂起窗口内完成时，此处必然读到新 epoch → 结论不再陈旧。
    const latestControl = await this.deps.repo.getQueueControl();
    if (task.authorization.epoch !== latestControl.authorizationEpoch) {
      return { ok: false, reason: '授权状态已变化（epoch 不匹配），旧任务不再执行' };
    }
    return { ok: true };
  }

  private async runTask(task: ActionTask): Promise<void> {
    const gen = this.generation;

    // P0-5：派发前重新验证（不满足 → skipped，executor 不被调用）
    const verdict = await this.verifyTaskEligible(task);
    if (!verdict.ok) {
      // P0-5 竞态保护：验证期间任务可能已被撤权取消（queued→cancelled）
      // 或标记撤销（in_flight→revocationRequested）；不得用 skipped 覆盖已确立的终态
      if (task.status === 'cancelled' || task.revocationRequested) {
        return;
      }
      task.status = 'skipped';
      task.skipReason = verdict.reason;
      task.result = {
        ok: false,
        status: 'skipped',
        errorType: 'authorization_changed',
        message: verdict.reason,
        attemptedAt: this.now(),
      };
      await this.persistIfCurrentSafe(gen, task);
      this.emitState();
      this.deps.onTaskDone?.(task);
      return;
    }

    // P0-5（v0.1.6）：**派发前二次确认**——verify 结论跨多个 await 已过期，
    // 窗口内 revoke/cancel/reset 可能已把任务改写为 cancelled（或 in_flight 标记了
    // revocationRequested）。此时绝不派发，保留已确立的终态（executor 调用恒为 0）。
    // P0-5b（v0.1.7）：revoke 的 epoch+1 是**同步内存**修改（先于 saveControl await）；
    // 存储写 in-flight 期间 verify 的 check-latest-again 读 cache（仍旧 epoch）会返回 ok，
    // 而 revoke 的 queued→cancelled 循环在 saveControl await **之后**才执行——任务仍 queued。
    // 必须一并比较**内存 epoch**（revoke 同步先改，必然捕获该子窗口），否则 executor 仍被调用。
    if (
      task.status !== 'queued' ||
      task.revocationRequested ||
      task.authorization?.epoch !== this.control.authorizationEpoch
    ) {
      return;
    }

    task.status = 'in_flight';
    task.attempts += 1;
    // P0-5：每次实际发送尝试先持久化（crash-safe 速率预算；发送前记录）
    this.control.recentAttempts[task.type].push(this.now());
    // P1-5（v0.1.6）：派发前持久化失败不得产生 unhandled rejection / orphaned promise；
    // 任务转 failed 并记录 lastError（executor 尚未被调用，无副作用）。
    try {
      await this.deps.writer.saveControl(this.control);
      await this.persistIfCurrent(gen);
    } catch (e) {
      task.status = 'failed';
      const msg = `派发前持久化失败（executor 未调用）：${e instanceof Error ? e.message : String(e)}`;
      this.lastError = msg;
      task.result = {
        ok: false,
        status: 'failed',
        errorType: 'unknown',
        message: msg,
        attemptedAt: this.now(),
      };
      this.emitState();
      this.deps.onTaskDone?.(task);
      return;
    }
    this.emitState();

    let result: TaskResult;
    try {
      result = await this.deps.executor.execute(task);
    } catch (e) {
      result = {
        ok: false,
        status: 'executor_error',
        errorType: 'unknown',
        message: e instanceof Error ? e.message : String(e),
        attemptedAt: this.now(),
      };
    }
    result.attemptedAt = this.now();

    // 队列被清空/reset（代际变化）：丢弃结果，不把旧任务写回存储
    if (gen !== this.generation) return;

    // P0-3：撤权/取消已请求 → 保留真实结果，终态 unknown_outcome，绝不自动重发
    if (task.revocationRequested) {
      task.result = result;
      task.status = 'unknown_outcome';
      task.skipReason = task.skipReason ?? '请求可能已发送（结果未知），已请求人工核对';
      await this.persistIfCurrent(gen);
      this.emitState();
      this.deps.onTaskDone?.(task);
      return;
    }

    task.result = result;

    if (result.ok) {
      task.status = 'succeeded';
      if (task.type === 'block') await this.deps.dedup.markBlocked(task.uid);
      if (task.type === 'report' && task.contentId && task.reasonId !== undefined) {
        await this.deps.dedup.markReported(
          task.uid,
          task.contentType ?? 'video_comment',
          task.contentId,
          task.reasonId,
        );
      }
    } else if (result.errorType === 'network' && task.attempts < task.maxAttempts) {
      task.status = 'queued';
      task.nextAttemptAt = this.now() + QUEUE.BACKOFF_BASE_MS * Math.pow(2, Math.min(task.attempts - 1, 4));
    } else if (result.errorType === 'login_invalid') {
      // P0-3（v0.1.5）：必须 await pause；持久化失败时 fail-closed 但任务已进入终态
      task.status = 'failed';
      try {
        await this.pause('登录状态已失效，请重新登录 Bilibili 后继续', 'login');
      } catch {
        // 已内存 fail-closed（paused=true + latch），不阻塞任务状态机
      }
    } else if (result.errorType === 'risk_control') {
      // P0-3（v0.1.5）：必须 await pause；risk_control 仅用户显式恢复
      task.status = 'failed';
      try {
        await this.pause('检测到验证码/风控，已暂停自动操作，请手动处理', 'risk_control', true);
      } catch {
        // 已内存 fail-closed（paused=true + latch），不阻塞任务状态机
      }
    } else if (result.errorType === 'duplicate') {
      task.status = 'succeeded';
      if (task.type === 'block') await this.deps.dedup.markBlocked(task.uid);
      if (task.type === 'report' && task.contentId && task.reasonId !== undefined) {
        await this.deps.dedup.markReported(
          task.uid,
          task.contentType ?? 'video_comment',
          task.contentId,
          task.reasonId,
        );
      }
    } else if (result.errorType === 'invalid_reason') {
      task.status = 'failed';
      this.lastError = '举报理由已失效，请在设置页重新选择';
    } else {
      task.status = 'failed';
      this.lastError = result.message ?? result.status;
    }

    // P1-5（v0.1.6）：结果持久化失败 → 任务转 failed 并记录（不产生 unhandled rejection）
    await this.persistIfCurrentSafe(gen, task);
    this.emitState();
    // onTaskDone 只在终态或 unknown_outcome 调用一次（网络重试中间态不触发）
    if (isTerminalStatus(task.status)) {
      this.deps.onTaskDone?.(task);
    }
  }

  /**
   * P1-5（v0.1.6）：runTask 内安全持久化——捕获写异常，任务转 failed 并记录 lastError，
   * 绝不产生 unhandled rejection / orphaned promise（任务卡内存 in_flight、存储 queued）。
   * 幂等：任务已是终态/异常已记录时保持现状。
   */
  private async persistIfCurrentSafe(gen: number, task: ActionTask): Promise<void> {
    try {
      await this.persistIfCurrent(gen);
    } catch (e) {
      const msg = `任务持久化失败：${e instanceof Error ? e.message : String(e)}`;
      this.lastError = msg;
      if (!isTerminalStatus(task.status) && task.status !== 'queued') {
        task.status = 'failed';
        task.result = {
          ok: false,
          status: 'failed',
          errorType: 'unknown',
          message: msg,
          attemptedAt: this.now(),
        };
      }
    }
  }

  /**
   * 终态任务 TTL 清理（P1-6/P0-3）：succeeded/failed/cancelled/skipped/unknown_outcome
   * 超过 TTL 从活动队列移除（TTL 内保留供审计）。与持久化一致。
   */
  private pruneTerminal(tasks: ActionTask[]): void {
    const now = this.now();
    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i]!;
      if (isTerminalStatus(t.status)) {
        if (now - (t.result?.attemptedAt ?? t.nextAttemptAt) > QUEUE.TERMINAL_TTL_MS) {
          tasks.splice(i, 1);
        }
      }
    }
  }

  private async persistIfCurrent(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    await this.persist();
  }

  private async persist(writer?: QueueWriter): Promise<void> {
    const w = writer ?? this.deps.writer;
    this.pruneTerminal(this.tasks);
    await w.saveTasks(this.pendingTasks());
  }

  private emitState(): void {
    this.deps.onQueueStateChange?.(this.getStatus());
  }
}

/** P0-2（v0.1.4）：快照按任务类型适配（block/unblock/report 各自 capabilityKey/reasonId） */
function adaptAuthorizationForTask(base: AuthorizationSnapshot, input: TaskInput): AuthorizationSnapshot {
  const capabilityKey: CapabilityKeyName | null = capabilityForTaskType(input.type, input.contentType);
  return {
    ...base,
    capabilityKey,
    reasonId: input.type === 'report' ? (input.reasonId ?? base.reasonId) : null,
    contentType: input.contentType ?? base.contentType,
  };
}

/**
 * P0-5（v0.1.4）：「能否创建官方任务」统一策略（commitAction 与 enqueue 共用，
 * 避免「能否创建」与「能否派发」两套逻辑漂移）。
 */
export function canEnqueueOfficialTask(control: QueueControlState): boolean {
  if (!control.paused) return true;
  return (
    control.pauseKind !== 'risk_control' &&
    control.pauseKind !== 'authorization_revoked' &&
    !control.requiresExplicitResume
  );
}

/** 终态判定（P0-3）：终态或 unknown_outcome 才触发 onTaskDone / TTL 清理 */
export function isTerminalStatus(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'skipped' ||
    status === 'unknown_outcome'
  );
}

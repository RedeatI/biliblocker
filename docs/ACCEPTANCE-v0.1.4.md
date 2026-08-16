# BiliBlocker v0.1.4 阶段 E 复验缺陷基线（ACCEPTANCE）

> 本文件将 v0.1.4 阶段 E 独立复验发现的缺陷**冻结为唯一基线**。
> v0.1.5 的每一项修复必须能追溯到下列缺陷条目；新增回归测试必须在 v0.1.4 代码上稳定失败（red），
> 并保存完整 red log 后才能在 v0.1.5 上转绿。
> 冻结时间：2026-08-14。证据来源：`BiliBlocker-v0.1.4-阶段E复验报告.md`、
> `BiliBlocker-v0.1.4-阶段E独立证据.json`。

## 0. 复验结论

- 复验判定：**阶段 E 不通过**；阶段 F 禁止开始；商店提交禁止。
- 发布工程完整性/关闭态产物洁净性**通过**（三份 ZIP 哈希、Source ZIP 180 文件逐文件一致、
  manifest 洁净、能力全 false、十步日志全绿）。
- 核心写锁作用域与存储安全集成**不通过**：6 个可复现缺陷（3 个 P0 + 3 个 P1）。

## 1. P0 缺陷（必须关闭）

### P0-1 实例级 `currentLease` 重新引入异步锁继承

- 位置：`src/storage/coordinator.ts` `private currentLease: WriteLease | null`，
  `execute()` 内 `this.currentLease = lease`，`writeQueue()` 内 `if (this.currentLease) return repo.saveQueueTasks(...)`。
- 问题：lease 被保存在**整个协调器实例共享的可变字段**中，而非沿同一词法调用链显式传递。
  当某条 `execute()` 在 backend `await` 时，任何无关异步来源（ActionQueue pump、alarm kick、
  已派发任务返回、pause/retry/dedup 回调、commitAction 内 queue.kick 启动的异步泵）调用
  `coordinator.writer`，都会看到另一条请求遗留的 `currentLease`，误以为自己处于锁内直接写 Storage。
- 探针复现：`{maxActive:2, overlapBeforeRelease:2}`，事件 `start:bb.blocked → start:bb.queue → end:bb.queue → end:bb.blocked`，
  两个 backend 写同时活跃，直接否定「最大活跃写入数=1」。
- 修复方向（二选一）：
  - 方案 A：词法作用域 ScopedWriter——`repo.withGlobalWrite(async (lease) => { const writer = coordinator.writerFor(lease); return executeInner(command, { lease, writer }); })`；
    `writerFor(lease)` 只在当前调用栈内创建；queue/revoke/reset 等锁内操作显式接收 scoped writer；
    外部 `coordinator.writer` 永远走公共 execute/全局队列；不把 lease 保存到 coordinator/queue 单例字段。
  - 方案 B：ActionQueue 纯状态计划——ActionQueue 只计算 `QueueMutationPlan`；coordinator 在锁内
    读取最新快照、应用 plan、一次 commit；pump 完成结果也通过独立 coordinator command 排队；
    queue 不直接持有可写 Repository。
- 无论哪种方案都必须保证：lease 所有权能区分调用链（而非只区分时间窗口）；
  外部异步回调永远不能继承正在运行请求的 lease；stale snapshot 不能覆盖更新后的 queue/control/dedup。
- 回归测试：**外部 QueueWriter 不得继承其他调用的 lease**（第一条公共 execute 在 backend.set 内等待，
  等待期间从无关异步调用直接执行 `coordinator.writer.saveTasks()`；断言最大活跃 backend 写恒为 1、
  QueueWriter 调用不能利用另一条命令的 lease、两次外部调用都能追溯到独立锁所有权、
  不存在实例级 `currentLease`/`inLock` 或其他共享「已持锁」布尔/对象）。

### P0-2 锁绕过可实际丢失队列任务并回退状态（stale snapshot 覆盖）

- 位置：`src/storage/coordinator.ts:504-528`（commitAction 使用 `this.queue?.pendingTasks()` 旧快照
  构造 items 后跨 `backend.set` await）。
- 问题：`commitAction` 读取旧队列并准备原子快照，在其 backend 写被延迟期间，外部 QueueWriter
  保存更新后的队列（`existing→in_flight` + 新增 `concurrent`）；延迟的旧快照随后完成，
  旧状态覆盖新状态。
- 探针复现（最终持久化状态）：`[{id:'existing',status:'queued'}, {id:'created',status:'queued'}]`；
  `concurrent` 任务完全丢失；`existing` 从 `in_flight` 回退成 `queued`；SW 恢复时可能把
  已发送的官方请求当未发送任务重新派发（自动举报的重复副作用风险）。
- 修复方向：`bb.queue` 增加 revision（或与全局 revisions 一起原子更新）；
  commitAction/pump/cancel/revoke/pause/retry/task result 都在锁内重新读取最新 queue/control；
  不允许持有旧数组引用后跨 await 覆盖；`pendingTasks()` 不返回可变内部数组
  （至少 structuredClone/readonly 快照）；ActionQueue 内存只在 backend 成功后 adopt 新快照；
  backend 写失败不得提前修改可被其他路径观察的持久语义状态。
- 回归测试：**stale queue snapshot 不得覆盖新状态**（原队列含 `existing:queued`；commitAction
  读取旧队列并等待写入；并发队列状态更新把 `existing→in_flight` 并加入 `concurrent`；释放第一条写；
  断言最终 Storage 中 `existing` 不回退、`concurrent` 不丢失、新创建任务只追加一次、
  已发送任务不会重新变回 queued、SW 重启后不会重复派发）。

### P0-3 pause 持久化失败被吞掉，SW 重启后恢复为未暂停

- 位置：`src/actions/queue.ts:430-443`（pause 内 `try { await saveControl } catch { lastError = ... }` 后
  直接 return）、`src/storage/backend.ts:44-59`（inMemoryBackend 引用共享掩盖失败）。
- 问题：`pause()` 只证明「成功写入时 Promise 会等待」，不能证明「写入失败时 crash-safe」；
  使用 structured-clone backend（模拟真实 `chrome.storage.local`）注入 `saveControl` 失败后，
  调用者未收到失败、内存看似暂停、持久 Storage 仍是未暂停、新 Service Worker 启动后继续未暂停。
- 探针复现：`{pauseRejected:false, q1Memory:{paused:true}, rawAfterFailure:{paused:false}, q2AfterRestart:{paused:false}}`。
- 修复方向：
  1. `pause()` 返回类型显式表达成功/失败（或失败时 reject），不得静默 resolve。
  2. 风控响应一出现立即停止 pump 与新任务创建（fail-closed）。
  3. 在 `bb.queueControl` 之外增加最小安全 latch：`chrome.storage.session` fail-closed latch
     （覆盖 SW 重启）+ `chrome.storage.local` 持久 control。
  4. local 写成功前不得对调用者报告「暂停已持久化」。
  5. local 写失败时保持 session latch，安排有限重试；不得自动恢复。
  6. background 启动时先读取 safety latch，再决定是否 pump。
  7. 浏览器完全重启后若无法证明上次暂停已安全清除，默认 fail-closed，并要求用户显式确认。
  - 若不采用 session storage，必须提出同等级、可运行时验证的跨 SW 方案。
- 回归测试：**pause 写失败 + SW 重启**（structured-clone backend；注入 saveControl 失败；
  断言 pause() 不得静默成功、pump 立即 fail-closed、调用者收到结构化失败、
  持久安全 latch/待确认状态能够被新 Service Worker 读取、SW 重启后不得恢复为 unpaused、
  只有用户显式修复/恢复后才允许继续）。

## 2. P1 缺陷（必须关闭）

### P1-1 resume() 会把全部 queued 任务标记为 skipped（重验顺序错误）

- 位置：`src/actions/queue.ts:452-466`（先 `revalidateQueued(...)` 再 `control.paused = false`）、
  `queue.ts:554-557`（verifyTaskEligible 第一条检查 `if (control.paused) return 队列已暂停`）。
- 问题：`control.paused=true` 时调用普通 `verifyTaskEligible()`，所有 queued 任务被判「队列已暂停」→ skipped；
  「用户显式恢复」实际静默清空可恢复任务。
- 探针复现：`{before:[{id:'resume-task',status:'queued'}], after:[{status:'skipped',skipReason:'恢复前重新验证：队列已暂停（风控）'}], executed:0}`。
- 修复方向：resume 重验时忽略「正在解除的这一个 pause」本身，但总开关、epoch、capability、
  理由、白名单和其他安全条件仍必须校验。可选：
  - `const candidateControl = { ...control, paused: false, ... }` 传给重验（`controlOverride`），或
  - `verifyTaskEligible(task, { ignorePauseReason: currentPauseToken })`。
- 回归测试：**resume 保留合法 queued 任务**（risk-control paused 队列含一条仍合法的 queued 任务 +
  一条能力/epoch/白名单等条件已失效的 queued 任务；断言 `login_restored` 不能恢复 risk-control；
  `user` 恢复后合法任务继续 queued 并执行恰好一次；无效任务才转 skipped；
  skipReason 必须是真实失效原因（不能是「队列已暂停」）；paused/control 与 tasks 最好一次原子落盘）。

### P1-2 测试 Storage 后端不符合 WebExtension structured-clone 语义

- 位置：`src/storage/backend.ts:44-59`（inMemoryBackend 的 get/set 直接保存/返回对象引用）、
  `src/storage/repository.ts:219-230`（read() 返回缓存引用）。
- 问题：修改从 Storage 读取的 control/list 看起来像已持久化；saveControl 失败后测试 backend 内
  对象可能已被引用修改；新建 Repository 仍读到同一被修改引用（pause crash-safe 假阳性）；
  read-only Repository 返回的数组可被调用者直接 push，缓存读取看到变化但底层 Storage 没变。
- 探针复现：`{returnedListLength:1, secondReadLength:1, rawLength:0, readOnlyMutationVisibleInCache:true}`。
- 修复方向：`inMemoryBackend` 的 initial/set 输入 structuredClone、get 输出 structuredClone；
  Repository 的 `read()` 返回 clone 或冻结对象；cache 存储独立 clone；
  lists/settings/control/tasks/rules 不把可变内部引用暴露给调用者；
  read-only 实例不允许通过返回引用改变逻辑视图。
- 回归测试：**Storage structured-clone 与只读边界**（inMemoryBackend 的 initial/set 输入克隆、
  get 输出克隆、修改返回对象不改 store、修改传入 set 的原对象不改 store；
  StorageRepository 的 allowWrites:false 返回的 lists/settings/control/rules/tasks
  不能通过引用修改内部 cache；写失败后 cache 和 backend 均保持旧值；
  新 Repository 读取与真实持久状态一致）。

### P1-3 operationId 结果没有与副作用原子提交

- 位置：`src/storage/coordinator.ts:504-563`（先 commitSnapshot 名单/队列，再单独
  `saveOperationOutcome`；第二次写失败时异常被吞掉并注释「可接受降级」）。
- 问题：成功提交时名单/队列先落盘，operationOutcomes 单独写失败 → 同一 operationId 重放
  不能返回第一次的确定结果；不同 binding 在结果记录缺失窗口内得不到承诺的拒绝；
  「持久幂等结果 + 绑定指纹」不属于同一原子事务。
- 探针复现：`{r1:{localBlockedAdded:true}, r2:{localBlockedAdded:false}, operationOutcomes:{}, sameResult:false}`。
- 修复方向：成功路径的单次 `commitSnapshot` 必须同时包含 blocked/verified delta、queue delta、
  queue revision/control（如有）、`bb.operationOutcomes[operationId]`；不允许
  `commitSnapshot(sideEffects); try { saveOperationOutcome(...) } catch { /* acceptable */ }`；
  验证拒绝类结果（disabled/self/whitelisted/authorization_changed 等）也需要确定的绑定记录；
  若记录失败应返回持久化失败，而非假装幂等承诺已建立；不得用 catch 吞掉 outcome 持久化错误；
  TTL/容量清理仍然有效。
- 回归测试：**operationId 结果必须原子**（注入「主要副作用可以写、operation outcome 单独写失败」
  的旧场景；断言修复后不存在独立 outcome 写窗口：成功结果记录与 blocked/verified/queue
  在同一个 backend.set 中；原子写失败时全部不落盘；响应丢失后相同 operationId 返回完全相同结果；
  不同 binding 复用同一 operationId 必须拒绝；不得用 catch 吞掉 outcome 持久化错误；
  TTL/容量清理仍然有效）。

## 3. 放行条件（完成定义，全部满足才可再次申请阶段 E）

1. 所有真实能力、理由、selectors 仍为 false。
2. 项目中不存在实例级 `currentLease` 或同义共享持锁状态。
3. QueueWriter 与任意 execute 并发时最大活跃 backend 写始终为 1。
4. stale snapshot 探针不丢任务、不回退状态。
5. pause 写失败不会静默成功；SW 重启仍 fail-closed。
6. structured-clone backend 和 Repository 不暴露可变缓存引用。
7. resume 后合法任务执行恰好一次，无效任务只因真实失效原因跳过。
8. operationId 结果与副作用原子提交。
9. 新 runtime evidence 六项 findings 全部 false。
10. v0.1.5 增强 gate PASS。
11. Source ZIP 与工作区逐文件一致，干净重建通过。
12. 全套测试和日志可复验。
13. 阶段 E 独立复验通过前，不开始阶段 F，不提交商店。

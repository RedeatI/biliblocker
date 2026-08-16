# BiliBlocker v0.1.5 整改追溯（REMEDIATION TRACE）

> 本文件在**打包前**冻结，只记录设计/测试/待发布状态；打包后不得修改（source-integrity 全量比较覆盖）。
> 缺陷基线：`docs/ACCEPTANCE-v0.1.4.md`（阶段 E 独立复验 6 项缺陷：3 P0 + 3 P1）。
> 复验基线（阶段 E 第二轮）：独立复验发现 **3 个新 P0 反例**（ScopedWriter timer 逃逸、浏览器完全重启 fail-open、revalidate 与 runTask 并发回退）+ 2 个次级问题。
> 复验基线（阶段 E 第三轮 / E2）：独立复验发现 **2 个 P0-3 边界**（persistent latch set 自身失败后浏览器完全重启仍 fail-open、pause retry 全部耗尽后相同原因 pause 静默成功）。
> 当前状态：v0.1.5 第三轮整改完成，**等待阶段 E 独立复验**；阶段 F 未开始；商店未提交。

## 1. 缺陷 → 修复 → 测试证据映射（第一轮：阶段 E 复验 6 项）

| 缺陷 | 修复（生产代码） | 回归测试（先红后绿） |
|---|---|---|
| P0-1 实例级 currentLease 允许外部 writer 继承 lease | `coordinator.ts`：删除 `currentLease` 实例字段；`execute()` 无条件 `withGlobalWrite(async (lease) => { const scoped = this.writerFor(lease); return this.executeInner(command, scoped); })`；`writerFor(lease)` 仅当前调用栈有效（词法作用域 ScopedWriter）；外部 `coordinator.writer` 每个方法无条件 `this.execute(...)` 排队；queue 的 cancel/revoke/resume/pause/revalidateQueued/markInFlightUnknown 显式接收 scoped writer | `v015-lease-isolation.test.ts`（execute 等待期间外部 writer.saveTasks：maxActive=1、事件严格串行、withGlobalWrite 进入 2 次、无实例级 currentLease/inLock） |
| P0-2 stale queue snapshot 覆盖新状态（丢任务/回退） | `queue.pendingTasks()` 返回 `structuredClone(this.tasks)`（不暴露可变内部数组）；`coordinator.saveQueueTasks`（公共路径）锁内 `mergeQueueTasks(最新持久快照, 传入)`——保留活跃/unknown 任务防旧快照覆盖；`commitAction` 锁内 `getQueueTasks()` 读取最新持久队列再追加 created；队列内存只在 `commitSnapshot` 成功后 adopt | `v015-queue-stale-snapshot.test.ts`（existing 不回退、concurrent 不丢失、created 只追加一次、SW 重启不重复派发、重复 commitAction 幂等） |
| P0-3 pause 持久化失败被吞、SW 重启恢复未暂停 | `queue.pause()`：失败时 `throw`（显式 reject，不静默 resolve）；新增 `src/storage/safety-latch.ts`（`SafetyLatch` 接口 + `chromeStorageSessionLatch` + 内存实现）；pause 先 `latch.set()`（fail-closed，覆盖 SW 重启）再写 local control，local 失败保持 latch + 有限重试（`schedulePauseRetry`，最多 3 次）；`queue.start()` 先读 latch，无法证明清除则强制 fail-closed（paused=true、不 pump）；`resume()` 成功后才 `latch.clear()`；background 注入 session latch | `v015-pause-storage-failure.test.ts`（saveControl 失败 → pause reject、latch 持久、SW 重启 fail-closed、用户显式恢复后才继续；runTask 内风控 pause 失败任务转 failed 且不再派发） |
| P1-1 resume 重验顺序错误（全量 skipped） | `queue.resume()`：构造 `candidateControl = {...control, paused:false,...}`，`buildRevalidated(reason, candidateControl)` 重验（忽略正在解除的这一个 pause，但 epoch/settingsRevision/capability/理由/白名单/总开关仍校验）；tasks 与 control 经 `writer.saveQueueSnapshot(tasks, control)` **一次原子落盘**（新命令 `saveQueueSnapshot`，coordinator 锁内 `commitSnapshot({queue, queueControl})`）；成功后才清 latch 并 pump | `v015-resume-revalidation.test.ts`（risk_control 下 login_restored 不恢复；user 恢复合法任务执行恰好一次、失效任务因真实原因 skipped 且 skipReason 非「队列已暂停」；tasks+control 单次 set 原子） |
| P1-2 测试 Storage 不符合 structured-clone 语义 | `backend.inMemoryBackend`：initial/set 输入 `structuredClone`、get 输出 `structuredClone`（与真实 chrome.storage.local 一致）；`repository.read()` 返回 `structuredClone`、cache 存独立 clone（`write`/`commitSnapshot`/`applyExternalChanges` 均克隆）；`mutateList` 内部 RMW 快速路径（纯函数契约，不克隆缓存引用，避免 O(n²) 克隆退化）——公开读取仍返回克隆 | `v015-storage-clone.test.ts`（initial/set/get 输入输出克隆、修改返回/传入对象不影响 store、写失败 cache+backend 保持旧值、新 Repository 读真实持久状态、read-only 实例无法通过引用改 cache、队列任务读取返回克隆） |
| P1-3 operationId 结果未与副作用原子提交 | `coordinator.commitAction`：成功路径单次 `commitSnapshot(items)` 同时含 blocked/verified delta、queue delta、`bb.operationOutcomes[operationId]`（`nextOutcomesMap`：TTL/容量清理 + 新记录）；拒绝类结果（disabled/self/whitelisted/authorization_changed/缺快照）经 `saveOutcomeAtomic` 写确定绑定记录；写失败 → `storage_failed`（绝不用 catch 吞掉 outcome 错误） | `v015-operation-outcome-atomic.test.ts`（blocked+queue+outcome 同一次 set、outcome 写失败全部不落盘、重放返回相同结果、不同 binding 拒绝、TTL/容量清理有效） |

## 2. 第二轮复验整改（阶段 E 第二轮：3 个新 P0 反例 + 2 个次级问题）

| 复验反例 | 修复（生产代码） | 回归测试（先红后绿） |
|---|---|---|
| P0-1 ScopedWriter 逃逸：`setQueuePaused → pause 写失败 → schedulePauseRetry(w)` 把**锁内 scoped writer** 捕获进 `setTimeout`；定时器稍后 `w.saveControl()` 直接写 repo，**不重新抢 globalWriteMutex** → 与另一条 execute 的 backend.set 重叠（maxActive=2） | `queue.schedulePauseRetry()` **不再接收参数**，改经 `this.deps.writer.saveControl(...)`（公共 writer → coordinator.execute 排队重新抢锁）；锁内首次写仍用 scoped writer（当前调用栈内有效），**任何延迟/异步逃逸一律走公共路径** | `v015-scoped-writer-escape.test.ts`：pause 写失败 + retry timer 在另一条 execute 挂起 backend.set 期间触发 → `maxActive === 1`、retry 写排在 p3 的 `end:bb.verified` 之后、最终 paused=true 持久化 |
| 次级 1：`schedulePauseRetry` 成功后未把 `pauseRetryTimer` 置 null → 第一次 retry 链结束后，后续新 pause 失败永远无法再安排 retry | 成功 / 达上限 / 已恢复三分支均 `this.pauseRetryTimer = null` | 同文件第二用例：第一轮 pause 失败→retry 成功→resume→第二轮 pause 失败→retry 仍能再次成功持久化 |
| 次级 2：`pause()` 第 521 行「相同暂停原因直接 return」——第一次持久化失败后，第二次相同 pause 可能直接 resolve 成功（尽管 local 仍未落盘） | 新增 `pausePersistPending` 标志：local 写失败置 true、retry 成功/达上限/resume 置 false；早退 return 条件追加 `&& !this.pausePersistPending`（持久化未完成时相同原因 pause 必须重新尝试写） | 同文件第三用例：第一次 pause reject 后，存储仍 paused:false，相同原因第二次 pause **必须 reject**（不得早退 resolve） |
| P0-3 浏览器完全重启 fail-open：`chrome.storage.session` 浏览器完全重启清空；若 local `bb.queueControl` 写失败（仍 paused:false）且 retry 成功前崩溃 → 重启后 latch 丢失 + control 未暂停 → 恢复运行 | `safety-latch.ts` 新增 **local 持久 latch**（`PERSISTENT_LATCH_KEY='bb.pauseSafetyLatchPersistent'` + `chromeStorageLocalLatch()`）+ `compositeSafetyLatch(...latches)`（isSet=任一通道 set、set/clear 双通道）；pause 双写（session + local 持久），resume 双清；background 注入 `compositeSafetyLatch(chromeStorageSessionLatch(), chromeStorageLocalLatch())`——浏览器完全重启后 local 持久 latch 仍在 → start() 读 composite 仍 fail-closed | `v015-browser-restart-latch.test.ts`：pause 写失败 + `session.browserRestart()`（清空 session）+ 新 queue.start()（local 持久 latch 仍在）→ **必须 fail-closed**（paused=true、不派发）；用户显式 resume 后才继续 |
| P0-2 revalidateQueued 与 runTask 并发：`revalidateQueued()` 先克隆（queued）→ `buildRevalidated` 内多个 await → 期间 pump 把任务改为 in_flight → `applyTasksIfChanged`（旧实现：全量 `adoptTasks(next)`）把内存回退 queued；runTask 持有旧对象脱离 this.tasks → 结果写不回 → Storage 残留 queued → 再次派发 | `applyTasksIfChanged` 改为**按 id 就地合并**：只把「当前仍 queued」的任务应用验证结果（queued→skipped），in_flight/终态任务绝不被旧快照回退；`resume()` 同样改用 `applyTasksIfChanged` + `pendingTasks()` 合并快照持久化（`saveQueueSnapshot(mergedTasks, ...)`）；`commitAction` 改用 `adoptTasksMerged`（内存 in_flight 不被存储快照回退） | `v015-revalidate-runTask-race.test.ts`：挂起 revalidate 的 verify（getWhitelist gate），期间 pump 把 t1 改为 in_flight → 释放 gate → **t1 保持 in_flight**（不回退 queued）；executor 恰好一次；存储最终 succeeded |

## 2b. 第三轮复验整改（阶段 E 第三轮 / E2：2 个 P0-3 边界）

| 复验反例 | 修复（生产代码） | 回归测试（先红后绿） |
|---|---|---|
| E2-P0-3A persistent latch `set()` 自身失败后浏览器完全重启仍 fail-open：`compositeSafetyLatch.set()` 顺序双写 session→persistent，persistent 失败 → `latch.set()` 抛错 → `pause()` 在 latch 阶段 reject → **`w.saveControl()` 根本未执行** → control 仍 `paused:false`；浏览器完全重启后（session 清空 + persistent 从未写入 + control 未暂停）→ `start()` 恢复未暂停 | `queue.pause()`：latch 设置失败**不阻断** local control 写入——`control(paused:true)` 本身就是跨浏览器重启的持久证据（`start()` 读 control.paused=true → fail-closed）；先记录 `latchFailed` 继续写 control，control 成功后若 latch 曾失败仍显式 reject（安全锁不完整，调用者知情），但跨重启 fail-closed 已由 control 兜底 | `v015-latch-set-failure.test.ts`：session.set 成功 + persistent.set reject → pause reject；**control 必须已写入 paused:true**；`session.browserRestart()` + 新 queue.start() → **paused=true**、不派发、executor 不被调用；用户显式 resume 后才继续 |
| E2-P0-3B pause retry 全部耗尽后相同原因 pause 静默成功：`schedulePauseRetry` 耗尽分支 `attempt >= MAX_ATTEMPTS` 时 `pausePersistPending=false`（错误——「重试耗尽」≠「持久化成功」）→ 相同原因再次 pause 命中 `!pausePersistPending` → 早退 return/resolve（静默成功，尽管 queueControl 仍 paused:false） | `schedulePauseRetry` 拆分耗尽与恢复两分支：`attempt >= MAX_ATTEMPTS` → 仅 `pauseRetryTimer = null`（**保持 `pausePersistPending=true`**，相同原因 pause 不得早退）；仅 `saveControl` 真正成功 / `!this.control.paused`（已 resume）才清 pending | `v015-pause-retry-exhausted.test.ts`：saveControl + 3 次 retry 全失败 → storage 仍 paused:false → 等待 retry 链彻底耗尽（~4.2s）→ 相同原因再次 pause **必须 reject**；内存仍 fail-closed、latch 保持 |

## 3. 先红后绿记录

### 第一轮（6 项缺陷）
- v0.1.4 红：6 组 v015 测试在 v0.1.4 代码上运行 → `docs/v0.1.5-red-run.log`：
  `Test Files 6 failed (6), Tests 18 failed | 3 passed (21)`。
  红点明细：
  - lease 隔离：`expected 2 to be 1`（maxActive=2，外部 writer 继承 lease 并发写）；
  - stale 快照：`expected undefined to be defined`（concurrent 丢失 / existing 回退）；
  - pause 失败：`pauseRejected:false`、重启后 `paused:false`（静默成功 + 不 fail-closed）；
  - resume 重验：合法任务被 skipped（executed:0）；
  - storage 克隆：修改返回/传入对象污染 store、read-only cache 可被 push；
  - outcome 原子：无同一次 set 含 blocked+queue+outcome；outcome 写失败被吞（r1 committed）。
- v0.1.5 绿（第一轮）：`tests/unit/v015-runtime-probe.test.ts` 运行输出
  `runtime-integration-evidence-v0.1.5.json`（workspace 根），6 项 findings 全部 false、
  `allDefectsClosed:true`；全套 `pnpm test` 376 passed；`pnpm typecheck` / `pnpm lint` 干净；
  独立 gate 复验 `python review/BiliBlocker-v0.1.5-release-gate.py . --expected-version 0.1.5` → PASS。

### 第二轮（复验 3 P0 + 2 次级）
- 复验前红：3 个复验测试文件在 v0.1.5（第一轮）代码上运行 → `docs/v0.1.5-rereview-red-run.log`：
  `Test Files 3 failed (3), Tests 5 failed (5)`。
  红点明细：
  - ScopedWriter 逃逸：`expected 2 to be 1`（pause retry timer 携带 scoped writer 直接写 → maxActive=2）；
  - 浏览器完全重启：`expected false to be true`（session 清空后 fail-open，paused=false）；
  - revalidate 回退：`expected 'queued' not to be 'queued'`（in_flight 被旧克隆回退 queued）；
  - timer 复位：第二轮 pause 失败后无法再次 retry（timer 未置 null）；
  - 相同原因早退：`promise resolved "undefined" instead of rejecting`（早退 return 假装成功）。
- 复验后绿：3 个复验测试文件全部通过；`v015-runtime-probe.test.ts` 更新为 **9 项 findings**
  （新增 scopedWriterTimerEscape / browserFullRestartFailOpen / revalidateRunTaskRevert）全部 false、
  `allDefectsClosed:true`；全套 `pnpm test` **381 passed**；typecheck / lint 干净；
  `python review/BiliBlocker-v0.1.5-release-gate.py . --expected-version 0.1.5` → PASS。

### 第三轮（E2：2 个 P0-3 边界）
- 复验前红：2 个 E2 测试文件在 v0.1.5（第二轮）代码上运行 → `docs/v0.1.5-e2-rereview-red.log`：
  `Test Files 2 failed (2), Tests 2 failed (2)`。
  红点明细：
  - persistent latch 自身失败：`expected false to be true`（persistent set 失败后 pause 在 latch 阶段
    reject、control 未写 → 浏览器完全重启后 paused=false，fail-open）；
  - retry 耗尽静默成功：`promise resolved "undefined" instead of rejecting`（耗尽分支清
    pausePersistPending → 相同原因再次 pause 早退 resolve）。
- 复验后绿：2 个 E2 测试文件全部通过；`v015-runtime-probe.test.ts` 更新为 **11 项 findings**
  （新增 persistentLatchSetFailureFailOpen / pauseRetryExhaustedSilentResume）全部 false、
  `allDefectsClosed:true`；全套 `pnpm test` **383 passed**；typecheck / lint 干净；
  `python review/BiliBlocker-v0.1.5-release-gate.py . --expected-version 0.1.5` → PASS。

## 4. 关键架构决策（v0.1.5 三轮）

- 写锁模型升级（P0-1）：实例级 `currentLease` 删除；`writerFor(lease)` 词法作用域 ScopedWriter
  只在 withGlobalWrite 回调内创建并沿调用栈传给 queue 方法；外部 writer 永远走公共 execute 排队；
  任意无关异步回调在任何 execute 进行期间都只能排队，绝不继承运行中请求的 lease。
  **复验强化**：任何延迟/异步逃逸（pause retry timer）必须改走公共 writer 重新抢锁。
- 队列写一致性（P0-2）：`pendingTasks()` 返回结构化克隆；公共 `saveQueueTasks` 锁内基于最新持久
  快照合并（保留活跃/unknown 任务，防旧快照覆盖）；`commitAction` 锁内读取最新持久队列追加 created；
  内存只在 backend 成功后 adopt。**复验强化**：revalidate/resume/commitAction 的 adopt 全部改为
  **合并式**（按 id 就地应用，in_flight 绝不被旧克隆回退；runTask 对象引用保持有效）。
- 安全暂停（P0-3）：`SafetyLatch` 抽象；pause 先 latch 后 local；失败 reject + 有限重试
  （重试经公共 writer）；start 先读 latch；resume 成功后清 latch。**复验强化**：新增 **local 持久
  latch 通道** + `compositeSafetyLatch`（session OR local）——浏览器完全重启后仍 fail-closed。
  **E2 强化**：latch 设置失败不阻断 local control 写入（control.paused=true 是跨浏览器重启的
  持久证据，start() 读 control 即 fail-closed）；retry 耗尽 ≠ 持久化成功（保持 pausePersistPending）。
- resume 原子（P1-1）：`candidateControl` 重验 + `saveQueueSnapshot` 单次原子落盘（合并快照）。
- structured-clone（P1-2）：backend 输入/输出全量克隆；Repository read 返回克隆、cache 独立克隆；
  mutateList 纯函数快速路径（避免 O(n²) 克隆退化，公开读取仍隔离）。
- outcome 原子（P1-3）：成功路径单次 commitSnapshot 含名单/队列/outcome；拒绝类也写绑定记录。

## 5. 测试与门禁

- 新增 12 个 v015 单元测试文件（6 组第一轮回归 + 3 组第二轮复验回归 + 2 组 E2 复验回归 + 1 个 runtime probe）。
- `runtime-integration-evidence-v0.1.5.json`：**11 项 findings 全部 false**（真实生产接线：
  StorageRepository → StorageCoordinator → coordinator.writer → ActionQueue/QueueWriter；
  第二轮新增：pause retry timer 逃逸、浏览器完全重启、revalidate/runTask 并发回退；
  E2 新增：persistent latch 自身失败、pause retry 耗尽静默成功）。
- E2E 新增：风控暂停→用户恢复→合法任务执行一次；SW 重启前 pause 持久化失败→页面安全锁定不派发；
  并发一键提交与队列状态更新不丢任务；同 operationId 响应丢失重发返回同一结果。
- 完整 release 流水线（`pnpm release`）：lint → typecheck → unit → e2e → build-chrome →
  build-edge → package → source-integrity → source-rebuild → release-gate（v0.1.5 gate）。

## 6. 冻结声明

- 全部真实能力、举报理由、selectors 保持 `verified:false`（关闭态）。
- 不执行任何真实 Bilibili 拉黑/解除拉黑/举报。
- 阶段 F 未开始；Chrome/Edge 商店未提交。
- 本文件打包前冻结；打包后任何修改都会被 source-integrity 全量比较发现。

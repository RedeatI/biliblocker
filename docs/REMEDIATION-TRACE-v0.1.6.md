# BiliBlocker v0.1.6 整改追溯（REMEDIATION TRACE）

> 本文件在**打包前**冻结，只记录设计/测试/待发布状态；打包后不得修改（source-integrity 全量比较覆盖）。
> 缺陷基线：`docs/ACCEPTANCE-v0.1.4.md`（阶段 E 独立复验 v0.1.4 缺陷）。
> 复验基线（阶段 E 独立复验 v0.1.5 / P0-5）：第三方验收方发现 **1 个新 P0**（stale verdict TOCTOU：
> 撤权/取消发生在 `verifyTaskEligible` 的 await 窗口内时，executor 仍被调用，官方请求仍发出）
> + 3 个 P1 观察项（P1-4 enqueue 公共 API、P1-5 runTask 持久化异常 orphaned promise、P1-6 revoke
> 先改内存再 persist 失败内存/存储不一致）。
> 当前状态：v0.1.6 整改完成，**等待阶段 E 独立复验**；阶段 F 未开始；商店未提交。

## 1. 缺陷 → 修复 → 测试证据映射（v0.1.6：P0-5 + P1-4~P1-6）

| 缺陷 | 修复（生产代码） | 回归测试（先红后绿） |
|---|---|---|
| P0-5 stale verdict TOCTOU：`verifyTaskEligible()` 的 epoch 检查（queue.ts L814）位于 `getSettingsRevision()`/`getWhitelist()` 两个 await **之前**；验证结论跨 await 过期。撤权/取消发生在该窗口内时（revoke epoch++ 且 queued→cancelled；cancel queued→cancelled，二者都不设置 `revocationRequested`），`runTask()` 拿到陈旧 `{ok:true}` → 直接 `task.status='in_flight'`（覆盖已确立的 cancelled）→ executor 被调用 → 真实官方请求发出；最终存储 `succeeded`（撤权被吞）。**独立复现：revoke 窗口 executed=1/succeeded、cancel 窗口 executed=1/succeeded** | 双保险：<br>1）**runTask 派发前二次确认**：`task.status = 'in_flight'` 之前检查 `task.status !== 'queued' || task.revocationRequested` → 不派发、保留已确立终态（executor 调用恒为 0）；<br>2）**check-latest-again**：`verifyTaskEligible` 的 epoch 比较移至函数**末尾**（所有 await 之后），返回前用锁内最新 control（`repo.getQueueControl()`）重新比较 `task.authorization.epoch`——revoke/恢复在 verify 挂起窗口内完成时必然读到新 epoch，结论不再陈旧（同时保留入口早期 epoch 检查以维持「epoch 失效」的报错优先级） | `tests/unit/v016-verify-revoke-race.test.ts`（6 场景）:<br>1. queued block → verify 挂起（getWhitelist gate）→ revoke → 放行 → **executor=0**、存储 cancelled、epoch=1；<br>2. 同场景 cancelTasks → executor=0、cancelled；<br>3. report 类任务 + revoke → executor=0（不可逆副作用路径）；<br>4. report 类任务 + cancelTasks → executor=0；<br>5. resume() 末尾 pump 触发 runTask 时 verify 挂起 → revoke → executor=0（覆盖 resume 入口）；<br>6. 任务完成回调后 pump 继续派发第二任务，其 verify 挂起窗口内 revoke → 第二任务不派发（executor 仅 t1 一次）。<br>先红证据：`docs/v0.1.6-red-run.log`（v0.1.5 代码上 6/6 红：executor=1/2、最终 succeeded） |
| P1-4 `ActionQueue.enqueue()` 公共 API 直接 `push+persist`，绕过 coordinator 原子提交与 operationOutcome | `enqueue` 标记 `@internal`（JSDoc 说明仅测试/遗留使用），生产路径统一 `planEnqueue`（StorageCoordinator.commitAction 锁内原子落盘）；门禁新增「生产代码无 `.enqueue(` 调用」检查 | 门禁 13.24/13.27 检查；现有 queue.test.ts 等测试保留（@internal 不改变行为） |
| P1-5 `runTask` 内 `saveControl`/`persistIfCurrent` 抛错 → unhandled rejection，任务卡内存 in_flight、存储 queued | runTask 派发前持久化与结果持久化均捕获异常：新增 `persistIfCurrentSafe(gen, task)`——写失败时任务转 `failed`、记录 `lastError`、不产生 orphaned promise；派发前持久化失败单独兜底（failed + lastError，executor 未调用、无副作用） | 门禁 13.25 检查；v016 全量单测覆盖无回归 |
| P1-6 `revoke()` 先改内存再 persist，persist 失败内存/存储不一致 | `revoke()` **先落盘 epoch**（安全性关键）：`w.saveControl(epoch+1)` 失败 → 回滚内存 epoch 并显式失败（不留「内存已撤权、存储未撤权」）；任务状态落盘（persist + saveControl）失败 → 显式记录——epoch 已安全持久化，重启后 queued 任务因 epoch 不匹配被 skipped，**绝不派发** | 门禁 13.26 检查；v016 全量单测覆盖无回归 |

## 2. 先红后绿记录（P0-5）

- **先红**：`tests/unit/v016-verify-revoke-race.test.ts` 在 v0.1.5 生产代码上运行 →
  `docs/v0.1.6-red-run.log`：`Test Files 1 failed (1)，Tests 6 failed (6)`。
  红点明细（与独立复验 repro-h-race.ts / repro-cancel-race.ts 结论一致）：
  - 场景 1（block+revoke）：`expected 0 to be 1`（executor 被调用 1 次）；
  - 场景 2（block+cancel）：`expected 0 to be 1`（executor 被调用 1 次）；
  - 场景 3/4（report+revoke/cancel）：`expected 0 to be 1`（executor 被调用 1 次）；
  - 场景 5（resume 入口）：`expected 0 to be 1`（executor 被调用 1 次）；
  - 场景 6（任务完成回调后再次 pump）：`expected 1 to be 2`（t2 被错误派发）。
- **后绿**：修复后 6/6 通过；`tests/unit/v016-runtime-probe.test.ts` 输出
  `runtime-integration-evidence-v0.1.6.json`：**13 项 findings 全部 false**
  （v0.1.5 的 11 项 + 新增 `revokeDuringVerifyDispatch` / `cancelDuringVerifyDispatch`），
  `allDefectsClosed:true`；results 记录 `revokeDuringVerifyExecutorCalls=0`、
  `cancelDuringVerifyExecutorCalls=0`、最终状态 `cancelled`、`revokeDuringVerifyEpoch=1`。
- 全套门禁：`pnpm test`（390 passed）、`pnpm test:e2e`、`pnpm typecheck`、`pnpm lint` 全绿；
  `python review/BiliBlocker-v0.1.6-release-gate.py . --expected-version 0.1.6` → PASS。

## 3. 关键架构决策（v0.1.6）

- **派发前二次确认**（P0-5 硬守卫）：`runTask` 在设置 `in_flight` 前必须重新确认
  `task.status === 'queued' && !task.revocationRequested`——verify 结论跨多个 await 已过期，
  窗口内 revoke/cancel/reset 改写的终态绝不被覆盖；这是所有触发 runTask 的入口
  （pump / kick / resume 末尾 pump / 任务完成回调后的再次 pump）的统一防线。
- **check-latest-again**（P0-5）：`verifyTaskEligible` 的 epoch 比较置于所有 await 之后，
  用锁内最新 control（`repo.getQueueControl()`，即撤权已持久化的值）重比 `authorization.epoch`；
  入口保留早期 epoch 检查以维持报错优先级（能力/理由不掩盖撤权事实）。
- **撤权持久化顺序**（P1-6）：epoch 先落盘（撤权语义的持久锚点），失败回滚；
  任务状态落盘失败显式记录——重启后 queued 任务因 epoch 不匹配被 skipped，绝不派发。
- **持久化异常兜底**（P1-5）：runTask 内所有持久化路径捕获异常并转 failed + lastError，
  不产生 unhandled rejection / orphaned promise。

## 4. 测试与门禁

- 新增 2 个 v016 单元测试文件：`v016-verify-revoke-race.test.ts`（6 场景，先红后绿）、
  `v016-runtime-probe.test.ts`（13 项运行时探针 → `runtime-integration-evidence-v0.1.6.json`）。
- `runtime-integration-evidence-v0.1.6.json`：13 项 findings 全 false；results 含 P0-5 两组
  （revoke/cancel during verify：executorCalls=0、最终状态 cancelled/skipped、epoch=1）。
- 权威门禁升级：`review/BiliBlocker-v0.1.6-release-gate.py`（继承 v0.1.5 全部检查 +
  13.21~13.27 P0-5/P1-4~P1-6 代码级检查 + evidence 13 项 + 冻结文档 REMEDIATION-TRACE-v0.1.6.md）。
- 完整 release 流水线（`pnpm release`）：lint → typecheck → unit → e2e → build-chrome →
  build-edge → package → source-integrity → source-rebuild → release-gate（v0.1.6 gate）。

## 5. 冻结声明

- 全部真实能力、举报理由、selectors 保持 `verified:false`（关闭态）。
- 不执行任何真实 Bilibili 拉黑/解除拉黑/举报。
- 阶段 F 未开始；Chrome/Edge 商店未提交。
- 本文件打包前冻结；打包后任何修改都会被 source-integrity 全量比较发现。

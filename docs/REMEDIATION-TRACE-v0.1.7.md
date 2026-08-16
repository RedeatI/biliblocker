# BiliBlocker v0.1.7 整改追溯（REMEDIATION TRACE）

> 本文件在**打包前**冻结，只记录设计/测试/待发布状态；打包后不得修改（source-integrity 全量比较覆盖）。
> 缺陷基线：`docs/ACCEPTANCE-v0.1.4.md`（阶段 E 独立复验 v0.1.4 缺陷）。
> 复验基线（阶段 E 独立复验 v0.1.6 / P0-5b）：第三方验收方发现 **1 个新 P0**（revoke 的
> `saveControl` in-flight 期间 verify 恢复 → executor 仍被调用）+ 3 个 P1 观察项
> （P1-7 `review/__pycache__/*.pyc` 进 Source ZIP、P1-8 gate 对 evidence runAt 副产物敏感、
> P1-9 v016-runtime-probe 未覆盖 P0-5b 子窗口）。
> 当前状态：v0.1.7 整改完成，**等待阶段 E 独立复验**；阶段 F 未开始；商店未提交。

## 1. 缺陷 → 修复 → 测试证据映射（v0.1.7：P0-5b + P1-7~P1-9）

| 缺陷 | 修复（生产代码） | 回归测试（先红后绿） |
|---|---|---|
| P0-5b revoke 的 saveControl in-flight 期间 verify 恢复 → executor 仍被调用：三条件交集——1) `verifyTaskEligible` 的 check-latest-again 读 repo **cache**，`revoke` 的 `saveControl` 先 `backend.set` 后 `cache.set`，set in-flight 期间 cache 仍旧 epoch；2) `revoke` 的 `epoch+1` 是**同步内存**修改（先于 saveControl await），但 `queued→cancelled` 循环在 await **之后**才执行——in-flight 期间任务仍 queued；3) `runTask` 二次确认（v0.1.6）只查 `task.status`/`revocationRequested`，**不比较内存 epoch**。**独立复现：block/report 均 executor=1、最终 unknown_outcome；对照（无存储延迟）executor=0、cancelled** | `runTask` 派发前二次确认（设置 in_flight 之前）补**内存 epoch 比较**：`task.authorization.epoch !== this.control.authorizationEpoch` → 不派发（revoke 的 epoch+1 是同步内存修改，必然捕获该子窗口；executor 调用恒为 0）。保留 status/revocationRequested 检查与 check-latest-again（主窗口 + 跨实例场景） | `tests/unit/v017-revoke-savecontrol-race.test.ts`（5 场景）：<br>1. block：verify 挂起（getWhitelist gate）+ revoke 的 saveControl 挂起（bb.queueControl 写 gate）→ 放行 verify → **executor=0**、最终 cancelled/skipped、epoch=1；<br>2. report 同场景 → executor=0（不可逆副作用路径）；<br>3. cancelTasks + persist 挂起 → executor=0（回归保护）；<br>4. resume 末尾 pump 入口同场景 → executor=0；<br>5. 任务完成回调后再次 pump → 第二任务不派发（executor 仅 t1 一次）。<br>先红证据：`docs/v0.1.7-red-run.log`（v0.1.6 代码上 4/5 红：executor=1/2、最终 unknown_outcome） |
| P1-7 `review/__pycache__/*.pyc` 进入 Source ZIP | Source 打包/校验/gate 统一排除 `__pycache__`（package.mjs / verify-source-rebuild.mjs / source-rebuild.mjs / release.mjs sourceTreeDigest / release gate / stage-e-package.mjs） | v0.1.7 gate 13.30：Source ZIP 无 `__pycache__`/*.pyc |
| P1-8 gate 的 Source↔工作区比较对 evidence runAt 副产物敏感 | v0.1.7 gate 比较时容忍 `runtime-integration-evidence*.json`（集合必须一致；内容按第 15 节单独校验 findings） | release-integrity 洁净产物 PASS（含 evidence 容忍） |
| P1-9 v016-runtime-probe 未覆盖 P0-5b 子窗口 | 新增 `tests/unit/v017-runtime-probe.test.ts`：探针 14 `revokeSaveControlInFlightDispatch`（挂起 revoke 的 saveControl）→ `runtime-integration-evidence-v0.1.7.json` | v0.1.7 gate 第 15 节校验 14 项 findings 全 false + results |

## 2. 先红后绿记录（P0-5b）

- **先红**：`tests/unit/v017-revoke-savecontrol-race.test.ts` 在 v0.1.6 生产代码上运行 →
  `docs/v0.1.7-red-run.log`：`Test Files 1 failed (1)，Tests 4 failed | 1 passed (5)`。
  红点明细（与独立复验 repro-p05-residual-window.ts / repro-p05-residual-report.ts 一致）：
  - 场景 1（block+revoke 窗口）：`expected 0 to be 1`（executor 被调用 1 次）；
  - 场景 2（report+revoke 窗口）：`expected 0 to be 1`（executor 被调用 1 次）；
  - 场景 4（resume 入口）：`expected 0 to be 1`（executor 被调用 1 次）；
  - 场景 5（完成回调后再次 pump）：`expected 1 to be 2`（t2 被错误派发）；
  - 场景 3（cancel persist 挂起）：绿（cancel 同步改状态，v0.1.6 已防）。
- **后绿**：修复后 5/5 通过；独立复现脚本 block/report/对照全部「未复现」（executor=0、
  最终 skipped/cancelled、epoch=1）；`tests/unit/v017-runtime-probe.test.ts` 输出
  `runtime-integration-evidence-v0.1.7.json`：**14 项 findings 全部 false**
  （v0.1.6 的 13 项 + 新增 `revokeSaveControlInFlightDispatch`），`allDefectsClosed:true`；
  results 记录 `revokeSaveControlInFlightExecutorCalls=0`、最终状态 `skipped`、epoch=1。
- 全套门禁：`pnpm test`、`pnpm test:e2e`、`pnpm typecheck`、`pnpm lint` 全绿；
  `python review/BiliBlocker-v0.1.7-release-gate.py . --expected-version 0.1.7` → PASS。

## 3. 关键架构决策（v0.1.7）

- **派发前二次确认（P0-5b 加固）**：`runTask` 二次确认在 `task.status`/`revocationRequested`
  之外，必须同时比较**内存 epoch**（`task.authorization.epoch !== this.control.authorizationEpoch`）。
  理由：revoke 的 `epoch+1` 是同步内存修改（先于 `saveControl` await），存储写 in-flight 窗口内
  check-latest-again（读 cache）会返回 ok、任务仍 queued——只有内存 epoch 比较必然捕获。
  三层防线齐备：入口早期检查（revoke 已完成）→ check-latest-again（cache 已更新）→
  二次确认内存 epoch（覆盖一切 in-flight 窗口）。
- **运行时探针扩展（P1-9）**：v017-runtime-probe 的 P0-5b 探针同时挂起 getWhitelist（verify）
  与 bb.queueControl 写（revoke 的 saveControl），精确覆盖「revoke 进行中」子窗口——
  不再只验证「revoke 已完成」主窗口。
- **Source 打包卫生（P1-7）**：`__pycache__`（python gate 运行副产物）从 Source ZIP、
  stage-e 包与所有一致性校验中排除。

## 4. 测试与门禁

- 新增 2 个 v017 单元测试文件：`v017-revoke-savecontrol-race.test.ts`（5 场景，先红后绿）、
  `v017-runtime-probe.test.ts`（14 项运行时探针 → `runtime-integration-evidence-v0.1.7.json`）。
- `runtime-integration-evidence-v0.1.7.json`：14 项 findings 全 false；results 含 P0-5b 组
  （revokeSaveControlInFlight：executorCalls=0、最终 skipped/cancelled、epoch=1）。
- 权威门禁升级：`review/BiliBlocker-v0.1.7-release-gate.py`（继承 v0.1.6 全部检查 +
  13.28~13.30 P0-5b/P1-7 代码级检查 + evidence 14 项 + evidence runAt 容忍 + 冻结文档
  REMEDIATION-TRACE-v0.1.7.md）。
- 完整 release 流水线（`pnpm release`）：lint → typecheck → unit → e2e → build-chrome →
  build-edge → package → source-integrity → source-rebuild → release-gate（v0.1.7 gate）。

## 5. 冻结声明

- 全部真实能力、举报理由、selectors 保持 `verified:false`（关闭态）。
- 不执行任何真实 Bilibili 拉黑/解除拉黑/举报。
- 阶段 F 未开始；Chrome/Edge 商店未提交。
- 本文件打包前冻结；打包后任何修改都会被 source-integrity 全量比较发现。

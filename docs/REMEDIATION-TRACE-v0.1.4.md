# BiliBlocker v0.1.4 整改追溯（REMEDIATION TRACE）

> 本文件在**打包前**冻结，只记录设计/测试/待发布状态；打包后不得修改（source-integrity 全量比较覆盖）。
> 缺陷基线：`docs/ACCEPTANCE-v0.1.3.md`（阶段 E 独立复验 8 项缺陷 + 5.1~5.5）。
> 当前状态：v0.1.4 开发者侧整改完成，**等待阶段 E 独立复验**；阶段 F 未开始；商店未提交。

## 1. 缺陷 → 修复 → 测试证据映射

| 缺陷 | 修复（生产代码） | 回归测试（先红后绿） |
|---|---|---|
| P0-1 共享 inLock 绕过全局锁 | `coordinator.ts`：删除 inLock；所有公共 `execute()` 无条件 `withGlobalWrite((lease)=>…)`；`repository.withGlobalWrite` 回调接收显式 `WriteLease`；队列 writer 由协调器注入（锁内 lease 直接写 / 锁外 execute 排队） | `v014-coordinator-lock.test.ts`（外部并发写串行：最大活跃写入数=1、两条公共 execute 均进入全局锁、事件顺序、死锁测试） |
| P0-2.1 commitAction 丢授权快照 | `coordinator.ts` `commitAction` 把 `req.authorization` 显式传给 `planEnqueue`；`queue.buildTask` 按任务类型适配快照（block/unblock/report 各自 capabilityKey/reasonId）并持久化 | `v014-auth-snapshot.test.ts`（8 字段持久化、跨 SW 重启、缺字段拒绝） |
| P0-2.2 autoProcessVerified 位置错误 | `queue.verifyTaskEligible` 把 auto_process 来源开关移到所有类型成功返回之前 | `v014-dispatch-gate.test.ts`（autoProcessVerified=false 时 auto block/report 拒绝） |
| P0-2.3 unblock 未校验 capability | `queue.verifyTaskEligible` + `coordinator.validateOfficialTask` 增加 unblock 分支 | `v014-dispatch-gate.test.ts`（unblockUser.verified=false 拒绝） |
| P0-3 reset/clear 代际倒退 | `coordinator.resetAndClear`：同锁内读旧 epoch → next=old+1 → 单次 commitSnapshot 原子写（meta/settings/rules/名单/queue/queueControl/审计保留 unknown）；clear 重建最小种子；`repo.init()` get 列表补 queueControl/revisions（修复 SW 重启覆盖持久化暂停的既有缺陷） | `v014-reset-clear.test.ts`（内存/Storage/重启一致、epoch 单调、clear 种子、backend 失败零副作用） |
| P0-4 unknown_outcome 证据丢失 | 新增 `bb.unknownOutcomes` 持久墓碑（`UnknownOutcomeRecord`，幂等 upsert、保留策略、acknowledge）；in_flight 被 cancel/revoke/reset/clear/SW 重启时先写记录再清队列；reset/clear 保留墓碑与 outcomeUnknown 审计 | `v014-unknown-outcome.test.ts`（cancel/revoke/clear 证据保留、SW 重启幂等、acknowledge 不改写、不自动重发） |
| P0-5 pause 非 crash-safe | `queue.pause` 改 `async` 且返回前 await saveControl；runTask 对 login_invalid/risk_control `await pause`；保存失败 fail-closed 停 pump；`coordinator.setQueuePaused` await | `v014-pause-crash-safe.test.ts`（延迟 writer 时序、保存失败停 pump、崩溃重启仍暂停、risk_control 仅用户恢复） |
| 5.1 commitAction 绕过 pause | `commitAction` 生成官方任务前检查持久化 queue control；risk_control/authorization_revoked/requiresExplicitResume → 不创建官方任务（`canEnqueueOfficialTask` 统一策略） | `v014-dispatch-gate.test.ts`（paused 拒绝新建）、`v014-runtime-probe`（paused commit 拒绝） |
| 5.2 auto-process 依赖缓存登录 | 移除 auto-process 触发条件中的 `this.loginOk`；本地动作不依赖登录 | `v014-auto-process-local.test.ts`（未登录 checkLogin 0 调用、本地 delta、无官方任务） |
| 5.3 BB_ENQUEUE 无保护通道 | 删除 `BB_ENQUEUE` schema/background 分支/coordinator enqueue kind；官方任务唯一创建路径为 `BB_COMMIT_ACTION` | `v014-messages.test.ts`（Schema 拒绝、无 BB_ENQUEUE）、`messages.test.ts` |
| 5.4 SW 重启帧身份立即终态 | 新增 `FrameRegistry`（not_registered/nonce_mismatch/not_bilibili/no_tab 区分）；`executeViaContent` 在宽限期（10s）内等待重新注册，非 not_registered 才终态 | `v014-frame-grace.test.ts` |
| 5.5 operationId 非幂等键 | `bb.operationOutcomes` 持久化 outcome（TTL 30min/容量 200）；绑定指纹（tab/frame/nonce/uid/contentId/hash）；同 opId 不同绑定拒绝（operationId_reused） | `v014-operation-idempotency.test.ts` |

## 2. 先红后绿记录

- v0.1.3 红：阶段 E 独立复验 `runtime-probe.json` 8 项 findings 全部 true（`externalWriteOverlap`、
  `authSnapshotDropped`、`autoProcessDisableNotEnforcedAtDispatch`、`unblockCapabilityNotEnforcedAtDispatch`、
  `resetControlDiverges`、`clearAllUnseeded`、`clearQueueLosesUnknownOutcome`、`pauseNotAwaitable`）。
- v0.1.4 绿：`tests/unit/v014-runtime-probe.test.ts` 运行输出 `runtime-integration-evidence.json`
  （workspace 根），8 项 findings 全部 false、`allDefectsClosed:true`；全部 v014 回归测试通过；
  独立 gate 复验 `python review/BiliBlocker-v0.1.4-release-gate.py . --expected-version 0.1.4` → PASS。
- 先红实测：v0.1.3 源码（`biliblocker-v0.1.3-stage-e.zip`）回放 v014 测试 → 失败记录见
  `docs/v0.1.3-red-run.log`（含并发锁绕过、授权快照缺失、epoch 分叉、unknown 证据丢失、
  pause 不可 await 等断言失败）。

## 3. 关键架构决策（v0.1.4）

- 写锁模型：`StorageCoordinator.execute()` 无条件 `repo.withGlobalWrite((lease)=>…)`；
  `WriteLease = { token: symbol }`；队列/去重/审计内部写在锁内（currentLease 匹配）直接写 repo，
  锁外经公共 execute 排队——外部命令永不绕过锁；无共享布尔。
- 授权快照：`AuthorizationSnapshot` 8 字段必填（epoch/settingsRevision/reasonId/capabilityKey/
  contentType/source/autoProcessAuthorized/reportAuthorized/createdAt）；官方任务缺快照 → 拒绝创建/拒绝派发；
  派发前逐项比较当前 settings/control/capabilities/reasons/whitelist。
- 单调 epoch：reset/clear 在锁内 oldEpoch+1；`repo.init()` 已读回持久化 queueControl/revisions，
  SW 重启不再用 DEFAULT 覆盖（修复既有 crash 缺陷）。
- unknown 证据：`bb.unknownOutcomes` 独立墓碑（reset/clear 不删）；审计清空/重置保留 outcomeUnknown 条目。
- 幂等：`bb.operationOutcomes` + 绑定指纹；同 operationId 重放返回同一结果。

## 4. 测试与门禁

- 单元/DOM：`pnpm test`（新增 10 个 v014 测试文件共 58 条断言，含 runtime 探针）。
- E2E：`pnpm test:e2e`（保留 21 条 + 新增接线场景）。
- `pnpm lint` / `pnpm typecheck` 全绿。
- `pnpm release` 十步流水线（lint/typecheck/unit/e2e/build-chrome/build-edge/package/
  source-integrity/source-rebuild/release-gate）全绿；`dist/RELEASE-EVIDENCE.json` 打包后生成。
- 增强门禁：`review/BiliBlocker-v0.1.4-release-gate.py`（含 17 项 v0.1.4 代码级检查 +
  runtime-integration-evidence.json 8 项 findings false）。

## 5. 状态声明

- 所有真实能力（8 项 capability/举报理由枚举/selectors 验证）保持 `false`。
- 未执行任何真实 Bilibili 拉黑/解除拉黑/举报；未开始阶段 F；未提交任何商店。

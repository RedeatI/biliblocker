# Changelog

## [Unreleased] - 2026-08-16

第二批上市候选差异；尚未生成包含本节变更的生产 ZIP，不能视为已发布或可上传商店的版本。

### 体验与安全
- 修复动态首页路由判定：`/dynamic` 与 `/dynamic/` 不再被误判为无 ID 的动态详情页；只有
  `/dynamic/{数字ID}` 和 `/opus/{数字ID}` 才进入 `dynamic_detail`，避免规则页面范围失配。
- RC4 修复：内容脚本初始化与 SPA 页面检测不再无条件刷新登录；新增统一的运行时官方请求门禁，只有总开关开启且具体端点已人工验证时才允许登录探测、任务构建或任务执行访问官方 API。默认关闭及 `enabled + flag_only` 的本地路径保持零官方请求。
- 新安装保持总开关关闭并使用 `flag_only`；首次启用前展示读取范围、本地处理、官方请求默认关闭与无新增权限说明，让用户选择「仅标记（推荐）」「折叠」或保持关闭。版本升级不覆盖既有设置。
- popup 的开启动作统一进入知情选择；设置页支持 `#welcome` 导航，避免绕过首次说明。
- 无 UID 时保留可理解的快捷菜单，但禁用需要 UID 的持久名单与官方动作；无、空或纯空白 `contentId` 在策略层与全部 UI/后台入口均不得 report，也不得加入已确认名单。
- 持久本地黑名单动作改用明确文案；命中原因可见，折叠内容保留页面内恢复入口。

### 交付与合规
- 统一 manifest、package、设置页品牌用途与商店候选文案，移除把默认关闭且未验证的拉黑/举报写成现成功能的旧描述；生产门禁新增 manifest description 精确校验。
- 打包前要求工作树除既有 `out-e2e/` 外完全洁净；Source ZIP 只收录 `git ls-files`，并记录候选 commit、基线、分支、例外、Node/pnpm、manifest 摘要/权限差异和产物条目数。
- 候选须等于或后继于基线 `5f97621`；Chrome/Edge manifest 固定为 MV3、`storage` + `alarms`、无 `host_permissions`、内容脚本仅匹配 `https://www.bilibili.com/*`。
- 更新隐私、商店说明、回滚流程与发布清单；不宣称替代通用拦截器，不绕过付费/会员边界，不把推荐内容或主观看法自动等同违规。

### 验证状态
- Node 22.23.2 / pnpm 9.15.0：typecheck 通过；ESLint 全量 0 warning；Vitest 64 files / 442 tests 全部通过；`git diff --check` 通过；新增 RC4 的新装/升级关闭、`enabled + flag_only`、延迟观察器、popup 及内容脚本本地动作零官方请求回归。
- canonical E2E 源文件已同步新文案；历史 `out-e2e/` 未修改。当前环境缺少浏览器缓存/系统 Chrome，浏览器 E2E 与 load-unpacked 烟测尚未验证。
- 基线提交 `5f97621` 的隔离 Chrome/Edge/ZIP 构建已通过，但不包含本节差异；第二批生产构建与 ZIP 待从新的洁净本地候选 commit 重新生成。
- RC2 `68c23f2b75904eb777204a6ff55873b8279be9ff` 因生产 manifest/UI 仍过度承诺官方能力而被替代；Chrome `afdad249…89004a1`、Edge `73a8d4ff…1a24bba`、Source `0720165f…e894bed` 仅保留调查/回滚，禁止上传、覆盖或冒充 RC3（完整哈希见 `docs/release-candidates.md`）。

## [0.1.7] - 2026-08-15

第七轮整改版（阶段 E 独立复验 P0-5b 关闭）：revoke 的 saveControl in-flight 期间 executor 不得被调用（runTask 二次确认补内存 epoch 比较）、Source 打包排除 __pycache__、gate 容忍 evidence 运行副产物、runtime probe 补 P0-5b 子窗口。

### 修复
- **P0-5b 派发前二次确认补内存 epoch 比较（撤权发起后绝不继续派发）**：revoke 的 `epoch+1` 是同步内存修改（先于 `saveControl` await），存储写 in-flight 窗口内 `check-latest-again`（读 cache）仍旧 epoch 会返回 ok、revoke 的 queued→cancelled 循环尚未执行（任务仍 queued）——v0.1.6 的二次确认只查 status 会漏过，executor 仍被调用（独立复现：block/report executor=1、unknown_outcome）。修复：`runTask` 二次确认增加 `task.authorization.epoch !== this.control.authorizationEpoch`（内存 epoch，revoke 同步先改，必然捕获）→ executor 调用恒为 0，终态 cancelled/skipped。三层防线齐备：入口早期检查 → check-latest-again → 二次确认内存 epoch。
- **P1-7 Source 打包排除 `__pycache__`**：python gate 运行副产物（review/__pycache__/*.pyc）曾进入 Source ZIP；package.mjs / verify-source-rebuild / source-rebuild / release.mjs / gate / stage-e-package 统一排除。
- **P1-8 gate 容忍 evidence runAt 副产物**：Source↔工作区比较忽略 `runtime-integration-evidence*.json` 内容差异（集合一致即可，findings 由 gate 第 15 节单独校验）。
- **P1-9 runtime probe 补 P0-5b 子窗口**：v017-runtime-probe 探针 14 同时挂起 getWhitelist 与 revoke 的 saveControl 写。

### 测试
- 单元 396 个（新增 2 个 v017 文件：`v017-revoke-savecontrol-race.test.ts` 5 场景先红后绿 + `v017-runtime-probe.test.ts` 14 项运行时探针）。
- 先红证据：`docs/v0.1.7-red-run.log`（v0.1.6 代码上 4/5 红：executor=1/2、最终 unknown_outcome）。
- `runtime-integration-evidence-v0.1.7.json`：**14 项 findings 全 false**（新增 `revokeSaveControlInFlightDispatch`；results 记录 executorCalls=0、最终 skipped/cancelled、epoch=1）。
- 独立复现脚本（v0.1.6 复验方提供 3 个）修复后全部「未复现」（executor=0）。
- 发布完整性（10.5）升级到 v0.1.7 gate；权威门禁 `review/BiliBlocker-v0.1.7-release-gate.py` 新增 13.28~13.30 P0-5b/P1-7 代码级检查。
- `pnpm lint` / `pnpm typecheck` / `pnpm test`（396）/ `pnpm test:e2e` / `pnpm release`（十步）全绿；Source ZIP 逐文件一致（无 __pycache__）。

### 阶段 F 适配（未放行）

- 公开实页预检发现 Bilibili 视频评论已迁移到 `<bili-comments>` 多层 open Shadow DOM；旧 `.reply-list/.reply-item` 路径命中 0。新增 composed-tree 查询、open ShadowRoot 观察和 ShadowRoot 内 UI 挂载，同时保留旧版 light DOM 兼容。
- 新增 Shadow DOM fixture 与首屏/懒加载集成 E2E；当前 unit 400/400、E2E 31/31、typecheck、Chrome/Edge build 通过。
- `selectorsVideo` 仍为 `verified:false`：尚未在加载生产扩展的真实登录 Chrome 中完成 manual-test 1.1–1.5；纯文本评论无 DOM `rpid` 的问题留给后续 report 能力独立处理。

## [0.1.6] - 2026-08-14

第六轮整改版（阶段 E 独立复验 P0-5 关闭）：撤权/取消发生在派发前验证的 await 窗口内时 executor 不得被调用（stale verdict TOCTOU 双保险修复）、revoke epoch 先落盘、runTask 持久化异常兜底、enqueue 收口 @internal。

### 修复
- **P0-5 派发前二次确认 + check-latest-again（stale verdict TOCTOU）**：`runTask()` 在 `task.status='in_flight'` 之前二次确认 `task.status === 'queued' && !task.revocationRequested`——verify 结论跨多个 await 已过期，窗口内 revoke/cancel/reset 改写的终态绝不被覆盖（executor 调用恒为 0）；`verifyTaskEligible()` 的 epoch 比较移至函数**末尾**（所有 await 之后），返回前用锁内最新 control（`repo.getQueueControl()`）重新比较 `authorization.epoch`，消除跨 await 陈旧结论（同时保留入口早期 epoch 检查维持报错优先级）。覆盖所有触发 runTask 的入口：pump / alarm kick / resume 末尾 pump / 任务完成回调后的再次 pump。独立复现（revoke/cancel 窗口 executed=1/succeeded）→ 修复后 executor=0、存储 cancelled、epoch=1。
- **P1-4 enqueue 收口**：`ActionQueue.enqueue` 标记 `@internal`（仅测试/遗留），生产路径统一 `planEnqueue`（coordinator 锁内原子落盘 + operationOutcome）。
- **P1-5 runTask 持久化异常兜底**：新增 `persistIfCurrentSafe`——saveControl/persistIfCurrent 抛错时任务转 `failed` 并记录 `lastError`，不产生 unhandled rejection / orphaned promise（executor 未调用，无副作用）。
- **P1-6 revoke 持久化顺序**：`revoke()` 先落盘 epoch（撤权语义的持久锚点；失败回滚内存并显式失败），任务状态落盘失败显式记录——重启后 queued 任务因 epoch 不匹配被 skipped，绝不派发。

### 测试
- 单元 390 个（新增 2 个 v016 文件：`v016-verify-revoke-race.test.ts` 6 场景先红后绿 + `v016-runtime-probe.test.ts` 13 项运行时探针）。
- 先红证据：`docs/v0.1.6-red-run.log`（v0.1.5 代码上 6/6 红：executor=1/2、最终 succeeded）。
- `runtime-integration-evidence-v0.1.6.json`：**13 项 findings 全 false**（新增 `revokeDuringVerifyDispatch` / `cancelDuringVerifyDispatch`；results 记录 executorCalls=0、最终 cancelled、epoch=1）。
- 发布完整性（10.5）升级到 v0.1.6 gate：洁净产物 PASS + 失败场景；权威门禁 `review/BiliBlocker-v0.1.6-release-gate.py` 新增 13.21~13.27 P0-5/P1-4~P1-6 代码级检查。
- `pnpm lint` / `pnpm typecheck` / `pnpm test`（390）/ `pnpm test:e2e` / `pnpm release`（十步）全绿；Source ZIP 逐文件一致。

## [0.1.5] - 2026-08-14

第五轮整改版（阶段 E 复验缺陷关闭 + 第二轮复验 3 P0 反例关闭）：词法作用域 ScopedWriter（删除实例级 currentLease）、队列锁内最新快照 + 合并写、crash-safe 安全暂停（session + local 持久 latch）、resume 原子重验、structured-clone 存储语义、operationId 结果原子提交。

### 修复
- **P0-1 词法作用域 ScopedWriter（异步 lease 泄漏）**：删除 `StorageCoordinator.currentLease` 实例字段；`execute()` 无条件 `withGlobalWrite((lease)=>…)`，锁内经 `writerFor(lease)` 创建**仅当前调用栈有效**的 scoped writer（queue/revoke/resume/pause 显式接收）；外部 `coordinator.writer` 每个方法无条件走公共 execute 排队——任意无关异步回调（pump/alarm/任务返回/queue.kick）在任何 execute 进行期间只能排队，绝不继承运行中请求的 lease；`pendingTasks()` 返回结构化克隆。探针：外部 writer 与 execute 并发最大活跃 backend 写恒为 1、事件严格串行。
  - **复验强化（ScopedWriter timer 逃逸）**：`schedulePauseRetry()` 不再接收锁内 scoped writer，改经 `this.deps.writer`（公共 execute 排队重新抢锁）——pause 写失败后 retry timer 触发时绝不与另一条 execute 的 backend.set 重叠（maxActive 恒为 1）；retry 成功/达上限后复位 `pauseRetryTimer`（后续新 pause 失败仍能再次安排）；新增 `pausePersistPending` 守卫——相同原因 pause 在持久化未完成时不得早退 return（不得假装已持久化）。
- **P0-2 队列写基于锁内最新快照（stale snapshot 覆盖）**：公共 `saveQueueTasks` 锁内 `mergeQueueTasks(最新持久快照, 传入)`（保留 queued/in_flight/unknown_outcome 任务，防旧快照覆盖丢 concurrent、把 in_flight 回退成 queued）；`commitAction` 锁内 `getQueueTasks()` 读取最新持久队列再追加 created；ActionQueue 内存只在 backend 成功后 adopt；同 operationId 重放/并发提交不重复追加、不回退已有状态。
  - **复验强化（revalidate/runTask 并发回退）**：`applyTasksIfChanged` 改为**按 id 就地合并**——只把「当前仍 queued」的任务应用验证结果（queued→skipped），in_flight/终态任务绝不被旧克隆回退；`resume()` 改用合并式 + `pendingTasks()` 最新快照持久化（`saveQueueSnapshot(mergedTasks,…)`）；`commitAction` 改用 `adoptTasksMerged`（pump 已推进的 in_flight 不被存储快照回退）。executor 恰好一次、存储终态正确写回。
- **P0-3 crash-safe 安全暂停（pause 持久化失败 + SW 重启 + 浏览器完全重启）**：新增 `src/storage/safety-latch.ts`（`SafetyLatch` 接口 + `chromeStorageSessionLatch` session 实现 + `chromeStorageLocalLatch` local 持久实现 + `compositeSafetyLatch` 组合 + 内存实现）；`pause()` 失败显式 reject（不得静默 resolve）；先 `latch.set()`（fail-closed，覆盖 SW 重启）再写 local control；local 写失败保持 latch + 有限重试（最多 3 次）；`queue.start()` 先读 latch，无法证明上次暂停已安全清除则强制 fail-closed（paused=true、不 pump）；`resume()` 成功后才清 latch；background 注入 `compositeSafetyLatch(session, local)`。
  - **复验强化（浏览器完全重启 fail-closed）**：新增 local 持久 latch 通道（`bb.pauseSafetyLatchPersistent`）——`chrome.storage.session` 在浏览器完全重启时被清空，local 持久 latch 不清空；浏览器重启后 `start()` 读 composite（session OR local）仍 fail-closed，绝不恢复为未暂停。
  - **E2 强化（persistent latch 自身失败仍 fail-closed）**：`pause()` 中 latch.set() 失败**不阻断** local control 写入——`control(paused:true)` 本身就是跨浏览器重启的持久证据（`start()` 读 control.paused=true → fail-closed）；latch 曾失败仍显式 reject（安全锁不完整），但跨重启 fail-closed 已由 control 兜底。
  - **E2 强化（retry 耗尽 ≠ 持久化成功）**：`schedulePauseRetry` 拆分耗尽与恢复分支——`attempt >= MAX_ATTEMPTS` 仅复位 timer、**保持 `pausePersistPending=true`**（相同原因 pause 不得早退静默成功）；仅 saveControl 真正成功 / 已 resume 才清 pending。
- **P1-1 resume 保留合法 queued 任务（重验顺序）**：`resume()` 构造 `candidateControl = {...control, paused:false}` 用 `buildRevalidated(reason, candidateControl)` 重验——只忽略「正在解除的这一个 pause」，epoch/settingsRevision/capability/理由/白名单/总开关仍校验；tasks 与 control 经新命令 `saveQueueSnapshot` **一次原子落盘**；合法任务继续 queued 并执行恰好一次，失效任务因真实失效原因转 skipped（skipReason 不再出现「队列已暂停」）。
- **P1-2 structured-clone 存储语义（测试 backend/Repository 边界）**：`inMemoryBackend` initial/set 输入、get 输出全量 structuredClone（与真实 chrome.storage.local 一致）；`repository.read()` 返回克隆、cache 存独立 clone（write/commitSnapshot/applyExternalChanges 均克隆）；`mutateList` 内部 RMW 快速路径（纯函数契约，避免 O(n²) 克隆退化）；read-only 实例返回的 lists/settings/control/rules/tasks 无法通过引用修改 cache；写失败后 cache 与 backend 均保持旧值。
- **P1-3 operationId 结果原子提交**：成功路径单次 `commitSnapshot(items)` 同时包含 blocked/verified delta、queue delta、`bb.operationOutcomes[operationId]`（`nextOutcomesMap`：TTL 30min/容量 200 清理 + 新记录）；拒绝类结果（disabled/self/whitelisted/authorization_changed/缺快照）经 `saveOutcomeAtomic` 写确定绑定记录；outcome 写失败 → 整个操作 `storage_failed`（绝不用 catch 吞掉持久化错误）；同 operationId 重放返回完全相同结果、不同 binding 复用拒绝。

### 测试
- 单元 383 个（新增 12 个 v015 文件：lease 隔离/stale 快照/pause 存储失败/resume 重验/storage 克隆/outcome 原子/scoped-writer 逃逸/浏览器重启 latch/revalidate 并发回退/persistent latch 失败/retry 耗尽/运行时集成探针 11 项缺陷全关闭）；E2E 30 个（新增 4 条：风控暂停→用户恢复→合法任务执行一次、SW 重启前 pause 失败→安全锁定、并发一键提交不同 UID 不丢任务、同 operationId 重发同结果）。
- 复验（阶段 E 第二轮）红 log：`docs/v0.1.5-rereview-red-run.log`（5 failed：scoped-writer 逃逸 maxActive=2、浏览器重启 fail-open、revalidate 回退 queued、timer 不复位、相同原因 pause 早退）。
- 复验（阶段 E 第三轮 / E2）红 log：`docs/v0.1.5-e2-rereview-red.log`（2 failed：persistent latch 自身失败重启 fail-open、retry 耗尽后相同原因 pause 静默 resolve）。
- 发布完整性（10.5）升级到 v0.1.5 gate：洁净产物 PASS + 12 项失败场景；`runtime-integration-evidence-v0.1.5.json` **11 项 findings 全 false**。
- `pnpm lint` / `pnpm typecheck` / `pnpm test`（383）/ `pnpm test:e2e`（30）/ `pnpm release`（十步）全绿；`review/BiliBlocker-v0.1.5-release-gate.py` PASS；Source ZIP 逐文件一致。

## [0.1.4] - 2026-08-13

第四轮整改版（阶段 E 复验缺陷关闭）：WriteLease 锁模型、每任务授权快照、单调 epoch 原子播种、unknown_outcome 持久证据、crash-safe 暂停、operationId 幂等。

### 修复
- **P0-1 显式 WriteLease 锁模型**：删除共享 `inLock` 布尔；所有公共 `execute()` 无条件进入 `withGlobalWrite((lease)=>…)`（KeyMutex 串行）；`repository.withGlobalWrite` 回调接收显式 `WriteLease`；队列/去重/审计内部写由协调器注入 writer（锁内 lease 直接写、锁外 execute 排队）；外部并发命令最大活跃写入数恒为 1（含死锁测试）。
- **P0-2 每任务授权快照 + 统一派发门禁**：`AuthorizationSnapshot` 8 字段必填（epoch/settingsRevision/reasonId/capabilityKey/contentType/source/autoProcessAuthorized/reportAuthorized/createdAt）；`BB_COMMIT_ACTION` 把快照显式传给 `planEnqueue/buildTask` 并持久化（block/unblock/report 各自 capabilityKey/reasonId）；`autoProcessVerified` 检查位于所有任务类型成功返回之前；`unblock` 队列层校验 `unblockUser` capability；settings revision 不一致/缺快照 → skipped 绝不直接派发。
- **P0-3 reset/clear 单调 epoch + 原子播种**：`resetAndClear()` 同锁内读旧 epoch → next=old+1（永不回 0）→ 单次 `commitSnapshot` 原子写最终快照；clear 后立即存在 meta/settings/queueControl 最小种子（只读实例可立即 init）；内存队列仅在 backend 成功后采用同一快照；修复 `repo.init()` 未读回 queueControl/revisions 导致 SW 重启覆盖持久化暂停/版本的既有缺陷。
- **P0-4 unknown_outcome 持久证据**：新增 `bb.unknownOutcomes` 独立墓碑（`UnknownOutcomeRecord`：taskId/uid/type/cause/markedAt/acknowledgedAt；幂等 upsert；已核对 30 天 TTL；未核对不删）；in_flight 被 cancel/revoke/reset/clear/SW 重启先写证据再清队列；reset/clear 保留墓碑与 outcomeUnknown 审计；用户显式「已人工核对」只标记 acknowledgedAt 绝不改写成 cancelled/succeeded。
- **P0-5 暂停 crash-safe**：`pause()` 改 `async` 且返回前 await saveControl；runTask 对 login_invalid/risk_control `await pause`；保存失败 fail-closed 停 pump；`coordinator.setQueuePaused` await；重启后从 Storage 恢复暂停与速率窗口。
- **5.1 paused 禁止积压官方任务**：commitAction 生成官方任务前检查持久化 queue control（risk_control/authorization_revoked/requiresExplicitResume 拒绝），`canEnqueueOfficialTask` 统一「能否创建」与「能否派发」策略。
- **5.2 自动处理本地动作不依赖登录**：移除 auto-process 触发条件中的缓存 `this.loginOk`；本地折叠/本地名单独立完成。
- **5.3 删除 BB_ENQUEUE**：消息 Schema/background 分支/coordinator enqueue kind 全部移除；官方任务唯一创建路径为 `BB_COMMIT_ACTION`。
- **5.4 SW 重启帧注册宽限期**：新增 `FrameRegistry`（not_registered/nonce_mismatch/not_bilibili/no_tab 区分）；`executeViaContent` 在 10s 宽限期内等待重新注册，页面关闭/nonce 变化才进入明确终态。
- **5.5 operationId 幂等**：`bb.operationOutcomes` 持久化 outcome（TTL 30min/容量 200）+ 绑定指纹（tab/frame/nonce/uid/contentId/hash）；同 operationId 重放返回同一结果，不同绑定复用被拒绝（operationId_reused）。

### 测试
- 单元/DOM 358+ 个（新增 10 个 v014 文件：外部并发写串行/授权快照/派发门禁/reset-clear epoch/unknown 证据/pause 时序/auto-process 本地/消息边界/operationId 幂等/帧宽限 + 运行时集成探针 8 项缺陷全关闭）；E2E 保留 21 个 + 新增接线场景。
- 发布完整性（10.5）升级到 v0.1.4 gate：洁净产物 PASS + 12 项失败场景；`runtime-integration-evidence.json` 8 项 findings 全 false。
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm release`（十步）全绿；`review/BiliBlocker-v0.1.4-release-gate.py` PASS。

## [0.1.3] - 2026-08-13

第三轮整改版（Stage-E 候选）：可信发布证据链、本地动作能力优先、零官方任务取消窗口、取消/撤权状态机、队列安全状态持久化、StorageCoordinator 统一写。

### 修复
- **P0-1 可信发布证据链**：`pnpm release` 重写为 10 步（新增 source-integrity / source-rebuild / 新 gate）；`scripts/source-rebuild.mjs` 从 Source ZIP 干净重建并逐项比较（Manifest 全字段/文件集合/内容哈希/权限/matches/能力关闭/测试数量）；`review/BiliBlocker-v0.1.3-release-gate.py` 真实执行 Source 逐文件内容比较，校验 sourceArchiveSha256/lockfileSha256/十步 exitCode/十份日志/RELEASE-EVIDENCE/Manifest 洁净性/真实能力关闭；`docs/REMEDIATION-TRACE-v0.1.3.md` 打包前冻结；`dist/RELEASE-EVIDENCE.json` 打包后生成（不进入 Source ZIP，消除自引用证据）。
- **P0-2 本地动作先能力过滤后登录检查**：`resolveExecutableOfficialTasks()` 先做能力/理由/类型门禁，`executableOfficialTasks.length > 0` 才 checkLogin；全部能力关闭时本地折叠/黑名单/已确认名单仍完成且不触发登录检查；零官方任务不绕过可取消倒计时（`hasReversibleSideEffect = fold || commitLocalBlock || commitVerified || officialTasks.length > 0`）。
- **P0-3/P0-5 取消与撤权状态机**：`queued + cancel → cancelled`（executor 从未被调用）；`in_flight + cancel/revoke/reset/clear → unknown_outcome`（真实结果保留、不覆盖、不自动重发、写审计并人工核对）；succeeded 永不显示已取消；统一撤权流程 `revoke()`（epoch++、queued→cancelled 记录原因、in_flight→unknown_outcome、落盘后才返回、清空后旧任务不复活）。
- **P0-4 原子动作提交**：删除跨倒计时长生命周期事务（transactions Map / beginTx/commitTx/rollbackTx / `shortId('tx')` 降级）；新增 `BB_COMMIT_ACTION`：background 单所有者短事务内一次 `backend.set` 原子写入名单+队列（全成功或全失败）；重复 UID 普通添加为 no-op（保留原 blockedAt/source/reason）。
- **P0-5 持久化队列安全状态**：新增 `bb.queueControl`（paused/pauseReason/pauseKind/requiresExplicitResume/authorizationEpoch/recentAttempts）；risk_control 只能用户显式恢复、跨 SW 重启保持；登录暂停可在已验证重新登录后恢复；速率预算每次发送尝试先持久化（crash-safe）；派发前逐项重新验证（总开关/授权/能力/理由/内容类型/epoch/白名单/暂停）。
- **P1-1 所有写入收归 StorageCoordinator**：新增 `src/storage/coordinator.ts` 唯一写入口（全局写锁、可重入）；content/popup/options 只读实例（`allowWrites:false`，写方法抛错）；队列/去重/审计/队列控制写入经协调器；移除 content `repo.saveRules`、popup `repo.updateSettings`、options `repo.clearAudit` 等直接写。
- **P1-2 UI 状态表达**：新增「仅临时折叠/仅本地处理完成（未发送任何请求）/已排队/已派发/服务端确认/取消确认未发送/结果未知/因撤权跳过/因能力未验证跳过/因风控暂停/本地提交失败」等明确文案。

### 测试
- 单元/DOM 302 个（Vitest）+ E2E 21 个（Playwright）：新增本地关闭态（10.1）、队列撤权与取消（10.2）、SW 恢复（10.3）、写协调与并发（10.4）、发布完整性 12 项 gate 场景（10.5）；E2E 新增未登录本地流程、倒计时取消、撤权后 queued 不执行、clear 不复活、unknown_outcome UI。

## [0.1.2] - 2026-08-13

第二轮复验整改版：MatchTrace 因果证据、动作计划矩阵、不可逆举报 unknown_outcome 恢复、跨 Tab 原子事务、统一写并发模型。

### 修复
- **P0-1 规则求值因果路径（MatchTrace）**：`evaluateConditionWithTrace / evaluateGroupWithTrace / evaluateRuleWithTrace` 返回结构化 trace（哪个叶子对最终 true 有贡献）；AND 收集全部真实贡献叶子、OR 只收集命中分支、NOT 内部叶子绝不成为正向证据；反向运算符（ne/not_contains/not_exists）永远 positivePolarity=false；`buildEvidence()` 只消费 MatchTrace，不再遍历整棵条件树猜测证据 —— OR 未命中内容分支 / NOT(content contains x) / not_contains 不再伪造内容违规证据。
- **P0-2 动作计划矩阵（ActionExecutionPlan）**：`commitLocalBlock / commitVerified / enqueueOfficialBlock / enqueueReport` 四维独立，单一映射函数 `mapActionMatrix`；禁止 `block: officialBlock || localBlock` 混写；local_block_verified_uid 不再隐式加入已确认名单；官方拉黑但不举报的本地/确认副作用由明确常量决定；登录边界：本地折叠/本地黑名单/规则执行不要求登录，仅官方动作需要；任务数为 0 时显示「仅本地处理完成；官方能力尚未验证，本次未发送任何请求」。
- **P0-3 unknown_outcome 队列恢复**：SW 崩溃时 in_flight 任务（尤其不可逆举报）可能已发送但结果未知 → 恢复为 `unknown_outcome`，**绝不自动重发**，写审计并提示人工核对；不登记为已成功举报；in_flight block/unblock 无幂等证明同样转 unknown_outcome；`onTaskDone` 只在终态或 unknown_outcome 调用一次（网络重试中间态不写「任务完成」审计）；每次发送请求（含失败）计入每分钟速率；duplicate 响应同步更新 dedup；终态 TTL 与持久化一致；设置页可筛选查看「结果未知」记录。
- **P1-1 跨 Tab 原子事务**：before 快照、名单提交、事务归属、补偿回滚全部在 background；每次动作生成 operationId，写入时记录「本次实际创建」的条目与版本快照；补偿只删除同一 operationId 创建且版本未变化的记录 —— 双 Tab 同 UID 一方回滚不会误删另一方记录。
- **P1-2 KeyMutex 尾队列清理**：统一为 `src/storage/key-mutex.ts`（保存 tail 引用再比较），修复 tails Map 永不清理的内存泄漏。
- **P1-3 统一写并发模型**：settings/rules/名单/审计/导入/reset/clear 全部经 background 全局写锁（`withGlobalWrite`）串行；importAll/reset/clear 与普通写互斥；settings/rules 支持 revision/CAS 拒绝过期覆盖；`write()` 先写 backend 成功后再更新 cache（失败时 cache 保持旧值）。
- **P1-4 完整导入恢复 settings**：`toEntities()` 保留并验证 settings（缺字段用默认值补全）；export → mutate → import 可完整恢复设置。
- **P1-5 Observer 自身与后代**：节点自身为目标后仍继续扫描后代；不因父节点是目标跳过合法嵌套后代；WeakSet 去重保证每个节点只处理一次。
- **P1-6 runtime message 信任边界**：`importAll.data` 使用完整 Zod Schema（不再 `z.unknown()`）；每次任务派发生成一次性 `executionToken`，结果必须同时匹配 taskId/tabId/frameId/frameNonce/executionToken；sender 缺少 tab/frame 直接拒绝；token 只消费一次并有超时。
- **P1-7 正则 Worker 保存硬门禁**：每个 regex 条件持久化 Worker 验证状态与被验证的 pattern/样例；pattern/样例/条件变化后状态失效；Worker 超时/失败/不可用时不能保存启用状态的 regex 规则；无 Worker 不得显示「已通过 Worker」；可保存 disabled 草稿但明确标注。
- **P1-8 队列审计语义对齐**：retry 中间态不写「任务完成」审计；BB_TASK_DONE 使用任务自身的 groupId（不混用 taskId）；terminal TTL 注释与实现一致；unknown_outcome 可在设置页查看与筛选。

### 测试
- 单元/DOM fixture 267 个（Vitest）+ E2E 16 个（Playwright）：新增 MatchTrace 因果证据（OR/NOT/反向运算符 11 条）、动作计划矩阵（7 条）、unknown_outcome 恢复（3 条）、跨 Tab 事务（6 条）、全局写锁与 revision/CAS（5 条）、KeyMutex 清理（4 条）、import 恢复 settings（3 条）、executionToken 归属校验（9 条）、正则 Worker 保存门禁（10 条）；原 15 个失败测试（阶段 A 复现）修复后全部转绿。

## [0.1.1] - 2026-08-13

整改版：可回滚事务、能力硬门禁、构建隔离与发布门禁、storage 一致性。

### 修复
- **P0-2 一键事务可回滚**：倒计时结束前不写入名单/不发请求；新增「取消全部操作」（完整回滚：无名单写入、节点恢复）与「仅取消官方任务」（保留本地记录）两种取消；commit 失败按补偿回滚；before 快照防止误删原有 blocked/verified 记录（E2E 覆盖 4 条事务路径）。
- **P0-3 证据模型**：举报动作计划基于「账号授权证据（exact_uid/user_confirmation）+ 独立内容违规证据（content/links/linkDomains/hasLinks 字段命中且带可举报类别）」；UID/username/reportCategory 标签不再冒充内容违规证据；已确认机器人发布的普通内容禁止自动举报。
- **P0-4 真实能力硬门禁**：blockUser/unblockUser/各内容类型举报/选择器均有独立 Verification（引用 REAL-ACCOUNT-VALIDATION-RECORD.md 证据编号）；生产构建中未验证能力拒绝发送真实请求（适配器层二次兜底），设置页展示未验证状态并禁用授权；E2E 构建经 vite define 整体放行且与生产编译隔离。
- **P1-1 storage 一致性**：跨上下文名单/审计/导入 RMW 统一经 background 的 BB_MUTATE_LIST 串行执行；storage.onChanged 遍历全部键失效缓存；import/reset/clear 广播 BB_REFRESH_DATA；批量写入原子（新增/重复/无效计数，无效整包拒绝）。
- **P1-2 MutationObserver 后代扫描**：新增节点子树内用集中选择器查询目标（不扫全 document），wrapper 一次加入 20 条评论全部处理且不重复（E2E A-02）。
- **P1-3 正则与条件树安全**：导入强制 RegexSafety 校验（危险正则整包拒绝）；条件树深度/总数上限；设置页正则经独立 Worker 时间预算测试。
- **P1-4 统一名单导入**：字节上限/原型污染剥离/schema 校验/预览确认，任一无效整包拒绝。
- **P1-5 精确 UID 规范化**：根级或任意层级 NOT/OR 一律拒绝、必须恰好一个 UID eq 正整数、多 UID/非正整数/isVerifiedMachine=false/嵌套组均拒绝（19 条边界表）。
- **P1-6 消息协议 Zod 化**：全部 runtime message discriminated union 强校验（字段范围/发送上下文/任务归属）；任务 maxAttempts 语义修正（总执行次数，消除 off-by-one）；failed/cancelled 终态按 TTL 清理；公开 kick() 供 alarm 兜底；任务派发前验证 tab 存在 + 帧会话 nonce + 页面 URL。
- **P0-1 构建隔离与发布门禁**：E2E=1 输出独立 out-e2e/（绝不触碰 out/）；生产 manifest 门禁（matches 恰为 https://www.bilibili.com/*、权限恰为 [storage,alarms]、无 localhost/.e2e 痕迹）；`scripts/package.mjs` 强制清理重建 + 官方 wxt zip + 跨平台 source zip + SHA256SUMS；`review/release_gate.py` 发布复验。
- **P0-5 SPA 路由观察器单例**：history 补丁全局只安装一次，监听器具名完整卸载，50 次 pushState 无监听器增长。

### 测试
- 单元/DOM fixture 209 个（Vitest）+ E2E 16 个（Playwright）：新增证据模型、能力门禁、精确 UID 边界表、
  队列精确执行次数、storage 一致性、名单导入安全、消息校验、观察器（SPA 导航/后代扫描）、
  /dynamic/{id} 与 /opus/{id} fixture、双 tab 并发名单一致性、外部名单变更即时生效等。

## [0.1.0] - 2026-08-13

首个版本（首版定义完成）。

### 新增
- 页面适配：视频一级评论、楼中楼回复、动态首页卡片、动态详情（/dynamic/ 与 /opus/）、动态评论；
  SPA 路由切换与无限滚动支持；选择器集中管理（多候选回退）。
- 规则引擎：全部运算符（eq/ne/contains/not_contains/prefix/suffix/regex/exists/not_exists）、
  AND/OR/NOT 条件组、优先级、页面/内容类型过滤、动作权限校验（疑似/官方动作边界）。
- 名单：本地黑名单、已确认机器人名单、白名单（白名单覆盖一切；本人账号永不处理）。
- 快捷操作：每条内容右上角「一键拉黑并举报」+ 更多菜单（仅隐藏/本页隐藏/白名单/标记机器人/仅拉黑/拉黑并举报/命中规则/操作记录）。
- 一键流程：立即折叠 → 本地名单 → 可取消倒计时 → 官方拉黑 → 自动举报；状态分别展示。
- 自动处理已确认机器人（默认关闭）：精确 UID + 内容违规 + 授权 + 可取消倒计时。
- 后台队列：拉黑/举报分离、串行执行、每分钟限流、网络错误有限重试、
  登录失效/风控暂停、SW 回收恢复、alarms 兜底。
- 去重：同 UID 不重复拉黑；同内容同理由不重复举报。
- 审计日志：本地保存、筛选、导出（脱敏，不含正文）。
- 设置页（Vue 3）：总开关/页面开关/疑似处理方式/按钮显示/授权/默认理由/自动处理开关/倒计时、
  规则表单化编辑器（含正则校验与测试面板）、名单管理、日志、导入导出、恢复默认、清空数据、隐私与权限说明。
- 弹窗：总开关、名单统计、队列状态、快捷入口。
- 测试：93 个单元/DOM fixture 测试（Vitest）+ 8 个 E2E 场景（Playwright，本地 fixture + Mock）。
- 构建：Chrome/Edge MV3 双目标、商店 ZIP、Source ZIP、SHA256SUMS、build-info.json。

### 已知限制（如实标注）
- Bilibili 官方接口行为（拉黑/举报参数、举报理由枚举、动态举报端点）尚未经真实账号人工验收，
  详见 docs/bilibili-research.md 与 docs/manual-test.md；验收通过前相关功能标注 UNVERIFIED。
- 页面选择器基于社区文档与历史结构整理，页面改版时需按 docs/manual-test.md 更新 selectors.ts。

### 安全
- 权限最小化：仅 storage + alarms + www.bilibili.com 内容脚本；无 cookies/webRequest/`<all_urls>`。
- 无遥测、无远程代码、无第三方请求；日志不含正文；导入导出防原型污染与超大文件。

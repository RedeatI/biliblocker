# 架构设计（BiliBlocker v0.1.x）

> 更新：2026-08-13（v0.1.4：WriteLease 显式锁模型、每任务授权快照、单调 epoch
> 原子播种、unknown_outcome 持久证据、crash-safe 暂停、operationId 幂等；
> v0.1.3：发布证据链 10 步流水线、BB_COMMIT_ACTION 原子提交、取消/撤权状态机、
> QueueControlState 持久化、StorageCoordinator 唯一写入口）

## 1. 技术栈与理由

| 选型 | 理由 |
|---|---|
| Manifest V3 | Chrome/Edge 现行标准；Service Worker 取代后台页 |
| TypeScript（strict） | 类型安全；本项目在 strict + noUncheckedIndexedAccess 下通过 tsc --noEmit |
| WXT（0.20.x，outDir 按构建模式隔离） | 统一 Chrome/Edge 构建、自动生成 manifest、类型化入口；`-b chrome/edge` 输出 `out/chrome-mv3` / `out/edge-mv3`；`E2E=1` 输出独立目录 `out-e2e/<browser>-mv3`（生产输出不被 E2E 污染） |
| Vue 3（options/popup） | 表单化规则编辑器与设置页的开发效率 |
| 轻量响应式 store（非 Pinia） | 设置页状态仅 6 个集合，引入 Pinia 无收益（决策记录在案） |
| Zod（3.x） | 规则/导入数据/消息协议（discriminated union）的 Schema 校验（含严格模式防未知键） |
| Vitest + happy-dom + Playwright | 单元/DOM fixture/E2E 三层测试 |
| ESLint(9 flat)+Prettier | 静态检查与格式化（lint 零告警通过） |

## 2. 模块职责与依赖方向

```
shared/         类型、常量（品牌/限额/举报理由）、消息协议、工具（纯函数，无 DOM）
storage/        StorageBackend 抽象 + StorageRepository（chrome.storage.local 类型化访问）
rules/          Zod Schema、正则安全、求值器、规则引擎（权限校验）、默认规则、导入导出、迁移
actions/        ActionPolicyEngine（双重条件校验）、DeduplicationRegistry、ActionQueue（串行/限流/持久化）
adapters/       页面适配（评论/动态/选择器）+ Bilibili 官方操作适配（block/report/auth/api 客户端）
ui/             快捷按钮（Shadow DOM）、占位条、Toast（均为内容脚本侧 UI）
entrypoints/    background（队列中枢）、content（编排器+观察器）、options、popup
```

依赖方向严格自上而下：`entrypoints → ui/adapters/actions → rules/storage → shared`，禁止反向依赖。

## 3. 关键组件设计

### 3.1 RuleEngine（`src/rules/engine.ts`）
- 求值：`ContentContext` → 条件组（and/or/not 递归）→ 匹配规则按优先级降序 → 最高优先级决定动作；
- 动作权限校验 `isActionAllowed`：
  - 疑似类动作（flag/collapse/hide/notify/suggest）任意内容规则可用；
  - 官方动作（local_block/official_block/report）**仅精确 UID 规则（uid eq + 可选 isVerifiedMachine eq）且 UID 在已确认机器人名单**时可用；
  - report 动作还要求规则带可举报类别（内容违规依据）；
- 硬性短路：白名单、当前登录用户（engine 与 policy 双层）。

### 3.2 ActionPolicyEngine（`src/actions/policy.ts`）+ 证据模型（`src/rules/evidence.ts`）
- `canBlock`：缺 UID/自己/白名单/未登录 一律拒绝；
- `canReport`（自动举报唯一入口）：**账号条件**（用户一键确认 **或** exact-UID 账号授权证据+自动处理开关）∧ **内容条件**（用户确认 **或** 独立内容违规证据）∧ 授权 ∧ 有效理由 ∧ 有内容 ID ∧ 已登录；
- 证据模型（P0-3）：`RuleEvidence = 账号授权证据（exact_uid / user_confirmation）+ 内容违规证据（content/links/linkDomains/hasLinks 字段命中且带 ad/spam/fraud 类别）`；
  - UID / isVerifiedMachine / username 单独命中、或 reportCategory 标签本身，**不构成内容违规证据**（标签不得冒充当前内容证据）；
  - 已确认机器人发布的普通内容最多隐藏/拉黑，禁止自动举报（无独立内容证据）。

### 3.3 ActionQueue（`src/actions/queue.ts`，运行于 background）
- 拉黑/举报队列分离，各自并发 1（严格串行）；每分钟上限：拉黑 15、举报 8；
- 任务持久化于 `bb.queue`：SW 被回收后重启自动恢复（**v0.1.3：in_flight → unknown_outcome，绝不自动重发**；queued 恢复执行，attempts 钳制为 maxAttempts-1）；
- **maxAttempts = 总执行次数**（消除 off-by-one）：网络错误仅在 attempts < maxAttempts 时重试；block 最多 3 次、report 默认 1 次（不重试，防“响应丢失但服务端已受理”重复举报）；服务端拒绝（风控/未登录/理由失效）不重试；
- failed/cancelled/skipped/unknown_outcome 终态任务按 TTL（7 天）清理，不永久留在活动队列；
- 登录失效/风控 → 暂停队列并通知页面；alarms 每分钟调用公开 `kick()` 兜底推进退避任务；
- 去重：入队时检查持久化去重表 + 队列内同键任务；成功后再登记去重；
- **v0.1.3 取消状态机**：`queued + cancel → cancelled`（executor 从未被调用，确认未发送）；
  `in_flight + cancel/revoke/reset/clear → unknown_outcome`（真实结果保留、不覆盖、
  不自动重发、写审计并要求人工核对）；`succeeded` 永不显示为已取消；
- **v0.1.3 统一撤权流程 `revoke()`**：authorizationEpoch++；queued → cancelled（记录具体原因）；
  in_flight → unknown_outcome；可选暂停（authorization_revoked）/清空；落盘后才返回；
  清空后内存队列代际递增，旧任务不复活；
- **v0.1.3 派发前逐项重新验证 `verifyTaskEligible()`**：总开关、自动举报授权、自动处理开关、
  能力验证（isCapabilityEnabled）、理由验证（REPORT_REASONS.verified + isValidReason +
  resolveDefaultReason）、内容类型、授权 epoch（task.authorization vs control.authorizationEpoch）、
  用户白名单、暂停状态；不满足 → skipped（executor 不被调用）；
- **v0.1.3 QueueControlState（`bb.queueControl`）持久化**：paused/pauseReason/pauseKind/
  pausedAt/requiresExplicitResume/authorizationEpoch/recentAttempts；risk_control 只能用户
  显式恢复、跨 SW 重启保持；login 暂停可在已验证重新登录后恢复；速率预算每次发送尝试
  **先持久化**（crash-safe，重启后恢复最近 60 秒预算）；ActionQueue 构造/启动不默认恢复未暂停。

### 3.4 官方操作适配器（`src/adapters/bilibili/`）
- `BilibiliBlockAdapter` / `BilibiliReportAdapter` / `BilibiliAuthStateAdapter` 独立封装；
- **为什么在内容脚本发请求**：fetch 携带页面同源 Cookie（无需 cookies 权限），api.bilibili.com 对 bilibili.com 源开放 CORS（页面自身前端同方式调用）；后台只做编排，不直接请求 Bilibili 接口 → 不需要 host_permissions 与 cookies 权限；
- 统一结果模型 `TaskResult {ok,status,code,message,errorType}`；`classifyApiCode` 归类 -101 未登录 / -352 风控 / -403 / -404 接口变更等；
- **P0-4 能力硬门禁**：blockUser/unblockUser/各内容类型举报/选择器 均在 `src/shared/capabilities.ts` 有独立 Verification 记录（引用 docs/REAL-ACCOUNT-VALIDATION-RECORD.md 证据编号）；未验证能力在**生产构建**中拒绝发送真实请求（适配器层再次兜底）；E2E/Mock 构建经 vite define（`__BILIBLOCKER_E2E__`）整体放行，生产包不包含该路径。

### 3.5 内容脚本编排（`src/entrypoints/content/app.ts` + observer.ts）
- `PageObserver`：body 级 MutationObserver 只处理新增目标节点、40ms 批量、每批 300、分片 yield；**P1-2 后代扫描**：对新增节点先查自身、再在其子树内用集中选择器（selectors.ts）查询目标后代（不扫全 document）；
- **P0-5 SPA 路由观察器单例**：history 补丁全局只安装一次（RouterObserver 单例）；`stop()` 完整卸载具名监听器、回调立即失效；页面切换只重建 DOM observer，不创建新的 history wrapper（50 次 pushState 测试无监听器增长）；
- 处理管线：提取 → 构建 Context → 规则求值 → 注入快捷按钮（先注入，占位条 canOfficial 依赖上下文）→ 隐藏/占位 → 自动处理；
- **v0.1.3 一键流程（能力优先 + 原子提交）**：`resolveExecutableOfficialTasks()` 先做
  能力/理由/类型门禁得到可执行官方任务（**不触发登录检查**）；`executableOfficialTasks.length > 0`
  才 checkLogin；`hasReversibleSideEffect = fold || commitLocalBlock || commitVerified ||
  officialTasks.length > 0` 决定必须显示可取消倒计时（零官方任务也不跳过）；倒计时前不写名单、
  不入队、仅临时视觉预览；倒计时结束后经 `BB_COMMIT_ACTION` 在 background 单所有者短事务内
  一次原子写入（名单+队列单次 `backend.set`，全成功或全失败）；background 不可用 → 失败且零副作用；
- 自动处理已确认机器人：仅当 开关+授权+exact-UID 账号证据+独立内容违规证据+有内容 ID+登录 全满足，且带倒计时；同内容同页不重复触发（内存集合）。

### 3.6 UI 隔离
- 快捷按钮、Toast：Shadow DOM（open），样式完全隔离；菜单焦点外关闭用 shadow 感知包含判断（`host.contains` 不穿透 shadow root）；
- 占位条：页面 DOM + `bb-` 命名空间样式（style 注入 document.head），文本一律 textContent；
- 页面级样式仅两条命名空间规则（`.bb-anchor` 定位、`.bb-quick-host` 显隐）。

## 4. 数据存储（chrome.storage.local，版本化）

| 键 | 内容 |
|---|---|
| `bb.meta` | schemaVersion / seededAt / lastMigratedAt |
| `bb.settings` | 总开关、页面开关、疑似处理、按钮显示、自动举报授权、默认理由、自动处理开关、倒计时 |
| `bb.rules` | 规则数组（上限 300） |
| `bb.blocked` / `bb.verified` / `bb.whitelist` | 名单数组（上限 2 万/2 万/5 千） |
| `bb.dedup` | 去重表（block:uid、report:uid:type:id:reason，TTL 30 天/365 天，最多 5000 条） |
| `bb.queue` | 队列持久化（未完成任务 + TTL 内终态任务供审计） |
| `bb.queueControl` | **v0.1.3** 队列安全状态（paused/pauseReason/pauseKind/requiresExplicitResume/authorizationEpoch/recentAttempts），跨 SW 重启持久；**v0.1.4** init 读回不覆盖 |
| `bb.unknownOutcomes` | **v0.1.4** 不可逆操作「结果未知」持久证据墓碑（幂等 upsert；未核对不删；已核对 30 天 TTL；reset/clear 不删） |
| `bb.operationOutcomes` | **v0.1.4** operationId 幂等结果（绑定指纹 + result + ts；TTL 30 分钟；容量 200） |
| `bb.audit` | 审计日志（上限 2000，不含正文；reset/clear/clearAudit 保留 outcomeUnknown 条目） |

一致性（P1-1，v0.1.3 收归 StorageCoordinator；v0.1.4 WriteLease 显式锁模型）：
- **v0.1.3：所有写入只有一个所有者** —— background 的 `StorageCoordinator`（`src/storage/coordinator.ts`，
  全局写锁 + 固定锁顺序）；content/popup/options 的 `StorageRepository` 以 `allowWrites:false`
  构造（写方法抛错），只能发强类型消息；队列/去重/审计/队列控制写入统一经协调器；
  `BB_COMMIT_ACTION` 多键原子提交（名单+队列单次 `backend.set`）；
- **v0.1.4（P0-1）显式 WriteLease**：删除共享 `inLock` 布尔；所有公共 `execute()` 无条件
  `repo.withGlobalWrite((lease)=>…)`（KeyMutex 串行，外部命令永不绕过）；`repository.withGlobalWrite`
  回调接收显式 `WriteLease={token:symbol}`；协调器持有 `currentLease`（仅 inside withGlobalWrite 时设置），
  队列/去重/审计 writer 由协调器注入：锁内（lease 匹配）直接写 repo、锁外经公共 execute 排队；
- **v0.1.4（P0-2）每任务授权快照**：`AuthorizationSnapshot` 8 字段必填（epoch/settingsRevision/
  reasonId/capabilityKey/contentType/source/autoProcessAuthorized/reportAuthorized/createdAt）；
  commitAction 把快照显式传给 planEnqueue/buildTask 并持久化；派发前逐项比较当前
  settings/control/capabilities/reasons/whitelist；缺快照的旧任务迁移时转 skipped/unknown；
- **v0.1.4（P0-3）reset/clear 单调 epoch + 原子播种**：`resetAndClear()` 同锁内 oldEpoch+1、
  单次 commitSnapshot 原子写最终快照；clear 后最小种子（meta/settings/queueControl）立即存在；
  内存队列仅在 backend 成功后采用同一快照；`repo.init()` get 列表含 queueControl/revisions
  （SW 重启不覆盖持久化暂停/版本）；
- **v0.1.4（P0-4）unknown_outcome 持久证据**：`bb.unknownOutcomes` 独立墓碑（幂等 upsert、
  未核对不删、已核对 30 天 TTL、acknowledge 只标记不改写）；reset/clear 保留墓碑与
  outcomeUnknown 审计；`bb.operationOutcomes` 持久化 operationId 幂等结果（TTL 30min/容量 200）；
- **v0.1.4（P0-5）pause crash-safe**：`pause()` async 且返回前 await saveControl；
  runTask 对 login_invalid/risk_control await；保存失败 fail-closed 停 pump；
- **v0.1.4（5.1~5.5）**：commitAction 检查持久化 queue control（paused 拒绝创建官方任务，
  `canEnqueueOfficialTask` 统一策略）；auto-process 本地动作不依赖缓存登录；删除 `BB_ENQUEUE`；
  `FrameRegistry` 区分 not_registered/nonce_mismatch/not_bilibili（10s 宽限期等待重新注册）；
- 单实例内每键互斥（KeyMutex）串行 read-modify-write；
- 跨上下文（多 tab/设置页）的名单/审计/导入 RMW 统一经 background 协调器串行执行；
- `storage.onChanged` 遍历**全部**变化键并使缓存失效（不只处理第一个键）；import/reset/clear 后广播 `BB_REFRESH_DATA` 全量刷新；
- 批量写入（addBlockedBatch 等）一次提交：返回新增/重复/无效数量，存在无效条目时整包拒绝（不部分写入）；导入解析统一 `parseListImport`（字节上限/原型污染剥离/schema 校验）。

迁移：`rules/migrations.ts` 版本化幂等迁移；导入导出走 Zod 严格校验 + 原型污染剥离 + 大小限制 + **正则安全校验（RegexSafety）与条件树限制（深度/总数）**。

## 5. 消息协议（`src/shared/messages.ts`）

- **P1-6 全部消息为 Zod discriminated union**：字段类型/范围（uid 正整数、reasonId 整数、任务枚举等）在接收方强校验；发送上下文校验（tabId/frameId 由 background 从 sender 推导，内容脚本不发送、不信任）；
- content → background：`BB_PING`（帧身份注册：nonce+url）`BB_LOGIN` / `BB_CANCEL_TASKS` / `BB_EXECUTE_RESULT` / `BB_QUEUE_STATUS_REQ` / `BB_OPEN_OPTIONS` / **`BB_MUTATE_LIST`**（名单/审计/导入串行变更） / **`BB_COMMIT_ACTION`**（一键原子提交+授权快照+operationId 幂等）；
  - v0.1.4：**`BB_ENQUEUE` 已删除**（无保护入队通道关闭）；官方任务唯一创建路径为 `BB_COMMIT_ACTION`；
- background → content：`BB_EXECUTE_TASK` / `BB_TASK_DONE` / `BB_TASK_CANCELLED` / `BB_QUEUE_PAUSED` / `BB_QUEUE_RESUMED` / `BB_NOTIFY` / **`BB_REFRESH_DATA`**；
- **P1-6 任务归属校验**：派发前验证 tab 存在、帧会话 nonce 匹配、页面 URL 为 Bilibili（无 tabs 权限时以内容脚本自报 URL 为准；E2E 允许 localhost fixture）；BB_EXECUTE_RESULT 只能来自任务派发页面；
- 接收方校验消息结构；background 用 sender 校验来源（onMessageExternal 一律拒绝）。

## 6. 已知决策记录

1. 页面 UI 用轻量 store 而非 Pinia（集合小、无共享缓存需求）。
2. 举报任务网络错误不重试（防重复提交），拉黑最多重试 3 次（maxAttempts=3，幂等无副作用）。
3. 动态评论举报 type 暂按社区文档取 17（带图动态 11、专栏 12 视内容），UNVERIFIED，人工验收时修正（改 `report.ts` 常量）。
4. 占位条用页面 DOM 而非 Shadow DOM：需与宿主卡片并列插入且不破坏 Bilibili 布局，命名空间样式风险可控。
5. WXT 输出目录按构建模式隔离：生产 `out`、E2E `out-e2e`（wxt.config 由 `scripts/build-mode.mjs` 决策，单测覆盖）。
6. E2E 构建经 vite define 注入 `__BILIBLOCKER_E2E__`（`vite: () => viteDefine(mode)`），生产构建恒为 false；生产 manifest 门禁（matches/权限/无 localhost）由 `scripts/production-gate.mjs` + `review/release_gate.py` 双重复核。

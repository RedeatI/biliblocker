# BiliBlocker v0.1.0 发布验收缺陷基线

> 本文档是 v0.1.0 发布验收的**唯一缺陷基线**（由 v0.1.1 整改指令重建，2026-08-13）。
> 所有缺陷按 P0/P1 分级；任何 P0 未关闭时不得生成发布候选。
> 整改状态追踪见 docs/REMEDIATION-TRACE-v0.1.1.md。
>
> **整改状态（2026-08-13）：全部 P0/P1 已关闭**，每项均有对应实现与测试证据（见各节「关闭证据」与
> docs/REMEDIATION-TRACE-v0.1.1.md）。剩余约束仅剩阶段 4「真实账号验证」（须人工在真实浏览器完成，
> 未验证能力在生产构建中被硬门禁拦截，不影响发布候选生成）。

## P0 缺陷（发布阻断）

### P0-1 E2E 与生产构建未分离
> 状态：✅ 已关闭
> 关闭证据：`wxt.config.ts` 由 `scripts/build-mode.mjs` 决策输出目录（E2E=1 → out-e2e/）；`scripts/production-gate.mjs` 生产洁净门禁（matches 恰为 https://www.bilibili.com/*、权限恰为 [storage,alarms]、拒绝 .e2e-built/localhost/127.0.0.1、全文件扫描）；`scripts/package.mjs` 强制清理重建 + `wxt zip` 官方流程 + 跨平台零依赖 zip-util；`review/release_gate.py` 复验；新增单测 release-manifest（10 条门禁边界）、e2e-output-isolation、release-gate（人为注入 localhost/.e2e-built 时 FAIL）。
- 现状：`E2E=1` 时 wxt.config.ts 的 `build:manifestGenerated` hook 直接向 `out/chrome-mv3` 的内容脚本 matches 追加 localhost/127.0.0.1；E2E global-setup 直接构建并写入 `out/chrome-mv3` 并打 `.e2e-built` 标记。
- 后果：生产产物可能残留 E2E 痕迹（`.e2e-built`、localhost matches），store 审核与安全审计不合格。
- 验收要求：
  - E2E 构建输出到独立目录（如 `out-e2e/chrome-mv3`），E2E=1 绝不修改 `out/chrome-mv3`、`out/edge-mv3`。
  - production 构建前强制清理生产输出。
  - 打包前检查并拒绝：`.e2e-built`、`localhost`、`127.0.0.1`、非 `https://www.bilibili.com/*` 的内容脚本 matches、非预期 permissions/host_permissions。
  - 优先采用 WXT 官方 production ZIP 流程（`wxt zip` / `wxt zip -b edge`），不得依赖已有目录「看起来能解析」就跳过构建。
  - 打包流程必须跨平台；不得硬编码 powershell.exe 和 pnpm.cmd 作为唯一实现。
  - 新增测试：release-manifest（生产 manifest 只含 Bilibili）、e2e-output-isolation（E2E 输出不触碰生产目录）、release-gate（人为加入 localhost/.e2e-built 时门禁必须失败）。

### P0-2 一键操作事务不可回滚
> 状态：✅ 已关闭
> 关闭证据：`src/entrypoints/content/app.ts` runActionFlow 重写为可回滚事务（before 快照 → 临时折叠 → 双取消倒计时 → 提交本地名单（失败补偿回滚）→ 入队）；取消全部 = 无名单写入、无请求、节点恢复；E2E 新增 4 条事务路径（新 UID 取消/原本 blocked 取消/原本 verified 取消/倒计时结束后才持久化）。
- 现状：`runActionFlow()` 在倒计时开始前就永久写入 blocked/verified（`repo.addBlocked` / `repo.addVerified`）；取消只跳过入队，不恢复名单与 UI。
- 后果：取消后 UID 仍留在本地黑名单/已确认名单，与用户「取消」意图相悖；对已存在名单中的 UID，取消后原记录被覆盖或无法区分。
- 验收要求：
  - 倒计时开始前不得永久写入 blocked/verified。
  - 临时折叠必须记录原始 UI 状态。
  - 取消后必须恢复：当前节点显示状态、blocked 原状态、verified 原状态、临时任务。
  - 倒计时结束后再提交本地变更并入队；本地提交中途失败需补偿回滚。
  - 对已存在于名单中的 UID，取消不能误删用户原有记录；必须保存 before snapshot。
  - UI 文案区分「取消全部操作」和「仅取消尚未发送的官方任务」。
  - 新增 E2E：新 UID 取消（无请求、无 blocked、无 verified、节点恢复）；原本已 blocked 未 verified 取消后保持原状态；原本已 verified 取消后不得删除原记录；倒计时结束后才出现持久化名单。

### P0-3 规则动作执行链与证据模型缺失
> 状态：✅ 已关闭
> 关闭证据：`src/rules/evidence.ts`（RuleEvidence/ActionPlan/buildEvidence/buildActionPlan；内容证据字段白名单 CONTENT_EVIDENCE_FIELDS；user_confirmation 双证据；actionPlan 副作用校验）；`src/actions/policy.ts` 重写（账号条件 ∧ 独立内容条件）；单测 evidence.test.ts（14 条）+ policy.test.ts（21 条）。
- 现状：policy 使用布尔 `contentViolation`，`hasReportableContent()` 只看 reportCategory 标签；引擎不产出结构化证据；官方动作副作用未逐项验证。
- 后果：UID 单独命中 + reportCategory 标签可能伪装成内容违规；自动举报缺乏「独立内容违规证据」硬性要求；`local_block_verified_uid` 是否实际写名单未验证。
- 验收要求（引入明确类型）：
  - `RuleEvidence`：`accountAuthorization`（exact_uid | user_confirmation）+ `contentViolation`（ruleId、category: ad|spam|fraud、fields: content|links|linkDomains|hasLinks）。
  - `ActionPlan`：collapse/hide/localBlock/officialBlock/report + evidence。
  - UID、isVerifiedMachine、pageScope、contentType、username 单独命中不得构成内容违规证据。
  - 举报必须同时拥有账号授权证据和独立内容违规证据；用户本次点击可提供显式确认，自动流程不能。
  - `local_block_verified_uid` 必须实际写入本地名单。
  - `official_block_verified_uid` 必须只创建 block 任务。
  - `report_verified_uid_content` 必须创建 report 任务并要求独立违规证据。
  - 不允许用 reportCategory 标签本身冒充当前内容证据。
  - 已确认机器人发布的普通内容最多隐藏/拉黑，不举报。
  - 新增单测/E2E：UID-only + reportCategory=ad 不得举报普通内容；exact UID + 独立 content/link 违规规则才可自动举报；每种动作副作用单独验证；最高优先级规则与可叠加证据组合行为稳定。

### P0-4 真实能力硬门禁缺失
> 状态：✅ 已关闭（仅剩人工回填证据编号）
> 关闭证据：`src/shared/capabilities.ts`（CapabilityVerification 8 键 + E2E_FORCED 编译隔离 + contentTypeReportDecision + canReportContentType）；`vite: () => viteDefine(mode)` 注入 __BILIBLOCKER_E2E__；适配器（block.ts/report.ts）再次兜底拒绝未验证能力；设置页 OverviewTab 展示未验证原因并禁用授权；单测 capabilities.test.ts（12 条）。
- 现状：`REPORT_REASONS.verified=false`、`selectors VERIFICATION.selectorsVerified=false`，但代码中没有任何门禁阻止未验证能力发送真实请求；设置页可随意授权。
- 验收要求：
  - 细粒度配置：`CapabilityVerification`（blockUser/unblockUser/reportVideoComment/reportVideoReply/reportDynamicComment/reportDynamic/selectorsVideo/selectorsDynamic），每个能力一个 `Verification{verified, verifiedAt, evidenceId, browserVersion}`。
  - production 中任何未验证能力不得发送真实请求。
  - 设置页对未验证能力禁用授权/开关，并显示具体原因。
  - Mock/dev 模式可以保留，但必须由编译模式隔离，生产包不可切换到 Mock。
  - 验证必须引用 docs/REAL-ACCOUNT-VALIDATION-RECORD.md 中的证据编号。
  - 不同内容类型独立门禁；视频评论验证通过不能自动解锁动态举报。

### P0-5 SPA 路由观察器缺陷
> 状态：✅ 已关闭
> 关闭证据：`src/entrypoints/content/observer.ts` 重写（RouterObserver 单例：history 补丁全局一次、具名监听器 subscribe/unsubscribe、stop() 后回调失效；PageObserver 只重建 DOM 部分）；tests/dom/observer.test.ts（8 条：50 次 pushState 无增长、stop 失效、单例共享、后代扫描）。
- 现状：`PageObserver.patchHistory()` 每次 `start()` 都检查 `patched`（实例级），但每个实例都持有自己的 `checkNavigation` 闭包监听 `bb-location-changed`；`stop()` 后闭包监听不解除（window 级监听器泄漏）；`onNavigate` 中重建 observer 会再次 patchHistory（虽然 patched 标志防重复 wrap，但 window 监听器叠加）。
- 验收要求：
  - history 补丁全局只安装一次。
  - 监听器使用具名函数并可完整卸载。
  - 导航不创建新的全局 history wrapper。
  - `stop()` 后所有回调立即失效。
  - DOM observer 可以按页面范围重置，但 router observer 保持单例。
  - 连续 50 次 pushState/replaceState/popstate 后，每次导航仍只触发一次回调，无监听器增长、无重复注入。

## P1 缺陷

### P1-1 storage 一致性
> 状态：✅ 已关闭
> 关闭证据：`repository.ts` 增加 invalidate/applyExternalChanges（遍历全部变化键）、每键互斥 KeyMutex、批量原子写入；background 统一执行 BB_MUTATE_LIST 串行变更并广播 BB_REFRESH_DATA；options store 与 content app 均经 background 变更名单；测试 storage-consistency.test.ts（9 条）+ E2E A-08（双 tab 并发、外部白名单即时生效）。
- repository 长期缓存跨事件存活；`storage.onChanged` 只处理第一个键；名单/审计/去重/队列 read-modify-write 无串行化；import/reset/clear 后内容脚本不刷新。
- 要求：`invalidate(keys)` / `applyExternalChanges(changes)`；onChanged 遍历全部变化键；RMW 统一到 background 串行执行或每键互斥；import/reset/clear 后通知所有内容脚本刷新；测试：两 tab 同时添加不同 UID、全量导入多键、白名单修改后内容页立即生效。

### P1-2 MutationObserver 后代扫描
> 状态：✅ 已关闭
> 关闭证据：`observer.ts` collectTargets（新增节点先自身、再子树内集中选择器查询、WeakSet 防重、批次上限）；单测 observer.test.ts（后代扫描 3 条）+ E2E A-02（wrapper 一次 20 条全处理且不重复）。
- 现状：observer 只对「新增节点自身」调用 `isTarget`，wrapper 内批量新增的目标节点不会处理（只靠 initialScan 全 document 扫描兜底）。
- 要求：对每个新增 HTMLElement 先检查自身，再在其内部用集中选择器查询目标后代；限制查询范围和批次大小；同一内容 ID 与同一节点均不得重复处理；回归测试「一个 wrapper 一次加入 20 条评论/回复/动态」。

### P1-3 正则安全与条件树限制
> 状态：✅ 已关闭
> 关闭证据：`src/shared/regex-worker.ts`（时间预算 + 超时 worker.terminate）+ public/workers/regex-tester.js（RuleEditor 调用）；evaluator 运行时只接受 RegexSafety.validate 通过的正则（异常→规则禁用）；import-export 导入前全规则正则安全校验 + 条件树深度/总数限制（schema.ts conditionTreeStats）；测试 import-safety.test.ts（6 条）。
- 要求：设置页通过独立 Worker 执行正则测试，主线程预算超时后必须 `worker.terminate()`；运行时只接受通过 `RegexSafety.validate()` 的正则；全量导入与名单导入检查文件字节上限、schema、危险键、正则安全；条件树限制最大递归深度、节点总数、每组条件数、每组子组数；递归解析避免栈溢出；Worker 文件若保留必须有实际调用与测试，否则删除。

### P1-4 统一名单导入
> 状态：✅ 已关闭
> 关闭证据：`parseListImport`（字节上限/原型污染剥离/schema）；ListsTab.vue 预览确认 + 批量原子写入并展示新增/重复/无效；repository addBlockedBatch/addVerifiedBatch/addWhitelistBatch；测试 storage-consistency.test.ts + import-safety.test.ts。
- 现状：`ListsTab.vue` 直接 `JSON.parse` + fire-and-forget 写入。
- 要求：删除该路径；复用统一解析器和预览；新增 `addBlockedBatch/addVerifiedBatch/addWhitelistBatch` 一次写入并返回新增/重复/无效数量；只有所有验证通过后才提交，失败不得部分写入。

### P1-5 精确 UID 规则规范化
> 状态：✅ 已关闭
> 关闭证据：`schema.ts` exactUidIssue（10 类拒绝原因，19 条边界表 exact-uid.test.ts）；RuleEditor 校验信息同步更新。
- 要求：根级或任意层级 NOT 一律拒绝；OR 一律拒绝；必须恰好存在一个 UID eq 正整数；可选条件只能是 isVerifiedMachine eq true；多个不同 UID、isVerifiedMachine=false、空组、重复冲突条件均拒绝；增加属性测试或完整边界表。

### P1-6 队列修复
> 状态：✅ 已关闭
> 关闭证据：`queue.ts` maxAttempts=总执行次数（block 3/report 1）、终态 TTL 清理、公开 kick()、SW 恢复 attempts 钳制；background 帧身份注册（nonce+url）与派发前验证（tab 存在/nonce/URL）；messages.ts 全部 Zod discriminated union；测试 queue.test.ts（新增 6 条）+ messages.test.ts（12 条）。
- 要求：明确定义 maxAttempts 语义并消除 off-by-one；report 默认不做网络自动重试；failed/cancelled 任务归档或按 TTL 清理；alarm 调用公开 `queue.kick()` 推进到期任务；恢复任务前验证 tab 存在、URL 为 Bilibili、frame/会话 nonce 匹配；对所有 runtime message 使用 Zod discriminated union；补精确执行次数、SW 恢复、过期 tab、cancelled cleanup、alarm kick 测试。

## 验收测试补充（阶段 3）
> 状态：✅ 已交付（见 tests/ 与本文档关闭证据）
真实 history.pushState SPA 连续导航（observer.test.ts 50 次）；新增 wrapper 内含多条目标节点（E2E A-02）；动态详情主卡片+动态评论+楼中楼 fixture（tests/dom/fixtures.test.ts + fixtures/pages/dynamic-detail*.html）；/dynamic/{id} 与 /opus/{id} 路由（E2E A-04）；取消完整回滚（E2E P0-2 四路径）；独立内容证据边界（evidence.test.ts）；local/official/report 三类规则动作副作用（evidence/policy 测试）；双 tab storage 同步与并发写入（E2E A-08）；导入深层条件树、危险正则、超大名单、原型污染（import-safety.test.ts）；production manifest 不含测试域名（release-manifest.test.ts + release_gate.py）；ZIP 根目录结构、manifest、权限和校验值（release-gate.test.ts）；未验证能力绝不发请求（capabilities.test.ts + 适配器兜底）；真实脱敏 DOM fixture（video/dynamics/dynamic-detail/opus，文件头注明合成与测试用途）；E2E 构建写入 out-e2e（global-setup 指向 out-e2e/chrome-mv3）。

## 真实账号验证（阶段 4）
使用 docs/REAL-ACCOUNT-VALIDATION-RECORD.md；分别验证拉黑、解除拉黑、视频评论、楼中楼、动态评论、动态本体和 reason 枚举；不记录 Cookie/bili_jct/完整账号标识；记录浏览器版本、扩展 ZIP SHA、请求路径/参数名、脱敏响应 code 和 UI 后验结果；任一能力未通过时保持 verified=false，不得发布该能力。

## 复验完成定义
- 所有 P0/P1 已关闭（本文件所列）。
- 每项有对应测试与 REMEDIATION-TRACE 证据。
- release gate 返回 PASS。
- 三份 ZIP、校验值、build-info、完整日志全部交付。
- production manifest 只匹配 Bilibili，无 E2E 标记。
- 取消能够完整回滚。
- 自动举报拥有独立内容违规证据。
- 所有启用的真实能力均有人工验证证据编号。
- 未验证能力在 production 中不可发送请求。
- Chrome/Edge 商店文案和隐私披露与最终 ZIP 行为一致。

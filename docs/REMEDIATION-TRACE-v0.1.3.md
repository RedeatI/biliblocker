# BiliBlocker v0.1.3 整改记录（打包前冻结）

> ⚠️ 本文档在发布打包**之前**冻结：只记录修复设计、测试名称与待发布状态。
> 具体的发布哈希（三份 ZIP SHA-256、日志哈希、重建结果）在打包后写入
> `dist/RELEASE-EVIDENCE.json`（位于 dist/，不属于 Source ZIP 输入，避免自引用证据）。
> 打包后不得再修改本文档（source-integrity 步骤会逐文件比较工作区与 Source ZIP）。

- 版本：0.1.3（开发期使用 0.1.3-dev；正式 Stage-E 候选为 0.1.3）
- 阶段：E（静态 / Mock / 自动化测试 / 生产关闭态安全 / 发布可复现性）
- 状态：**开发者侧整改完成，等待阶段 E 独立复验**（不得写入「阶段 E 已通过」，不得开始阶段 F）
- 冻结日期：2026-08-13

## 1. 整改范围（对照 v0.1.2 阶段 E 复验）

### P0-1 可信发布证据链
- `scripts/release.mjs` 重写为 10 步：lint → typecheck → unit → e2e → build-chrome →
  build-edge → package → **source-integrity** → **source-rebuild** → release-gate。
- 新增 `scripts/source-rebuild.mjs`：从 Source ZIP 解压到全新临时目录，
  `pnpm install --frozen-lockfile` 后完整重建（build:chrome / build:edge / test），
  逐项比较 Manifest 全字段、Chrome/Edge 解包文件集合与内容哈希、权限与 matches、
  真实能力关闭状态、测试数量、Source 文件集合与内容哈希。
- `scripts/verify-source-rebuild.mjs` 作为 source-integrity 步骤（工作区 vs Source ZIP 逐文件哈希）。
- 新增 `review/BiliBlocker-v0.1.3-release-gate.py`：**真实执行 Source 内容比较**
  （逐文件 SHA-256），并校验 build-info.sourceArchiveSha256/lockfileSha256、
  十步 exitCode、十份日志、RELEASE-EVIDENCE.json、生产 Manifest 洁净性与真实能力关闭。
- 十份日志固定路径：dist/logs/{lint,typecheck,unit,e2e,build-chrome,build-edge,package,
  source-integrity,source-rebuild,release-gate}.log；任一步失败整个 release 失败。
- `dist/RELEASE-EVIDENCE.json` 打包后生成（三份 ZIP 哈希、构建环境、日志哈希、重建结果、git/source-tree 锚点）。
- `docs/REMEDIATION-TRACE-v0.1.3.md` 打包前冻结，不写入自身 ZIP 哈希。

### P0-2 本地动作先能力过滤后登录检查
- `resolveExecutableOfficialTasks()`：先做能力验证 / 举报理由验证 / 内容类型验证，
  得到可执行官方任务（**不触发登录检查**）。
- `executableOfficialTasks.length > 0` 时才 `auth.checkLogin(true)`。
- 本地折叠 / 本地黑名单 / 已确认机器人名单 / 白名单 / 规则执行完全独立于登录。
- 新增测试：`tests/unit/local-actions.test.ts`（10.1）。

### P0-4 零官方任务不绕过取消窗口 + 原子提交
- `hasReversibleSideEffect = fold || commitLocalBlock || commitVerified || officialTasks.length > 0`；
  倒计时前不写 blocked / 不写 verified / 不入队，仅临时视觉预览，取消后完整恢复。
- 倒计时结束后经 `BB_COMMIT_ACTION` 在 background 单所有者短事务内一次原子写入
  （名单 + 队列单次 `backend.set`，全成功或全失败）；background 不可用 → 失败且零副作用。
- 删除跨倒计时长生命周期事务：`StorageRepository` 移除 transactions Map /
  beginTransaction / commitTransaction / rollbackTransaction；消息协议移除
  beginTx / commitTx / rollbackTx；删除 `return shortId('tx')` 无归属降级。
- 普通「添加」遇到已存在 UID 为 no-op（保留原 blockedAt/source/reason），
  只有明确 update 命令才允许覆盖（P0-4 6.3）。

### P0-3/P0-5 取消状态机、撤权与队列安全
- 取消状态机：`queued + cancel → cancelled`（executor 从未被调用）；
  `in_flight + cancel/revoke/reset/clear → unknown_outcome`（真实结果保留、不覆盖、
  不自动重发、写审计并要求人工核对）；`succeeded` 永不显示为已取消。
- 统一队列撤权流程 `ActionQueue.revoke()`：authorizationEpoch++；
  queued → cancelled（记录具体原因）；in_flight → unknown_outcome；reset/clear
  落盘后才返回；内存队列清空（代际递增）防止旧任务写回。
- 派发前逐项重新验证 `verifyTaskEligible()`：总开关、自动举报授权、自动处理开关、
  能力验证、理由验证、内容类型、授权 epoch、用户白名单、暂停状态。
- 持久化 `bb.queueControl`（QueueControlState）：paused/pauseReason/pauseKind/
  pausedAt/requiresExplicitResume/authorizationEpoch/recentAttempts；
  risk_control 只能用户显式恢复；登录暂停可在已验证重新登录后恢复；
  ActionQueue 构造/启动不默认恢复未暂停；速率预算每次发送尝试**先持久化**（crash-safe）。

### P1-1 所有写入收归 StorageCoordinator
- 新增 `src/storage/coordinator.ts`：background 唯一写入口（全局写锁、可重入、
  固定锁顺序）；content/popup/options 的 Repository 以 `allowWrites:false` 构造，
  任何写方法抛错；队列/去重/审计/队列控制写入经协调器；import/reset/clear 与所有写互斥。
- 移除直接写：content `repo.saveRules`、popup `repo.updateSettings`、
  options `repo.clearAudit`、background 任务完成审计、queue `saveQueueTasks`、dedup mark/clear。

### P1-2 UI 状态表达
- 新增文案：仅临时折叠、本地处理完成（未发送任何请求）、官方任务已排队、
  请求已派发、服务端确认、取消确认未发送、结果未知、因撤权跳过、因能力未验证跳过、
  因风控暂停、本地提交失败；禁止「无官方任务显示已入队」「in-flight 取消显示已取消成功」。

## 2. 新增/修改测试清单

| 文件 | 覆盖 |
|---|---|
| `tests/unit/local-actions.test.ts` | 10.1 本地关闭态（能力=false/未登录/倒计时/取消/commit 失败/文案） |
| `tests/unit/queue-revoke-cancel.test.ts` | 10.2 撤权与取消（executor 零调用/总开关/clear 不复活/in_flight unknown_outcome/reason 失效/epoch/白名单） |
| `tests/unit/queue-sw-recovery.test.ts` | 10.3 SW 恢复（risk_control 持久/显式恢复/速率预算持久/无事务/unknown_outcome 不重发） |
| `tests/unit/storage-coordinator.test.ts` | 10.4 写协调与并发（settings/import/clear/audit/dedup/双 Tab/只读仓储） |
| `tests/unit/release-integrity.test.ts` | 10.5 发布完整性（12 项 gate 失败场景 + 洁净 PASS） |
| `tests/unit/transaction.test.ts` | 重写为 P0-4 原子提交语义（单次 set/no-op UID/纪元拒绝/失败零副作用） |
| `tests/unit/queue.test.ts` / `queue-recovery-failing.test.ts` | 适配新队列（writer 注入/已验证环境/取消状态机） |
| `tests/e2e/extension.spec.ts` | 新增 5 个场景：未登录本地流程、倒计时取消、撤权后 queued 不执行、clear 不复活、unknown_outcome UI |

## 3. 待发布状态（打包后由 gate 与 RELEASE-EVIDENCE 记录）
- 三份 ZIP 哈希：见 `dist/RELEASE-EVIDENCE.json`（不写入本文档）。
- 十步 release 结果：见 `dist/logs/*.log` 与 `dist/build-info.json`。
- 真实能力：`src/shared/capabilities.ts` 八项 verified=false；
  `REPORT_REASONS.verified=false`；`selectors VERIFICATION.selectorsVerified=false`（冻结条件）。
- 声明：**v0.1.3 开发者侧整改完成，等待阶段 E 独立复验。**

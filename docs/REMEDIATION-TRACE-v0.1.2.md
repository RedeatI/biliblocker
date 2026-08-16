# BiliBlocker v0.1.2 整改追踪

> 唯一缺陷基线：docs/ACCEPTANCE-v0.1.1.md（v0.1.1 第二轮复验）
> 状态图例：⬜ 未开始 / 🔧 修复中 / ✅ 已关闭 / ❌ 未关闭（必须说明原因）
> 整改时间：2026-08-13。发布候选版本：0.1.2。

## 阶段 A：冻结与复现

| 项 | 状态 | 证据 |
|---|---|---|
| 版本冻结 0.1.2-dev | ✅ | package.json（阶段 D 发布时改为正式 0.1.2） |
| 真实能力全部保持 false | ✅ | `src/shared/capabilities.ts` 8 键 verified:false；`REPORT_REASONS.verified=false`；`selectors VERIFICATION.selectorsVerified=false`（复验脚本确认） |
| 复验发现写入 ACCEPTANCE-v0.1.1.md | ✅ | docs/ACCEPTANCE-v0.1.1.md（P0×4 + P1×8 + 20 项必测清单） |
| 三个 P0 失败测试证明旧实现失败 | ✅ | 阶段 A 运行结果：matchtrace-failing 5 失败、action-plan-failing 7 失败、queue-recovery-failing 3 失败（共 15 个失败，证明旧实现缺陷真实存在）；修复后全部转绿 |

## P0

| 验收编号 | 缺陷 | 修改文件 | 测试 | 状态 | 证据 |
|---|---|---|---|---|---|
| P0-1 | 规则求值无因果路径（MatchTrace） | src/rules/evaluator.ts（MatchedLeaf/MatchTrace/evaluateConditionWithTrace/evaluateGroupWithTrace/evaluateRuleWithTrace）、src/rules/evidence.ts（buildEvidence 只消费 MatchTrace） | tests/unit/matchtrace-failing.test.ts（11）+ evidence.test.ts | ✅ | OR 未命中内容分支不产生内容证据；NOT(content contains x) 无证据；not_contains/ne/not_exists 无证据；正向命中（content contains 广告 AND uid==x）有证据；嵌套 OR/AND/NOT 只有正向路径产生证据；多 true OR 分支确定性收集；精确 UID 授权证据与内容证据独立；hasLinks 可作证据而名单状态字段不能 |
| P0-2 | 动作副作用未拆分（ActionExecutionPlan） | src/rules/evidence.ts（ActionExecutionPlan/mapActionMatrix/deriveMatrixAction/buildActionExecutionPlan/commitLocalBlock|commitVerified|enqueueOfficialBlock|enqueueReport/BLOCK_ONLY_SIDE_EFFECTS）、src/entrypoints/content/app.ts（runActionFlow 用计划矩阵；登录边界：仅官方动作需要登录；零官方任务显示「仅本地处理完成」）、src/shared/strings.ts（localOnlyDone/outcomeUnknown） | tests/unit/action-plan-failing.test.ts（7）+ evidence.test.ts | ✅ | 矩阵每行断言：local_block_verified_uid（Local✅/Verified❌/Official❌/Report❌）；official_block_verified_uid（Local❌/Verified❌/Official✅/Report❌）；report_verified_uid_content+内容证据（仅 Report✅）；一键拉黑并举报（全✅）；仅隐藏（全❌）；无账号证据时官方动作拒绝且不隐式写名单；能力门禁关闭时 commitLocalBlock 独立可完成 |
| P0-3 | in_flight 举报 SW 恢复无 unknown_outcome | src/shared/types.ts（TaskStatus+unknown_outcome/AuditEntry.outcomeUnknown）、src/actions/queue.ts（start() 恢复 in_flight→unknown_outcome 绝不重发；onTaskDone 仅终态一次；bucket 按每次发送计数含失败；duplicate 同步 dedup；isTerminalStatus 统一 TTL）、src/entrypoints/background/index.ts（handleTaskDone 写 outcomeUnknown 审计 + groupId 修正）、src/shared/messages.ts（status 枚举/taskDone.unknownOutcome/audit.outcomeUnknown）、src/entrypoints/options/tabs/LogsTab.vue（「结果未知」筛选与标注）、src/entrypoints/content/app.ts（unknownOutcome Toast） | tests/unit/queue-recovery-failing.test.ts（3）+ queue.test.ts（更新 3 条旧语义测试） | ✅ | SW 崩溃前服务端可能已接收举报 → 重启后执行次数保持 0、状态转 unknown_outcome；unknown_outcome 不进入 pump；网络重试 onTaskDone 仅终态调用一次；失败请求也计入每分钟速率；duplicate 同步登记 dedup；TTL 注释与实现一致（isTerminalStatus） |
| P0-4 | 交付完整性 | scripts/release.mjs（动态版本/package.log/steps 回填）、scripts/package.mjs（build-info 最低字段；EXCLUDED_DIRS 排除 .workbuddy）、scripts/verify-source-rebuild.mjs（Source ZIP 内容一致性验证）、review/release_gate.py（版本取自 package.json、8 份日志、build-info 新字段、拒绝 -dev 版本）、tests/unit/release-gate.test.ts | release-gate（3）+ release-manifest（10）+ e2e-output-isolation（4） | ✅ | 阶段 D 完整流水线生成三份 ZIP + SHA256SUMS + build-info + 8 份日志；Source ZIP 干净重建（见下）；生产包无 localhost/.e2e/强制放行；release gate PASS |

## P1

| 验收编号 | 缺陷 | 修改文件 | 测试 | 状态 | 证据 |
|---|---|---|---|---|---|
| P1-1 | 跨 Tab 原子事务 | src/storage/repository.ts（beginTransaction/commitTransaction/rollbackTransaction；addBlocked/addVerified/addWhitelist 带 operationId 记录创建；回滚只删同 op 创建且版本未变化）、src/entrypoints/background/index.ts（beginTx/commitTx/rollbackTx 消息）、src/shared/messages.ts（事务 ops + operationId 字段）、src/entrypoints/content/app.ts（runActionFlow 用事务） | tests/unit/transaction.test.ts（P1-1 6 条） | ✅ | 双 Tab 同 UID：一方回滚不删除另一方记录（版本已变化）；只删本事务创建条目；verified/whitelist 同样支持；并发两事务互不误删 |
| P1-2 | KeyMutex 清理 | src/storage/key-mutex.ts（新建共享实现，tail 引用保存后比较）、src/storage/repository.ts、src/entrypoints/background/index.ts 统一使用 | tests/unit/key-mutex.test.ts（4） | ✅ | 高频不同 key / 同一 key 并发 / 交错 key 运行后 pendingCount 回到 0；串行互斥执行顺序正确 |
| P1-3 | 统一写并发模型 | src/storage/repository.ts（withGlobalWrite 全局写锁；write() 先 backend 后 cache；settings/rules revision/CAS）、src/entrypoints/background/index.ts（executeMutation 经 withGlobalWrite；saveRules/updateSettings 消息）、src/entrypoints/options/store.ts（settings/rules 写经 background+CAS）、src/shared/messages.ts（saveRules/updateSettings schema + expectedRevision） | tests/unit/transaction.test.ts（P1-3 5 条） | ✅ | backend.set 失败后 cache 保持旧值；updateSettings/saveRules 过期 revision 被拒绝；importAll 与 addBlocked/removeBlocked 经全局写锁互斥不丢数据 |
| P1-4 | 完整导入恢复 settings | src/rules/import-export.ts（toEntities 保留并补全 settings）、src/entrypoints/background/index.ts（importAll settings 补全后写入） | tests/unit/import-restore.test.ts（3） | ✅ | export→mutate→import→settings 完整恢复；无 settings 时返回 undefined 不破坏；缺字段用默认值补全 |
| P1-5 | Observer 自身与后代 | src/entrypoints/content/observer.ts（collectTargets：自身为目标后继续扫描后代；不因父节点是目标跳过；WeakSet 去重） | tests/dom/observer.test.ts（更新 1 条） | ✅ | 节点自身为目标后仍扫描后代；嵌套后代均处理且各自只处理一次 |
| P1-6 | runtime message 信任边界 | src/shared/messages.ts（importAll.data 用完整 importDataSchema；BB_EXECUTE_TASK/BB_EXECUTE_RESULT 带 executionToken）、src/shared/execute-result-validation.ts（校验纯函数：taskId/tabId/frameId/frameNonce/executionToken；sender 缺 tab/frame 拒绝；token 只消费一次）、src/entrypoints/background/index.ts（派发生成一次性 token；结果校验后消费）、src/entrypoints/content/app.ts（回传 executionToken） | tests/unit/execute-result-validation.test.ts（9）+ messages.test.ts（更新 1 条） | ✅ | 无 tab/无 frame/错 tab/错 frame/错 token/旧 nonce/已消费（entry 不存在）全部拒绝；匹配通过 |
| P1-7 | 正则 Worker 保存硬门禁 | src/shared/types.ts（Condition.regexVerification/RegexVerification）、src/rules/schema.ts（regexVerificationSchema）、src/rules/regex-gate.ts（regexSaveGate/collectRegexConditions/isRegexVerificationValid）、RuleEditor.vue（验证状态持久化到 row；无 Worker 不显示「已通过 Worker」；保存时门禁） | tests/unit/regex-gate.test.ts（10） | ✅ | Worker 失败/无记录/无 Worker/pattern 变化/样例变化 → 不能保存启用状态；disabled 草稿可保存但明确标注；嵌套组 regex 收集正确 |
| P1-8 | 队列与审计语义对齐 | src/actions/queue.ts（onTaskDone 仅终态触发，retry 中间态不写「任务完成」审计）、src/entrypoints/background/index.ts（BB_TASK_DONE 用 task.groupId 不混用 taskId；unknown_outcome 审计）、src/entrypoints/options/tabs/LogsTab.vue（unknown_outcome 可查看/筛选） | queue.test.ts（更新 3 条）+ queue-recovery-failing.test.ts | ✅ | retry 中间态不触发 onTaskDone（审计只写一次）；groupId/taskId 不混用；terminal TTL 注释与实现一致（isTerminalStatus）；unknown_outcome 设置页可查看处理；UI 区分本地成功/已入队/请求已发送/结果未知 |

## 必测清单核对（v0.1.2）

| # | 测试 | 位置 | 状态 |
|---|---|---|---|
| 1 | OR 未命中内容分支不产生内容证据 | matchtrace-failing.test.ts | ✅ |
| 2 | NOT 内容条件不产生内容证据 | matchtrace-failing.test.ts | ✅ |
| 3 | not_contains 不产生内容证据 | matchtrace-failing.test.ts | ✅ |
| 4 | 每种规则动作的精确 Storage delta 与 Queue task 类型 | action-plan-failing.test.ts | ✅ |
| 5 | 纯本地动作未登录正常完成 | action-plan-failing.test.ts（commitLocalBlock 独立）+ app.ts 登录边界 | ✅ |
| 6 | 全部能力关闭、tasks=0 提示「未发送请求」 | action-plan-failing + strings.localOnlyDone + commitLocalActions 零任务分支 | ✅ |
| 7 | SW 恢复 in-flight report 不再次调用 executor | queue-recovery-failing.test.ts | ✅ |
| 8 | unknown_outcome 不进入 pump | queue-recovery-failing.test.ts | ✅ |
| 9 | 网络重试 onTaskDone 仅终态触发 | queue-recovery-failing.test.ts + queue.test.ts | ✅ |
| 10 | 双 Tab 同 UID：一方回滚不删另一方记录 | transaction.test.ts | ✅ |
| 11 | importAll 与 addBlocked 并发不丢数据 | transaction.test.ts | ✅ |
| 12 | settings/rules 并发 revision 冲突 | transaction.test.ts | ✅ |
| 13 | Storage backend.set 失败后 cache 保持旧值 | transaction.test.ts | ✅ |
| 14 | 完整 JSON 导入恢复 settings | import-restore.test.ts | ✅ |
| 15 | 新增目标节点自身及嵌套后代均处理且不重复 | observer.test.ts（dom） | ✅ |
| 16 | Mutex 尾队列清理 | key-mutex.test.ts | ✅ |
| 17 | BB_EXECUTE_RESULT 无 tab/错 frame/错 token 拒绝 | execute-result-validation.test.ts | ✅ |
| 18 | 正则 Worker 超时后无法保存启用规则 | regex-gate.test.ts | ✅ |
| 19 | Source ZIP 干净重建 | 阶段 D（从 source zip 解压 → 安装 → 完整 release） | ✅ |
| 20 | 生产包无 localhost/E2E 标记/强制放行 | release-manifest + e2e-output-isolation + release-gate | ✅ |

## 阶段 D 发布

| 产物 | 状态 | 证据 |
|---|---|---|
| dist/biliblocker-chrome-0.1.2.zip | ✅ | SHA-256 `42e50172324c5792262756e0addc9536b8fa6bb16e9728a0d0f073f171980e07` |
| dist/biliblocker-edge-0.1.2.zip | ✅ | SHA-256 `40379eaab255b65190eada2422da52833900fc916dbbc11869fddc905a5a279a` |
| dist/biliblocker-source-0.1.2.zip | ✅ | SHA-256 `fa5c594fe952945909bd09805461ad75f708308d09cba9d977889a7e2253d49f` |
| dist/SHA256SUMS.txt / build-info.json | ✅ | build-info：version 0.1.2 / builtAt / sourceArchiveSha256 / nodeVersion v22.22.2 / pnpmVersion pnpm@9.15.4 / playwrightVersion 1.62.1 / browserVersion / tests{unit:267,e2e:16} / steps[] 8 步全 exit 0 |
| dist/logs/*（8 份） | ✅ | lint/typecheck/unit/e2e/build-chrome/build-edge/package/release-gate 全部 exit=0 |
| release gate | ✅ | `RELEASE GATE: PASS`（2026-08-13 流水线） |

## P0-4 Source ZIP 干净重建（可复现验证）

执行（2026-08-13）：
1. `scripts/verify-source-rebuild.mjs`：Source ZIP 文件集合与内容 SHA-256 与工作区完全一致（148 个文件，0 差异），无 node_modules/out/out-e2e/dist/.git/.wxt/.workbuddy 泄漏。
2. 解压 `biliblocker-source-0.1.2.zip` 到干净临时目录 → `pnpm install --frozen-lockfile`（lockfile 固定依赖）→ `pnpm release` 完整流水线全部 exit=0、gate PASS。
3. 比较重建产物：Chrome ZIP 16 个内容文件（js/json/html/css/png）SHA-256 **全部一致**（diff=0）；manifest version 0.1.2、matches `https://www.bilibili.com/*`、permissions `[storage,alarms]` 完全一致。
结论：源码包可复现构建，时间戳导致的 ZIP 字节差异不影响内容一致性。

## 阶段 E/F

| 项 | 状态 |
|---|---|
| 阶段 E：提交 v0.1.2 包等待静态与 Mock 复验 | ⬜ 待提交（本整改轮产出包；不启用真实能力） |
| 阶段 F：真实账号验证（仅 E 通过后） | ⬜ 待人工在真实浏览器按顺序逐项启用（selectorsVideo→selectorsDynamic→blockUser→unblockUser→reportVideoComment→reportVideoReply→reportDynamicComment→reportDynamic→report reason），每项独立证据编号；不得批量翻转 |

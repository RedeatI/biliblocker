# BiliBlocker v0.1.1 第二轮复验缺陷基线（v0.1.2 整改输入）

> 本文档是 v0.1.1 第二轮静态复验的**唯一缺陷基线**（2026-08-13 复验，2026-08-13 整改）。
> 所有缺陷按 P0/P1 分级；任何 P0 未关闭时不得生成发布候选、不得进入真实账号验证、不得提交商店。
> 整改状态追踪见 docs/REMEDIATION-TRACE-v0.1.2.md（本轮新建）。
>
> 冻结状态（阶段 A）：
> - 版本冻结为 `0.1.2-dev`（package.json），发布候选版本为 `0.1.2`。
> - `CAPABILITY_VERIFICATION` 8 项能力全部 `verified:false`；`REPORT_REASONS.verified=false`；
>   `selectors VERIFICATION.selectorsVerified=false`。上述任何一项被修改为 true 前，本整改轮视为未完成。
> - 整改期间不执行真实 Bilibili 拉黑/解除拉黑/举报；不开始真实账号验证；不提交商店。
> - v0.1.1 交付物（dist/ 三份 ZIP 与日志）由本轮 release 流水线以 v0.1.2 名义重建，不复用旧产物。

## P0 缺陷（发布阻断）

### P0-1 规则求值无因果路径（MatchTrace 缺失）
> 状态：🔧 修复中（阶段 B）
- 现状：`buildEvidence()` 只知道「整条规则匹配」，用 `ruleContentFields()` **递归收集规则树中出现的全部内容字段**，
  不区分：哪个 OR 分支实际命中、条件是否位于 NOT 下、运算符正/反向、哪个叶子真正对最终 true 有贡献。
- 后果：`(username == bot OR content contains 广告)` 仅用户名命中时也会产生内容违规证据；
  `NOT(content contains 广告)` 与 `content not_contains 广告` 对普通内容为 true 时同样产生内容证据；
  `content ne 广告`、`content not_exists` 等反向/否定运算符可伪造内容证据。普通内容错误标记成广告证据 → 误举报。
- 验收要求：
  - 定义 `MatchedLeaf`（path/field/operator/positivePolarity/contributedToTrue）与 `MatchTrace`（matched/contributingLeaves）。
  - 新增 `evaluateConditionWithTrace` / `evaluateGroupWithTrace` / `evaluateRuleWithTrace`。
  - AND true：收集所有实际为 true 且有贡献的叶子；OR true：只收集实际命中的分支，绝不收集未命中分支；
    NOT true：NOT 内部叶子不得成为正向内容证据。
  - `ne` / `not_contains` / `not_exists` 及任何负极性上下文的条件不得成为可举报内容证据。
  - 可作内容证据的字段仅限 `content` / `links` / `linkDomains` / `hasLinks`；
    uid、username、页面范围、名单状态、内容类型不得作为内容违规证据；reportCategory 只是分类标签，不自己产生证据。
  - `buildEvidence()` 只消费 MatchTrace，不得再次遍历整棵条件树猜测证据。
  - 必测：OR 仅用户名命中 → 无内容证据；同规则仅正文命中 → 有内容证据；NOT(content contains 广告) 对普通内容 → 无内容证据；
    content not_contains 广告 → 无内容证据；content contains 广告 AND uid==x → 有内容证据；嵌套 OR/AND/NOT 每路径；
    多个 true OR 分支确定性追踪；精确 UID 授权证据与内容证据保持独立。

### P0-2 动作副作用未彻底拆分（ActionExecutionPlan 缺失）
> 状态：🔧 修复中（阶段 B）
- 现状：`runActionFlow({ block, report })` 粒度不足；`autoProcess` 中 `block: plan.officialBlock || plan.localBlock` 把
  本地、确认、官方拉黑混在一起；`buildActionPlan` 的 `localBlock` 字段与 ActionPlan 语义不清；
  一键流程恒写入 verified（`addVerified` 无条件执行），无明确动作矩阵。
- 后果：无法断言每种来源/动作对 `bb.blocked` / `bb.verified` / 队列任务类型的确切副作用；
  「仅本地拉黑」可能隐式加入已确认名单；能力门禁关闭时可能误报「已加入队列」。
- 验收要求：
  - 定义 `ActionExecutionPlan`：`fold / commitLocalBlock / commitVerified / enqueueOfficialBlock / enqueueReport / source / evidence`。
  - 禁止 `block: plan.officialBlock || plan.localBlock` 这类混写；必须有单一映射函数（动作矩阵固定）。
  - 矩阵：
    | 来源/动作 | Local blocked | Verified | Official block | Report |
    |---|---|---|---|---|
    | local_block_verified_uid | ✅ | ❌ | ❌ | ❌ |
    | official_block_verified_uid | ❌ | ❌ | ✅ | ❌ |
    | report_verified_uid_content | ❌ | ❌ | ❌ | ✅ |
    | 一键拉黑并举报（one_click block+report） | ✅ | ✅ | ✅ | ✅ |
    | 仅隐藏 | ❌ | ❌ | ❌ | ❌ |
    | 仅本地拉黑 | ✅ | 由明确产品动作决定，不得隐式加入 | ❌ | ❌ |
    | 官方拉黑但不举报 | 用明确常量决定 | 用明确常量决定 | ✅ | ❌ |
  - 登录边界：本地折叠、本地黑名单、白名单和规则执行不要求登录；只有 enqueueOfficialBlock / enqueueReport / enqueueUnblock 需要登录；
    能力门禁关闭时继续完成允许的本地动作。
  - UI 边界：任务数为 0 时不得显示「已加入队列」，应显示「仅本地处理完成；官方能力尚未验证，本次未发送任何请求」。
  - 必测：为每类动作断言 bb.blocked / bb.verified 是否变化、队列任务类型与数量、是否调用登录检查、零任务提示文案、能力关闭时不误报已入队。

### P0-3 不可逆举报的 SW 恢复无 unknown_outcome
> 状态：🔧 修复中（阶段 B）
- 现状：`ActionQueue.start()` 把所有 `in_flight` 任务重新置为 `queued` 并重新执行；
  report 任务在 SW 崩溃前可能已发送到服务端，重启后会被**重复提交**。
- 后果：不可逆举报可能重复发送；无审计记录；UI 无法区分「请求已发送但结果未知」。
- 验收要求：
  - `TaskStatus` 扩展 `unknown_outcome`（在 queued/in_flight/succeeded/failed/cancelled/skipped 之外）。
  - 恢复规则：in_flight + report → 直接转 unknown_outcome，**永不自动重发**，记录审计，提示人工核对；
    不登记为已成功举报，除非有服务端可验证查询依据。
  - in_flight + block/unblock → 仅在证明接口幂等或可查询最终状态后才允许恢复；否则同样进入 unknown_outcome。
  - `onTaskDone` 只在终态或 unknown_outcome 调用一次；尝试速率按每次发送请求计数（不只按成功计数）；
    duplicate 响应同步更新对应 dedup 状态；终态 TTL 与持久化实现一致。
  - 对已发出的 in-flight 请求，UI 只能说「已请求取消后续处理，当前请求结果可能未知」，不能保证撤销。
  - 必测：SW 崩溃前服务端可能已接收举报，重启后执行次数仍为 0；unknown_outcome 不进入 pump；
    手动确认后可只做本地标记不自动重发；网络重试 onTaskDone 仅最终调用一次；失败请求也计入每分钟尝试频率。

### P0-4 交付完整性
> 状态：🔧 修复中（阶段 D）
- 根目录必需：wxt.config.ts / tsconfig.json / vitest.config.ts / README.md / PRIVACY.md / THIRD_PARTY_NOTICES.md（当前已存在，阶段 D 复核）。
- dist/ 必需：biliblocker-chrome-0.1.2.zip / biliblocker-edge-0.1.2.zip / biliblocker-source-0.1.2.zip / SHA256SUMS.txt /
  build-info.json / dist/logs/{lint,typecheck,unit,e2e,build-chrome,build-edge,package,release-gate}.log。
- build-info 最低字段：version / builtAt / sourceArchiveSha256 / nodeVersion / pnpmVersion / playwrightVersion / browserVersion / tests{unit,e2e} / steps[]（每步 name/exitCode/log）。
- 可复现验证：从 source ZIP 解压到干净目录 → lockfile 固定安装 → 完整 release → 比较重建 Manifest、文件清单与关键产物哈希；
  时间戳导致 ZIP 字节不同时，至少保证解包文件集合与文件内容哈希一致。
- 生产包绝不包含 localhost / E2E 标记 / 真实能力强制放行。

## P1 缺陷（一致性、安全边界与产品状态）

### P1-1 跨 Tab 原子事务缺失
> 状态：🔧 修复中（阶段 C）
- 现状：`runActionFlow` 在内容脚本侧做 before 快照 + 提交 + 补偿回滚；多 Tab 并发时补偿 `removeBlocked(uid)` 可能误删
  另一 Tab 刚写入的同 UID 记录。
- 验收：before 快照、名单提交、事务归属、补偿回滚全部移入 background；每次动作生成 `operationId`；
  记录本次实际创建条目；补偿只删除同一 operationId 创建且版本未变化的记录；双 Tab 并发 + 失败注入测试。

### P1-2 KeyMutex 清理
> 状态：🔧 修复中（阶段 C）
- 验收：两个 Mutex（storage/repository.ts 与 background/index.ts）统一使用 `tail === prev.then(() => gate)` 比较后删除；
  高频不同 key 运行后 Map 回到 0 的测试。

### P1-3 统一写并发模型
> 状态：🔧 修复中（阶段 C）
- 现状：settings/rules 由 options store 直接 `repo.write`，未与名单/审计/导入互斥；importAll/reset/clear 只锁 `bb.import` key，
  与 addBlocked（bb.blocked key）可并发；`StorageRepository.write()` **先更新 cache 再写 backend**，backend 失败时 cache 已脏。
- 验收：settings、rules、名单、审计、导入、reset、clear 全部经 background 串行；importAll/reset/clear 与所有普通写互斥；
  全局写锁或严格固定锁顺序防死锁；revision/CAS 拒绝过期覆盖；write() 后端成功后再更新 cache。

### P1-4 完整导入必须恢复 settings
> 状态：🔧 修复中（阶段 C）
- 现状：`toEntities()` 丢弃 settings（只返回 rules/blocked/verified/whitelist），`importJson` 无法恢复设置。
- 验收：toEntities() 保留并验证 settings；新增 export → mutate → import → 完整恢复测试。

### P1-5 Observer 自身与后代处理
> 状态：🔧 修复中（阶段 C）
- 现状：`collectTargets` 中节点自身是目标时 `return`（跳过后代）；后代父节点是目标时 `!isTarget(el.parentElement)` 跳过。
- 验收：节点自身为目标后仍继续扫描后代；不因父节点是目标跳过合法后代；稳定 content ID + WeakSet + 已注入标记去重；
  真实楼中楼/嵌套回复/转发动态 fixture。

### P1-6 runtime message 信任边界
> 状态：🔧 修复中（阶段 C）
- 现状：`importAll.data` 为 `z.unknown()`；BB_EXECUTE_RESULT 无一次性 token（仅 taskId+tabId 校验）；sender 缺 tab/frame 未拒绝。
- 验收：importAll.data 用完整 Zod Schema；每次任务派发生成一次性 executionToken；结果必须同时匹配 taskId/tabId/frameId/frameNonce/executionToken；
  sender 缺少 tab 或 frame 直接拒绝；token 只消费一次 + 超时；测试无 tab/错误 tab/错误 frame/旧 nonce/错误 token/重复结果。

### P1-7 正则 Worker 保存硬门禁
> 状态：🔧 修复中（阶段 C）
- 现状：RuleEditor 保存时无 Worker 验证状态持久化；无 Worker 环境也可显示「已通过 Worker」。
- 验收：每个 regex row 保存 Worker 验证状态与被验证的 exact pattern/version；pattern/样例/条件变化后状态失效；
  Worker 超时/失败/不可用时不能保存启用状态的 regex 规则；无 Worker 时不得显示「已通过 Worker」；
  可保存 disabled 草稿但必须明确标注。

### P1-8 队列与审计语义对齐
> 状态：🔧 修复中（阶段 C）
- 现状：retry 中间态也调用 onTaskDone（handleTaskDone 会写「任务完成」审计）；groupId 与 taskId 混用（handleTaskDone 发 BB_TASK_DONE 用 groupId: task.id）；
  终态 TTL 注释与实现不完全一致；无 unknown_outcome 查看/处理界面。
- 验收：retry 中间态不写「任务完成」审计；groupId 与 taskId 不混用；terminal TTL 注释与实现一致；
  unknown_outcome 可在设置页查看和处理；清晰区分：本地成功/已入队/请求已发送/服务端确认成功/结果未知。

## 必测清单（本整改轮新增自动化测试）
1. OR 未命中内容分支不产生内容证据（P0-1）。
2. NOT 内容条件不产生内容证据（P0-1）。
3. not_contains 不产生内容证据（P0-1）。
4. 每种规则动作的精确 Storage delta 与 Queue task 类型（P0-2）。
5. 纯本地动作在未登录时正常完成（P0-2）。
6. 全部能力关闭、tasks=0 时提示「未发送请求」（P0-2）。
7. SW 恢复 in-flight report 不再次调用 executor（P0-3）。
8. unknown_outcome 不进入 pump（P0-3）。
9. 网络重试 onTaskDone 仅终态触发（P1-8 / P0-3）。
10. 双 Tab 同 UID：一方失败回滚不得删除另一方记录（P1-1）。
11. importAll 与 addBlocked 并发不丢数据（P1-3）。
12. settings/rules 并发 revision 冲突测试（P1-3）。
13. Storage backend.set 失败后 cache 保持旧值（P1-3）。
14. 完整 JSON 导入恢复 settings（P1-4）。
15. 新增目标节点自身及嵌套后代均处理且不重复（P1-5）。
16. Mutex 尾队列清理测试（P1-2）。
17. BB_EXECUTE_RESULT 无 tab/错 frame/错 token 全部拒绝（P1-6）。
18. 正则 Worker 超时后无法保存启用规则（P1-7）。
19. Source ZIP 干净重建测试（P0-4）。
20. 生产包绝不包含 localhost/E2E 标记/真实能力强制放行（P0-4，回归）。

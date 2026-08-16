# BiliBlocker v0.1.1 整改追踪

> 唯一缺陷基线：docs/ACCEPTANCE-v0.1.0.md
> 原始输入包 SHA-256：`3bea5ad68dc4a9642b01abdbeae552fe3e286c33292bcc9db8517a5592c75686`
> 状态图例：⬜ 未开始 / 🔧 修复中 / ✅ 已关闭 / ❌ 未关闭（必须说明原因）

## P0

| 验收编号 | 缺陷 | 修改文件 | 测试 | 状态 | 证据 |
|---|---|---|---|---|---|
| P0-1 | E2E 与生产构建分离 | wxt.config.ts、scripts/build-mode.mjs、tests/e2e/global-setup.ts、scripts/production-gate.mjs、scripts/package.mjs、scripts/zip-util.mjs、review/release_gate.py、eslint.config.mjs | release-manifest（10）/ e2e-output-isolation（4）/ release-gate（3） | ✅ | 生产 manifest matches 恰为 https://www.bilibili.com/*；E2E 构建输出 out-e2e/（含 localhost matches），生产 out/ 不受影响；`wxt zip -b chrome/edge` 官方流程 + 跨平台零依赖 ZIP 写入器；门禁对 .e2e-built/localhost/非预期权限 FAIL |
| P0-2 | 一键操作事务可回滚 | src/entrypoints/content/app.ts、src/ui/placeholder/controller.ts、src/ui/toast/manager.ts、src/shared/strings.ts | tests/e2e/extension.spec.ts（取消回滚 4 条） | ✅ | E2E：新 UID 取消（无请求/无名单/节点恢复）；原本 blocked 取消保持 blockedAt；原本 verified 取消不删记录；倒计时结束后才出现持久化名单；commit 失败补偿回滚（代码路径） |
| P0-3 | 规则动作执行链与证据模型 | src/rules/evidence.ts、src/actions/policy.ts、src/entrypoints/content/app.ts、src/adapters/context.ts | evidence（14）+ policy（21）单测 | ✅ | UID-only+reportCategory 不构成内容证据；exact UID+独立 content/link 违规才自动举报；local/official/report 副作用逐项验证；已确认机器人普通内容只隐藏/拉黑 |
| P0-4 | 真实能力硬门禁 | src/shared/capabilities.ts、src/adapters/bilibili/block.ts、report.ts、src/entrypoints/options/tabs/OverviewTab.vue、wxt.config.ts（vite define） | capabilities 单测（12） | ✅ | 8 能力键独立 Verification；生产构建 E2E_FORCED=false（编译常量替换经 vite define）；适配器层拒绝未验证请求；设置页禁用授权并显示原因；内容类型独立门禁；未验证能力绝不发请求由单测 + 构建产物核验 |
| P0-5 | SPA 路由观察器 | src/entrypoints/content/observer.ts | tests/dom/observer.test.ts（8） | ✅ | RouterObserver 单例：history 补丁全局一次；50 次 pushState 每次仅一次回调、无监听器增长；stop() 后回调失效；重建只影响 DOM observer |

## P1

| 验收编号 | 缺陷 | 修改文件 | 测试 | 状态 | 证据 |
|---|---|---|---|---|---|
| P1-1 | storage 一致性 | src/storage/repository.ts、src/entrypoints/background/index.ts、src/entrypoints/options/store.ts、src/entrypoints/content/app.ts、src/shared/messages.ts | storage-consistency（9）+ E2E A-08 | ✅ | invalidate/applyExternalChanges 遍历全部键；名单/审计/导入 RMW 经 BB_MUTATE_LIST 在 background 串行；import/reset/clear 广播 BB_REFRESH_DATA；双 tab 并发不同 UID 无丢失；白名单外部变更即时生效 |
| P1-2 | MutationObserver 后代扫描 | src/entrypoints/content/observer.ts、src/entrypoints/content/app.ts | observer.test.ts（后代扫描 3）+ E2E A-02 | ✅ | 新增节点先自身再子树内集中选择器查询；WeakSet 防重；wrapper 一次 20 条全处理且不重复 |
| P1-3 | 正则安全与条件树限制 | src/shared/regex-worker.ts、public/workers/regex-tester.js、src/rules/schema.ts、src/rules/import-export.ts、src/rules/evaluator.ts、RuleEditor.vue | import-safety（6）+ exact-uid（树限制） | ✅ | 导入前全规则正则安全校验（危险正则整包拒绝）；条件树深度/总数上限；Worker 时间预算 + 超时 terminate（RuleEditor 实际调用） |
| P1-4 | 统一名单导入 | src/entrypoints/options/tabs/ListsTab.vue、src/rules/import-export.ts（parseListImport）、src/storage/repository.ts、src/entrypoints/options/store.ts | storage-consistency + import-safety | ✅ | 统一解析器 + 预览确认；批量原子写入返回新增/重复/无效；无效整包拒绝 |
| P1-5 | 精确 UID 规则规范化 | src/rules/schema.ts、RuleEditor.vue | exact-uid.test.ts（19 条边界表） | ✅ | 根级/任意层级 NOT、OR、多 UID、非正整数、isVerifiedMachine=false、空组、嵌套组均拒绝 |
| P1-6 | 队列修复 | src/actions/queue.ts、src/shared/messages.ts、src/entrypoints/background/index.ts | queue（17）+ messages（12） | ✅ | maxAttempts=总执行次数（block 3/report 1，精确执行次数测试）；终态 TTL 清理；公开 kick()（alarm 调用）；SW 恢复 attempts 钳制且不重复执行；帧身份 nonce+URL 注册与派发前验证；全部消息 Zod discriminated union |

## 阶段 3 验收测试

| 验收编号 | 场景 | 测试文件 | 状态 |
|---|---|---|---|
| A-01 | 真实 history.pushState SPA 连续导航 | tests/dom/observer.test.ts（50 次） | ✅ |
| A-02 | 新增 wrapper 内含多条目标节点 | tests/dom/observer.test.ts + tests/e2e/extension.spec.ts | ✅ |
| A-03 | 动态详情主卡片 + 动态评论 + 楼中楼 fixture | tests/dom/fixtures.test.ts + tests/fixtures/pages/dynamic-detail.html | ✅ |
| A-04 | /dynamic/{id} 与 /opus/{id} 路由 | tests/dom/fixtures.test.ts + tests/e2e/extension.spec.ts | ✅ |
| A-05 | 取消完整回滚 | tests/e2e/extension.spec.ts（4 条事务路径） | ✅ |
| A-06 | 独立内容证据边界 | tests/unit/evidence.test.ts | ✅ |
| A-07 | local/official/report 三类动作副作用 | tests/unit/evidence.test.ts + policy.test.ts | ✅ |
| A-08 | 双 tab storage 同步与并发写入 | tests/e2e/extension.spec.ts（双 tab + 外部白名单即时生效） | ✅ |
| A-09 | 导入深层条件树/危险正则/超大名单/原型污染 | tests/unit/import-safety.test.ts | ✅ |
| A-10 | production manifest 不含测试域名 | tests/unit/release-manifest.test.ts | ✅ |
| A-11 | ZIP 根目录结构、manifest、权限和校验值 | review/release_gate.py + tests/unit/release-gate.test.ts | ✅ |
| A-12 | 未验证能力绝不发请求 | tests/unit/capabilities.test.ts + 适配器兜底 | ✅ |
| A-13 | 真实脱敏 DOM fixture（记录采集日期与页面版本特征） | tests/fixtures/pages/*（文件头注明合成与测试用途） | ✅ |

## 阶段 4 真实账号验证

| 能力 | evidenceId | 状态 |
|---|---|---|
| blockUser / unblockUser / reportVideoComment / reportVideoReply / reportDynamicComment / reportDynamic / selectorsVideo / selectorsDynamic | — | ⬜ 待人工验证（环境无真实账号）；生产构建已硬门禁，未验证能力不可发送真实请求 |

## 阶段 5 发布

| 产物 | 状态 | SHA-256 |
|---|---|---|
| dist/biliblocker-chrome-0.1.1.zip | ✅ | `c582e275ab8280e6823f300226d9dc49695b0b77fa064274bb2918125d4e7e88` |
| dist/biliblocker-edge-0.1.1.zip | ✅ | `ff6f4f4cbd4900a11ee539573843da13ac7c0ac25990583bfbbd0c2c7bfe1a95` |
| dist/biliblocker-source-0.1.1.zip | ✅ | `98108f4af21b4cbb455ca8fd8120fbd1447ea36bb55e37f4706134caccfb663b` |
| dist/SHA256SUMS.txt / build-info.json / dist/logs/*（8 个日志） | ✅ | build-info：tests{unit:209,e2e:16}，全部步骤 exit=0 |
| release gate | ✅ | `RELEASE GATE: PASS`（2026-08-13 流水线） |

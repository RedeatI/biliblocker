# BiliBlocker v0.1.7 阶段 F 进度与下一阶段计划

> 更新：2026-08-15。阶段 E 已独立复验通过；阶段 F 必须逐项验证。本文记录工程预检与待人工验收项，不能替代 `docs/REAL-ACCOUNT-VALIDATION-RECORD.md` 的通过证据。

## 当前结论

| 顺序 | 能力                          | 状态                                    | 下一门槛                                                                  |
| ---- | ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| 1    | `selectorsVideo`              | 整改后工程预检通过，仍 `verified:false` | 在加载当前生产构建的真实登录 Chrome 中完成 manual-test 1.1–1.5 并保存证据 |
| 2    | `selectorsDynamic`            | 未开始                                  | 仅在 `selectorsVideo` 正式通过后开始                                      |
| 3–8  | block / unblock / 4 类 report | 未开始                                  | 使用自控测试账号与自有测试内容，逐项小规模验证                            |
| 9    | report reason mapping         | 未开始                                  | 在各 report 端点通过后逐 reasonId 验证                                    |

商店提交、打包发布与任何真实官方操作仍禁止。

## selectorsVideo 首轮结果

1. 旧版选择器在 2026-08-15 的公开真实视频页命中为 0：页面已改为 `<bili-comments>` + 多层 open Shadow DOM。
2. 实页结构确认：根评论为 `<bili-comment-thread-renderer>`，字段位于嵌套 `<bili-comment-renderer>` / `<bili-rich-text>`，操作区为 `#footer`。
3. 已实现 composed-tree 查询、open ShadowRoot 观察、ShadowRoot 内快捷按钮/占位条样式挂载，并保留旧版 light DOM 兼容。
4. 公开页整改后聚合预检：2/2 根评论可读 UID 链接、正文与操作区；1 条纯文本评论没有 DOM `rpid`，因此 report 能力仍需独立解决，不能由 selectorsVideo 预检代替。
5. 验证：unit 400/400、E2E 31/31（新增新版 Shadow DOM 首屏 + 懒加载集成用例）、typecheck PASS、lint 0 error（历史 review 文件 11 warning）、Chrome/Edge 生产构建 PASS。

## 完成 selectorsVideo 的操作清单

1. 在用户控制的测试 Chrome 中加载 `out/chrome-mv3`，登录专用/可控 Bilibili 账号。
2. 按 `docs/manual-test.md` 1.1–1.5 检查一级评论、楼中楼、热门/最新切换、下滑懒加载、SPA 换视频和 aid 更新。
3. 保存脱敏截图/网络记录与浏览器版本，生成 `EV-2026-08-15-001`。
4. 仅在全部通过后回填验证记录，并单独开启 `CAPABILITY_VERIFICATION.selectorsVideo`；同步 selector UI 验证字段后重建、再验。
5. 任一项失败则保持 false，只修该失败点；不得顺带开启 `selectorsDynamic`。

## 下一阶段计划

`selectorsVideo` 正式通过后，下一阶段只做 `selectorsDynamic`：

1. 先对动态首页、`/dynamic/{id}`、`/opus/{id}` 做只读 DOM 结构预检。
2. 若选择器失效，新增脱敏 fixture + 单元/集成测试，保持 capability false。
3. 在真实登录 Chrome 完成 manual-test 1.6–1.8，记录独立 evidenceId。
4. 单独回填、开启、双浏览器重建和再验；完成后才进入 `blockUser`。

`blockUser` 起的下一组任务涉及真实账号外部副作用，必须使用自控测试账号和明确安全、可撤销的目标；举报不可撤销，不得对陌生第三方内容测试。

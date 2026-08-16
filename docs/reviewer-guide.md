# 审核人员测试步骤（Reviewer Guide）

> 给 Chrome Web Store / Microsoft Edge Add-ons 审核人员的复现步骤。
> 目的：让审核员可以在不登录真实 Bilibili 账号的情况下验证核心行为，并理解自动举报机制。

## 1. 无需真实账号即可验证的部分（本地 fixture + Mock）

扩展内附带完整单元/E2E 测试；审核员如愿意，可执行：
```bash
pnpm install
pnpm test          # Vitest 单元与 DOM fixture 测试
pnpm test:e2e      # 在本地 fixture 页面 + Mock 接口上跑完整 E2E
pnpm build:chrome
```

证据溯源：`dist/` 中的是迁移前历史 Stage E 证据（unit 396 / E2E 30）；Stage F 的源码记录为
unit 400 / E2E 31，见 `CHANGELOG.md`。本轮第二批工作树在 Linux、Node 22.23.2、pnpm 9.15.4 下通过
typecheck、完整 ESLint（0 warning）和 Vitest（62 files / 436 tests），但浏览器 E2E、load-unpacked 烟测以及
包含第二批差异的生产构建/ZIP 尚未验证。基线提交 `5f97621` 的隔离生产构建不包含第二批差异，不能作为其发布证据。
上述命令是审核复现路径，不构成完整发布链已通过的声明。

E2E 覆盖：按钮注入且每节点一次、疑似内容折叠、白名单放行、一键处理倒计时取消不产生请求、
确认后拉黑/举报 Mock 成功与失败、状态分别显示、页面切换后继续工作、总开关实时生效。

## 2. 带真实账号的快速验证（docs/manual-test.md 的摘要）

> 以下是官方能力解除门禁前的人工验证计划，不表示仓库当前已具备可提交真实请求的能力。

1. 加载与待审完整 commit 对应的 `out/chrome-mv3`，登录 Bilibili；
2. 打开视频页 → 评论右上角出现「一键拉黑并举报」（悬停显示）；
3. 设置页完成自动举报授权并选择默认理由（如「垃圾广告」）；
4. 对一条明显违规评论点「一键拉黑并举报」→ 倒计时可取消；
5. 倒计时结束后页面 Toast 分别显示「官方拉黑成功」与「举报已提交（无法由扩展撤回）」；
6. 到对方空间确认已被拉黑；举报可在 Bilibili 举报记录中查到。

## 3. 自动举报机制的透明性（审核重点）

- 首次授权页明确披露：代表用户提交举报、使用用户登录账号、成功后无法撤回、不上传 Cookie/凭据、不向第三方发送内容；
- 每次操作都有可取消倒计时（默认 3 秒）；
- 只有「用户点击一键处理 / 手动标记 / 精确 UID 名单 + 用户开启自动处理」三种路径可触发；
- 举报必须同时满足账号条件与内容条件；仅疑似（关键词/正则命中）绝不触发；
- 举报理由必须在配置枚举内有效，否则停止提交并提示；
- 无批量举报、无页面后台自动遍历、无远程代码、无遥测。

## 4. 权限最小化核对

- manifest 权限：`storage`、`alarms`；`host_permissions` 为空；
- 内容脚本仅注入 `https://www.bilibili.com/*`；
- 无 cookies/webRequest/history/downloads/tabs/`<all_urls>`；
- 官方接口请求由内容脚本以页面登录态发起（与页面前端同机制），扩展自身不保存 Cookie。

## 5. 数据与隐私核对

- 数据默认本地（chrome.storage.local）；设置页「隐私与权限」页有完整说明；
- 日志不含评论正文；导出为脱敏 JSON；
- 无第三方请求、无遥测、无广告 SDK。

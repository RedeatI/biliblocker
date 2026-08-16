# BiliBlocker 真实账号验证记录

> 本文件是唯一的能力验证证据来源。每一条 `Verification.evidenceId` 必须能在本文件查到。
> 验证原则：使用专用测试账号与可控测试内容；不记录 Cookie、bili_jct、完整账号标识或可复用凭据；
> 只记录浏览器版本、扩展 ZIP SHA、请求路径/参数名、脱敏响应 code 与 UI 后验结果。
> 任一能力未通过时保持 `verified=false`，不得发布该能力。

## 验证状态总览

| 能力键 | verified | verifiedAt | evidenceId | 说明 |
|---|---|---|---|---|
| blockUser | false | — | — | 待真实账号人工验证 |
| unblockUser | false | — | — | 待真实账号人工验证 |
| reportVideoComment | false | — | — | 待真实账号人工验证 |
| reportVideoReply | false | — | — | 待真实账号人工验证 |
| reportDynamicComment | false | — | — | 待真实账号人工验证 |
| reportDynamic | false | — | — | 待真实账号人工验证 |
| selectorsVideo | false | — | — | 2026 Shadow DOM 整改后工程预检通过；待真实登录 Chrome 完成 1.1–1.5 |
| selectorsDynamic | false | — | — | 待真实账号人工验证 |

> ⚠️ 当前整改环境（2026-08-13）无真实登录账号与可控测试内容，**全部能力保持 UNVERIFIED**。
> 依据 P0-4 硬门禁，生产包中上述能力一律不可发送真实请求；商店提交必须待人工验证补齐后方可进行。
>
> 代码映射：`src/shared/capabilities.ts`（CAPABILITY_VERIFICATION / isCapabilityEnabled / canReportContentType）
> 是本表在运行时的唯一权威读取点；页面选择器验证状态另见 `src/adapters/bilibili/selectors.ts` 的 `VERIFICATION` 常量
> （selectorsVideo/selectorsDynamic 对应本表两行，人工验收时一并回填）。

## 证据条目

_（无。验证由人工在真实浏览器 + 专用测试账号下完成，逐条回填。每条证据包含：日期、浏览器版本、扩展 ZIP SHA-256、请求路径/参数名、脱敏响应 code、UI 后验结果。）_

## 工程预检（不构成通过证据）

### PF-2026-08-15-001 — selectorsVideo Shadow DOM 适配

- 日期：2026-08-15
- 环境：公开真实视频页、匿名内置浏览器；未加载生产扩展、未使用真实账号。
- 修复前：旧 `.reply-list/.reply-item` 选择器命中 0；页面实际为 `<bili-comments>` 的多层 open Shadow DOM。
- 修复后聚合结构检查：2/2 根评论命中 UID 链接、正文和 `#footer` 操作区；其中 1 条纯文本评论无 DOM `rpid`。
- 自动验证：unit 400/400；E2E 31/31（含 Shadow DOM 首屏与懒加载）；typecheck、Chrome/Edge build 通过。
- 结论：工程预检通过，但不满足真实账号人工验收定义；`selectorsVideo.verified` 必须保持 false，待 manual-test 1.1–1.5 完整执行后另建 `EV-*` 证据。

## 人工验证步骤摘要（详见 docs/manual-test.md）

1. 准备专用测试账号（非日常账号）与可控测试内容（自建视频/动态/评论）。
2. 加载生产 ZIP 对应的扩展构建（记录 ZIP SHA-256）。
3. 逐能力执行：拉黑 → 解除拉黑 → 视频评论举报 → 楼中楼举报 → 动态评论举报 → 动态本体举报 → reason 枚举抽查。
4. 每次操作记录：请求 URL 与参数名、脱敏响应 code（如 `code:0`）、UI 后验（黑名单状态、举报回执、账号页确认）。
5. 通过后把对应能力 `verified=true` 并回填 evidenceId（形如 `EV-2026-08-xx-001`）。

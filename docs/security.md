# 安全设计（BiliBlocker）

> 版本：0.1.0 ｜ 更新：2026-08-13

## 1. 威胁面与控制

| 威胁 | 控制 |
|---|---|
| XSS / DOM 注入 | 所有页面文本经 `textContent` 写入，禁止 innerHTML 携带未转义页面内容（eslint 强制 no-v-html off 仅限受控静态文案） |
| 任意消息伪造 | 消息协议判别联合 + 结构校验；background 通过 sender 校验来源；`onMessageExternal` 一律拒绝 |
| 任意请求代理 | 适配器 URL 白名单（仅 api/www/passport/account.bilibili.com）；不接受任意 URL/函数名/JS 字符串 |
| 重复点击 / 重复举报 | 按钮 busy 态防连点；持久化去重（block:uid 30 天、report 365 天）+ 队列内同键去重 |
| 并发拉黑 | 队列串行（拉黑/举报并发度均为 1） |
| 正则 DoS（灾难性回溯） | 模式长度 ≤200、输入 ≤1000；启发式拒绝嵌套/重叠量词与多层回溯；语法错误规则自动禁用不影响其他规则；设置页用独立 Worker 时间预算测试（public/workers/regex-tester.js） |
| 恶意 JSON 导入 | Zod strict Schema（拒绝未知键/代码字段）、文件 ≤512KB、递归剥离 `__proto__`/`constructor`/`prototype`、导入前预览需确认 |
| 原型污染 | 见上；数据读取使用 Object.entries/Map 而非直接展开不可信对象 |
| 网络超时 | 所有 Bilibili 请求 15s AbortController 超时 |
| 登录失效 | 错误码 -101 归类 login_invalid → 队列暂停；页面提示重新登录 |
| 接口变更 | HTTP 404 / code -404 → api_changed，不冒充成功 |
| 验证码/风控 | code -352/-403/-509 → 队列暂停，要求用户手动处理，不绕过 |
| 撤销部分失败 | 取消只作用于未发送任务；已发送任务结果不被取消覆盖（runTask 校验 cancelled 状态）；已提交举报明确不可撤回 |
| SW 回收队列恢复 | 队列持久化 + 重启重排队 + alarms 唤醒 |
| CSRF | 仅使用 bili_jct 签名同源接口请求（与页面前端一致）；不存储、不跨域转发 |
| 数据外泄 | 无遥测；无第三方请求（除 Bilibili 第一方接口）；日志不含正文；导入导出本地文件 |

## 2. 关键安全不变量（代码级）

1. 白名单 > 一切规则；当前登录用户永不处理（engine 与 policy 双层）。
2. 疑似状态（关键词/正则/用户名/链接命中）只可折叠/标记/提示，**绝不**触发官方拉黑/举报/加入已确认名单。
3. 官方动作仅「精确 UID 规则 + 已确认名单」；`report_verified_uid_content` 还要求可举报类别。
4. 举报双条件：账号条件 ∧ 内容条件；已确认机器人发布的普通内容不得自动举报。
5. 举报理由无效时停止提交，绝不猜测 reason id、不虚构证据。
6. 无远程代码：不远程加载 JS、无 eval/new Function、规则不可含代码。

## 3. 构建期检查

- `pnpm lint`（0 error 0 warning）、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e` 全绿；
- CSP：MV3 默认（无远程脚本）；未使用 `unsafe-eval`。

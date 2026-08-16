# 权限申请与理由（Permissions Rationale）

> 版本：0.1.0 ｜ 更新：2026-08-13

## 1. manifest 权限清单

| 权限 | 类型 | 用途 | 是否必需 |
|---|---|---|---|
| `storage` | API 权限 | 本地保存设置、规则、名单、队列、去重、日志（chrome.storage.local） | 是 |
| `alarms` | API 权限 | 每分钟唤醒后台队列，推进退避中的任务（SW 生命周期兜底） | 是 |
| `https://www.bilibili.com/*` | 内容脚本注入 | 在 Bilibili 页面执行过滤与快捷按钮；接口调用在页面上下文以用户登录态进行 | 是 |

`host_permissions` 为空数组：扩展页（后台/设置/弹窗）**不**直接请求任何第三方域名。

## 2. 为什么不需要更宽权限

| 未申请权限 | 原因 |
|---|---|
| `cookies` | 接口请求从内容脚本发起，浏览器自动携带 `.bilibili.com` 域 Cookie；CSRF 令牌（bili_jct）仅瞬时读取用于签名，不持久化、不上传 |
| `webRequest` | 不拦截/改写任何网络流量（网络层过滤方案列入 future-features 评估） |
| `<all_urls>` | 只操作 www.bilibili.com |
| `history` / `tabs` | 任务派发通过消息的 sender 携带 tabId，无需 tabs 权限（tabs.query 未使用） |
| `downloads` | 导入导出通过 Blob 下载与 FileReader 完成 |
| `notifications` | 状态提示使用页面内 Toast，不需要系统通知 |
| `unlimitedStorage` | 数据量受上限约束（规则 300、名单 2 万、日志 2000） |

## 3. 权限与行为对照

- 「读取 Bilibili 页面中的评论与动态内容」：仅在内容脚本运行时（你打开 Bilibili 页面时）发生，用于过滤与举报；
- 「代表用户调用 Bilibili 拉黑」：仅当用户点击一键处理 / 手动确认 / 精确名单+自动处理开关 时；
- 「代表用户提交举报」：需要首次明确授权 + 有效默认理由，且始终带可取消倒计时；
- 数据默认本地保存；无遥测、无第三方上传。

## 4. 商店审核要点（对应本文件）

商店「权限用途」填写建议直接引用本文件 §1 表格；隐私政策与 PRIVACY.md 保持一致。

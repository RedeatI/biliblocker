# 发布状态（0.1.7）

本仓库当前只准备公开源码，不发布 Chrome/Edge 商店包，也不提供已签名或已审核的二进制分发。

## 0.1.7 源码预览

- 产品模式：本地优先、默认关闭；用户明确启用后默认仍为“仅标记”。
- 官方操作：拉黑、举报及真实账号能力尚未完成验证，保持关闭。
- 网络边界：隔离的 Chrome for Testing 151 烟测中，扩展 Service Worker 在默认关闭和“仅标记”启用阶段均未发出官方 API 请求。
- 适用范围：上述零请求结论仅指扩展自身，不包括 Bilibili 页面发出的请求。
- 动态限制：公开页面烟测未观察到可确认的评论/动态标记节点，真实内容注入效果仍需人工验收。
- 分发状态：未创建商店条目、未上传 ZIP、未创建 GitHub Release。

## 已替代的 RC2 证据

RC2 源码提交为 `68c23f2b75904eb777204a6ff55873b8279be9ff`。以下三个历史包因产品真值不合格而被替代，仅保留哈希用于识别，均不属于本次源码预览：

| 历史包 | SHA-256 |
|---|---|
| Chrome ZIP | `afdad249a4e4987b036b2af6965ba221abd113a4a287b4ccfcf70194489004a1` |
| Edge ZIP | `73a8d4ffe3e0231bd9309325e49ada055c2ddbc426fcb6772ecccd9471a24bba` |
| Source ZIP | `0720165fe9e8c1ade6ec3fd1425ba0dd07ceef7741d02c266bc32ed64e894bed` |

这些历史包**不得上传、不得覆盖、不得冒充**当前或后续候选的构建证据。

## 安全承诺

- 不申请 Cookie、`webRequest` 或 `<all_urls>` 权限。
- 不上传评论、动态正文、Cookie 或 CSRF Token。
- 疑似内容只在本地标记或折叠，不自动拉黑或举报。
- 未验证的官方能力保持失效关闭，不能由普通设置绕过。

完整隐私说明见 [`PRIVACY.md`](../PRIVACY.md)，权限理由见
[`docs/permissions-rationale.md`](permissions-rationale.md)。

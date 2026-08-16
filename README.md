# BiliBlocker

在本地解释、标记、折叠并可恢复地治理 Bilibili 评论与动态中的疑似广告、营销和垃圾内容。

> 单一用途：在本地标记、折叠并可恢复地管理 Bilibili 评论与动态中的疑似广告和垃圾内容。
> 第三方非官方扩展，与哔哩哔哩（Bilibili）官方无关。

## 功能

- **本地规则过滤**：按关键词 / 链接 / 域名 / 正则 / 用户名 / UID 折叠或隐藏疑似广告内容（规则在设置页表单化创建）。
- **本地快捷治理**：评论/楼中楼/动态右上角提供快捷入口；可临时隐藏、加入本地黑名单或白名单，并在页面内恢复误折叠内容。官方拉黑/举报能力默认关闭，且当前仍被未验证能力门禁阻止。
- **三种名单**：本地黑名单、已确认机器人名单、白名单（白名单高于一切规则；本人账号永不处理）。
- **自动处理开关**（默认关闭）：仅在精确 UID 与独立内容证据同时满足、能力已验证且用户明确授权时，才可能带倒计时处理；当前生产能力未验证，不发送官方请求。
- **操作日志**：本地保存、可筛选/导出（脱敏，不含正文）。
- **导入导出**：设置/规则/名单 JSON 备份（Schema 校验 + 原型污染防护）。

## 安全边界（不会做的事）

- 疑似（关键词/正则/用户名/链接命中）只折叠/标记，**绝不**自动拉黑或举报；
- 只有「用户确认 / 手动标记 / 精确 UID 名单 + 用户开启自动处理」才可能触发官方操作；
- 自动举报必须同时满足账号条件与内容条件；
- 不申请 cookies/webRequest/`<all_urls>` 权限；不保存 Cookie；不上传任何数据；
- 无遥测、无远程代码、无批量举报、无页面后台遍历。

## 开发

```bash
pnpm install
pnpm lint          # ESLint（0 error / 0 warning）
pnpm typecheck     # tsc --noEmit
pnpm test          # Vitest 单元 + DOM fixture 测试
pnpm test:e2e      # Playwright E2E（本地 fixture + Mock，无需真实账号；E2E=1 构建写入 out-e2e/，不触碰 out/）
pnpm build:chrome  # out/chrome-mv3
pnpm build:edge    # out/edge-mv3
pnpm zip           # dist/ 商店 ZIP + Source ZIP + SHA256SUMS + build-info（强制清理重建 + 生产洁净门禁）
pnpm release       # 完整发布流水线：lint → typecheck → 单测 → E2E → 构建 → zip → release_gate，日志写入 dist/logs/
pnpm dev           # 开发模式（热更新）
```

> 0.1.7 源码预览基于 RC4 的“默认关闭、零官方请求”门禁。已在隔离的 Chrome for Testing 151 中真实加载：
> 默认开关关闭；用户明确选择“仅标记”后保持本地模式；扩展 Service Worker 在默认和启用阶段均未发出官方 API 请求。
> 该结论只约束扩展自身请求，不包括 Bilibili 页面本身的网络流量。公开页面烟测未观察到可用于确认的评论/动态标记节点，
> 因此真实内容注入效果仍属于人工验收项，不能写成已通过。源码预览不包含商店包，也不授权上传或启用官方拉黑/举报能力。

> 真实能力门禁：拉黑/举报/选择器等能力未通过真实账号人工验证（docs/REAL-ACCOUNT-VALIDATION-RECORD.md）
> 前，生产构建不会发送任何真实请求；验证通过后按 docs/manual-test.md 回填证据编号即可启用。

## 手动安装（开发/验收）

1. 运行 `pnpm build:chrome`；
2. Chrome → `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `out/chrome-mv3`。

## 测试

- 单元测试：规则运算符/组合/优先级、权限校验、去重、队列（重试/取消/暂停/恢复/限流）、导入导出、迁移、日志脱敏。
- DOM fixture：评论/楼中楼/动态提取、缺字段降级、class 变化、注入防重、占位条。
- E2E：真实加载扩展 + 本地 fixture 页面 + api.bilibili.com Mock（注入、折叠、白名单、一键流程、倒计时取消、成败状态、页面切换、设置实时生效）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 技术栈与架构决策 |
| [docs/reference-research.md](docs/reference-research.md) | 参考扩展研究（许可证核验、借鉴与红线） |
| [docs/bilibili-research.md](docs/bilibili-research.md) | Bilibili 页面与接口调研（含 UNVERIFIED 标记） |
| [docs/security.md](docs/security.md) / [docs/threat-model.md](docs/threat-model.md) | 安全设计与威胁模型 |
| [docs/permissions-rationale.md](docs/permissions-rationale.md) | 权限申请理由 |
| [docs/manual-test.md](docs/manual-test.md) | 真实账号人工验收步骤 |
| [docs/store-submission.md](docs/store-submission.md) / [docs/reviewer-guide.md](docs/reviewer-guide.md) | 商店材料与审核说明 |
| [docs/release-checklist.md](docs/release-checklist.md) | 发布清单 |
| [docs/release-candidates.md](docs/release-candidates.md) | 本地候选与替代证据登记 |
| [docs/future-features.md](docs/future-features.md) | 后续功能审批 |
| [PRIVACY.md](PRIVACY.md) | 隐私政策 |
| [CHANGELOG.md](CHANGELOG.md) | 变更日志 |

## 许可证

MIT（见 [LICENSE](LICENSE)）。参考扩展研究见 docs/reference-research.md（GPL 项目仅作行为借鉴，未复制代码）。

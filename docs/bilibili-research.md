# Bilibili 技术调研（BiliBlocker）

> 调研日期：2026-08-13
> 范围：桌面端 www.bilibili.com 的评论区、动态、官方拉黑/举报接口、登录/CSRF/风控机制。
> 纪律：只研究普通用户正常登录态可完成的操作；不绕过登录/验证码/风控/限流；不保存 Cookie；
> 不向第三方传输 Cookie、CSRF 或页面内容；所有无法在本环境实际验证的结论一律标注 UNVERIFIED。

## 1. 核验状态总览

| 结论 | 核验状态 |
|---|---|
| 用户链接形如 `//space.bilibili.com/{uid}`（DOM 可见） | ✅ VERIFIED（线上页面抓取确认） |
| SSR 初始状态 `window.__INITIAL_STATE__` 含 `aid` 等字段 | ✅ VERIFIED（线上页面抓取确认） |
| 评论区/动态各 class 选择器（见 §2） | ⚠️ UNVERIFIED（依据社区文档与历史结构整理，多候选回退，需人工验收） |
| 拉黑接口 `POST /x/relation/modify`（act=5 拉黑 / act=6 解除） | ⚠️ 接口路径与参数有多年社区文档佐证（UNVERIFIED-行为） |
| 举报接口 `POST /x/v2/reply/report` 及参数 | ⚠️ UNVERIFIED（社区文档；原 bilibili-API-collect 仓库已因律师函关停，活跃 fork：`github.com/afiuh/bilibili-api-collect`） |
| 举报理由枚举与动态举报端点 | ⚠️ UNVERIFIED（见 §4，需人工验收） |
| 登录检查 `GET /x/web-interface/nav` | ⚠️ 路径社区文档佐证（UNVERIFIED-行为） |
| `bili_jct` cookie 非 HttpOnly（页面 JS 可读） | ✅ 依据公开资料（UNVERIFIED-行为） |
| 错误码 -101 / -352 / -403 / -111 / -509 含义 | ⚠️ 社区文档（UNVERIFIED-行为） |

> 说明：本仓库开发环境无法登录真实账号。所有「接口行为」类结论都不能在本环境实测，
> 已在代码注释与 docs/manual-test.md 中提供人工验收步骤，未经验证的接口不会显示“成功”。

## 2. 页面 DOM 结构（选择器集中维护于 `src/adapters/bilibili/selectors.ts`）

### 2.1 视频评论区

- **2026-08-15 公开实页观察**：评论根为 `<bili-comments>`，使用多层 open Shadow DOM；根评论为 `<bili-comment-thread-renderer>`，实际字段组件为 `<bili-comment-renderer>`。
- 新版用户名/UID：`#user-name a[href*="space.bilibili.com"]` 或 `a#user-avatar`；正文位于 `<bili-rich-text>` shadow root 的 `#contents`；操作区为评论组件 shadow root 的 `#footer`。
- 新版楼中楼容器为 `<bili-comment-replies-renderer>`；回复条目仍待真实登录账号展开后完成最终核验。
- 旧版评论根容器：`.reply-list`（亦有 `.comment-list`）
- 一级评论：`.list-item`（外层）> `.reply-node` > `.reply-item`；部分版本 `.reply-item` 直接作为根
- 用户名：`.user-name`（`<a href="//space.bilibili.com/{uid}">`）；UID 从 href 解析（VERIFIED 模式）
- 正文：`.reply-content-container .reply-content` / `.reply-content`
- 楼中楼：`.sub-reply-container` > `.sub-reply-item`（内容同 `.reply-content`）
- 内容 ID：旧版条目上的 `data-rpid` / `data-id` 候选属性；新版含表情评论的内容后代可能带 `data-rpid`，但公开实测纯文本评论无 DOM `rpid`，**JSON 接口仍是更可靠来源**（见 §7 降级路径）。

### 2.2 动态

- 动态卡片：`.bili-dyn-item`（外层，`data-dyn-id` 候选）> `.bili-dyn-card`
- 用户：`.bili-dyn-card__user-name`（含 space 链接）
- 正文：`.bili-dyn-content__text` / `.bili-dyn-card__content`；转发原文块：`.bili-dyn-content__orig`
- 动态详情页：`/dynamic/{id}` 与 `/opus/{id}` 两种形态（opus 为较新形态）
- 动态评论：复用评论组件（容器/条目 class 与视频评论近似）

### 2.3 SPA 与懒加载

- 路由：history pushState/replaceState + popstate（Bilibili 为 SPA）
- 懒加载/无限滚动：滚动到底部触发加载，评论区通过分页接口渲染新节点
- 适配策略（本项目）：body + 所有可达 open ShadowRoot 的 MutationObserver 只处理新增目标节点并批处理；history 补丁 + popstate + 800ms 轮询兜底

## 3. 稳定提取

| 字段 | 方式 |
|---|---|
| UID | 用户名链接 href 正则 `space\.bilibili\.com/(\d+)` |
| 用户名 | 用户名元素 textContent |
| 正文 | 正文容器 textContent（空白归一化） |
| 链接 | 内容内 `<a href>` + 文本 URL 提取（站外域名过滤内部域） |
| 评论 ID | 条目 `data-rpid` 等候选属性；JSON 接口为更可靠来源 |
| 根评论 ID | 楼中楼向上找所属 `.list-item` 的 rpid |
| 视频 aid（oid） | `window.__INITIAL_STATE__.aid / videoData.aid`（VERIFIED 字段） |
| 动态 ID | `/dynamic/{id}`、`/opus/{id}` URL 或卡片 `data-dyn-id` |
| 页面类型 | `pathname`：`/video/`、`/dynamic/`、`/opus/`、其余为动态首页 |

## 4. 官方操作接口（全部 UNVERIFIED，需人工验收）

### 4.1 拉黑 / 解除拉黑

- 接口：`POST https://api.bilibili.com/x/relation/modify`
- 参数：`fid=<目标UID>&act=5|6&re_src=11&csrf=<bili_jct>`
  - `act=5` 拉黑；`act=6` 解除拉黑（多年稳定约定，社区文档佐证）
- CSRF：读取 `bili_jct` cookie（非 HttpOnly，页面 JS 同源读取；本扩展仅内存使用、不持久化）
- 重复拉黑：服务端通常返回 code 0（幂等）；本项目另以本地去重兜底

### 4.2 举报

- 评论/楼中楼/动态评论：`POST https://api.bilibili.com/x/v2/reply/report`
  - 参数：`oid`（视频 aid / 动态 ID）、`type`（视频=1、动态=17、带图动态=11、专栏=12）、`rpid`（评论 ID）、`reason`（理由 ID）、`csrf`
- 动态本体举报：候选端点 `https://api.bilibili.com/x/polymer/web-dynamic/v1/dynamic/report`（**端点本身 UNVERIFIED**）
- 举报理由枚举（社区文档，UNVERIFIED，版本化维护于 `src/shared/constants/report-reasons.ts`）：
  - 1 垃圾广告 / 2 色情低俗 / 3 人身攻击 / 4 违法违禁 / 5 视频无关 / 6 刷屏 / 7 涉及未成年 / 8 其它 / 9 引战 / 12 赌博诈骗
- **安全不变量**：理由必须在配置枚举内有效，否则返回 `invalid_reason` 并停止提交，绝不猜测或替代 reason id；不虚构证据、不自动生成违规描述

## 5. 登录 / CSRF / 错误 / 重复 / 改版

| 主题 | 结论 |
|---|---|
| 登录检查 | `GET /x/web-interface/nav` → `code:0, data.isLogin, data.mid`（当前用户 UID） |
| CSRF | `bili_jct` cookie；非 HttpOnly；仅瞬时读取用于签名 |
| 常见错误码 | `-101` 未登录；`-352` 风控/验证码；`-403` 拒绝访问；`-111` CSRF 校验失败；`-509` 频率限制 |
| 接口改版表现 | HTTP 404 / 业务 code -404 → 归类 `api_changed`，绝不冒充成功 |
| 验证码 | 触发时停止自动化（队列暂停），要求用户手动处理，不绕过 |

## 6. 页面改版风险选择器清单（失效时优先修改 selectors.ts）

- `.reply-list` / `.list-item` / `.reply-item` / `.sub-reply-container` / `.sub-reply-item`
- `.user-name` / `.reply-content` / `.reply-actions`
- `.bili-dyn-item` / `.bili-dyn-card` / `.bili-dyn-content__text` / `.bili-dyn-content__orig`
- `data-rpid` / `data-dyn-id` / `data-id`
- `window.__INITIAL_STATE__` 结构（aid 字段）

## 7. 可用降级路径

1. **rpid 从 JSON 接口取**：评论列表接口（如 `/x/v2/reply/main`）返回 `replies[].rpid`、`root`、`parent`，比 DOM 属性更稳定；接口带 Wbi 签名（密钥在 SSR `__INITIAL_STATE__.wbi_img` 中，社区文档说明）。
2. **aid 从 SSR 取**：`__INITIAL_STATE__`（VERIFIED）；页面改版后可回退到 bvid→aid 转换接口（需网络，v1 不做）。
3. **选择器多候选回退**：每个语义字段保留 2~3 个候选选择器，首个命中使用。
4. **缺失关键字段降级**：缺 UID → 仅隐藏；缺内容 ID → 可拉黑但不可举报，并明确提示原因（已实现）。
5. **接口行为未验证**：适配器统一标准化结果，任何未验证环节不会显示“成功”（已实现）。

## 8. 未验证事项清单（人工验收时逐项核对，见 docs/manual-test.md）

1. 视频评论新版 Shadow DOM 已完成公开页工程预检，但真实登录 Chrome 的楼中楼/排序/懒加载/SPA 全清单与全部动态选择器仍待人工验收。
2. `/x/relation/modify` 的 act 参数与返回码（含重复拉黑行为）。
3. `/x/v2/reply/report` 的 type 值（视频=1/动态=17/带图=11/专栏=12）。
4. 举报理由枚举（尤其 12 赌博诈骗 是否对各类内容有效）。
5. 动态本体举报端点 `/x/polymer/web-dynamic/v1/dynamic/report` 是否存在。
6. `bili_jct` 在当前登录态下是否可读、内容脚本 fetch 的 CORS 行为。
7. 风控触发阈值（-352 的实际表现与触发条件）。

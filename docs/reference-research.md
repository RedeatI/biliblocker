# 参考扩展研究（BiliBlocker）

> 研究日期：2026-08-13
> 用途：为 BiliBlocker（Bilibili 广告/垃圾内容过滤 + 一键拉黑举报扩展）提供行为与架构参考。
> 合规纪律：不反编译商店安装包；不绕过访问限制；GPL 等强 copyleft 源码只研究行为与架构，不复制实现代码。

## 1. 研究对象与核验信息

### 1.1 Twitter Blocker（rxliuli）

| 项目 | 内容 |
|---|---|
| 开发者 | rxliuli（rxliuli.com，运营 37 个 Chrome 扩展） |
| Firefox 商店页 | https://addons.mozilla.org/firefox/addon/twitter-blocker1 |
| Chrome Web Store | ID `mbjkhjgpomohfcodieeokjniidffmcga`（extwise 镜像：https://extwise.com/extension/twitter-blocker-3） |
| 版本 | Firefox 0.3.16（2026-07-06）；Chrome 0.3.x（2026-07-06 更新） |
| 许可证 | **GNU GPL v3.0 only**（商店明确列出） |
| 公开源码 | 关联仓库 `github.com/rxliuli/mass-block-twitter`（公开）；「Twitter Blocker」扩展代码与该仓库的同步程度**未核验（UNVERIFIED）** |
| 权限 | “Block content on any page”（近似 `<all_urls>`）、通知、x.com 数据访问 |
| 数据收集 | 开发者声明不收集数据 |

商店可观察行为（来源：AMO 商店说明）：
- 全站推文卡片注入「Quick Block」一键拉黑按钮；
- **每次拉黑提供 3 秒撤销窗口**；
- 批量导入 CSV 用户名执行后台批量拉黑（可运行数天，不依赖前台标签页）；
- 自动处理 API 限流并自动恢复；随时暂停/恢复；进度跨会话跟踪。

### 1.2 Mass Block Twitter（rxliuli）

| 项目 | 内容 |
|---|---|
| Chrome Web Store ID | `IDeaghpebepefbcadjdppjjopoagckdhej` |
| 版本 | 0.26.9（2025-03-24 左右）；约 5000+ 用户 |
| 许可证 | **GPL-3.0**（公开仓库 `github.com/rxliuli/mass-block-twitter` 的 LICENSE 确认，公开源码已实际阅读） |
| 隐私定位 | 最小权限、零数据收集、100% 开源 |

已阅读源码确认的产品/架构事实：
- 内容审核清单（类似 Bluesky moderation lists）；
- 智能扫描 + 批量拦截可疑账户；一键即时屏蔽；
- 社区共享黑名单（第三方同步——**BiliBlocker v1 明确不做**）；
- 自动隐藏可疑账号（无头像/简介/粉丝 等账号特征）；
- 关键词过滤（跨个人资料/用户名/推文）。

### 1.3 Twitter Filter（rxliuli）

| 项目 | 内容 |
|---|---|
| Firefox 商店页 | https://www.crxsoso.com/firefox/detail/twitter-filter |
| 版本 | 0.0.65（2026-08-02） |
| 许可证 | 商店未标注 GPL（**UNVERIFIED**），仅作行为研究 |
| 规则能力 | 基于「推文内容 + 账号属性（粉丝数、账号年龄、简介关键词、用户名模式、认证状态）」自定义规则；规则语言支持比较、字符串匹配、正则、逻辑运算符；匹配后动作：黄框标记 / 隐藏 / **延迟 + 撤销的自动拉黑** |
| 规则导入导出 | 屏幕名 CSV 导入（每条规则支持多达 100,000 个名字）；规则 JSON 导入导出 |
| 隐私设计 | 过滤完全在浏览器内执行；规则分享可选且仅同步规则元数据，时间线数据不出设备；**自己的推文与已关注账号的推文永远跳过** |

### 1.4 其他参考

| 项目 | 说明 |
|---|---|
| `amahteru/x-comment-blocker` | MIT 许可（agent 核验报告），场景最接近：X 评论区内容过滤（**UNVERIFIED by 主 agent 复核**，仅行为借鉴） |
| `apoorvdarshan/x-country-filter` | MIT（dev.to 公开），按国家隐藏推文，简单过滤实现 |
| gorhill/twit-block | **不存在**：gorhill 的 28 个仓库已核验，无该仓库（纠正任务前提） |
| Vista（Twitter 过滤） | 网络层拦截并改写 API 响应以实现过滤，比 DOM 过滤更抗虚拟滚动（仅架构思想借鉴） |

## 2. 十个方面的实现/设计模式总结

| 主题 | 参考实现模式 | 来源 |
|---|---|---|
| 1. 快捷按钮注入 | 注入到内容卡片操作区（action bar）内联，非覆盖式弹层；按钮随卡片渲染 | Twitter Blocker（商店行为） |
| 2. 无限滚动检测 | MutationObserver 观察内容容器新增节点 + 滚动/交叉观察；Vista 用网络层拦截 API 响应（虚拟滚动免疫） | mass-block-twitter 源码 / Vista |
| 3. SPA 页面跳转 | history.pushState/replaceState 补丁 + popstate + URL 轮询兜底 | 社区通用做法（行为研究） |
| 4. 防重复注入 | WeakMap/WeakSet 状态缓存 + DOM data 标记；节点替换后旧条目自动回收 | mass-block-twitter 源码 |
| 5. MutationObserver 性能 | 批处理（批量刷新队列）、只处理新增节点、容器级观察、节流、必要时断开重连 | mass-block-twitter 源码 |
| 6. 拉黑状态管理 | storage 持久化 + 按 UID 去重 + 跨标签页一致性（storage.onChanged） | 通用做法（行为研究） |
| 7. 规则表达 | JSON 条件（字段+运算符+值）；Twitter Filter 用表达式语言（比较/字符串/正则/逻辑） | Twitter Filter 商店说明 |
| 8. 规则优先级 | 分数/顺序判定；**白名单与“自己/已关注”永远跳过** 优先于一切规则 | Twitter Filter（行为研究） |
| 9. 撤销与失败恢复 | 每次拉黑带 3 秒撤销窗口；限流自动暂停/恢复；批量任务断点续跑 | Twitter Blocker 商店说明 |
| 10. 黑名单导入导出 | CSV（用户名列表）+ JSON（规则）；大小限制与格式校验 | Twitter Filter / Mass Block Twitter |
| 11. 权限与隐私 | 最小权限声明（Mass Block Twitter：零数据收集）；过滤本地执行 | 商店说明 |

## 3. 可借鉴的产品思想

1. **一键操作 + 短撤销窗口**：Twitter Blocker 的「3 秒撤销」非常契合我们的「倒计时取消」设计（已采用）。
2. **占位/折叠而非永久删除**：过滤结果可视化、可恢复，降低误伤成本（已采用占位条）。
3. **账号特征辅助判断**：Mass Block Twitter 的「无头像/无简介/无粉丝」特征用于“疑似”，只能提示不可自动拉黑（BiliBlocker 中归入“疑似”状态，符合产品定义）。
4. **跳过自己与已关注**：Twitter Filter 的“自己的推文永远跳过”——BiliBlocker 等价物为「当前登录用户保护 + 白名单」（已实现为硬性不变量）。
5. **本地优先 + 隐私透明**：规则与名单全部本地处理，隐私声明明确（已采用）。
6. **延迟+撤销的自动拉黑**：Twitter Filter 支持“匹配后延迟自动拉黑并可撤销”——与我们的“已确认机器人自动处理 + 倒计时取消”同构（已采用）。

## 4. 可借鉴的架构思想

1. **批处理 MutationObserver + WeakMap 状态缓存**：防重复注入与内存可控（已实现：`PageObserver` + `WeakSet` + `data-bb-processed`）。
2. **UI 样式隔离**：Shadow DOM / 严格命名空间（已实现：快捷按钮与 Toast 用 Shadow DOM，占位条用 `bb-` 命名空间样式）。
3. **规则引擎独立于页面**：纯函数求值 + 动作权限校验（已实现：`RuleEngine` + `ActionPolicyEngine` 双层校验）。
4. **队列化官方操作 + 限流自恢复**：串行队列、按分钟限流、登录失效/风控暂停（已实现：`ActionQueue`）。
5. **SPA 处理三件套**：history 补丁 + popstate + 轮询兜底（已实现）。
6. **网络层拦截思路**（Vista）：不在 v1 采用（需要 `webRequest` 权限，违背权限最小化），列入 future-features 评估。

## 5. 不得复制的代码

| 对象 | 许可证 | 结论 |
|---|---|---|
| `rxliuli/mass-block-twitter` 全部源码 | GPL-3.0 | 仅研究行为与架构；不复制任何实现代码、函数或算法细节 |
| `rxliuli` 的 Twitter Blocker / Twitter Filter（若源码公开） | GPL-3.0-only / 未核验 | 同上；GPL 传染性，禁止并入本项目 |
| `amahteru/x-comment-blocker` 源码 | MIT | 可借鉴思路；若引用需保留署名（本项目未引用其代码） |
| 本项目对上述仓库的 any 代码片段 | — | 一律 clean-room 独立实现 |

## 6. 不得复制的品牌和视觉资源

- 不复制上述任何扩展的**名称、Logo、图标、配色、截图与宣传语**。
- BiliBlocker 使用自有品牌：名称、自绘图标（盾牌+封禁符号，品牌蓝 #4A6CF7，见 `scripts/generate-icons.mjs`）、自有文案。
- 不复制 Bilibili 官方商标/图标；商店文案声明“与哔哩哔哩官方无关”。

## 7. 风险清单（参考侧）

1. GPL 仓库代码不得混入本仓库（已通过独立实现规避，审查时需核对无复制痕迹）。
2. 参考扩展普遍申请 `<all_urls>` / 通知等宽权限；BiliBlocker 采用最小权限（storage + alarms + www.bilibili.com 内容脚本），商店审核文案需说明差异理由。
3. 批量/社区黑名单属于「后续功能审批」范畴（产品定义 §二十一），v1 不做。

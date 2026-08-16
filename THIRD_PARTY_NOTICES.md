# Third-Party Notices

本项目的代码为独立（clean-room）实现，参考了下列开源项目的**行为与架构思想**，未复制其实现代码
（研究过程与红线见 docs/reference-research.md）。

## 运行时依赖

| 包 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| vue | ^3.5 | MIT | 设置页/弹窗 UI |
| zod | ^3.24 | MIT | 规则与导入数据 Schema 校验 |
| wxt | ^0.20 | MIT | 浏览器扩展构建框架 |
| @wxt-dev/module-vue | ^1.0 | MIT | WXT Vue 支持 |

完整依赖树请查看各包自带的 LICENSE 文件（`node_modules/<pkg>/LICENSE`）。

## 开发/构建依赖

| 包 | 许可证 |
|---|---|
| typescript | Apache-2.0 |
| vite / vitest / @vitejs/plugin-vue | MIT |
| happy-dom | MIT |
| @playwright/test | Apache-2.0 |
| eslint / typescript-eslint / eslint-plugin-vue / vue-eslint-parser | MIT |
| prettier | MIT |
| @types/chrome / @types/node | MIT (DefinitelyTyped) |

## 行为参考（未复制代码，许可情况见下）

| 项目 | 许可证 | 借鉴点 |
|---|---|---|
| rxliuli/mass-block-twitter | GPL-3.0 | 批处理 MutationObserver、WeakMap 状态缓存、Shadow DOM 隔离等架构思想 |
| rxliuli 的 Twitter Blocker / Twitter Filter | GPL-3.0-only / 未核验 | 3 秒撤销窗口、规则语言、延迟+撤销自动拉黑等产品思想 |
| amahteru/x-comment-blocker | MIT | 评论区过滤场景（仅思想借鉴，未引用代码） |

> GPL-3.0 项目仅用于行为与架构研究，其代码受 GPL 传染，未并入本项目；
> 本项目以 MIT 发布，不受其约束（无衍生代码）。

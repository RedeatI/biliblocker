# 发布清单（Release Checklist）

> 0.1.7 候选发布清单。所有复选框均须由实际执行者在候选构建后勾选；未勾选不代表已完成。

## 1. 溯源与环境

- [ ] 记录本次候选的完整 HEAD commit（`git rev-parse HEAD`）、分支、执行时间，并确认构建产物的 provenance 指向该 commit。
- [ ] `pnpm zip` 在写入产物前已拒绝所有 tracked/untracked 源码改动；唯一允许例外是已有 `out-e2e/`，其路径和排除状态已写入 `dist/build-info.json`，且绝不进入 Source ZIP。
- [ ] 记录实际 Node（需满足 `package.json` 的 `>=20`）与 pnpm（需匹配 `packageManager`）版本；版本不符时停止发布。
- [ ] 发布验证只使用当前会话已有的非交互权限；遇到权限不足时记录原始错误并标记 BLOCKED/未验证，不请求命令审批、不提权，也不以此扩大候选范围。

## 2. 代码质量门禁

- [ ] `pnpm lint` 通过（0 error / 0 warning）
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全部通过
- [ ] `pnpm test:e2e` 全部通过
- [ ] E2E 输出隔离检查：仅写入 `out-e2e/`，未修改生产 `out/chrome-mv3` 或 `out/edge-mv3`。

## 3. 构建

- [ ] `pnpm build:chrome` 成功 → `out/chrome-mv3`
- [ ] `pnpm build:edge` 成功 → `out/edge-mv3`
- [ ] `pnpm zip` 成功 → `dist/` 下生成 3 个 ZIP + `SHA256SUMS.txt` + `build-info.json`
- [ ] 核对 `build-info.json`：完整 source commit、baseline commit、dirty/例外状态、Node/pnpm、Chrome/Edge manifest 摘要、相对基线 permissions/matches 差异，以及每个 ZIP 的 SHA-256、size、entry count。
- [ ] 生产输出隔离检查：Chrome/Edge 产物不含 E2E fixture/localhost/Mock 标记，且未混入 `out-e2e/` 内容。

## 4. 版本与变更

- [ ] `package.json` version 已更新；`src/shared/constants/brand.ts` 品牌信息核对
- [ ] `CHANGELOG.md` 已追加本次变更
- [ ] `docs/release-checklist.md` 对应版本勾选完成

## 5. 隐私与合规（每次发布重新核对）

- [ ] PRIVACY.md 与实际行为一致（无遥测、本地存储、官方请求默认关闭且尚待人工验证）
- [ ] 商店描述披露：本地可解释可恢复治理、读取内容、官方请求默认关闭、验证后的拉黑/举报、本地存储、举报不可撤回、非官方扩展、非 uBO/不绕过付费会员/推荐不等同违规
- [ ] manifest 权限无新增未论证项（对照 docs/permissions-rationale.md）
- [ ] 无远程代码、无 eval、无规则代码注入

## 6. 真实账号验收（发布前必须）

- [ ] docs/manual-test.md 中 2.1/3.3/3.5 等关键项人工验收通过；未通过则保持官方请求关闭，不能以该能力宣称已可用
- [ ] `src/shared/constants/report-reasons.ts` 的 verified 标记如实更新
- [ ] docs/bilibili-research.md §8 未验证清单已勾销或如实保留

## 7. 商店提交

- [ ] Chrome Web Store 上传 `dist/biliblocker-chrome-<ver>.zip`
- [ ] Edge Add-ons 上传 `dist/biliblocker-edge-<ver>.zip`
- [ ] 商店材料按 docs/store-submission.md 填写（含官方请求默认关闭、验证状态与自动处理醒目披露）
- [ ] 已收到并人工复核真实截图与主宣传图；当前仓库没有这些资产，缺失时不得提交，也不得伪造完成状态
- [ ] 提交前重新核验 CWS/Edge 最新官方政策
- [ ] 记录商店后台的提交状态与审核结果（未通过审核不得声称已发布）

## 8. 发布记录

| 版本 | 日期 | 提交状态 | 审核结果 | 备注 |
|---|---|---|---|---|
| 0.1.7 | | | | |

## 9. 本地候选回滚（不含 push 或商店操作）

- [ ] 对照 `docs/release-candidates.md` 核对候选替代关系；已被替代的 RC2 只作调查/回滚证据，不得上传、覆盖或冒充新候选。
- [ ] 若需要撤回本地候选，按 `docs/release-rollback.md` 在独立本地工作树重建并验证已知良好 commit。
- [ ] 保留被撤回候选的 `build-info.json`、`SHA256SUMS.txt` 和原因记录；不得覆盖其证据或把本地回滚描述为商店下架。

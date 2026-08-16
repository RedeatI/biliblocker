# 本地候选回滚流程（0.1.7）

> 本流程只恢复和验证**本地候选 ZIP**。它不执行 push、分支改写、商店上传、商店下架或任何外部账号操作。

## 触发条件

在发现候选的源码溯源、manifest 权限/matches、隐私披露、人工验证记录或 ZIP 校验不满足发布门槛时，停止使用该候选。不要删除或覆盖其现有 `dist/build-info.json`、`dist/SHA256SUMS.txt` 和原因记录；它们是调查证据，不是可继续上传的候选。

## 恢复步骤

1. 从此前通过门禁的**完整 commit**（而非未提交工作树）创建一个独立的本地工作树。例如：`git worktree add <empty-local-directory> <known-good-full-commit>`。
2. 在该独立工作树中核对 `git rev-parse HEAD` 与选定 commit 完全一致，且 `git status --porcelain=v1 --untracked-files=all` 仅可包含已有的 `out-e2e/` 例外。
3. 使用锁定依赖安装并重建：`pnpm install --frozen-lockfile`，随后运行该候选规定的验证和 `pnpm zip`（需要完整发布证据时运行 `pnpm release`）。
4. 核对新 `dist/build-info.json` 的 source commit、baseline、dirty/例外、Chrome/Edge manifest 摘要和三份 ZIP 的 SHA-256、size、entry count；核对 `SHA256SUMS.txt`。
5. 将原候选与恢复候选的证据并列保存，并记录：撤回时间、原候选 commit、恢复 commit、触发原因、验证命令和结果。ZIP 容器字节若受时间戳影响不同，应以解包清单/内容哈希和 manifest 摘要复验，不得只凭文件名判断。

## 结束条件

只有恢复候选的所有本地门禁、溯源和人工验证门槛均满足时，才能把它标记为“可供后续人工提交”。这不是“已发布”或“已下架”的声明；商店状态必须由相应后台的人工记录单独证明。

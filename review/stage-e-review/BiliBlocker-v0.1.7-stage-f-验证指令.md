# BiliBlocker v0.1.7 阶段 F 验证指令（Stage F）

> 来源：v0.1.7 阶段 E 独立复验 **PASS**（`BiliBlocker-v0.1.7-阶段E通过报告.md`）。
> 阶段 E 通过仅代表静态/Mock/并发/安全/恢复/发布工程达到进入真实账号验证的条件；**不代表真实 Bilibili API 已验证，不代表可提交商店**。

## 1. 阶段 F 总则

- 使用**自己控制的测试账号**、**自己发布的测试内容**，或明确安全、可撤销的目标。
- **禁止**：批量拉黑陌生用户、批量举报真实用户、制造虚假举报、绕过验证码/风控/限流。
- 举报成功后通常不可由插件撤销——尽量使用不会伤害第三方的验证方案。
- **禁止大规模测试**；每项能力单独、小规模验证。

## 2. 推荐验证顺序（逐项独立）

| # | 能力键 | 验证内容 | 失败处置 |
|---|---|---|---|
| 1 | `selectorsVideo` | 视频页评论/楼中楼选择器命中（真实视频页） | 该键保持 false，修选择器 |
| 2 | `selectorsDynamic` | 动态页/详情页卡片选择器命中 | 该键保持 false，修选择器 |
| 3 | `blockUser` | 对测试账号执行官方拉黑，接口返回成功且关系生效 | 该键保持 false |
| 4 | `unblockUser` | 解除拉黑测试账号，接口返回成功 | 该键保持 false |
| 5 | `reportVideoComment` | 举报自己发布视频下的测试评论，返回受理 | 该键保持 false |
| 6 | `reportVideoReply` | 举报测试楼中楼回复 | 该键保持 false |
| 7 | `reportDynamicComment` | 举报测试动态评论 | 该键保持 false |
| 8 | `reportDynamic` | 举报测试动态 | 该键保持 false |
| 9 | report reason mapping | 逐 reasonId 验证 mapping（仅对测试内容） | 该 reason 保持不可用 |

## 3. 每项验证流程（mandatory）

1. 单独人工测试（Playwright/手动）→ 记录实际请求/响应/UI 反馈；
2. 保存证据编号（evidenceId，如 `EV-2026-08-15-001`）+ 截图/网络记录；
3. 回填 `docs/REAL-ACCOUNT-VALIDATION-RECORD.md`（证据编号、日期、浏览器版本、结论）；
4. **单独开启对应 verification**（`src/shared/capabilities.ts` 对应键 `verified: true` + `verifiedAt` + `evidenceId`）；
5. 重建（`pnpm build:chrome` / `build:edge`）；
6. 再验（确认开启后行为正确）；
7. 进入下一项前，其余能力保持 false。

## 4. 验证记录模板（追加到 docs/REAL-ACCOUNT-VALIDATION-RECORD.md）

```md
## EV-2026-08-15-XXX — <capabilityKey>

- 日期：
- 测试账号 UID：
- 测试内容 ID（自有内容）：
- 浏览器版本：
- 步骤：
  1. ...
- 实际结果（接口响应/UI）：
- 截图/证据文件：
- 结论：通过 / 失败（原因）
- 回填：capabilities.ts <key>.verified = true（仅通过时）
```

## 5. 阶段 F 门禁（`BiliBlocker-v0.1.7-stage-f-gate.py`）

运行：`python review/stage-e-review/BiliBlocker-v0.1.7-stage-f-gate.py . --expected-version 0.1.7`

检查：
- `REAL-ACCOUNT-VALIDATION-RECORD.md` 存在且包含本版本 evidenceId；
- 已开启的能力键 `evidenceId` 必须能在记录中找到；
- 未开启的能力键 `verified === false`（未验证不得放行）；
- 举报理由枚举：仅当对应记录存在时才允许 `REPORT_REASONS.verified = true`；
- selectors：仅当 selectorsVideo/selectorsDynamic 对应记录存在时才允许；
- 产物/rebuild/gate 常规检查复用阶段 E 门禁。

## 6. 商店提交（阶段 F 全部通过后）

全部 9 项能力逐一验证通过并回填证据后，才允许：
1. 提交 Chrome Web Store / Edge Add-ons 的最终审查包；
2. 提交前再次跑完整 release 流水线 + 阶段 F gate；
3. 每项能力开启均需单独重建 + 再验，禁止一次性批量开启。

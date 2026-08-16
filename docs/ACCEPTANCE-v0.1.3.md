# BiliBlocker v0.1.3 阶段 E 复验缺陷基线（ACCEPTANCE）

> 本文件将 v0.1.3 阶段 E 独立复验发现的缺陷**冻结为唯一基线**。
> v0.1.4 的每一项修复必须能追溯到下列缺陷条目；新增回归测试必须在 v0.1.3 代码上稳定失败。
> 冻结时间：2026-08-13。证据来源：`BiliBlocker-v0.1.3-阶段E复验报告.md`、
> `BiliBlocker-v0.1.3-阶段E独立证据.json`、`BiliBlocker-v0.1.3-independent-evidence.zip`。

## 0. 复验结论

- 复验判定：**阶段 E 不通过**；阶段 F 禁止开始；商店提交禁止。
- 发布工程完整性/关闭态产物洁净性**通过**（三份 ZIP 哈希、Source ZIP 逐文件一致、manifest 洁净、能力全 false）。
- 核心队列与存储安全集成**不通过**：8 个可复现缺陷。

## 1. P0 缺陷（必须关闭）

### P0-1 StorageCoordinator 共享 `inLock` 布尔允许外部并发写绕过全局锁

- 位置：`src/storage/coordinator.ts` `private inLock` / `execute()`。
- 问题：布尔无法区分「同一调用栈内部重入」与「另一条独立外部命令在第一条 await 期间进入」；
  第二条外部命令看到 `inLock=true` 直接绕过 `withGlobalWrite`。
- 探针复现：`{overlap:true, globalWriteEntries:1, events:[start:1,start:2,end:2,end:1]}`。
- 修复方向：所有公共 `execute()` 无条件获取全局锁；显式 `WriteLease`/锁令牌；
  内部嵌套显式传 lease；queue/dedup/audit 锁内不得重入公共 execute。
- 回归测试：**外部并发写串行**（两条命令在 backend await 期间进入，最大活跃写入数 = 1）。

### P0-2 原子提交丢失授权快照；派发前校验存在不可达分支

- 2.1 `BB_COMMIT_ACTION` → coordinator `commitAction()` 调 `queue.planEnqueue(officialTasks, origin)`
  **未传授权快照**；探针：`capturedAuthorization:null, adoptedAuthorization:null`。
- 2.2 `verifyTaskEligible()` 中 `autoProcessVerified` 检查位于 block/report 的提前 `return {ok:true}` 之后；
  探针：`autoProcessVerified=false` 时 auto-process block 仍 `{ok:true}`。
- 2.3 `unblock` 未在队列层重新校验 `unblockUser` capability；探针：`unblockUser.verified=false` 时 `{ok:true}`。
- 修复方向：每任务独立 `AuthorizationSnapshot`（epoch/settingsRevision/capabilityKey/reasonId/
  contentType/source/autoProcessAuthorized/reportAuthorized/createdAt）必填；
  commitAction 传 snapshot 到 planEnqueue/buildTask 并持久化；
  auto_process 检查置于所有任务类型成功返回之前；block/unblock/report 分支各自校验 capability。

### P0-3 reset/clear 破坏撤权代际，内存与持久化分叉

- 位置：coordinator `resetDefaults`/`clearAll` → `queue.revoke()` + `repo.resetToDefaults()`/`clearAllData()`。
- 问题：内存 control 变为 `paused:true, epoch:1`，随后 `resetToDefaults` 把持久化 `bb.queueControl`
  写回 `paused:false, epoch:0`；`clearAllData` 后 `bb.meta/settings/queueControl` 均不存在（Storage 为 `{}`）。
- 探针复现：`{memory:{paused:true,epoch:1}, storage:{paused:false,epoch:0}}`；clear 后 `raw:{}`。
- 修复方向：epoch 单调递增永不回 0；reset/clear 在同一锁内读取旧 epoch、计算 next control、
  一次 backend.set 原子写入最终快照；clear 后立即存在 meta/settings/queueControl 最小种子；
  操作返回前内存/Storage 完全一致；SW 重启后一致。

### P0-4 unknown_outcome 证据可能被 clearQueue/reset/clear 丢弃

- 位置：`queue.revoke()`：`in_flight → unknown_outcome` 后 `clearQueue` 时 `this.tasks.length = 0`，
  未写独立审计/tombstone。
- 探针复现：`{pending:[], lastSaved:[], done:[]}`（唯一证据消失）。
- 修复方向：`in_flight → unknown_outcome` 必须先原子写入 `UnknownOutcomeRecord` + 审计；
  普通队列可清理但结果未知记录保留；幂等；设置页人工核对入口。

### P0-5 风险暂停 fire-and-forget，不 crash-safe

- 位置：`queue.pause()` 返回 void，内部 `void this.deps.writer.saveControl(...)`；
  `runTask` 中 login_invalid/risk_control 分支未 await。
- 探针复现：`{retType:'undefined', started:true, finished:false}`（pause 返回时持久化未完成）。
- 修复方向：`pause(): Promise<void>` 返回前持久化完成；runTask 对风控/登录失效分支 await；
  保存失败 fail-closed 停 pump；recentAttempts 发送前持久化；SW 重启恢复暂停。

## 2. 其他必须关闭的问题（5.1～5.5）

- 5.1 `commitAction` 直接调 `planEnqueue`，绕过 `enqueue()` 的 pause 拒绝逻辑：
  风控/撤权暂停期间仍可积压官方任务。→ 提交前检查持久化 queue control；paused 拒绝创建官方任务。
- 5.2 auto-process 入口仍先检查缓存 `this.loginOk`：本地折叠/本地名单动作在未登录时不运行。
  → 仅当官方任务数 > 0 才检查登录；本地动作独立。
- 5.3 `BB_ENQUEUE` 无完整授权/证据/原子快照约束。→ 删除或封闭为内部受信路径。
- 5.4 帧身份注册表是 SW 内存状态；SW 重启后 pump 可能在内容脚本重新 PING 前把任务判定为页面失效。
  → 短暂注册宽限期（grace period），重新注册后可继续；页面关闭/nonce 变化才进入终态。
- 5.5 `operationId` 未作为幂等键：消息重发/响应丢失可能重复写名单/入队。
  → background 保存有限 TTL 的 operation outcome；绑定 tab/frame/nonce/uid/contentId/hash。

## 3. 放行条件（v0.1.4 申请阶段 E 复验前必须全部满足）

1. 本基线所有 P0 与 5.1～5.5 均有真实代码修复。
2. 回归测试先红后绿（在 v0.1.3 上稳定失败，修复后全绿）。
3. 新增生产接线测试（真实 runtime message → coordinator → queue → storage）。
4. 所有真实能力/举报理由/selectors 继续保持 `false`。
5. reset/clear 后 epoch 单调、内存/Storage/SW 重启快照一致。
6. unknown_outcome 在 reset/clear 后仍有持久审计证据。
7. 风控暂停在返回前持久化，崩溃恢复仍保持暂停。
8. `BB_COMMIT_ACTION` 的每个任务携带独立 AuthorizationSnapshot。
9. 增强 gate（`review/BiliBlocker-v0.1.4-release-gate.py`）与运行时探针均返回 PASS。
10. 从干净 Source ZIP 重建完整 release，提交全部日志与哈希。

/**
 * 独立 adversarial probe（v0.1.6 复验）：revoke 的 epoch 落盘与 verify 恢复的残余竞态。
 *
 * 理论窗口（源码分析）：
 * - pump → runTask → verifyTaskEligible 挂起在 getWhitelist（backend.get await，锁外）；
 * - 窗口内 revoke 开始执行（锁内）：L408 `control.authorizationEpoch += 1`（内存），
 *   L410 `await w.saveControl(this.control)`（backend.set 挂起期间，repo cache 仍是旧 epoch）；
 * - gate 释放 → verify 恢复 → check-latest-again 读 repo cache（旧 epoch）→ 返回 ok；
 * - runTask 二次确认 L941 查 task.status（revoke 的 queued→cancelled 循环在 L410 await 之后，
 *   此时尚未执行）→ 任务仍 queued → 通过 → in_flight → executor 被调用；
 * - revoke 完成循环时任务已是 in_flight → 走 unknown_outcome + revocationRequested；
 * - 最终：executor 调用 1 次（官方请求发出），状态 unknown_outcome。
 *
 * 若可复现：撤权已发起（epoch+1）后官方请求仍发出（虽最终标记 unknown_outcome）。
 * 验证方式：backend.set 写 queueControl 时挂起（模拟 revoke 的 saveControl 慢写），
 * 同时 getWhitelist gate 释放，观察 executor 是否被调用。
 */
import { StorageCoordinator } from '../../src/storage/coordinator';
import { StorageRepository } from '../../src/storage/repository';
import { ActionQueue } from '../../src/actions/queue';
import { DeduplicationRegistry } from '../../src/actions/dedup';
import { CAPABILITY_VERIFICATION } from '../../src/shared/capabilities';
import { DEFAULT_SETTINGS } from '../../src/shared/constants/defaults';
import type { ActionTask, AuthorizationSnapshot, TaskResult } from '../../src/shared/types';
import type { StorageBackend } from '../../src/storage/backend';

function scBackend(initial = {}): StorageBackend & { raw(): Promise<Record<string, unknown>> } {
  const store = new Map<string, unknown>();
  for (const [k, v] of Object.entries(initial)) store.set(k, structuredClone(v));
  return {
    async get(keys) { const out: Record<string, unknown> = {}; for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k)); return out; },
    async set(items) { for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of keys) store.delete(k); },
    async raw() { const out: Record<string, unknown> = {}; for (const [k, v] of store) out[k] = structuredClone(v); return out; },
  };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve }; }
async function waitFor(cond: () => boolean, ms = 4000) { const s = Date.now(); while (!cond()) { if (Date.now() - s > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } }
function makeAuth(): AuthorizationSnapshot {
  return { epoch: 0, settingsRevision: 0, reasonId: null, capabilityKey: 'blockUser', contentType: 'video_comment', source: 'one_click', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 };
}
function mkTask(id: string, uid: number): ActionTask {
  const now = Date.now();
  return { id, groupId: 'g', type: 'block', uid, username: `u${uid}`, source: 'one_click', createdAt: now, attempts: 0, maxAttempts: 3, nextAttemptAt: now, status: 'queued', authorization: makeAuth() };
}

async function main() {
  CAPABILITY_VERIFICATION.blockUser.verified = true;
  let whitelistCalls = 0;
  let armGate = false;
  const gateWhitelist = deferred();
  const gateControl = deferred(); // revoke 的 saveControl 写挂起
  let holdControlWrite = false;
  let controlWriteHeld = false;
  const base = scBackend({ 'bb.settings': { ...DEFAULT_SETTINGS, enabled: true, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true } });
  const backend: StorageBackend = {
    get: async (keys) => {
      if (keys.includes('bb.whitelist')) {
        whitelistCalls++;
        if (armGate && whitelistCalls === 1) await gateWhitelist.promise;
      }
      return base.get(keys);
    },
    set: async (items) => {
      if (holdControlWrite && items['bb.queueControl'] !== undefined) {
        controlWriteHeld = true;
        await gateControl.promise; // revoke 的 saveControl 挂起（epoch 未落 cache）
      }
      await base.set(items);
    },
    remove: (keys) => base.remove(keys),
  };
  const repo = new StorageRepository(backend);
  await repo.init();
  const coordinator = new StorageCoordinator(repo, null, null);
  const dedup = new DeduplicationRegistry(repo, coordinator.writer);
  let executed = 0;
  const execLog: string[] = [];
  const queue = new ActionQueue({
    repo, dedup, writer: coordinator.writer,
    executor: { execute: async (t: ActionTask): Promise<TaskResult> => { executed++; execLog.push(`execute(${t.id}, status=${t.status})`); return { ok: true, status: 'ok' }; } },
  });
  coordinator.attachQueue(queue);
  await queue.start();

  const t1 = mkTask('w1', 70);
  await base.set({ 'bb.queue': [t1] });
  queue.adoptTasks([t1]);

  // pump → runTask → verify 挂起在 getWhitelist
  armGate = true;
  whitelistCalls = 0;
  queue.kick();
  await waitFor(() => whitelistCalls >= 1);
  console.log('[t] verify 挂起在 getWhitelist');

  // revoke 开始：epoch+1（内存）→ saveControl 写挂起（cache 未更新）
  holdControlWrite = true;
  const pRevoke = coordinator.execute({ kind: 'revoke', reason: '窗口撤权', pause: false });
  await waitFor(() => controlWriteHeld);
  console.log('[t] revoke 的 saveControl 已挂起（epoch+1 仅内存，cache 仍旧）');

  // 放行 verify → check-latest-again 读 cache（旧 epoch）→ 观察 executor
  gateWhitelist.resolve();
  await new Promise((r) => setTimeout(r, 100));
  console.log('[t] verify 放行后任务状态:', queue.pendingTasks().find((x) => x.id === 'w1')?.status, '| executor 调用:', executed);

  // 释放 revoke 的 saveControl → revoke 完成循环（任务已是 in_flight → unknown_outcome?）
  gateControl.resolve();
  await pRevoke;
  await new Promise((r) => setTimeout(r, 200));
  const finalRaw = await base.get(['bb.queue', 'bb.queueControl']);
  const finalT = (finalRaw['bb.queue'] as ActionTask[]).find((x) => x.id === 'w1');
  const control = finalRaw['bb.queueControl'] as { authorizationEpoch: number };
  console.log('[t] 最终存储状态:', finalT?.status, '| epoch:', control.authorizationEpoch, '| executor 调用:', executed);
  console.log('[t] execLog:', execLog);
  console.log('[t] 结论:', executed > 0 ? '残余竞态复现：撤权发起后 executor 仍被调用' : '未复现（双保险完整关闭）');

  CAPABILITY_VERIFICATION.blockUser.verified = false;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

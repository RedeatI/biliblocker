/**
 * 独立 probe：runTask 二次确认（内存 epoch 不匹配）return 后，
 * 任务是否残留 queued 导致 pump 空转/无限循环/重复派发。
 * 期望：revoke 完成后 pump 再次 runTask → verify 早期 epoch 检查捕获 → skipped 终态；
 * executor 调用恒 0；不出现 queued 残留（或残留但下一轮即终态）。
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
  const gateControl = deferred();
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
        await gateControl.promise;
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
  const queue = new ActionQueue({
    repo, dedup, writer: coordinator.writer,
    executor: { execute: async (t: ActionTask): Promise<TaskResult> => { executed++; return { ok: true, status: 'ok' }; } },
  });
  coordinator.attachQueue(queue);
  await queue.start();

  const t1 = mkTask('term1', 90);
  await base.set({ 'bb.queue': [t1] });
  queue.adoptTasks([t1]);

  armGate = true;
  whitelistCalls = 0;
  queue.kick();
  await waitFor(() => whitelistCalls >= 1);
  holdControlWrite = true;
  const pRevoke = coordinator.execute({ kind: 'revoke', reason: '窗口撤权', pause: false });
  await waitFor(() => controlWriteHeld);
  gateWhitelist.resolve(); // verify 恢复 → 二次确认内存 epoch 捕获 → return
  await new Promise((r) => setTimeout(r, 100));
  gateControl.resolve(); // revoke 完成
  await pRevoke;
  // 等待足够时间观察任务是否收敛到终态
  await new Promise((r) => setTimeout(r, 1500));
  const finalRaw = await base.get(['bb.queue', 'bb.queueControl']);
  const finalT = (finalRaw['bb.queue'] as ActionTask[]).find((x) => x.id === 'term1');
  const memStatus = queue.pendingTasks().find((x) => x.id === 'term1')?.status;
  console.log('[t] 存储状态:', finalT?.status, '| 内存状态:', memStatus, '| executor:', executed);
  console.log('[t] 结论:', executed === 0 && (finalT?.status === 'skipped' || finalT?.status === 'cancelled')
    ? 'PASS：二次确认 return 后任务收敛到终态，无空转/无重复派发'
    : '观察：' + JSON.stringify({ finalStatus: finalT?.status, memStatus, executed }));
  CAPABILITY_VERIFICATION.blockUser.verified = false;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

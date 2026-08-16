/**
 * 独立 probe：revoke 在 verify 的 await 段**中间**（getSettingsRevision 之后、getWhitelist 之前）
 * 完成（非 saveControl 挂起，正常完成）——验证 v0.1.7 三层防线中 check-latest-again
 * 与内存二次确认的行为。期望：executor=0、任务 skipped/cancelled。
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
  // gate 挂在 getSettingsRevision（第一次读 bb.revisions）——在 verify 的 await 段中间
  let revCalls = 0;
  let armRev = false;
  const gateRev = deferred();
  const base = scBackend({ 'bb.settings': { ...DEFAULT_SETTINGS, enabled: true, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true } });
  const backend: StorageBackend = {
    get: async (keys) => {
      if (keys.includes('bb.revisions')) {
        revCalls++;
        if (armRev && revCalls === 1) await gateRev.promise;
      }
      return base.get(keys);
    },
    set: (items) => base.set(items),
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
  const t1 = mkTask('mid1', 96);
  await base.set({ 'bb.queue': [t1] });
  queue.adoptTasks([t1]);
  armRev = true;
  revCalls = 0;
  queue.kick();
  await waitFor(() => revCalls >= 1);
  // verify 挂起在 getSettingsRevision；revoke 正常完成（epoch+1 落盘 + queued→cancelled）
  await coordinator.execute({ kind: 'revoke', reason: '中间窗口撤权', pause: false });
  gateRev.resolve();
  await new Promise((r) => setTimeout(r, 300));
  const raw = await base.get(['bb.queue', 'bb.queueControl']);
  const finalT = (raw['bb.queue'] as ActionTask[]).find((x) => x.id === 'mid1');
  const epoch = (raw['bb.queueControl'] as { authorizationEpoch: number }).authorizationEpoch;
  console.log('[t] 最终状态:', finalT?.status, '| epoch:', epoch, '| executor:', executed);
  console.log('[t] 结论:', executed === 0 && ['cancelled', 'skipped'].includes(finalT?.status ?? '')
    ? 'PASS：await 段中间 revoke 完成 → 不派发、终态 cancelled/skipped'
    : '观察：' + JSON.stringify({ status: finalT?.status, epoch, executed }));
  CAPABILITY_VERIFICATION.blockUser.verified = false;
}

main().then(() => process.exit(0)).catch((e) => { console.error('CRASH:', e); process.exit(1); });

/**
 * 验证残余窗口对 report 类任务（不可逆副作用）同样成立。
 */
import { StorageCoordinator } from '../../src/storage/coordinator';
import { StorageRepository } from '../../src/storage/repository';
import { ActionQueue } from '../../src/actions/queue';
import { DeduplicationRegistry } from '../../src/actions/dedup';
import { CAPABILITY_VERIFICATION, canReportContentType, capabilityForTaskType, isCapabilityEnabled } from '../../src/shared/capabilities';
import { REPORT_REASONS } from '../../src/shared/constants/report-reasons';
import { DEFAULT_SETTINGS } from '../../src/shared/constants/defaults';
import type { ActionTask, AuthorizationSnapshot, TaskResult } from '../../src/shared/types';
import type { StorageBackend } from '../../src/storage/backend';

// 模拟已验证环境（生产常量不可改，这里通过修改验证对象）
function enableCaps() {
  (CAPABILITY_VERIFICATION as Record<string, { verified: boolean }>).blockUser.verified = true;
  (CAPABILITY_VERIFICATION as Record<string, { verified: boolean }>).reportVideoComment.verified = true;
  (REPORT_REASONS as { verified: boolean }).verified = true;
}
function disableCaps() {
  (CAPABILITY_VERIFICATION as Record<string, { verified: boolean }>).blockUser.verified = false;
  (CAPABILITY_VERIFICATION as Record<string, { verified: boolean }>).reportVideoComment.verified = false;
  (REPORT_REASONS as { verified: boolean }).verified = false;
}

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
  return { epoch: 0, settingsRevision: 0, reasonId: 1, capabilityKey: 'reportVideoComment', contentType: 'video_comment', source: 'one_click', autoProcessAuthorized: true, reportAuthorized: true, createdAt: 0 };
}
function mkTask(id: string, uid: number): ActionTask {
  const now = Date.now();
  return { id, groupId: 'g', type: 'report', uid, username: `u${uid}`, contentType: 'video_comment', contentId: `rpid-${uid}`, rootContentId: `rpid-${uid}`, oid: '1', reasonId: 1, source: 'one_click', createdAt: now, attempts: 0, maxAttempts: 1, nextAttemptAt: now, status: 'queued', authorization: makeAuth() };
}

async function main() {
  enableCaps();
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

  const t1 = mkTask('rep-w', 80);
  await base.set({ 'bb.queue': [t1] });
  queue.adoptTasks([t1]);

  armGate = true;
  whitelistCalls = 0;
  queue.kick();
  await waitFor(() => whitelistCalls >= 1);
  holdControlWrite = true;
  const pRevoke = coordinator.execute({ kind: 'revoke', reason: '窗口撤权', pause: false });
  await waitFor(() => controlWriteHeld);
  gateWhitelist.resolve();
  await new Promise((r) => setTimeout(r, 100));
  console.log('[t] report verify 放行后状态:', queue.pendingTasks().find((x) => x.id === 'rep-w')?.status, '| executor:', executed);
  gateControl.resolve();
  await pRevoke;
  await new Promise((r) => setTimeout(r, 200));
  const finalRaw = await base.get(['bb.queue']);
  const finalT = (finalRaw['bb.queue'] as ActionTask[]).find((x) => x.id === 'rep-w');
  console.log('[t] report 最终状态:', finalT?.status, '| executor 调用:', executed);
  console.log('[t] 结论:', executed > 0 ? 'P0 确认：report（不可逆）任务在撤权发起后仍被派发' : '未复现');
  disableCaps();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

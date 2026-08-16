/**
 * 最小复现：revoke 与 runTask.verifyTaskEligible 的竞态
 * 目标：确认 revoke（epoch++ + queued→cancelled）在 verify 挂起窗口内发生时，
 * executor 是否仍被调用（= 撤权后仍执行官方任务）。
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
  return {
    epoch: 0, settingsRevision: 0, reasonId: null, capabilityKey: 'blockUser',
    contentType: 'video_comment', source: 'one_click', autoProcessAuthorized: true,
    reportAuthorized: true, createdAt: 0,
  };
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
  const base = scBackend({ 'bb.settings': { ...DEFAULT_SETTINGS, enabled: true, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true } });
  const backend: StorageBackend = {
    get: async (keys) => {
      if (keys.includes('bb.whitelist')) {
        whitelistCalls++;
        if (armGate && whitelistCalls === 1) await gateWhitelist.promise;
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
  const execLog: string[] = [];
  const queue = new ActionQueue({
    repo, dedup, writer: coordinator.writer,
    executor: { execute: async (t: ActionTask): Promise<TaskResult> => { executed++; execLog.push(`execute(${t.id}, status=${t.status})`); return { ok: true, status: 'ok' }; } },
  });
  coordinator.attachQueue(queue);
  await queue.start();

  const t1 = mkTask('h1', 60);
  await base.set({ 'bb.queue': [t1] });
  queue.adoptTasks([t1]);

  armGate = true;
  whitelistCalls = 0;
  queue.kick();
  await waitFor(() => whitelistCalls >= 1);
  console.log('[t] verify 挂起在 getWhitelist；task 当前状态:', queue.pendingTasks().find((x) => x.id === 'h1')?.status);

  // revoke：epoch++ + queued→cancelled
  await coordinator.execute({ kind: 'revoke', reason: '派发前撤权', pause: false });
  const afterRevoke = queue.pendingTasks().find((x) => x.id === 'h1');
  console.log('[t] revoke 后 task 状态:', afterRevoke?.status, 'epoch:', queue.getStatus().authorizationEpoch);

  gateWhitelist.resolve();
  await new Promise((r) => setTimeout(r, 200));
  const finalRaw = await base.get(['bb.queue']);
  const finalT = (finalRaw['bb.queue'] as ActionTask[]).find((x) => x.id === 'h1');
  console.log('[t] 最终存储 task 状态:', finalT?.status);
  console.log('[t] executor 调用次数:', executed);
  console.log('[t] execLog:', execLog);
  console.log('[t] 结论:', executed > 0 ? 'P0 竞态复现：撤权后 executor 仍被调用' : '未复现');

  // 清理
  CAPABILITY_VERIFICATION.blockUser.verified = false;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

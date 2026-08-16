/**
 * 独立 probe：runTask 二次确认在 task.authorization 为 undefined（旧版本任务）时的行为。
 * 旧版本任务：无 authorization 快照 → verifyTaskEligible 早期检查返回 !ok（任务缺少授权快照）
 * → runTask 走 skipped 分支。二次确认的 `task.authorization?.epoch` 可选链防御性兜底。
 * 验证：authorization undefined 的任务不会被派发、正确转 skipped、不产生 TypeError。
 */
import { StorageCoordinator } from '../../src/storage/coordinator';
import { StorageRepository } from '../../src/storage/repository';
import { ActionQueue } from '../../src/actions/queue';
import { DeduplicationRegistry } from '../../src/actions/dedup';
import { CAPABILITY_VERIFICATION } from '../../src/shared/capabilities';
import { DEFAULT_SETTINGS } from '../../src/shared/constants/defaults';
import type { ActionTask, TaskResult } from '../../src/shared/types';
import type { StorageBackend } from '../../src/storage/backend';

function scBackend(initial = {}): StorageBackend {
  const store = new Map<string, unknown>();
  for (const [k, v] of Object.entries(initial)) store.set(k, structuredClone(v));
  return {
    async get(keys) { const out: Record<string, unknown> = {}; for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k)); return out; },
    async set(items) { for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of keys) store.delete(k); },
  };
}
function mkTaskNoAuth(id: string, uid: number): ActionTask {
  const now = Date.now();
  return { id, groupId: 'g', type: 'block', uid, username: `u${uid}`, source: 'one_click', createdAt: now, attempts: 0, maxAttempts: 3, nextAttemptAt: now, status: 'queued' }; // 无 authorization
}

async function main() {
  CAPABILITY_VERIFICATION.blockUser.verified = true;
  const base = scBackend({ 'bb.settings': { ...DEFAULT_SETTINGS, enabled: true, autoReportAuthorized: true, defaultReportReason: 1, autoProcessVerified: true } });
  const repo = new StorageRepository(base);
  await repo.init();
  const coordinator = new StorageCoordinator(repo, null, null);
  const dedup = new DeduplicationRegistry(repo, coordinator.writer);
  let executed = 0;
  let crashed = false;
  const queue = new ActionQueue({
    repo, dedup, writer: coordinator.writer,
    executor: { execute: async (t: ActionTask): Promise<TaskResult> => { executed++; return { ok: true, status: 'ok' }; } },
  });
  coordinator.attachQueue(queue);
  await queue.start();
  const t = mkTaskNoAuth('noauth', 95);
  await base.set({ 'bb.queue': [t] });
  queue.adoptTasks([t]);
  try {
    queue.kick();
    await new Promise((r) => setTimeout(r, 400));
  } catch { crashed = true; }
  const raw = await base.get(['bb.queue']);
  const finalT = (raw['bb.queue'] as ActionTask[]).find((x) => x.id === 'noauth');
  console.log('[t] 最终状态:', finalT?.status, '| executor:', executed, '| crashed:', crashed);
  console.log('[t] 结论:', executed === 0 && finalT?.status === 'skipped' && !crashed
    ? 'PASS：无授权快照任务安全转 skipped，无 TypeError/无派发'
    : '观察：' + JSON.stringify({ status: finalT?.status, executed, crashed }));
  CAPABILITY_VERIFICATION.blockUser.verified = false;
}

main().then(() => process.exit(0)).catch((e) => { console.error('CRASH:', e); process.exit(1); });

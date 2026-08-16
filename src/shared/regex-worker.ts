/**
 * 正则 Worker 测试助手（P1-3）。
 *
 * 在独立 Worker（public/workers/regex-tester.js）中以时间预算执行正则测试，
 * 防止灾难性回溯卡死设置页主线程；主线程预算超时后必须 worker.terminate()。
 * 非扩展环境（单元测试）自动降级为静态校验，不抛错。
 */

export interface RegexWorkerTestResult {
  ok: boolean;
  matched: boolean;
  ms: number;
  error?: string;
  /** true 表示实际使用了 Worker 执行 */
  usedWorker: boolean;
}

const WORKER_BUDGET_MS = 200;
const WORKER_GRACE_MS = 50;

/** 获取 Worker 文件 URL（扩展环境）；非扩展环境返回 null */
function workerUrl(): string | null {
  try {
    const g = globalThis as unknown as {
      chrome?: { runtime?: { getURL?: (p: string) => string } };
      browser?: { runtime?: { getURL?: (p: string) => string } };
    };
    const getURL = g.chrome?.runtime?.getURL ?? g.browser?.runtime?.getURL;
    if (getURL) return getURL('workers/regex-tester.js');
  } catch {
    return null;
  }
  return null;
}

/** 在 Worker 中执行正则测试；超时 terminate；非扩展环境静态降级 */
export function testRegexInWorker(
  pattern: string,
  text: string,
  budgetMs = WORKER_BUDGET_MS,
): Promise<RegexWorkerTestResult> {
  const url = workerUrl();
  if (!url || typeof Worker === 'undefined') {
    // 降级：静态校验（不执行正则，无法做时间预算）
    try {
      new RegExp(pattern, 'u');
      return Promise.resolve({ ok: true, matched: false, ms: 0, usedWorker: false });
    } catch (e) {
      return Promise.resolve({
        ok: false,
        matched: false,
        ms: 0,
        usedWorker: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return new Promise<RegexWorkerTestResult>((resolve) => {
    let worker: Worker | null = null;
    let settled = false;
    const done = (r: RegexWorkerTestResult) => {
      if (settled) return;
      settled = true;
      worker?.terminate(); // 无论成功/超时都终止，避免泄漏
      resolve(r);
    };

    try {
      worker = new Worker(url);
    } catch (e) {
      done({ ok: false, matched: false, ms: 0, usedWorker: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    // 主线程预算：超时后必须 worker.terminate()
    const timer = setTimeout(() => {
      worker?.terminate();
      worker = null;
      done({
        ok: false,
        matched: false,
        ms: budgetMs,
        usedWorker: true,
        error: '正则执行超时（可能存在灾难性回溯），请简化表达式',
      });
    }, budgetMs + WORKER_GRACE_MS);

    worker.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      const data = event.data as { ok: boolean; matched: boolean; ms: number; error?: string };
      done({
        ok: data.ok === true,
        matched: data.matched === true,
        ms: data.ms ?? 0,
        usedWorker: true,
        error: data.ok ? undefined : data.error,
      });
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      done({ ok: false, matched: false, ms: 0, usedWorker: true, error: event.message ?? 'Worker 执行失败' });
    };
    worker.postMessage({ pattern, text, budgetMs });
  });
}

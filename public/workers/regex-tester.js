/**
 * 正则时间预算测试 Worker（静态文件，供设置页规则编辑器使用）。
 * 在独立线程中以时间预算执行正则测试，防止灾难性回溯卡死页面。
 * 消息协议：
 *   { pattern: string, text: string, budgetMs?: number }
 * 响应：
 *   { ok: true, matched: boolean, ms: number }
 *   { ok: false, error: string }
 */
self.onmessage = (event) => {
  const data = event.data || {};
  const pattern = String(data.pattern ?? '');
  const text = String(data.text ?? '');
  const budgetMs = Number(data.budgetMs ?? 200);
  const start = performance.now();

  try {
    const re = new RegExp(pattern, 'u');
    // 用 setInterval 做墙钟超时：每次匹配前检查耗时
    const timer = setInterval(() => {}, 10);
    const checkTimeout = () => {
      if (performance.now() - start > budgetMs) {
        clearInterval(timer);
        throw new Error('REGEX_TIMEOUT');
      }
    };
    try {
      checkTimeout();
      const matched = re.test(text);
      clearInterval(timer);
      self.postMessage({ ok: true, matched, ms: Math.round(performance.now() - start) });
    } catch (e) {
      clearInterval(timer);
      if (e instanceof Error && e.message === 'REGEX_TIMEOUT') {
        self.postMessage({ ok: false, error: '正则执行超时（可能存在灾难性回溯），请简化表达式' });
      } else {
        self.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    self.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};

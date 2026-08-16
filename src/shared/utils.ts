/**
 * 通用工具函数（无 DOM 依赖，可被单元测试直接使用）。
 */

/** FNV-1a 32 位哈希，返回 8 位十六进制字符串（用于日志摘要，非安全用途） */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 生成短 ID（任务/日志用） */
export function shortId(prefix = 'id'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** 内容摘要哈希：只存哈希不存正文，降低隐私风险 */
export function contentHash(text: string, uid: number | null, contentId: string | null): string {
  return fnv1a(`${uid ?? ''}|${contentId ?? ''}|${text.slice(0, 200)}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 从 Bilibili 用户空间链接 href 解析 UID；失败返回 null */
export function parseUidFromHref(href: string | null | undefined): number | null {
  if (!href) return null;
  const m = href.match(/(?:^|\/)space\.bilibili\.com\/(\d+)/i);
  if (!m || !m[1]) return null;
  const uid = Number(m[1]);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

/** 从文本中提取站外链接与域名（供规则引擎 links/linkDomains 字段使用） */
export function extractLinksFromText(
  text: string,
  internalDomains: ReadonlySet<string>,
): { links: string[]; domains: string[] } {
  const links: string[] = [];
  const domains: string[] = [];
  const re = /https?:\/\/[^\s"'<>，。！？、；：）】」』]+/gi;
  for (const m of text.matchAll(re)) {
    let url = m[0].replace(/[.,;:!?)\]}>"']+$/, '');
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      url = parsed.toString();
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (internalDomains.has(host) || host.endsWith('.bilibili.com')) continue;
      links.push(url);
      domains.push(host);
    } catch {
      // 无效 URL 忽略
    }
  }
  return { links: [...new Set(links)], domains: [...new Set(domains)] };
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
}

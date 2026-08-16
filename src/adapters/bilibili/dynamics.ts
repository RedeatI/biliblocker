/**
 * 动态卡片 DOM 适配器（首页卡片 / 动态详情 / opus）。
 */
import type { ExtractedContent, PageScope } from '../../shared/types';
import { parseUidFromHref } from '../../shared/utils';
import { DYNAMIC_SELECTORS } from './selectors';

export interface DynamicExtraction {
  ok: boolean;
  missing?: 'uid' | 'contentId' | 'both';
  data?: ExtractedContent;
}

function firstSelector<T extends Element>(root: Element, selectors: readonly string[]): T | null {
  for (const sel of selectors) {
    const el = root.querySelector<T>(sel);
    if (el) return el;
  }
  return null;
}

function firstAttr(el: Element | null | undefined, attrs: readonly string[]): string | null {
  if (!el) return null;
  for (const a of attrs) {
    const v = el.getAttribute(a);
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function collectLinks(root: Element): string[] {
  const out: string[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = (a as HTMLAnchorElement).href;
    if (!href || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('data:')) {
      continue;
    }
    try {
      out.push(new URL(href).toString());
    } catch {
      // 忽略
    }
  }
  return [...new Set(out)];
}

export function extractDynamic(
  node: HTMLElement,
  opts: { pageScope: PageScope },
): DynamicExtraction {
  const uidLink = firstSelector<HTMLAnchorElement>(node, DYNAMIC_SELECTORS.userLink);
  const uid = parseUidFromHref(uidLink?.getAttribute('href') ?? uidLink?.href);

  const nameEl = firstSelector(node, DYNAMIC_SELECTORS.userNameText);
  const username = nameEl?.textContent?.trim() || uidLink?.textContent?.trim() || null;

  // 正文：优先纯文本节点；退回内容容器；转发动态合并原文摘要
  const textEl = firstSelector(node, DYNAMIC_SELECTORS.contentText);
  const contentEl = firstSelector(node, DYNAMIC_SELECTORS.content);
  const origEl = firstSelector(node, DYNAMIC_SELECTORS.origContent);

  const textParts: string[] = [];
  if (textEl) textParts.push((textEl.textContent ?? '').replace(/\s+/g, ' ').trim());
  else if (contentEl)
    textParts.push((contentEl.textContent ?? '').replace(/\s+/g, ' ').trim());
  if (origEl) {
    const origText = (origEl.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (origText && !textParts.some((t) => t.includes(origText.slice(0, 40)))) {
      textParts.push(`[转发] ${origText}`);
    }
  }

  const contentId = firstAttr(node, DYNAMIC_SELECTORS.idAttrs);
  // 转发原文动态 ID：从原文块内链接尝试提取 /dynamic/{id} 或 /opus/{id}
  let origDynamicId: string | null = null;
  if (origEl) {
    for (const a of origEl.querySelectorAll('a[href]')) {
      const m = (a as HTMLAnchorElement).href.match(/(?:dynamic|opus)\/(\d+)/);
      if (m?.[1]) {
        origDynamicId = m[1];
        break;
      }
    }
  }

  const links = collectLinks(node);

  const missing: ('uid' | 'contentId')[] = [];
  if (uid === null) missing.push('uid');
  if (contentId === null) missing.push('contentId');

  const data: ExtractedContent = {
    contentType: 'dynamic',
    pageScope: opts.pageScope,
    uid,
    username,
    text: textParts.join(' '),
    links,
    linkDomains: [],
    contentId,
    rootContentId: contentId,
    videoId: null,
    origDynamicId,
    node,
  };

  return {
    ok: missing.length === 0,
    missing: missing.length === 2 ? 'both' : missing[0],
    data,
  };
}

/** 查找页面内动态条目 */
export function findDynamicItems(root: Document | HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const sel of DYNAMIC_SELECTORS.item) {
    for (const el of root.querySelectorAll(sel)) {
      if (el instanceof HTMLElement) out.push(el);
    }
  }
  return [...new Set(out)];
}

/** 挂载快捷按钮的候选容器 */
export function findDynamicActionAnchor(node: HTMLElement): HTMLElement | null {
  for (const sel of DYNAMIC_SELECTORS.actionArea) {
    const el = node.querySelector(sel);
    if (el instanceof HTMLElement) return el;
  }
  return node;
}

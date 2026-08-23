/**
 * 评论/楼中楼 DOM 适配器。
 * 纯 DOM 逻辑，可在 happy-dom 下用 fixture 测试。
 */
import type { ContentType, ExtractedContent, PageScope } from '../../shared/types';
import { parseUidFromHref } from '../../shared/utils';
import {
  closestComposed,
  composedTextContent,
  firstSelectorDeep,
  querySelectorAllDeep,
} from '../../shared/composed-dom';
import { COMMENT_SELECTORS } from './selectors';

export interface CommentExtraction {
  ok: boolean;
  /** 提取失败的明确原因（缺 UID / 缺内容 ID 等），供 UI 降级提示 */
  missing?: 'uid' | 'contentId' | 'both';
  data?: ExtractedContent;
}

function firstSelector<T extends Element>(root: Element, selectors: readonly string[]): T | null {
  return firstSelectorDeep<T>(root, selectors);
}

function firstAttr(el: Element | null | undefined, attrs: readonly string[]): string | null {
  if (!el) return null;
  for (const a of attrs) {
    const v = el.getAttribute(a);
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyScalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function componentData(node: Element): Record<string, unknown> | null {
  const carrier = node as Element & Record<string, unknown>;
  for (const property of COMMENT_SELECTORS.dataProperties) {
    const data = asRecord(carrier[property]);
    if (data) return data;
  }
  return null;
}

function componentContentId(node: Element): string | null {
  const data = componentData(node);
  if (!data) return null;
  return nonEmptyScalar(data.rpid) ?? nonEmptyScalar(data.rpid_str);
}

function componentMessage(node: Element): string {
  const content = asRecord(componentData(node)?.content);
  return nonEmptyScalar(content?.message) ?? '';
}

/** 内容 ID 提取：选中条目 → 实际评论组件 → 旧版包装层 → 有界属性 carrier。 */
function firstContentId(
  itemNode: HTMLElement,
  contentRoot: HTMLElement,
  attrs: readonly string[],
): string | null {
  for (const candidate of [itemNode, contentRoot]) {
    const direct = firstAttr(candidate, attrs) ?? componentContentId(candidate);
    if (direct) return direct;
  }

  const wrapper = closestComposed<HTMLElement>(itemNode, '.list-item');
  if (wrapper && wrapper !== itemNode) {
    const wrapperId = firstAttr(wrapper, attrs);
    if (wrapperId) return wrapperId;
  }

  for (const attr of attrs) {
    const carrier = firstSelectorDeep<HTMLElement>(contentRoot, [`[${attr}]`]);
    const value = firstAttr(carrier, [attr]);
    if (value) return value;
  }
  return null;
}

function collectLinks(root: Element): string[] {
  const out: string[] = [];
  for (const a of querySelectorAllDeep<HTMLAnchorElement>(root, 'a[href]')) {
    const href = (a as HTMLAnchorElement).href;
    if (
      !href ||
      href.startsWith('javascript:') ||
      href.startsWith('#') ||
      href.startsWith('data:')
    ) {
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

function findUid(root: Element): number | null {
  const link = firstSelector<HTMLAnchorElement>(root, COMMENT_SELECTORS.userNameLink);
  return parseUidFromHref(link?.getAttribute('href') ?? link?.href);
}

function findUsername(root: Element): string | null {
  const textEl = firstSelector(root, COMMENT_SELECTORS.userNameText);
  if (textEl) {
    const t = composedTextContent(textEl).trim();
    if (t) return t;
  }
  const link = firstSelector<HTMLAnchorElement>(root, COMMENT_SELECTORS.userNameLink);
  const t = link ? composedTextContent(link).trim() : '';
  return t || null;
}

function findText(root: Element): string {
  const contentEl = firstSelector(root, COMMENT_SELECTORS.content);
  if (contentEl) {
    const rendered = composedTextContent(contentEl).replace(/\s+/g, ' ').trim();
    if (rendered) return rendered;
  }
  return componentMessage(root).replace(/\s+/g, ' ').trim();
}

/**
 * 提取一条评论（一级评论或楼中楼回复）。
 * @param node 评论条目节点
 * @param opts.contentType 视频评论 or 动态评论
 * @param opts.videoId 视频 aid（一级评论上下文提供）
 * @param opts.rootCommentId 所属根评论 rpid（楼中楼上下文提供）
 * @param opts.pageScope 页面范围
 */
export function extractComment(
  node: HTMLElement,
  opts: {
    contentType: ContentType;
    pageScope: PageScope;
    videoId?: string | null;
    rootCommentId?: string | null;
  },
): CommentExtraction {
  const contentRoot = firstSelector<HTMLElement>(node, COMMENT_SELECTORS.componentContent) ?? node;
  const uid = findUid(contentRoot);
  const username = findUsername(contentRoot);
  const text = findText(contentRoot);
  const links = collectLinks(contentRoot);
  const contentId = firstContentId(node, contentRoot, COMMENT_SELECTORS.idAttrs);

  const missing: ('uid' | 'contentId')[] = [];
  if (uid === null) missing.push('uid');
  if (contentId === null) missing.push('contentId');

  const data: ExtractedContent = {
    contentType: opts.contentType,
    pageScope: opts.pageScope,
    uid,
    username,
    text,
    links,
    linkDomains: [], // 由 context 构建时填充
    contentId,
    rootContentId: opts.rootCommentId ?? contentId,
    videoId: opts.videoId ?? null,
    origDynamicId: null,
    node,
  };

  return {
    ok: missing.length === 0,
    missing: missing.length === 2 ? 'both' : missing[0],
    data,
  };
}

/** 定位页面内一级评论容器（供 Observer 使用） */
export function findCommentContainers(root: Document | HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const sel of COMMENT_SELECTORS.container) {
    for (const el of querySelectorAllDeep(root, sel)) {
      if (el instanceof HTMLElement) out.push(el);
    }
  }
  return [...new Set(out)];
}

/** 在容器内查找所有一级评论条目（优先最内层 .reply-item；无内层时用包装节点兜底） */
export function findRootComments(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of querySelectorAllDeep<HTMLElement>(
    container,
    COMMENT_SELECTORS.rootItem.join(','),
  )) {
    if (el instanceof HTMLElement && !isNested(el)) out.push(el);
  }
  if (out.length === 0) {
    // 兜底：老版本可能只有包装层
    for (const el of querySelectorAllDeep<HTMLElement>(
      container,
      COMMENT_SELECTORS.rootWrapper.join(','),
    )) {
      if (el instanceof HTMLElement) out.push(el);
    }
  }
  return [...new Set(out)];
}

/** 在容器内查找所有楼中楼回复 */
export function findSubReplies(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const sel of COMMENT_SELECTORS.subItem) {
    for (const el of querySelectorAllDeep(container, sel)) {
      if (el instanceof HTMLElement) out.push(el);
    }
  }
  return [...new Set(out)];
}

/** 一级评论条目的根评论 ID（取自身 id 属性） */
export function rootCommentIdOf(node: HTMLElement): string | null {
  const contentRoot = firstSelector<HTMLElement>(node, COMMENT_SELECTORS.componentContent) ?? node;
  return firstContentId(node, contentRoot, COMMENT_SELECTORS.idAttrs);
}

/** 由楼中楼条目向上找所属根评论条目 */
export function parentRootComment(node: HTMLElement): HTMLElement | null {
  const ancestors = [
    'bili-comment-thread-renderer',
    '.list-item',
    '.reply-node > .reply-item',
    '.reply-item',
  ];
  const found = closestComposed<HTMLElement>(node, ancestors.join(','));
  return found === node ? null : found;
}

function isNested(el: HTMLElement): boolean {
  // 一级评论条目不应嵌套在楼中楼容器内
  return !!closestComposed(el, COMMENT_SELECTORS.subContainer.join(','));
}

/** 挂载快捷按钮的候选容器（评论条目内） */
export function findCommentActionAnchor(node: HTMLElement): HTMLElement | null {
  const contentRoot = firstSelector<HTMLElement>(node, COMMENT_SELECTORS.componentContent) ?? node;
  const area = firstSelector<HTMLElement>(contentRoot, COMMENT_SELECTORS.actionArea);
  if (area) return area;
  return node;
}

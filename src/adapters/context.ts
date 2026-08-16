/**
 * 上下文构建：由 ExtractedContent + 本地名单状态 → ContentContext（规则引擎输入）。
 * 同时负责链接/域名的统一解析（内部域名过滤）。
 */
import type { ContentContext, ExtractedContent } from '../shared/types';
import { INTERNAL_DOMAINS } from '../shared/constants/defaults';
import { extractLinksFromText } from '../shared/utils';

export interface RegistryState {
  isLocalBlocked: boolean;
  isWhitelisted: boolean;
  isVerifiedMachine: boolean;
}

export function buildContext(
  extracted: ExtractedContent,
  state: RegistryState,
): ContentContext {
  // 合并 DOM 链接与文本链接；域名统一提取
  const textLinks = extractLinksFromText(extracted.text, INTERNAL_DOMAINS);
  const domLinks = extracted.links.filter((l) => {
    try {
      const host = new URL(l).hostname.toLowerCase().replace(/^www\./, '');
      return !INTERNAL_DOMAINS.has(host) && !host.endsWith('.bilibili.com');
    } catch {
      return false;
    }
  });
  const links = [...new Set([...domLinks, ...textLinks.links])];
  const linkDomains = [...new Set([...textLinks.domains, ...domLinks.map(domOf).filter(Boolean)])];

  return {
    uid: extracted.uid,
    username: extracted.username,
    text: extracted.text,
    links,
    linkDomains: linkDomains as string[],
    contentType: extracted.contentType,
    pageScope: extracted.pageScope,
    hasLinks: links.length > 0,
    isLocalBlocked: state.isLocalBlocked,
    isWhitelisted: state.isWhitelisted,
    isVerifiedMachine: state.isVerifiedMachine,
    contentId: extracted.contentId,
    rootContentId: extracted.rootContentId,
    videoId: extracted.videoId,
    origDynamicId: extracted.origDynamicId,
  };
}

function domOf(link: string): string | null {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

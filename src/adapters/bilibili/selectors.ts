/**
 * 页面选择器集中维护（禁止散落在组件中）。
 *
 * ⚠️ 核验状态：以下选择器包含 Bilibili 2026 桌面端 <bili-comments> 开放 Shadow DOM
 * 结构与旧版 class 多候选回退；阶段 F 实页预检发现旧选择器失效后已适配，但尚未在加载
 * 生产扩展的真实登录 Chrome 中完成全清单人工验收，因此仍为 UNVERIFIED；
 * 请按 docs/manual-test.md 的人工验收清单核对，失效时只需修改本文件。
 * 证据编号引用 docs/REAL-ACCOUNT-VALIDATION-RECORD.md（selectorsVideo/selectorsDynamic）。
 */

export const VERIFICATION = {
  selectorsVerified: false,
  selectorsVerifiedAt: null as string | null,
  selectorsEvidenceId: null as string | null,
  selectorsBrowserVersion: null as string | null,
  note: '选择器为多候选回退策略，页面改版时优先修改本文件',
};

/** 视频评论区（也复用于动态评论区） */
export const COMMENT_SELECTORS = {
  /** 评论根容器（Observer 观察目标） */
  container: [
    'bili-comments',
    '.reply-list',
    '.comment-list',
    '.bili-comment-area .reply-list',
    '.opus-comment-list',
  ] as const,
  /** 一级评论提取目标（最内层） */
  rootItem: ['bili-comment-thread-renderer', '.reply-item'] as const,
  /** 一级评论外层包装（仅用于兜底：无内层 reply-item 时直接提取包装节点） */
  rootWrapper: ['.list-item'] as const,
  /** 楼中楼容器 */
  subContainer: [
    'bili-comment-replies-renderer',
    '.sub-reply-container',
    '.sub-reply-list',
    '.bili-comment-replies',
  ] as const,
  /** 楼中楼条目 */
  subItem: ['bili-comment-reply-renderer', '.sub-reply-item'] as const,
  /** 新版 thread/reply 组件内承载实际字段的评论组件 */
  componentContent: ['bili-comment-renderer#comment', 'bili-comment-renderer'] as const,
  /** 用户名链接（取 href 中 UID） */
  userNameLink: [
    '#user-name a[href*="space.bilibili.com"]',
    'a#user-avatar[href*="space.bilibili.com"]',
    'a[href*="space.bilibili.com"]',
  ] as const,
  userNameText: ['#user-name a', '.user-name', '.reply-user-name', '.sub-user-name'] as const,
  /** 正文 */
  content: [
    '#contents',
    'bili-rich-text',
    '.reply-content-container .reply-content',
    '.reply-content',
    '.reply-content__content',
    '.content',
  ] as const,
  /** 内容 ID 候选属性（取第一个非空） */
  idAttrs: ['data-rpid', 'data-id', 'data-rpid-id'] as const,
  /** 2026 评论组件暴露的只读数据对象（实页结构捕获确认包含 rpid/content.message） */
  dataProperties: ['data', '__data'] as const,
  /** 回复/操作按钮区（快捷按钮挂载位置候选） */
  actionArea: [
    '#footer',
    '.reply-actions',
    '.reply-option',
    '.sub-reply-option',
    '.reply-info',
  ] as const,
} as const;

/** 动态卡片（首页/详情/opus） */
export const DYNAMIC_SELECTORS = {
  /** 动态条目（最外层容器，提取目标） */
  item: ['.bili-dyn-item', '.opus-item'] as const,
  /** 卡片内部主容器（供提取回退，不作为独立目标） */
  card: ['.bili-dyn-card', '.opus-card'] as const,
  /** 用户链接 */
  userLink: ['a[href*="space.bilibili.com"]'] as const,
  userNameText: [
    '.bili-dyn-card__user-name',
    '.opus-card__user-name',
    '.bili-dyn-card__header__name',
  ] as const,
  /** 正文 */
  content: [
    '.bili-dyn-card__content',
    '.bili-dyn-content',
    '.opus-card__content',
    '.bili-dyn-card__body .bili-dyn-content',
  ] as const,
  /** 正文纯文本节点（排除按钮区） */
  contentText: [
    '.bili-dyn-content__text',
    '.opus-card__text',
    '.bili-dyn-content .bili-dyn-content__text',
  ] as const,
  /** 转发原文块 */
  origContent: [
    '.bili-dyn-content__orig',
    '.opus-card__quote',
    '.bili-dyn-card__content--orig',
  ] as const,
  /** 动态 ID 候选属性 */
  idAttrs: ['data-dyn-id', 'data-id', 'data-dynamic-id'] as const,
  /** 操作区（快捷按钮挂载候选） */
  actionArea: ['.bili-dyn-card__action', '.opus-card__action', '.bili-dyn-actions'] as const,
} as const;

/** 动态详情页评论容器（动态评论区复用评论选择器） */
export const DETAIL_COMMENT_CONTAINER = [
  '.bili-comment',
  '.opus-comment',
  '.comment-area',
  '.reply-list-wrap',
] as const;

/**
 * 页面类型判定。
 * 动态详情必须带数值 ID；`/dynamic` 与 `/dynamic/` 属于动态首页，不能按详情页处理。
 */
export function detectPageScope(
  pathname: string,
): 'video_page' | 'dynamic_feed' | 'dynamic_detail' {
  if (/^\/video(?:\/|$)/.test(pathname) || /^\/list(?:\/|$)/.test(pathname)) return 'video_page';
  if (/^\/(?:dynamic|opus)\/\d+(?:\/|$)/.test(pathname)) {
    return 'dynamic_detail';
  }
  return 'dynamic_feed';
}

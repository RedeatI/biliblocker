/**
 * 真实脱敏 DOM fixture 测试（A-03/A-04）：
 * - 动态详情页主卡片 + 动态评论 + 楼中楼回复提取；
 * - /dynamic/{id} 与 /opus/{id} 两种路由的页面检测与动态 ID 提取；
 * - 每条 fixture 记录采集日期与页面版本特征（文件头注释维护）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractComment } from '@/adapters/bilibili/comments';
import { extractDynamic } from '@/adapters/bilibili/dynamics';
import { detectPageScope } from '@/adapters/bilibili/selectors';
import { extractDynamicId } from '@/entrypoints/content/app';

const PAGES = resolve(__dirname, '../fixtures/pages');

function loadPage(name: string): void {
  const html = readFileSync(resolve(PAGES, name), 'utf8');
  document.open();
  document.write(html);
  document.close();
}

describe('A-04 路由：/dynamic/{id} 与 /opus/{id}', () => {
  it('detectPageScope 识别动态详情路由', () => {
    expect(detectPageScope('/dynamic/12345')).toBe('dynamic_detail');
    expect(detectPageScope('/opus/67890')).toBe('dynamic_detail');
    expect(detectPageScope('/video/BV1xx411c7mD')).toBe('video_page');
    expect(detectPageScope('/')).toBe('dynamic_feed');
    expect(detectPageScope('/dynamic')).toBe('dynamic_feed');
    expect(detectPageScope('/dynamic/')).toBe('dynamic_feed');
    expect(detectPageScope('/opus')).toBe('dynamic_feed');
    expect(detectPageScope('/opus/')).toBe('dynamic_feed');
  });

  it('extractDynamicId 提取两种路由的动态 ID', () => {
    expect(extractDynamicId('/dynamic/12345')).toBe('12345');
    expect(extractDynamicId('/opus/67890')).toBe('67890');
    expect(extractDynamicId('/video/BV1xx')).toBeNull();
  });
});

describe('A-03 动态详情 fixture（/dynamic/{id}）', () => {
  it('fixture 包含采集日期与页面版本特征注释', () => {
    const src = readFileSync(resolve(PAGES, 'dynamic-detail.html'), 'utf8');
    expect(src).toContain('脱敏合成 DOM');
    expect(src).toMatch(/仅供测试/);
  });

  it('主卡片提取（dynamic 本体，uid + 动态 ID + 正文）', () => {
    loadPage('dynamic-detail.html');
    const item = document.querySelector<HTMLElement>('.bili-dyn-item')!;
    const r = extractDynamic(item, { pageScope: 'dynamic_detail' });
    expect(r.ok).toBe(true);
    expect(r.data?.contentType).toBe('dynamic');
    expect(r.data?.uid).toBe(30001);
    expect(r.data?.contentId).toBe('300001');
    expect(r.data?.text).toContain('新项目');
    expect(r.data?.pageScope).toBe('dynamic_detail');
  });

  it('动态评论一级评论 + 楼中楼回复提取', () => {
    loadPage('dynamic-detail.html');
    const roots = document.querySelectorAll<HTMLElement>('.reply-list > .list-item .reply-item');
    const first = extractComment(roots[0]!, {
      contentType: 'dynamic_comment',
      pageScope: 'dynamic_detail',
      videoId: '300001',
    });
    expect(first.ok).toBe(true);
    expect(first.data?.uid).toBe(30002);
    expect(first.data?.contentId).toBe('300101');

    const sub = document.querySelector<HTMLElement>('.sub-reply-item')!;
    const subR = extractComment(sub, {
      contentType: 'dynamic_comment',
      pageScope: 'dynamic_detail',
      videoId: '300001',
      rootCommentId: '300101',
    });
    expect(subR.ok).toBe(true);
    expect(subR.data?.uid).toBe(30003);
    expect(subR.data?.contentId).toBe('300102');
    expect(subR.data?.rootContentId).toBe('300101');
  });
});

describe('A-03 Opus 详情 fixture（/opus/{id}）', () => {
  it('Opus 主卡片提取（.opus-item / .opus-card 结构）', () => {
    loadPage('dynamic-detail-opus.html');
    const item = document.querySelector<HTMLElement>('.opus-item')!;
    const r = extractDynamic(item, { pageScope: 'dynamic_detail' });
    expect(r.ok).toBe(true);
    expect(r.data?.uid).toBe(40001);
    expect(r.data?.contentId).toBe('400001');
    expect(r.data?.text).toContain('摄影技巧');
  });

  it('Opus 评论区（.opus-comment .reply-list）一级评论 + 楼中楼', () => {
    loadPage('dynamic-detail-opus.html');
    const root = document.querySelector<HTMLElement>('.reply-list .reply-item')!;
    const r = extractComment(root, { contentType: 'dynamic_comment', pageScope: 'dynamic_detail', videoId: '400001' });
    expect(r.ok).toBe(true);
    expect(r.data?.uid).toBe(40002);
    expect(r.data?.contentId).toBe('400101');
    const sub = document.querySelector<HTMLElement>('.sub-reply-item')!;
    const sr = extractComment(sub, { contentType: 'dynamic_comment', pageScope: 'dynamic_detail', videoId: '400001', rootCommentId: '400101' });
    expect(sr.data?.uid).toBe(40003);
  });
});

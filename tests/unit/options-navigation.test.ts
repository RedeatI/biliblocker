import { describe, expect, it } from 'vitest';
import { decideOptionsNavigation } from '@/shared/options-navigation';

describe('Options 导航决策', () => {
  it('默认目标只选择浏览器注册的 Options 页面', () => {
    expect(decideOptionsNavigation()).toEqual({ kind: 'registered-options' });
  });

  it('日志目标只选择带 #logs 的 extension 相对路径', () => {
    expect(decideOptionsNavigation('logs')).toEqual({
      kind: 'extension-url',
      path: '/options.html#logs',
    });
  });

  it('首次启用目标只选择受限的 #welcome 路径', () => {
    expect(decideOptionsNavigation('welcome')).toEqual({
      kind: 'extension-url',
      path: '/options.html#welcome',
    });
  });
});

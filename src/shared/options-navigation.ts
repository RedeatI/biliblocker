/** 可由 popup 请求的 Options 页面目标。 */
export type OptionsTarget = 'logs' | 'welcome';

export type OptionsNavigation =
  | { kind: 'registered-options' }
  | { kind: 'extension-url'; path: '/options.html#logs' | '/options.html#welcome' };

/**
 * 将受限的 popup 目标映射为唯一的打开策略。
 * 默认页必须走浏览器注册的 Options 页面；日志页需要 hash 以供 Options App 初始化时选中。
 */
export function decideOptionsNavigation(target?: OptionsTarget): OptionsNavigation {
  if (target === 'logs') return { kind: 'extension-url', path: '/options.html#logs' };
  if (target === 'welcome') return { kind: 'extension-url', path: '/options.html#welcome' };
  return { kind: 'registered-options' };
}

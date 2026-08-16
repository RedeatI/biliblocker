/** Popup 主开关动作：仅协调 extension runtime/storage，不触发页面或官方 API 请求。 */
import type { Settings } from '../../shared/types';

export interface PopupControllerDeps {
  sendMessage(message: unknown): Promise<unknown>;
  getSettingsRevision(): Promise<number>;
}

export async function togglePopupMaster(
  settings: Pick<Settings, 'enabled'>,
  deps: PopupControllerDeps,
): Promise<'open_welcome' | 'disable'> {
  if (!settings.enabled) {
    // 新装/重新启用从知情选择开始，popup 不直接改写安全默认值。
    await deps.sendMessage({ type: 'BB_OPEN_OPTIONS', target: 'welcome' });
    return 'open_welcome';
  }
  await deps.sendMessage({
    type: 'BB_MUTATE_LIST',
    mutation: {
      op: 'updateSettings',
      patch: { enabled: false },
      expectedRevision: await deps.getSettingsRevision(),
    },
  });
  return 'disable';
}

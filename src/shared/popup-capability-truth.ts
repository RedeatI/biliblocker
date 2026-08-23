import type { Settings } from './types';

const REPORT_CAPABILITY_KEYS = [
  'reportVideoComment',
  'reportVideoReply',
  'reportDynamicComment',
  'reportDynamic',
] as const;

export type PopupSettingsRead =
  | { state: 'known'; settings: Pick<Settings, 'enabled' | 'autoReportAuthorized'> }
  | { state: 'unknown' };

export type PopupCapabilityRead =
  | { state: 'known'; verified: boolean }
  | { state: 'unknown' };

export interface PopupCapabilityTruth {
  settingText: '已启用' | '未启用' | '状态未知';
  authorizationText: '已授权' | '未授权' | '状态未知';
  capabilityText:
    | '真实能力已验证，真实请求已允许'
    | '真实能力已验证，但设置未允许真实请求'
    | '真实能力已验证，但设置状态未知，真实请求已禁用'
    | '未通过真实验证，真实请求已禁用'
    | '状态未知，真实请求已禁用';
  realRequestEnabled: boolean;
}

/**
 * 将运行时能力表收窄为 Popup 所需的自动举报能力真值。
 * 结构缺失或字段类型异常一律视为读取失败，避免 UI 猜测能力状态。
 */
export function readPopupCapabilityVerification(
  capabilityVerification: unknown,
  reportReasons: unknown,
): PopupCapabilityRead {
  if (!isRecord(capabilityVerification) || !isRecord(reportReasons)) {
    return { state: 'unknown' };
  }

  const capabilityFlags = REPORT_CAPABILITY_KEYS.map((key) => {
    const verification = capabilityVerification[key];
    return isRecord(verification) && typeof verification.verified === 'boolean'
      ? verification.verified
      : null;
  });
  if (capabilityFlags.some((flag) => flag === null) || typeof reportReasons.verified !== 'boolean') {
    return { state: 'unknown' };
  }

  return {
    state: 'known',
    verified: capabilityFlags.every((flag) => flag === true) && reportReasons.verified,
  };
}

/**
 * Popup 展示与真实请求门禁共用的纯状态投影。
 * 用户设置允许和真实能力验证是两个独立条件；未知状态始终 fail closed。
 */
export function projectPopupCapabilityTruth(
  settingsRead: PopupSettingsRead,
  capabilityRead: PopupCapabilityRead,
): PopupCapabilityTruth {
  const settingsKnown = settingsRead.state === 'known';
  const settingEnabled = settingsKnown && settingsRead.settings.enabled === true;
  const authorized = settingsKnown && settingsRead.settings.autoReportAuthorized === true;
  const settingAllowsRequest = settingEnabled && authorized;

  const settingText = settingsKnown ? (settingEnabled ? '已启用' : '未启用') : '状态未知';
  const authorizationText = settingsKnown ? (authorized ? '已授权' : '未授权') : '状态未知';

  if (capabilityRead.state === 'unknown') {
    return {
      settingText,
      authorizationText,
      capabilityText: '状态未知，真实请求已禁用',
      realRequestEnabled: false,
    };
  }

  if (!capabilityRead.verified) {
    return {
      settingText,
      authorizationText,
      capabilityText: '未通过真实验证，真实请求已禁用',
      realRequestEnabled: false,
    };
  }

  if (!settingsKnown) {
    return {
      settingText,
      authorizationText,
      capabilityText: '真实能力已验证，但设置状态未知，真实请求已禁用',
      realRequestEnabled: false,
    };
  }

  return {
    settingText,
    authorizationText,
    capabilityText: settingAllowsRequest
      ? '真实能力已验证，真实请求已允许'
      : '真实能力已验证，但设置未允许真实请求',
    realRequestEnabled: settingAllowsRequest,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

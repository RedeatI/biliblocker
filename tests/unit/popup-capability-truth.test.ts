import { describe, expect, it } from 'vitest';
import {
  projectPopupCapabilityTruth,
  readPopupCapabilityVerification,
  type PopupCapabilityRead,
  type PopupSettingsRead,
} from '@/shared/popup-capability-truth';

const SETTINGS_CASES: Array<{
  name: string;
  read: PopupSettingsRead;
  settingText: '已启用' | '未启用' | '状态未知';
  authorizationText: '已授权' | '未授权' | '状态未知';
  allowsRequest: boolean;
}> = [
  {
    name: '设置读取失败',
    read: { state: 'unknown' },
    settingText: '状态未知',
    authorizationText: '状态未知',
    allowsRequest: false,
  },
  {
    name: '总设置关闭且未授权',
    read: { state: 'known', settings: { enabled: false, autoReportAuthorized: false } },
    settingText: '未启用',
    authorizationText: '未授权',
    allowsRequest: false,
  },
  {
    name: '总设置关闭但已授权',
    read: { state: 'known', settings: { enabled: false, autoReportAuthorized: true } },
    settingText: '未启用',
    authorizationText: '已授权',
    allowsRequest: false,
  },
  {
    name: '总设置开启但未授权',
    read: { state: 'known', settings: { enabled: true, autoReportAuthorized: false } },
    settingText: '已启用',
    authorizationText: '未授权',
    allowsRequest: false,
  },
  {
    name: '总设置开启且已授权',
    read: { state: 'known', settings: { enabled: true, autoReportAuthorized: true } },
    settingText: '已启用',
    authorizationText: '已授权',
    allowsRequest: true,
  },
];

const CAPABILITY_CASES: Array<{
  name: string;
  read: PopupCapabilityRead;
}> = [
  { name: '能力读取失败', read: { state: 'unknown' } },
  { name: '能力未验证', read: { state: 'known', verified: false } },
  { name: '能力已验证', read: { state: 'known', verified: true } },
];

describe('Popup capability truth 状态矩阵', () => {
  for (const settingsCase of SETTINGS_CASES) {
    for (const capabilityCase of CAPABILITY_CASES) {
      it(`${settingsCase.name} × ${capabilityCase.name}`, () => {
        const truth = projectPopupCapabilityTruth(settingsCase.read, capabilityCase.read);

        expect(truth.settingText).toBe(settingsCase.settingText);
        expect(truth.authorizationText).toBe(settingsCase.authorizationText);
        expect(truth.realRequestEnabled).toBe(
          settingsCase.allowsRequest &&
            capabilityCase.read.state === 'known' &&
            capabilityCase.read.verified,
        );

        if (capabilityCase.read.state === 'unknown') {
          expect(truth.capabilityText).toBe('状态未知，真实请求已禁用');
        } else if (!capabilityCase.read.verified) {
          expect(truth.capabilityText).toBe('未通过真实验证，真实请求已禁用');
        }
      });
    }
  }

  it('只有设置开启、用户已授权且真实能力已验证时才允许真实请求', () => {
    const enabled = SETTINGS_CASES.flatMap((settingsCase) =>
      CAPABILITY_CASES.map((capabilityCase) =>
        projectPopupCapabilityTruth(settingsCase.read, capabilityCase.read).realRequestEnabled,
      ),
    );
    expect(enabled.filter(Boolean)).toHaveLength(1);
  });
});

describe('Popup capability 状态读取', () => {
  const verifiedCapabilities = {
    reportVideoComment: { verified: true },
    reportVideoReply: { verified: true },
    reportDynamicComment: { verified: true },
    reportDynamic: { verified: true },
  };

  it('全部举报能力与理由均验证后才返回 known/verified', () => {
    expect(readPopupCapabilityVerification(verifiedCapabilities, { verified: true })).toEqual({
      state: 'known',
      verified: true,
    });
    expect(readPopupCapabilityVerification(verifiedCapabilities, { verified: false })).toEqual({
      state: 'known',
      verified: false,
    });
  });

  it('任一举报能力未验证时返回 known/unverified', () => {
    expect(
      readPopupCapabilityVerification(
        { ...verifiedCapabilities, reportDynamic: { verified: false } },
        { verified: true },
      ),
    ).toEqual({ state: 'known', verified: false });
  });

  it.each([
    ['能力表缺失', null, { verified: true }],
    ['能力记录缺失', {}, { verified: true }],
    ['能力字段类型异常', { ...verifiedCapabilities, reportDynamic: { verified: 'yes' } }, { verified: true }],
    ['理由状态缺失', verifiedCapabilities, {}],
    ['理由字段类型异常', verifiedCapabilities, { verified: 'yes' }],
  ])('%s 时 fail closed 为 unknown', (_name, capabilities, reasons) => {
    expect(readPopupCapabilityVerification(capabilities, reasons)).toEqual({ state: 'unknown' });
  });
});

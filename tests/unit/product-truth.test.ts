import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STRINGS } from '@/shared/strings';

describe('生产产品真值', () => {
  it('隐私页使用当前本地边界与未来条件语气', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/entrypoints/options/tabs/PrivacyTab.vue'),
      'utf8',
    );
    expect(source).toContain('当前仅执行本地处理');
    expect(source).toContain('生产环境不会发送这些请求');
    expect(source).toContain('能力验证通过且你明确授权后');
    expect(source).not.toContain('扩展会代表你调用');
    expect(source).not.toContain('用于过滤与举报');
  });

  it('未验证能力的本地主动作与禁用原因使用明确文案', () => {
    expect(STRINGS.quickAction.localOnly).toBe('加入本地黑名单并隐藏本页内容');
    expect(STRINGS.quickAction.localOnlyTitle).toContain('不发送任何请求');
    expect(STRINGS.quickAction.blockCapabilityUnavailable).toContain('未通过真实账号验证');
    expect(STRINGS.quickAction.reportCapabilityUnavailable).toContain('未通过真实账号验证');
  });

  it('RC2 三包被登记为不可上传的替代证据', () => {
    const register = readFileSync(resolve(__dirname, '../../docs/release-candidates.md'), 'utf8');
    expect(register).toContain('68c23f2b75904eb777204a6ff55873b8279be9ff');
    expect(register).toContain('afdad249a4e4987b036b2af6965ba221abd113a4a287b4ccfcf70194489004a1');
    expect(register).toContain('73a8d4ffe3e0231bd9309325e49ada055c2ddbc426fcb6772ecccd9471a24bba');
    expect(register).toContain('0720165fe9e8c1ade6ec3fd1425ba0dd07ceef7741d02c266bc32ed64e894bed');
    expect(register).toMatch(/不得上传.*不得覆盖.*不得冒充/s);
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertCandidateDescendsFromBaseline,
  assertCleanCandidateChanges,
  assertSourceZipEntriesSafe,
  parseGitStatusPorcelain,
  RELEASE_BASELINE_MANIFEST,
  summarizeManifest,
  summarizeManifestDelta,
} from '../../scripts/package-evidence.mjs';

describe('package candidate evidence', () => {
  it('only permits an explicit out-e2e/ status exception', () => {
    const changes = parseGitStatusPorcelain(Buffer.from('?? out-e2e/chrome-mv3/manifest.json\0'));
    expect(() => assertCleanCandidateChanges(changes)).not.toThrow();
    expect(parseGitStatusPorcelain(Buffer.from('?? out-e2e\\chrome-mv3\\manifest.json\0'))[0]?.paths).toEqual([
      'out-e2e/chrome-mv3/manifest.json',
    ]);
  });

  it('rejects tracked and untracked source changes, including a rename preimage', () => {
    expect(() => assertCleanCandidateChanges(parseGitStatusPorcelain(Buffer.from(' M src/index.ts\0')))).toThrow(/未确认/);
    expect(() => assertCleanCandidateChanges(parseGitStatusPorcelain(Buffer.from('?? notes.txt\0')))).toThrow(/未确认/);
    expect(() => assertCleanCandidateChanges(parseGitStatusPorcelain(Buffer.from('R  out-e2e/new.txt\0src/index.ts\0')))).toThrow(/src\/index/);
  });

  it('permits the audited baseline or a descendant, and rejects unrelated history', () => {
    expect(assertCandidateDescendsFromBaseline('base', 'base', 'base')).toBe('equal');
    expect(assertCandidateDescendsFromBaseline('base', 'candidate', 'base')).toBe('descendant');
    expect(() => assertCandidateDescendsFromBaseline('base', 'other', 'different-root')).toThrow(/不是指定/);
  });

  it('summarizes manifest permissions and reports the semantic delta', () => {
    const baseline = summarizeManifest({ manifest_version: 3, permissions: ['storage'], content_scripts: [{ matches: ['https://www.bilibili.com/*'] }] });
    const candidate = summarizeManifest({ manifest_version: 3, permissions: ['storage', 'alarms'], host_permissions: ['https://api.bilibili.com/*'], content_scripts: [{ matches: ['https://www.bilibili.com/*', 'https://t.bilibili.com/*'] }] });
    expect(summarizeManifestDelta(baseline, candidate)).toEqual({
      permissions: { added: ['alarms'], removed: [] },
      hostPermissions: { added: ['https://api.bilibili.com/*'], removed: [] },
      contentScriptMatches: { added: ['https://t.bilibili.com/*'], removed: [] },
    });
  });

  it('uses the audited RC1 manifest contract as the release comparison baseline', () => {
    expect(RELEASE_BASELINE_MANIFEST).toEqual({
      manifestVersion: 3,
      permissions: ['alarms', 'storage'],
      hostPermissions: [],
      contentScriptMatches: ['https://www.bilibili.com/*'],
    });
    expect(summarizeManifestDelta(RELEASE_BASELINE_MANIFEST, RELEASE_BASELINE_MANIFEST)).toEqual({
      permissions: { added: [], removed: [] },
      hostPermissions: { added: [], removed: [] },
      contentScriptMatches: { added: [], removed: [] },
    });
  });

  it('refuses prohibited source archive roots', () => {
    expect(() => assertSourceZipEntriesSafe(['src/index.ts', 'out-e2e/chrome-mv3/manifest.json'])).toThrow(/out-e2e/);
    expect(() => assertSourceZipEntriesSafe(['src/index.ts', 'docs/store-submission.md'])).not.toThrow();
  });
});

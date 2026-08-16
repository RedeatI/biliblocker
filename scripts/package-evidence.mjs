/**
 * Candidate-provenance helpers for `pnpm zip`.
 *
 * They deliberately use Git porcelain and Node APIs only: no shell parsing,
 * globbing, or platform-specific commands are needed to make the release
 * decision reproducible on Windows, macOS, and Linux.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const RELEASE_BASELINE_COMMIT = '5f97621';
/** Manifest contract audited at the 0.1.7 RC1 baseline. */
export const RELEASE_BASELINE_MANIFEST = Object.freeze({
  manifestVersion: 3,
  permissions: Object.freeze(['alarms', 'storage']),
  hostPermissions: Object.freeze([]),
  contentScriptMatches: Object.freeze(['https://www.bilibili.com/*']),
});
const E2E_OUTPUT_PREFIX = 'out-e2e/';

function normalizePath(path) {
  return path.replaceAll('\\', '/');
}

/** Parse `git status --porcelain=v1 -z`, including rename/copy old paths. */
export function parseGitStatusPorcelain(raw) {
  const fields = raw.toString().split('\0');
  const changes = [];
  for (let i = 0; i < fields.length - 1; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = normalizePath(field.slice(3));
    const paths = [path];
    // In -z porcelain v1, rename/copy records carry the preimage as the next
    // NUL-delimited field. Check both sides so a source rename cannot hide.
    if (status.includes('R') || status.includes('C')) {
      const oldPath = fields[++i];
      if (oldPath) paths.push(normalizePath(oldPath));
    }
    changes.push({ status, paths });
  }
  return changes;
}

export function isApprovedCandidateException(path) {
  return path === 'out-e2e' || path.startsWith(E2E_OUTPUT_PREFIX);
}

export function assertCleanCandidateChanges(changes) {
  const unapproved = changes.filter((change) => !change.paths.every(isApprovedCandidateException));
  if (unapproved.length > 0) {
    const detail = unapproved
      .flatMap((change) => change.paths.map((path) => `${change.status} ${path}`))
      .join(', ');
    throw new Error(
      `[candidate] 拒绝在未确认的 tracked/untracked 源码改动上打包：${detail}。` +
        '请提交、暂存外移或明确恢复这些改动后重试；只有 out-e2e/ 是可排除的本地 E2E 例外。',
    );
  }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** Return only committed source paths, never ignored/local by-products. */
export function listTrackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString()
    .split('\0')
    .filter(Boolean)
    .map(normalizePath);
}

/**
 * A candidate may advance the RC1 baseline, but it must never come from an
 * unrelated history. Keeping this pure makes the fail-closed policy testable.
 */
export function assertCandidateDescendsFromBaseline(baselineCommit, candidateCommit, mergeBaseCommit) {
  if (mergeBaseCommit !== baselineCommit) {
    throw new Error(
      `[candidate] 当前 HEAD ${candidateCommit} 不是指定 0.1.7 RC 基线 ${baselineCommit} 的后代；拒绝打包。`,
    );
  }
  return candidateCommit === baselineCommit ? 'equal' : 'descendant';
}

/** Capture the exact source identity before any output directory is changed. */
export function captureCandidateProvenance(root, baselineCommit = RELEASE_BASELINE_COMMIT) {
  if (!existsSync(resolve(root, '.git'))) {
    throw new Error('[candidate] 当前目录不是 Git 工作树，无法生成可追溯候选包。');
  }
  const changes = parseGitStatusPorcelain(
    execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root }),
  );
  assertCleanCandidateChanges(changes);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']);
  const resolvedBaseline = git(root, ['rev-parse', baselineCommit]);
  const baselineRelationship = assertCandidateDescendsFromBaseline(
    resolvedBaseline,
    sourceCommit,
    git(root, ['merge-base', resolvedBaseline, sourceCommit]),
  );
  const branch = git(root, ['branch', '--show-current']) || 'DETACHED';
  const e2eChanges = changes.flatMap((change) => change.paths).filter(isApprovedCandidateException);
  return {
    sourceCommit,
    branch,
    baselineCommit: resolvedBaseline,
    // `dirty` reflects Git's complete worktree; the only permitted dirty
    // state is listed below and never becomes Source ZIP input.
    dirty: e2eChanges.length > 0,
    sourceDirty: false,
    workingTreeStatus: e2eChanges.length ? 'out-e2e-exception-only' : 'clean',
    baselineRelationship,
    exceptions: e2eChanges.length
      ? [{ path: E2E_OUTPUT_PREFIX, status: 'explicitly excluded local E2E output', paths: e2eChanges }]
      : [],
  };
}

export function summarizeManifest(manifest) {
  const matches = [...new Set((manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []))].sort();
  return {
    manifestVersion: manifest.manifest_version,
    permissions: [...(manifest.permissions ?? [])].sort(),
    hostPermissions: [...(manifest.host_permissions ?? [])].sort(),
    contentScriptMatches: matches,
  };
}

export function summarizeManifestDelta(baseline, candidate) {
  const diff = (before, after) => ({
    added: after.filter((item) => !before.includes(item)),
    removed: before.filter((item) => !after.includes(item)),
  });
  return {
    permissions: diff(baseline.permissions, candidate.permissions),
    hostPermissions: diff(baseline.hostPermissions, candidate.hostPermissions),
    contentScriptMatches: diff(baseline.contentScriptMatches, candidate.contentScriptMatches),
  };
}

export function assertSourceZipEntriesSafe(entryNames) {
  const forbiddenRoots = ['.git/', 'out/', 'out-e2e/', 'dist/', 'node_modules/'];
  const leaked = entryNames.filter((name) => forbiddenRoots.some((root) => name === root.slice(0, -1) || name.startsWith(root)));
  if (leaked.length > 0) {
    throw new Error(`[candidate] Source ZIP 混入禁止内容：${leaked.slice(0, 10).join(', ')}`);
  }
}

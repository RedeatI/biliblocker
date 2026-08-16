/** scripts/package-evidence.mjs 类型声明 */
export const RELEASE_BASELINE_COMMIT: string;
export const RELEASE_BASELINE_MANIFEST: ManifestSummary;

export type GitStatusChange = { status: string; paths: string[] };
export type ManifestSummary = {
  manifestVersion: number;
  permissions: string[];
  hostPermissions: string[];
  contentScriptMatches: string[];
};

export function parseGitStatusPorcelain(raw: Buffer): GitStatusChange[];
export function isApprovedCandidateException(path: string): boolean;
export function assertCleanCandidateChanges(changes: GitStatusChange[]): void;
export function listTrackedFiles(root: string): string[];
export function assertCandidateDescendsFromBaseline(
  baselineCommit: string,
  candidateCommit: string,
  mergeBaseCommit: string,
): 'equal' | 'descendant';
export function captureCandidateProvenance(root: string, baselineCommit?: string): {
  sourceCommit: string;
  branch: string;
  baselineCommit: string;
  dirty: boolean;
  sourceDirty: false;
  workingTreeStatus: 'clean' | 'out-e2e-exception-only';
  baselineRelationship: 'equal' | 'descendant';
  exceptions: Array<{ path: string; status: string; paths: string[] }>;
};
export function summarizeManifest(manifest: {
  manifest_version: number;
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
}): ManifestSummary;
export function summarizeManifestDelta(baseline: ManifestSummary, candidate: ManifestSummary): {
  permissions: { added: string[]; removed: string[] };
  hostPermissions: { added: string[]; removed: string[] };
  contentScriptMatches: { added: string[]; removed: string[] };
};
export function assertSourceZipEntriesSafe(entryNames: string[]): void;

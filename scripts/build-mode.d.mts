/** scripts/build-mode.mjs 类型声明 */
export interface BuildMode {
  isE2E: boolean;
  outDir: string;
  e2eDefine: string;
}
export function resolveBuildMode(env?: NodeJS.ProcessEnv): BuildMode;
export function patchContentScriptsForE2E(
  manifest: { content_scripts?: Array<{ matches: string[] }> },
  isE2E: boolean,
): { content_scripts?: Array<{ matches: string[] }> };
export function viteDefine(mode: BuildMode): { define: Record<string, string> };

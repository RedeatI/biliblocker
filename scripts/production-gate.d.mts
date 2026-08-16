/** scripts/production-gate.mjs 类型声明 */
export const EXPECTED_PERMISSIONS: string[];
export const EXPECTED_HOST_PERMISSIONS: string[];
export const EXPECTED_CONTENT_MATCHES: string[];
export const EXPECTED_DESCRIPTION: string;
export function assertProductionClean(
  outDir: string,
  browser: string,
  version?: string,
): { matches: string[]; permissions: string[]; hostPerms: string[] };

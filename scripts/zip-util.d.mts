/** scripts/zip-util.mjs 类型声明 */
export function crc32(buf: Uint8Array): number;
export function createZip(files: Map<string, Uint8Array | Buffer>, outPath: string): Promise<void>;
export function readZipEntries(
  zipPath: string,
): Promise<Array<{ name: string; data: Buffer; crc: number }>>;

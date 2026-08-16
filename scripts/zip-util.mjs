/**
 * 跨平台 ZIP 写入器（零依赖，STORE 无压缩，确定性输出）。
 *
 * 为什么不用 powershell.exe / Compress-Archive（P0-1）：
 * - 打包流程必须跨平台（Windows/Linux/macOS 均可运行）；
 * - 确定性输出便于可复现发布与校验值比对。
 *
 * 用法：
 *   createZip(new Map([[相对路径, Buffer]]), 'out.zip')
 *   readZipEntries('out.zip') -> [{ name, data, crc32, size }]（用于门禁校验）
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';

/** 标准 CRC32（IEEE 802.3，ZIP 使用） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 写 UTF-8 字符串到 Buffer（含长度前缀） */
function encodeName(name) {
  const buf = Buffer.from(name, 'utf8');
  return { buf, len: buf.length };
}

function writeU16(buf, offset, v) {
  buf.writeUInt16LE(v, offset);
}
function writeU32(buf, offset, v) {
  buf.writeUInt32LE(v >>> 0, offset);
}

export { writeU16, writeU32 };

/**
 * 创建 ZIP（STORE 模式）。
 * @param {Map<string, Uint8Array|Buffer>} files 相对路径（使用正斜杠）→ 内容
 * @param {string} outPath 输出路径
 */
export async function createZip(files, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  // 写入临时文件后原子替换，避免半成品
  const tmp = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  const entries = [];
  let centralDirSize = 0;
  const centralDir = [];
  const localParts = [];

  for (const [name, content] of files) {
    const normalized = name.replace(/\\/g, '/');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const crc = crc32(data);
    const { buf: nameBuf, len: nameLen } = encodeName(normalized);
    const localOffset = localParts.reduce((n, p) => n + p.length, 0);

    // ---- 本地文件头（版本 20, STORE） ----
    const local = Buffer.alloc(30);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20); // version needed
    writeU16(local, 6, 0); // flags
    writeU16(local, 8, 0); // method: store
    writeU16(local, 10, 0); // mod time
    writeU16(local, 12, 0x21); // mod date 1980-01-01（确定性）
    writeU32(local, 14, crc);
    writeU32(local, 18, data.length);
    writeU32(local, 22, data.length);
    writeU16(local, 26, nameLen);
    writeU16(local, 28, 0); // extra len
    localParts.push(local, nameBuf, data);

    // ---- 中央目录记录 ----
    const cd = Buffer.alloc(46);
    writeU32(cd, 0, 0x02014b50);
    writeU16(cd, 4, 20); // version made by
    writeU16(cd, 6, 20); // version needed
    writeU16(cd, 8, 0); // flags
    writeU16(cd, 10, 0); // method
    writeU16(cd, 12, 0);
    writeU16(cd, 14, 0x21);
    writeU32(cd, 16, crc);
    writeU32(cd, 20, data.length);
    writeU32(cd, 24, data.length);
    writeU16(cd, 28, nameLen);
    writeU16(cd, 30, 0); // extra
    writeU16(cd, 32, 0); // comment
    writeU16(cd, 34, 0); // disk
    writeU16(cd, 36, 0); // internal attrs
    writeU32(cd, 38, 0); // external attrs
    writeU32(cd, 42, localOffset);
    centralDir.push(cd, nameBuf);
    centralDirSize += 46 + nameLen;
    entries.push({ name: normalized, size: data.length, crc });
  }

  const cdStart = localParts.reduce((n, p) => n + p.length, 0);
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, entries.length);
  writeU16(eocd, 10, entries.length);
  writeU32(eocd, 12, centralDirSize);
  writeU32(eocd, 16, cdStart);
  writeU16(eocd, 20, 0);

  const out = createWriteStream(tmp);
  for (const p of [...localParts, ...centralDir, eocd]) out.write(p);
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    out.end();
  });
  await renameAtomic(tmp, outPath);
}

async function renameAtomic(tmp, target) {
  const { rename, rm } = await import('node:fs/promises');
  try {
    await rm(target, { force: true });
  } catch {
    /* ignore */
  }
  await rename(tmp, target);
}

/** 读取 ZIP 条目（支持 STORE 与 deflate），供门禁校验使用 */
export async function readZipEntries(zipPath) {
  const data = await readFile(zipPath);
  const entries = [];
  let offset = 0;
  while (offset + 30 <= data.length) {
    const sig = data.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const nameLen = data.readUInt16LE(offset + 26);
    const extraLen = data.readUInt16LE(offset + 28);
    const method = data.readUInt16LE(offset + 8);
    const compSize = data.readUInt32LE(offset + 18);
    const crc = data.readUInt32LE(offset + 14);
    const name = data.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const contentStart = offset + 30 + nameLen + extraLen;
    let content;
    if (method === 0) {
      content = data.subarray(contentStart, contentStart + compSize);
    } else if (method === 8) {
      // deflate：使用 node zlib 解压
      const zlib = await import('node:zlib');
      content = zlib.inflateRawSync(data.subarray(contentStart, contentStart + compSize));
    } else {
      throw new Error(`不支持的 ZIP 压缩方法 ${method}（${name}）`);
    }
    entries.push({ name, data: Buffer.from(content), crc });
    offset = contentStart + compSize;
  }
  return entries;
}

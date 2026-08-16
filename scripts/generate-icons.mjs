/**
 * BiliBlocker 图标生成脚本（纯 Node，无第三方依赖）。
 *
 * 品牌色 #4A6CF7（盾牌蓝），图形为「圆形 + 斜杠」的封禁/阻止符号，
 * 采用 4x 超采样 + 盒式降采样抗锯齿，输出 512 / 128 / 48 / 32 / 16 五种尺寸 PNG。
 * 输出：src/assets/icon.png（512，WXT 自动派生各尺寸）与 public/icons/icon-*.png（商店素材）。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- PNG 编码（手写，零依赖） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 图形绘制 ----------
const BG = [0x4a, 0x6c, 0xf7, 255]; // 品牌蓝 #4A6CF7
const FG = [255, 255, 255, 255]; // 白色

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 在 0..1 坐标系中采样单个像素颜色（S= 超采样倍数） */
function sample(px, py, S) {
  let r = 0, g = 0, b = 0, a = 0;
  const acc = (c) => {
    r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
  };
  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      const x = (px + (sx + 0.5) / S) / 1; // 归一化到 0..1
      const y = (py + (sy + 0.5) / S) / 1;
      // 外圆角矩形（留 4% 边距）
      const dOuter = sdRoundRect(x, y, 0.5, 0.5, 0.46, 0.46, 0.22);
      if (dOuter > 0) continue; // 透明
      // 白色圆圈（封禁符号外环），中心 (0.5,0.5)，半径 0.30，环宽 0.055
      const ring = Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.30) - 0.055;
      // 斜杠：从左上到右下的白色斜线，宽度 0.085，角度 -45°
      // 将点旋转 +45° 后，斜杠变为水平带
      const dx = x - 0.5, dy = y - 0.5;
      const rot = Math.PI / 4;
      const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
      const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
      const bar = Math.max(Math.abs(ry) - 0.042, Math.abs(rx) - 0.34);
      const d = Math.min(ring, bar);
      if (d <= 0) {
        acc(FG);
      } else {
        // 1px 平滑
        const cov = Math.min(1, Math.max(0, 0.5 - d * S));
        const c = [...BG];
        if (cov > 0) {
          c[0] = BG[0] + (FG[0] - BG[0]) * cov;
          c[1] = BG[1] + (FG[1] - BG[1]) * cov;
          c[2] = BG[2] + (FG[2] - BG[2]) * cov;
          c[3] = 255;
          acc(c);
        } else {
          acc(BG);
        }
      }
    }
  }
  if (a === 0) return [0, 0, 0, 0];
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / (S * S))];
}

function render(size) {
  const S = 4; // 超采样
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = sample(x / size, y / size, S);
      const i = (y * size + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return encodePng(size, size, px);
}

const sizes = [512, 128, 48, 32, 16];
const assetsDir = resolve(root, 'src/assets');
const publicDir = resolve(root, 'public/icons');
mkdirSync(assetsDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

for (const size of sizes) {
  const buf = render(size);
  writeFileSync(resolve(publicDir, `icon-${size}.png`), buf);
  if (size === 512) writeFileSync(resolve(assetsDir, 'icon.png'), buf);
}
console.log('Icons generated:', sizes.join(', '), '->', publicDir, '+ src/assets/icon.png');

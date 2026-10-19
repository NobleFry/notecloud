/**
 * 生成 PWA 图标（192 / 512），零依赖。
 *
 * 为什么手写 PNG：只为两张纯色图标引一个 sharp/canvas 依赖不值得。
 * PNG 结构很简单：签名 + IHDR + IDAT(zlib) + IEND，每块带 CRC32。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');
mkdirSync(publicDir, { recursive: true });

const BG = [24, 160, 88, 255]; // #18a058
const FG = [255, 255, 255, 255];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function render(size) {
  const cx = size / 2;
  const cy = size / 2;
  const outer = size * 0.34;
  const inner = size * 0.22;

  // 每行：1 字节 filter type(0) + size*4 字节 RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  let offset = 0;

  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;

    for (let x = 0; x < size; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      // 圆环：外圈白色描边 + 中心白点，做出一个简化的 "N/环形" 标记
      let color = BG;
      if ((dist > outer && dist < outer + size * 0.05) || dist < inner) color = FG;

      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = color[3];
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = resolve(publicDir, `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`✓ ${file}`);
}

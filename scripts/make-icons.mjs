// 生成扩展图标（16/32/48/128）：藏青圆角底 + 白色纸页 + 一道黄色高亮。
// 不依赖任何图形库：逐像素画（带 4x 超采样抗锯齿），zlib 压成 PNG。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const NAVY = [27, 79, 114], WHITE = [255, 255, 255], YELLOW = [255, 213, 0], GREY = [170, 182, 192];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 单位坐标 (0..1) 下的颜色；返回 [r,g,b,a] */
function shade(u, v) {
  if (!inRoundRect(u, v, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0];
  // 纸页
  if (inRoundRect(u, v, 0.24, 0.16, 0.76, 0.84, 0.05)) {
    if (inRoundRect(u, v, 0.32, 0.42, 0.68, 0.52, 0.02)) return [...YELLOW, 255];   // 高亮那一行
    for (const y of [0.28, 0.62, 0.72]) {
      if (inRoundRect(u, v, 0.32, y - 0.025, y === 0.72 ? 0.56 : 0.68, y + 0.025, 0.02)) return [...GREY, 255];
    }
    return [...WHITE, 255];
  }
  return [...NAVY, 255];
}

function png(size) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        const a = c[3] / 255;
        acc[0] += c[0] * a; acc[1] += c[1] * a; acc[2] += c[2] * a; acc[3] += c[3];
      }
      const n = SS * SS, a = acc[3] / n;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const k = a > 0 ? 255 / a : 0;
      raw[o] = Math.round((acc[0] / n) * k); raw[o + 1] = Math.round((acc[1] / n) * k);
      raw[o + 2] = Math.round((acc[2] / n) * k); raw[o + 3] = Math.round(a);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/${s}.png`, png(s));
console.log("icons written");

// 生成 build/icon.png 与 build/icon.ico（纯 Node，无外部依赖）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(process.cwd(), 'build');
fs.mkdirSync(OUT, { recursive: true });

function render(size) {
  const ss = 4;
  const W = size * ss;
  const buf = new Uint8Array(W * W * 4);

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    // 简单 over 合成
    const sa = a / 255;
    const da = buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };

  const roundRect = (x0, y0, x1, y1, r, color) => {
    for (let y = Math.floor(y0); y < y1; y++) {
      const col = typeof color === 'function' ? color(y / W) : color;
      for (let x = Math.floor(x0); x < x1; x++) {
        const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
        const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r) set(x, y, ...col);
      }
    }
  };

  const rect = (x0, y0, x1, y1, color) => {
    for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) set(x, y, ...color);
  };

  // 背景：红到深红渐变 + 圆角
  const pad = W * 0.045;
  const r = W * 0.22;
  roundRect(pad, pad, W - pad, W - pad, r, (t) => [
    Math.round(244 - 120 * t), Math.round(64 - 48 * t), Math.round(56 - 30 * t), 255,
  ]);

  // 白色文档
  const left = W * 0.315, right = W * 0.69, top = W * 0.235, bottom = W * 0.775;
  const fold = W * 0.115;
  // 主体（缺右上角，用两块矩形拼）
  rect(left, top + fold, right, bottom, [255, 255, 255, 255]);
  rect(left, top, right - fold, top + fold, [255, 255, 255, 255]);
  // 折角三角（近似）
  for (let y = 0; y < fold; y++) {
    const x0 = right - fold + y;
    for (let x = Math.floor(x0); x < right; x++) set(x, Math.floor(top + y), 255, 255, 255, 255);
  }
  // 折角阴影线
  for (let y = 0; y < fold; y++) {
    for (let x = Math.floor(right - fold + y); x < right; x++) {
      const i = (Math.floor(top + y) * W + x) * 4;
      buf[i] = 226; buf[i + 1] = 232; buf[i + 2] = 238;
    }
  }

  // 文字线条（红色）
  const red = [190, 20, 34, 255];
  const lx0 = left + W * 0.055, lx1 = right - W * 0.055;
  [0.44, 0.53, 0.62, 0.71].forEach((p, i) => {
    rect(lx0, top + (bottom - top) * p, i === 3 ? lx0 + (lx1 - lx0) * 0.55 : lx1, top + (bottom - top) * p + W * 0.018, red);
  });

  // 缩小（盒式），得到 size
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * W + (x * ss + dx)) * 4;
          const a = buf[i + 3] / 255;
          rr += buf[i] * a; gg += buf[i + 1] * a; bb += buf[i + 2] * a; aa += a;
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      out[o] = aa ? Math.round(rr / aa) : 0;
      out[o + 1] = aa ? Math.round(gg / aa) : 0;
      out[o + 2] = aa ? Math.round(bb / aa) : 0;
      out[o + 3] = Math.round((aa / n) * 255);
    }
  }
  return out;
}

// ── PNG 编码 ───────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.slice(y * size * 4, (y + 1) * size * 4)).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png512 = png(render(512), 512);
const png256 = png(render(256), 256);
const png64 = png(render(64), 64);
fs.writeFileSync(path.join(OUT, 'icon.png'), png512);

// ICO：多尺寸 PNG 封装
const imgs = [
  { size: 256, data: png256 },
  { size: 64, data: png64 },
];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(imgs.length, 4);
let offset = 6 + 16 * imgs.length;
const entries = [];
for (const im of imgs) {
  const e = Buffer.alloc(16);
  e[0] = im.size >= 256 ? 0 : im.size;
  e[1] = im.size >= 256 ? 0 : im.size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(im.data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += im.data.length;
}
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([header, ...entries, ...imgs.map((i) => i.data)]));
console.log('icon.png', png512.length, 'icon.ico', fs.statSync(path.join(OUT, 'icon.ico')).size);

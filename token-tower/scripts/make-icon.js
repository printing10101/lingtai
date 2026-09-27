// 生成 electron/app.ico：手工绘制（圆角深蓝底 + 监控折线 + 活跃指示灯），
// 以解析式 coverage 采样得到平滑边缘，编码为多尺寸 PNG-in-ICO。纯 Node，无外部依赖。
// 用法：node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
function pngEncode(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制（坐标全部归一化到 0..1，乘尺寸转像素） ----------
const clamp01 = v => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;

// 圆角盒符号距离：负值在盒内
function sdRoundedBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
// 点到线段距离
function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

// 上升折线，终点带绿色活跃指示灯
const POLYLINE = [[0.20, 0.66], [0.40, 0.46], [0.56, 0.54], [0.74, 0.34]];
const DOT = { x: 0.74, y: 0.34, r: 0.085, glow: 0.045 };

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 像素中心，半像素偏移避免整体偏移半格
      const px = (x + 0.5) / s, py = (y + 0.5) / s;

      // 底：圆角方 + 对角渐变（左上亮 → 右下暗）
      const dBox = sdRoundedBox(px, py, 0.5, 0.5, 0.48, 0.48, 0.20) * s;
      const aBox = clamp01(0.5 - dBox);
      const t = clamp01((px + py) / 2);
      let r = lerp(51, 8, t), g = lerp(65, 15, t), b = lerp(85, 34, t), a = aBox * 255;

      if (aBox > 0) {
        // 白色折线
        let dLine = Infinity;
        for (let i = 0; i < POLYLINE.length - 1; i++) {
          dLine = Math.min(dLine, sdSegment(px, py, ...POLYLINE[i], ...POLYLINE[i + 1]));
        }
        const aLine = clamp01(0.5 - dLine * s);
        if (aLine > 0) {
          r = lerp(r, 248, aLine); g = lerp(g, 250, aLine); b = lerp(b, 252, aLine);
        }

        // 活跃灯：外圈光晕 + 实心圆点
        const dDot = Math.hypot(px - DOT.x, py - DOT.y);
        const aGlow = clamp01(0.5 - (dDot - DOT.r) / DOT.glow * 0.5) * 0.35;
        const aDot = clamp01(0.5 - (dDot - DOT.r) * s);
        if (aGlow > 0) {
          const aa = aGlow * aBox;
          r = lerp(r, 52, aa); g = lerp(g, 211, aa); b = lerp(b, 153, aa);
        }
        if (aDot > 0) {
          r = lerp(r, 52, aDot); g = lerp(g, 211, aDot); b = lerp(b, 153, aDot);
        }
      }

      const off = (y * size + x) * 4;
      buf[off] = Math.round(r); buf[off + 1] = Math.round(g);
      buf[off + 2] = Math.round(b); buf[off + 3] = Math.round(a);
    }
  }
  return buf;
}

// ---------- ICO 打包（Vista+ 支持 PNG-in-ICO） ----------
const SIZES = [256, 128, 64, 48, 32, 16];
const pngs = SIZES.map(size => ({ size, blob: pngEncode(size, size, drawIcon(size)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);

const entries = [];
let offset = 6 + 16 * pngs.length;
for (const { size, blob } of pngs) {
  const e = Buffer.alloc(16);
  e[0] = size === 256 ? 0 : size; // 0 表示 256
  e[1] = size === 256 ? 0 : size;
  e.writeUInt16LE(1, 4);  // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(blob.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += blob.length;
}

const outDir = path.join(__dirname, '..', 'electron');
fs.writeFileSync(path.join(outDir, 'app.ico'),
  Buffer.concat([header, ...entries, ...pngs.map(p => p.blob)]));
// 256px PNG 单独输出一份，供人工预览效果
fs.writeFileSync(path.join(outDir, 'icon-preview.png'),
  pngs[0].blob);
console.log('已生成 electron/app.ico（' + SIZES.join('/') + '）');

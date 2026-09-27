// build/icogen.js — 从 public/icon.svg 生成 build/icon.ico 与 electron/tray.png。
// 用法：node_modules/.bin/electron build/icogen.js
// 实现：offscreen 逐档渲染透明 PNG（paint 抓帧，capturePage 在本机不可靠），
//       ICO 容器手工打包 —— 全部 BMP(DIB) 条目：Windows 对 256 以下条目不认 PNG 压缩。
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svgRaw = fs.readFileSync(path.join(__dirname, '..', 'public', 'icon.svg'), 'utf8');
  const svgUri = 'data:image/svg+xml,' + encodeURIComponent(svgRaw);
  const win = new BrowserWindow({
    width: 256, height: 256, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true },
  });

  const pngs = {};
  const bmps = {};   // 原始 BGRA（供 ICO 的 BMP 条目用）
  for (const s of SIZES) {
    win.setContentSize(s, s);
    const html = `<body style="margin:0;background:transparent">
      <img src="${svgUri}" style="width:${s}px;height:${s}px;display:block"></body>`;
    win.loadURL('data:text/html,' + encodeURIComponent(html)).catch(() => {});
    await sleep(400); // 等解码与排版
    let img = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(s + 'px 没等到 paint 帧')), 1000);
      win.webContents.once('paint', (_e, _d, image) => { clearTimeout(t); resolve(image); });
      win.webContents.invalidate();
    });
    // DPI 缩放会让帧比请求的尺寸大（或带边），裁齐 / 缩到精确 s×s，ICO 条目尺寸必须严格一致
    const got = img.getSize();
    if (got.width !== s || got.height !== s) {
      img = got.width > s || got.height > s
        ? img.crop({ x: 0, y: 0, width: s, height: s })
        : img.resize({ width: s, height: s });
    }
    pngs[s] = img.toPNG();
    bmps[s] = img.getBitmap(); // BGRA，Chromium 是预乘 alpha
    console.log('rendered', s);
  }

  // ── 打包 ICO（全 BMP 条目）：Windows 对 256 以下的条目不认 PNG 压缩，必须给传统 DIB ──
  // DIB = BITMAPINFOHEADER(40B, 高度翻倍) + 自底向上 BGRA + 1bpp AND 掩码；32bpp 下透明度走 alpha 通道。
  const dib = (s, rgba) => {
    const stride = s * 4;
    const andStride = ((s + 31) >> 5) << 2; // 1bpp 行按 4 字节对齐
    const buf = Buffer.alloc(40 + stride * s + andStride * s);
    buf.writeUInt32LE(40, 0);            // biSize
    buf.writeInt32LE(s, 4);              // biWidth
    buf.writeInt32LE(s * 2, 8);          // biHeight：XOR + AND 两半
    buf.writeUInt16LE(1, 12);            // biPlanes
    buf.writeUInt16LE(32, 14);           // biBitCount
    buf.writeUInt32LE(stride * s + andStride * s, 20); // biSizeImage
    const xor = buf.slice(40, 40 + stride * s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const si = (y * s + x) * 4, di = ((s - 1 - y) * s + x) * 4; // 自底向上
        const a = rgba[si + 3];
        xor[di] = a ? Math.min(255, Math.round(rgba[si + 2] * 255 / a)) : 0; // 还原预乘 → 直通 alpha
        xor[di + 1] = a ? Math.min(255, Math.round(rgba[si + 1] * 255 / a)) : 0;
        xor[di + 2] = a ? Math.min(255, Math.round(rgba[si] * 255 / a)) : 0;
        xor[di + 3] = a;
      }
    }
    // AND 掩码保持全 0：不透明，透明度全由 alpha 通道表达
    return buf;
  };
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // 保留位
  header.writeUInt16LE(1, 2);      // 类型：图标
  header.writeUInt16LE(SIZES.length, 4);
  const entries = [];
  const datas = [];
  let offset = 6 + 16 * SIZES.length;
  for (const s of SIZES) {
    const data = dib(s, bmps[s]);
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);  // 宽（0 表示 256）
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2);                 // 调色板色数
    e.writeUInt8(0, 3);                 // 保留
    e.writeUInt16LE(1, 4);              // 色面
    e.writeUInt16LE(32, 6);             // 位深
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
    datas.push(data);
  }
  const ico = Buffer.concat([header, ...entries, ...datas]);
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), ico);
  fs.writeFileSync(path.join(__dirname, '..', 'electron', 'tray.png'), pngs[48]); // 托盘走 48px，系统自己缩
  console.log('icon.ico', ico.length, 'bytes (全 BMP 条目); tray.png 48px');
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });

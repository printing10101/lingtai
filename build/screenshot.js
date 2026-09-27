// build/screenshot.js — 开发辅助：用 Electron 截屏，检查三页视觉。
// 用法：node_modules/.bin/electron build/screenshot.js index experiments master
// （Git Bash 会把 "/" 转成 Windows 路径，所以命令行用 index 指看板页）
// 输出：.design-shots/<名字>-<时间戳>.png。
// 实现：offscreen + paint 事件抓帧 —— capturePage 在本机会抛 UnknownVizError，不可靠。
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', '.design-shots');
const page = a => (a === 'index' ? '/' : a.startsWith('/') ? a : '/' + a);
const PAGES = (process.argv.slice(2).length ? process.argv.slice(2) : ['index', 'experiments', 'master']).map(page);
const BASE = 'http://127.0.0.1:' + (process.env.LINGTAI_PORT || 8099);

app.disableHardwareAcceleration(); // 截图不需要 GPU，关掉避免 UnknownVizError / 缓存锁
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 1440, height: 960, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

  for (const p of PAGES) {
    // 不 await loadURL：直播页有常驻连接（SSE/轮询），did-finish-load 可能永远不来
    win.loadURL(BASE + p).catch(() => {});
    await new Promise(r => setTimeout(r, 3500)); // 等首轮 /api/state 与字体渲染
    const img = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('1 s 内没等到任何 paint 帧: ' + p)), 1000);
      win.webContents.once('paint', (_e, _dirty, image) => { clearTimeout(timer); resolve(image); });
      win.webContents.invalidate(); // 主动请求一帧
    });
    const name = (p === '/' ? 'kanban' : p.replace(/\//g, '')) + '-' + stamp + '.png';
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('saved', name);
  }
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });

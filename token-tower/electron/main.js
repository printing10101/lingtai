// Electron 壳：拉起 server.js 并把监控台页面装进桌面窗口，双击图标即用，无需手动开浏览器。
// 服务子进程用 Electron 自身以 ELECTRON_RUN_AS_NODE 方式运行，不依赖系统 PATH 里的 node。
// 监控的价值在于"一直在线"：关窗只是缩到托盘（服务继续收 hook 事件），
// 有 agent 转入"等你确认"时闪任务栏，托盘右键可退出/开关机自启。
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, Notification } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = app.getAppPath();
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
// 与 server.js 同一套端口决定逻辑，壳和服务永远指向同一个地址。
// WB_PORT 是外部输入：只认 1-65535 的整数，其余一律回退配置值，避免壳与服务各解析各的导致探测错位
const portEnv = Number(process.env.WB_PORT);
const PORT = Number.isInteger(portEnv) && portEnv >= 1 && portEnv <= 65535 ? portEnv : config.port;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let win = null;
let tray = null;
let serverProc = null; // 只有本壳拉起的服务才由本壳回收；复用外部服务时不碰它
let quitting = false;
let hideTipShown = false;

function serviceAlive() {
  // 端口上有任意 HTTP 响应即视为服务在跑（旧版本接口可能没有 /api/stats），复用不重复拉起
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/api/stats`, { timeout: 1500 }, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureService() {
  if (await serviceAlive()) return;
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write(d));
  serverProc.stderr.on('data', d => process.stderr.write(d));
  serverProc.on('exit', code => {
    serverProc = null;
    // 服务中途退出而窗口还开着：响亮报错并退出，不让用户对着白屏干等
    if (!quitting && win && !win.isDestroyed()) {
      dialog.showErrorBox('Token 塔台', `后台服务已退出（code ${code}），应用即将关闭。`);
      app.quit();
    }
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await serviceAlive()) return;
    await sleep(300);
  }
  throw new Error(`后台服务 20 秒内未就绪：${BASE_URL}（见上方服务日志）`);
}

function stopService() {
  if (!serverProc) return;
  // /T 连子进程树一起收（server.js 会周期 spawn git），/F 强制
  spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true });
  serverProc = null;
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.flashFrame(false);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Token 塔台',
    icon: path.join(__dirname, 'app.ico'),
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  // 关窗 ≠ 退出：把窗口藏起来继续在后台监控，首次顺带告诉一声"人在托盘"
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!hideTipShown) {
      hideTipShown = true;
      try {
        tray.displayBalloon({
          icon: path.join(__dirname, 'app.ico'),
          title: 'Token 塔台',
          content: '已缩到托盘，后台继续监控。右键托盘图标可退出。',
        });
      } catch { /* 非 Windows 平台没有气泡，无所谓 */ }
    }
  });
  // 闪任务栏提醒有人等你；用户回到窗口时自动熄灭
  win.on('focus', () => { if (win && !win.isDestroyed()) win.flashFrame(false); });
  win.loadURL(BASE_URL);
}

// 新建/添加项目时选文件夹：原生目录对话框（含"新建文件夹"按钮），取消返回 null
ipcMain.handle('wb-choose-folder', async () => {
  const opts = { properties: ['openDirectory', 'createDirectory'] };
  const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths[0];
});

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示监控台', click: showWindow },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      // 每次弹出都现读状态，菜单外的变化（手动改注册表等）也能如实反映
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => {
        // 开发态下 execPath 是 electron.exe，必须带应用目录参数才能自启出本应用
        app.setLoginItemSettings({ openAtLogin: item.checked, args: app.isPackaged ? [] : [ROOT] });
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'app.ico'));
  tray.setToolTip('Token 塔台 · 开发监控台');
  // 左键弹窗口、右键弹菜单（Windows 托盘的惯例分工），不用 setContextMenu 以免左键也弹菜单
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

// 等待提醒：常驻轮询轻量的 /api/waiting（只有等待中的会话，不含事件流水）。
// 窗口可见时只闪任务栏——页面自己的通知/响铃负责"吵"；窗口缩到托盘后页面提醒
// 靠被节流的后台定时器、任务栏闪烁也没了目标，改由主进程弹原生 toast，
// 点击唤出窗口并高亮对应会话卡片。可见期间出现的等待算"已看过"，不重复打扰。
let lastWaiting = null;
const seenWaiting = new Map(); // 会话 key -> true
let waitingBaseline = false;

function labelOfSession(s) {
  return s.project ? `${s.tool} · ${s.project}` : s.tool;
}

function showWaitingToast(fresh, total) {
  const lines = fresh.slice(0, 3).map(s => `【${labelOfSession(s)}】${s.title || s.file}`);
  if (fresh.length > 3) lines.push(`…共 ${fresh.length} 个`);
  const notif = new Notification({
    title: total > fresh.length ? `${total} 个会话等你确认` : 'agent 等你确认',
    body: lines.join('\n'),
    icon: path.join(__dirname, 'app.ico'),
  });
  notif.on('click', () => {
    showWindow();
    const key = fresh[0] && fresh[0].key;
    if (key && win && !win.isDestroyed()) {
      // 调页面暴露的 highlightSessionByKey，滚到对应卡片并高亮
      win.webContents.executeJavaScript(`highlightSessionByKey(${JSON.stringify(key)})`).catch(() => {});
    }
  });
  notif.show();
}

setInterval(async () => {
  let waiting = [];
  try {
    const res = await fetch(`${BASE_URL}/api/waiting`, { signal: AbortSignal.timeout(3000) });
    waiting = (await res.json()).sessions || [];
  } catch { return; } // 服务暂时不在，下轮再试
  const n = waiting.length;
  const visible = win && !win.isDestroyed() && win.isVisible();
  if (!waitingBaseline) {
    // 首轮只建基线：启动前就在等的会话不算"新等待"
    waitingBaseline = true;
  } else if (!visible) {
    const fresh = waiting.filter(s => !seenWaiting.has(s.key));
    if (fresh.length) showWaitingToast(fresh, n);
  } else if (lastWaiting !== null && n > lastWaiting) {
    win.flashFrame(true);
  }
  for (const s of waiting) seenWaiting.set(s.key, true);
  for (const k of [...seenWaiting.keys()]) {
    if (!waiting.some(s => s.key === k)) seenWaiting.delete(k); // 会话不再等待，解除"已看过"
  }
  if (tray && n !== lastWaiting) {
    tray.setToolTip(n ? `Token 塔台 · ${n} 个会话等你确认` : 'Token 塔台 · 开发监控台');
  }
  lastWaiting = n;
}, 5000);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow); // 重复启动时把已有窗口（包括藏在托盘的）拽出来

  app.whenReady().then(async () => {
    try {
      // Windows 原生 toast 需要显式 AppUserModelId，开发态（未打包）尤其要设
      app.setAppUserModelId('token-tower.monitor');
      await ensureService();
      createTray();
      createWindow();
    } catch (err) {
      dialog.showErrorBox('Token 塔台', '启动失败：' + err.message);
      app.quit();
    }
  });

  app.on('before-quit', () => { quitting = true; stopService(); });
  app.on('window-all-closed', () => app.quit());
}

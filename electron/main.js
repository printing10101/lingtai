// electron/main.js — 桌面壳：把 server.js 装进窗口，双击图标即用，不需要手动开浏览器。
// 约定：端口上已有采集服务在跑（比如终端里 `node server.js`）就直接复用，不再拉第二份 ——
// 两个进程同时 netstat/nvidia-smi 会让看板自己变成显存外的负载来源。
// 定位是「常驻哨兵」：关窗口 = 收进托盘继续盯，托盘菜单才真正退出；
// 托盘轮询 /api/state 时顺带跑一套告警（旁路出现 / 网关掉线 / 幽灵请求 / 空卡满显存 / 换卡风暴）。
'use strict';

const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const ALERTS = Object.assign({ enabled: true, cooldownMin: 10 }, config.alerts || {});
// 历史必须落在不随 exe 重启而变的地方：portable 包每次运行都解压到临时目录，
// 写在那里等于「看板自建历史」这条整个失效。
const histFile = () => path.join(app.getPath('userData'), config.historyDir || 'history', 'samples.jsonl');
const PORT = (() => {
  const v = Number(process.env.LINGTAI_PORT || process.env.MODEL_CONSOLE_PORT);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : (config.serverPort || 8099);
})();
const URL_BASE = 'http://127.0.0.1:' + PORT;

let win = null;
let tray = null;
let serverProc = null; // 只有本壳拉起的服务才由本壳回收
let quitting = false;
let alertsOn = ALERTS.enabled;

function api(pathname, method = 'GET') {
  return new Promise(resolve => {
    const req = http.request(URL_BASE + pathname, { method, timeout: 1200 }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const serviceAlive = () => api('/api/state').then(st => !!st);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 2026-09-27 由「本地模型看板」改名「灵台」：userData 目录随 productName 变了，
// 首次启动把旧目录里的历史账本搬过来，不然「自建历史」从改名那天断档。
function migrateOldUserData() {
  const oldHome = path.join(app.getPath('appData'), '本地模型看板');
  const newHome = app.getPath('userData');
  if (oldHome === newHome || !fs.existsSync(oldHome)) return;
  if (fs.existsSync(path.join(newHome, 'history'))) return; // 新目录已有账，不动
  try {
    fs.cpSync(path.join(oldHome, 'history'), path.join(newHome, 'history'), { recursive: true });
    if (fs.existsSync(path.join(oldHome, 'apps.json'))) {
      fs.copyFileSync(path.join(oldHome, 'apps.json'), path.join(newHome, 'apps.json'));
    }
  } catch (e) {
    console.error('[lingtai] 旧 userData 迁移失败（历史仍在旧目录，未丢失）:', e.message);
  }
}

async function ensureService() {
  if (await serviceAlive()) return;
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LINGTAI_PORT: String(PORT), LINGTAI_HOME: app.getPath('userData') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[server:err] ' + d));
  for (let i = 0; i < 40; i++) {
    if (await serviceAlive()) return;
    await sleep(250);
  }
  throw new Error('采集服务 10 s 内没起来（端口 ' + PORT + ' 被占？看 config.serverPort）');
}

/* ── 告警：只在状态越变时响，同类有冷却，绝不刷屏 ────────────────── */
const alertMem = {
  lastAt: new Map(),   // key -> 上次响的时刻
  strays: 0,
  gateway: null,
  phantom: new Map(),  // id -> 已知次数
  emptyNoisy: false,   // 「空卡但显存高占」一幕只报一次，驻留恢复后重置
  switchMarks: [],     // [ts, 换卡总数] 滑动窗口算换卡风暴
  expRuns: new Map(),  // 实验台：runKey -> 上次见到的状态，越变才响
};

function notify(key, title, body) {
  if (!alertsOn || !Notification.isSupported()) return;
  const now = Date.now();
  if (now - (alertMem.lastAt.get(key) || 0) < ALERTS.cooldownMin * 60000) return;
  alertMem.lastAt.set(key, now);
  const n = new Notification({ title, body, icon: trayIcon() });
  n.on('click', showWindow);
  n.show();
}

function evaluateAlerts(st) {
  // 1) 旁路实例出现（出现比消失要紧：它可能被网关换卡连坐，也可能在偷显存）
  const lp = st.llamaProc || {};
  const strays = lp.strays || [];
  if (strays.length > alertMem.strays) {
    const s0 = strays[0];
    notify('strays', '旁路实例出现：端口 ' + s0.port,
      String((s0.modelFile || '?').split(/[\\/]/).pop()) +
      (s0.parentAlive === false ? '（父进程已退出，孤儿）' : '') +
      (lp.killByImageRisk ? '。' + lp.killByImageRisk : ''));
  }
  alertMem.strays = strays.length;

  // 2) 网关探针 ok → absent（unknown 只是没测到，别狼来了）
  const gw = st.gateway && st.gateway.status;
  if (alertMem.gateway === 'ok' && gw === 'absent') {
    notify('gateway-down', '网关 ' + config.proxyPort + ' 无响应', '健康探针返回连接拒绝 —— 此刻所有调用方都会失败。');
  }
  alertMem.gateway = gw;

  // 3) 幽灵模型被请求：客户端正被静默降级，不报就没人知道
  for (const p of (st.events && st.events.phantom) || []) {
    const prev = alertMem.phantom.get(p.id) || 0;
    if (p.n > prev) notify('phantom:' + p.id, '幽灵请求：' + p.id,
      '注册表和盘上都没有这个模型，网关会静默降级，客户端拿不到报错（窗口内已累计 ' + p.n + ' 次）。');
    alertMem.phantom.set(p.id, p.n);
  }

  // 4) 网关确认空卡，但整卡显存高占 —— 最迷惑的状态组合，值得单独一报
  const g = st.gpu && st.gpu.gpus && st.gpu.gpus[0];
  const residentAbsent = st.resident && st.resident.status === 'absent';
  if (residentAbsent && g && g.totalMiB && g.usedMiB / g.totalMiB > 0.6) {
    if (!alertMem.emptyNoisy) {
      notify('empty-but-full', '网关空着，显存却没下来',
        '整卡已用 ' + Math.round(g.usedMiB / g.totalMiB * 100) + '% —— 那部分不在网关账本里，看「旁路 / 未纳管实例」。');
      alertMem.emptyNoisy = true;
    }
  } else if (!residentAbsent) {
    alertMem.emptyNoisy = false;
  }

  // 5) 换卡风暴：10 min 滑动窗口内累计换卡 ≥3 次（一次正常切换不该响）
  const sw = st.events && st.events.summary && st.events.summary.switches;
  if (Number.isFinite(sw)) {
    const now = Date.now();
    alertMem.switchMarks.push([now, sw]);
    while (alertMem.switchMarks.length && now - alertMem.switchMarks[0][0] > 10 * 60000) alertMem.switchMarks.shift();
    if (alertMem.switchMarks.length && sw - alertMem.switchMarks[0][1] >= 3) {
      notify('swap-storm', '换卡风暴', '最近 10 分钟换卡 ' + (sw - alertMem.switchMarks[0][1]) + ' 次 —— 冷加载在反复吃整卡。');
      alertMem.switchMarks = [[now, sw]]; // 以当下重新起算，别每轮都触发
    }
  }

  // 6) 实验台：run 状态越变才响（完成 / 疑似卡住 / 中断）。
  //    首轮只记基准不报（壳刚起来不该闹），interrupted 只从 running/stalled 掉下来才报 ——
  //    历史残骸不该每次开机都被翻出来示众。
  const exp = st.experiments;
  if (exp && exp.status === 'ok') {
    for (const src of exp.sources || []) {
      for (const r of src.runs || []) {
        const key = src.id + '/' + r.id;
        const prev = alertMem.expRuns.get(key);
        if (prev !== r.status) {
          if (r.status === 'stalled') {
            notify('exp-stall:' + key, '实验疑似卡住：' + r.id,
              '心跳已停 ' + Math.round((r.heartbeatAgeSec || 0) / 60) + ' min 但进程还在 —— 最该看一眼日志尾的时刻。');
          } else if (r.status === 'interrupted' && (prev === 'running' || prev === 'stalled')) {
            notify('exp-dead:' + key, '实验中断：' + r.id,
              '进程没了、没跑到完成、report.md 也不在 —— 需要人工续跑（批处理静默死掉的那种死法）。');
          } else if (r.status === 'done' && (prev === 'running' || prev === 'stalled')) {
            notify('exp-done:' + key, '实验完成：' + r.id,
              'report.md 已落盘' + (src.name ? '（' + src.name + '）' : '') + '。');
          }
          alertMem.expRuns.set(key, r.status);
        }
      }
    }
    // 注册表换掉/实验清空后，旧 key 不许在内存里滚雪球
    if (alertMem.expRuns.size > 500) alertMem.expRuns.clear();
  }
}

/* ── 托盘 ────────────────────────────────────────────────────────── */
function trayIcon() {
  if (!trayIcon.img) trayIcon.img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  return trayIcon.img;
}

let lastMenuKey = '';
function buildTrayMenu(st) {
  const paused = st && st.pausedUntil && new Date(st.pausedUntil) > new Date();
  const key = (paused ? 'p' : 'r') + (alertsOn ? 'a' : 'n');
  if (!tray || key === lastMenuKey) return;
  lastMenuKey = key;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示看板', click: showWindow },
    { type: 'separator' },
    paused
      ? { label: '恢复采集', click: () => api('/api/pause?ms=0', 'POST') }
      : { label: '暂停采集 30 分钟', click: () => api('/api/pause', 'POST') },
    { label: '桌面告警', type: 'checkbox', checked: alertsOn, click: item => { alertsOn = item.checked; lastMenuKey = ''; buildTrayMenu(st); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

async function refreshTray() {
  const st = await api('/api/state');
  if (tray) {
    if (st) {
      const g = st.gpu && st.gpu.gpus && st.gpu.gpus[0];
      tray.setToolTip('灵台\n' + [
        '驻留: ' + (st.resident && st.resident.id ? st.resident.id : (st.resident && st.resident.status === 'absent' ? '空卡' : '未测到')),
        '显存: ' + (g ? Math.round(g.usedMiB) + ' / ' + g.totalMiB + ' MiB' + (g.tempC != null ? ' · ' + g.tempC + '°C' : '') : '未测到'),
        '网关: ' + (st.gateway && st.gateway.status === 'ok' ? '正常' : st.gateway && st.gateway.status === 'absent' ? '无响应' : '未测到'),
      ].join('\n'));
    } else {
      tray.setToolTip('灵台\n采集服务不在运行');
    }
  }
  if (st) evaluateAlerts(st);
  buildTrayMenu(st);
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d11', // 与 style.css 的 --canvas 同值：不一致会在启动瞬间闪一块不同色的底
    title: '灵台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '看板',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: '实验直播（独立大屏）',
          click: () => {
            const w = new BrowserWindow({
              width: 1360, height: 920, minWidth: 900, minHeight: 600,
              backgroundColor: '#0b0d11', title: '实验直播', autoHideMenuBar: true,
              webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
            });
            w.loadURL(URL_BASE + '/experiments');
          },
        },
        {
          label: '总控大屏（看板 + 塔台）',
          click: () => {
            const w = new BrowserWindow({
              width: 1360, height: 920, minWidth: 900, minHeight: 600,
              backgroundColor: '#0b0d11', title: '总控大屏', autoHideMenuBar: true,
              webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
            });
            w.loadURL(URL_BASE + '/master');
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '打开数据',
      submenu: [
        { label: '应用目录（临时解包处，别往这儿放东西）', click: () => shell.openPath(ROOT) },
        { label: '历史与配置目录（真正的落盘点）', click: () => shell.openPath(path.dirname(histFile()).replace(/[\\/]history$/, '')) },
        { label: '自建历史 samples.jsonl', click: () => shell.openPath(histFile()) },
        { label: '事件归档 events.jsonl', click: () => shell.openPath(path.join(path.dirname(histFile()), 'events.jsonl')) },
        { label: '软件注册表 apps.json（启动器）', click: () => { const home = process.env.LINGTAI_HOME || process.env.MODEL_CONSOLE_HOME; shell.openPath(home && fs.existsSync(path.join(home, 'apps.json')) ? path.join(home, 'apps.json') : path.join(ROOT, 'apps.json')); } },
        { label: '网关日志 proxy.log', click: () => shell.openPath(config.proxyLog) },
        { label: '模型注册表 models.json', click: () => shell.openPath(config.registryFile) },
      ],
    },
  ]));
  win.loadURL(URL_BASE);
  // 壳内页面（实验直播等）开新窗仍留在壳里；外链才交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL_BASE)) {
      const w = new BrowserWindow({
        width: 1360, height: 920, minWidth: 900, minHeight: 600,
        backgroundColor: '#0b0d11', title: '实验直播', autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      w.loadURL(url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // 关窗 = 收进托盘继续盯，这是常驻哨兵的本分；真正退出走托盘菜单或应用菜单
  win.on('close', e => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  migrateOldUserData();
  try {
    await ensureService();
  } catch (e) {
    const { dialog } = require('electron');
    dialog.showErrorBox('灵台启动失败', String(e.message || e));
    app.quit();
    return;
  }
  createWindow();
  tray = new Tray(trayIcon());
  tray.on('click', showWindow);
  refreshTray();
  setInterval(refreshTray, 5000).unref();
  app.on('activate', () => showWindow());
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  if (serverProc && !serverProc.killed) { try { serverProc.kill(); } catch (_) {} }
});

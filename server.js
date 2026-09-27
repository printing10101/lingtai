// server.js — 看板的采集与页面服务。纯只读：不写网关任何文件、不发任何会改变模型状态的请求。
// 与 Electron 壳解耦：`node server.js` 就能跑，浏览器开 http://127.0.0.1:8099 与装包后是同一个页面。
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { Collector } = require('./src/collect');
const { Controller } = require('./src/control');
const { createTowerSource } = require('./src/tower');

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
// 历史落盘点必须与"应用文件所在位置"解耦：portable exe 解包到临时目录，
// 写在那里等于每次开机失忆 —— 壳会把 LINGTAI_HOME 指到 userData（旧名 MODEL_CONSOLE_HOME 仍兼容）。
config.historyRoot = process.env.LINGTAI_HOME || process.env.MODEL_CONSOLE_HOME || ROOT;
const PORT = (() => {
  const v = Number(process.env.LINGTAI_PORT || process.env.MODEL_CONSOLE_PORT);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : (config.serverPort || 8099);
})();

const collector = new Collector(config, ROOT).start();
setInterval(() => collector.appendHistory(), 15000).unref();
// 控制层与采集层分开实例化：采集只读，控制层是唯一写入口（见 src/control.js 头注释）
const controller = new Controller(config, ROOT, {
  registryModels: () => collector.getState().registry.models,
}).start();
// 塔台聚合源（总控大屏用）：只读拉塔台的公开 API，塔台没在跑时走 down/stale 三态，不影响其他功能
const towerSource = createTowerSource(config.tower);

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => {
      b += d;
      if (b.length > 1e5) req.destroy();
    });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// /api/ctl/* —— 显式与只读 /api/* 分开的控制面
async function controlRoute(req, res, url) {
  if (!controller.enabled) return json(res, 403, { error: '控制层未启用（config.json control.enabled）' });
  if (req.method !== 'POST') return json(res, 405, { error: '控制端点只收 POST' });
  const body = await readBody(req);
  if (url === '/api/ctl/model/activate') {
    if (!body.model) return json(res, 400, { error: '缺 model' });
    return json(res, 202, await controller.activate(String(body.model)));
  }
  const m = url.match(/^\/api\/ctl\/apps\/([^/]+)\/(start|stop)$/);
  if (!m) return json(res, 404, { error: 'not found: ' + url });
  const [, id, action] = m;
  if (action === 'start') return json(res, 202, await controller.startApp(decodeURIComponent(id), body.model ? String(body.model) : null));
  return json(res, 200, controller.stopApp(decodeURIComponent(id)));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function historyFile() {
  // 与 Collector 完全同一套解析，避免「写在一个地方、读在另一个地方」
  const root = config.historyRoot || ROOT;
  return path.join(root, config.historyDir || 'history', 'samples.jsonl');
}

function readHistory(limit) {
  let raw;
  try { raw = fs.readFileSync(historyFile(), 'utf8'); } catch (_) { return []; }
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-limit);
  return lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// ---------- CSV 导出 ----------
// 给外部分析用（Excel/脚本），所以带 BOM：没有它 Excel 打中文路径/进程名就是乱码。
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvOf(header, rows) {
  return [header, ...rows.map(r => r.map(csvEscape).join(','))].join('\r\n');
}
function samplesCsv(rows) {
  return csvOf('ts,iso,resident,vramUsedMiB,utilPct,tempC,powerW,strays,closedConns,clients',
    rows.map(r => [
      r.ts, new Date(r.ts).toISOString(), r.resident || '', r.vramUsedMiB, r.utilPct,
      r.tempC, r.powerW, r.strays, r.closedConns, (r.clients || []).join('; '),
    ]));
}
function eventsCsv(rows) {
  return csvOf('ts,iso,kind,text', rows.map(e => [e.ts, e.iso, e.kind, e.text]));
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/state') return json(res, 200, { ...collector.getState(), apps: controller.state });
  if (url === '/api/overview') {
    // 总控大屏的数据源：本服务自身的状态直接在进程内取（console 恒为 ok——它就是本服务），
    // 塔台是外部进程，走三态包装（ok/stale/down），两边互不拖累
    const tower = await towerSource.overview();
    return json(res, 200, {
      now: new Date().toISOString(),
      console: { status: 'ok', state: { ...collector.getState(), apps: controller.state } },
      tower,
    });
  }
  if (url.startsWith('/api/ctl/')) return controlRoute(req, res, url);
  if (url === '/api/pause') {
    // 无 ms 参数 = 切换（默认暂停 30 min）；带 ms = 明确设 0..8h，0 即恢复
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    let ms = q.has('ms') ? Number(q.get('ms')) : (collector.isPaused() ? 0 : 30 * 60000);
    if (!Number.isFinite(ms)) ms = 0;
    ms = Math.max(0, Math.min(8 * 3600000, ms));
    return json(res, 200, { pausedUntil: collector.setPause(ms) });
  }
  if (url === '/api/history') {
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const n = Math.min(20000, Math.max(10, Number(q.get('n')) || 2880));
    return json(res, 200, { samples: readHistory(n), note: '看板自建历史，15 s 一条；网关日志满 1 MB 会被整体清空，这份不会' });
  }
  if (url === '/api/export') {
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const what = q.get('what') === 'events' ? 'events' : 'samples';
    const body = '\ufeff' + (what === 'events'
      ? eventsCsv(collector.getMergedEvents(50000))
      : samplesCsv(readHistory(20000)));
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="lingtai-' + what + '-' + new Date().toISOString().slice(0, 10) + '.csv"',
      'cache-control': 'no-store',
    });
    return res.end(body);
  }
  if (url === '/' || url === '/index.html') {
    return fs.readFile(path.join(ROOT, 'public', 'index.html'), (e, b) => {
      if (e) return json(res, 500, { error: 'index.html 缺失: ' + e.message });
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(b);
    });
  }
  if (url === '/experiments' || url === '/live' || url === '/experiments.html') {
    // 实验直播：独立全屏页，只读同一份 /api/state，与主看板互不依赖
    return fs.readFile(path.join(ROOT, 'public', 'experiments.html'), (e, b) => {
      if (e) return json(res, 500, { error: 'experiments.html 缺失: ' + e.message });
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(b);
    });
  }
  if (url === '/master' || url === '/master.html') {
    // 总控大屏：看板自身 + 塔台账本拼成的一屏，数据见 /api/overview
    return fs.readFile(path.join(ROOT, 'public', 'master.html'), (e, b) => {
      if (e) return json(res, 500, { error: 'master.html 缺失: ' + e.message });
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(b);
    });
  }
  const safe = path.normalize(url).replace(/^(\.\.[\\/])+/, '');
  // 前缀比对必须带路径分隔符：不带的话 public-x 这类同名兄弟目录也会被当作 public 放行
  const pub = path.join(ROOT, 'public');
  const file = path.resolve(path.join(pub, safe));
  if ((file !== pub && !file.startsWith(pub + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(res, 404, { error: 'not found: ' + url });
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.on('error', e => {
  console.error('FATAL: cannot listen on', PORT, '-', e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[lingtai] 只读看板 http://127.0.0.1:' + PORT +
    '  观测目标 ' + config.proxyHost + ':' + config.proxyPort + ' / :' + config.upstreamPort +
    '  日志 ' + config.proxyLog);
});

module.exports = { server, collector };

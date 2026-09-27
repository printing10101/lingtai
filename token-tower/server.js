// 个人开发监控台：单进程聚合三类数据源——git 轮询、AI CLI 会话日志监听、hook 事件端点，
// 通过 WebSocket 推给浏览器页面。采集对象是"agent 自己的日志目录"而非项目源码树，
// 这样才能做到真·实时且零噪音（全盘文件监听在 Windows 上既吵又脆）。
// 会话监听不止于"有动静"：从日志尾部解析会话标题、token 消耗、工作/等待状态。
// 聚合统计落盘在 data/stats-daily.json——CLI 会清理自己的旧日志，这里的数据要活得比它们久。
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
// WB_PORT 只为开发/测试临时换端口用，正常启动一律走 config.json；与 electron/main.js 同一套校验
const portEnv = Number(process.env.WB_PORT);
const PORT = Number.isInteger(portEnv) && portEnv >= 1 && portEnv <= 65535 ? portEnv : config.port;

// ---------- 内存状态 ----------
const projects = new Map(); // 规范化路径 -> 项目状态
const sessions = new Map(); // 会话文件路径 -> 会话状态（含标题、token、阶段）
let events = [];            // 最新在前，封顶 500 条；落盘在 data/events.ndjson

// ---------- 基础工具 ----------
function normalizePath(p) {
  return path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

// 统计按"本地日"分桶（用户问"今天用了多少"指的是本地今天），与 byHour 的本地小时一致
function localDayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function addEvent(ev) {
  const item = { ts: new Date().toISOString(), ...ev };
  events.unshift(item);
  if (events.length > 500) events.length = 500;
  try {
    fs.appendFileSync(path.join(ROOT, 'data', 'events.ndjson'), JSON.stringify(item) + '\n');
  } catch (err) {
    console.error('[tower] 事件落盘失败:', err.message);
  }
  recordEventToWarehouse(item);
  scheduleBroadcast();
  return item;
}

function loadHistory() {
  const file = path.join(ROOT, 'data', 'events.ndjson');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  events = lines.slice(-500).reverse()
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  // 文件只追加会无限膨胀，启动时截回保留下来的尾部（此时尚无监听器在写，不会竞态）
  if (lines.length > 500) {
    const keep = [...events].reverse().map(e => JSON.stringify(e)).join('\n') + '\n';
    try { fs.writeFileSync(file, keep); } catch (err) { console.error('[tower] 事件文件截断失败:', err.message); }
  }
}

// ---------- 统计仓库 ----------
// 每日/每项目的活动与 token 聚合。事件明细只留 500 条，长程记忆全靠这里。
// files 是"台账"：每个源文件已入账的累计 token。所有入账路径（实时监听、重启补扫、
// 归档收割）都对着台账补差额——文件被 Codex 归档移动、服务重启，都不会重复计数。
const warehouse = { days: new Map(), projects: new Map(), files: new Map(), localModels: {}, llamaLogs: {} };

function loadWarehouse() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stats-daily.json'), 'utf8'));
    warehouse.days = new Map(Object.entries(raw.days || {}));
    warehouse.projects = new Map(Object.entries(raw.projects || {}));
    warehouse.files = new Map(Object.entries(raw.files || {}));
    warehouse.localModels = raw.localModels || {}; // 模型 -> 本机推理端点 host:port
    warehouse.llamaLogs = raw.llamaLogs || {};     // llama 日志文件 -> { run, size } 运行识别元数据
    // 老版本的日分桶缺后来加的字段（tokByTool 是 09-17 才有的，tokensCw 更晚），
    // 向老日期补账时会撞 undefined，加载时统一补全形状
    for (const d of warehouse.days.values()) {
      d.events = d.events || 0;
      d.tokensIn = d.tokensIn || 0;
      d.tokensOut = d.tokensOut || 0;
      d.tokensCr = d.tokensCr || 0;
      d.tokensCw = d.tokensCw || 0;
      d.tokByTool = d.tokByTool || {};
      d.tokByToolModel = d.tokByToolModel || {};
      d.creditsByTool = d.creditsByTool || {};
      d.byTool = d.byTool || {};
      d.byHour = Array.isArray(d.byHour) ? d.byHour : new Array(24).fill(0);
    }
    for (const p of warehouse.projects.values()) p.credits = p.credits || 0;
  } catch { /* 首次启动还没有统计文件，正常 */ }
}

function warehouseDay(dateKey) {
  let d = warehouse.days.get(dateKey);
  if (!d) {
    d = { events: 0, tokensIn: 0, tokensOut: 0, tokensCr: 0, tokensCw: 0, tokByTool: {}, tokByToolModel: {}, creditsByTool: {}, byTool: {}, byHour: new Array(24).fill(0) };
    warehouse.days.set(dateKey, d);
  }
  return d;
}

function warehouseProject(name) {
  let p = warehouse.projects.get(name);
  if (!p) {
    p = { events: 0, tokensIn: 0, tokensOut: 0, tokensCr: 0, tokensCw: 0, credits: 0, lastActive: 0 };
    warehouse.projects.set(name, p);
  }
  return p;
}

function recordEventToWarehouse(ev) {
  const now = new Date();
  const day = warehouseDay(localDayKey(now));
  day.events += 1;
  day.byTool[ev.tool] = (day.byTool[ev.tool] || 0) + 1;
  day.byHour[now.getHours()] += 1;
  if (ev.project) {
    const p = warehouseProject(ev.project);
    p.events += 1;
    p.lastActive = Date.now();
  }
  saveWarehouseSoon();
}

// tokens 是增量（这次新消耗的），project 是展示名，tool 用于分工具统计，model 用于分模型统计；
// dayKey 是入账日（补历史数据时落到事件真实发生的日子），不传就是今天；
// 未知归属时只记全局。tokens.credits 是另一套口径（Qoder 官方抹掉了 token 数、只给 credits），
// 与 in/out/cr/cw 并存但绝不混进 token 累计，前端单独一行显示。
function recordTokens(tokens, project, tool, model, dayKey) {
  if (!tokens || (!tokens.in && !tokens.out && !tokens.cr && !tokens.cw && !tokens.credits)) return;
  const day = warehouseDay(dayKey || localDayKey());
  day.tokensIn += tokens.in || 0;
  day.tokensOut += tokens.out || 0;
  day.tokensCr += tokens.cr || 0;
  day.tokensCw += tokens.cw || 0;
  if (tool) {
    const t = day.tokByTool[tool] || (day.tokByTool[tool] = { in: 0, out: 0, cr: 0, cw: 0 });
    t.in += tokens.in || 0;
    t.out += tokens.out || 0;
    t.cr += tokens.cr || 0;
    t.cw += tokens.cw || 0;
  }
  if (tool && tokens.credits) {
    const c = day.creditsByTool || (day.creditsByTool = {});
    c[tool] = (c[tool] || 0) + tokens.credits;
  }
  if (tool && model) {
    const byToolModel = day.tokByToolModel || (day.tokByToolModel = {});
    const byModel = byToolModel[tool] || (byToolModel[tool] = {});
    const m = byModel[model] || (byModel[model] = { in: 0, out: 0, cr: 0, cw: 0 });
    m.in += tokens.in || 0;
    m.out += tokens.out || 0;
    m.cr += tokens.cr || 0;
    m.cw += tokens.cw || 0;
  }
  if (project) {
    const p = warehouseProject(project);
    p.tokensIn += tokens.in || 0;
    p.tokensOut += tokens.out || 0;
    p.tokensCr += tokens.cr || 0;
    p.tokensCw += tokens.cw || 0;
    p.credits = (p.credits || 0) + (tokens.credits || 0);
    p.lastActive = Date.now();
  }
  saveWarehouseSoon();
}

// ---------- token 台账 ----------
// 台账按源文件名记账。Qoder 的会话文件名是 <uuid>.jsonl，与 Claude 的同形，光看文件名分不出
// 归属，所以新入账把 tool 一起写进台账；没有 tool 的旧条目仍按文件名启发式归类。
function ledgerFor(name, tool) {
  let f = warehouse.files.get(name);
  if (!f) {
    f = { in: 0, out: 0, cr: 0, cw: 0, credits: 0 };
    warehouse.files.set(name, f);
  }
  if (tool) f.tool = tool;
  return f;
}

// 日志里读到的累计值（codex 的 total_token_usage、claude/qoder 全文件求和）对着台账补差额；
// dayKey 供 trace 补账把历史用量落到真实日期
function bankCumulative(name, cum, project, tool, model, dayKey) {
  if (!cum) return;
  const led = ledgerFor(name, tool);
  const inc = {
    in: Math.max(0, (cum.in || 0) - led.in),
    out: Math.max(0, (cum.out || 0) - led.out),
    cr: Math.max(0, (cum.cr || 0) - led.cr),
    cw: Math.max(0, (cum.cw || 0) - led.cw),
    credits: Math.max(0, (cum.credits || 0) - (led.credits || 0)),
  };
  led.in = Math.max(led.in, cum.in || 0);
  led.out = Math.max(led.out, cum.out || 0);
  led.cr = Math.max(led.cr, cum.cr || 0);
  led.cw = Math.max(led.cw, cum.cw || 0);
  led.credits = Math.max(led.credits || 0, cum.credits || 0);
  recordTokens(inc, project, tool, model, dayKey);
}

// 增量日志（codex 的每条消息用量）直接累加入账。
// 同时写进台账的日记账：按日分桶补账（bankByDay）看的是 led.days，实时增量不落这里，
// 下次全量补账就会把实时已经记过的量按天再补一遍。
function bankIncremental(name, inc, project, tool, model) {
  if (!inc) return;
  const led = ledgerFor(name, tool);
  led.in += inc.in || 0;
  led.out += inc.out || 0;
  led.cr += inc.cr || 0;
  led.cw += inc.cw || 0;
  led.credits = (led.credits || 0) + (inc.credits || 0);
  const booked = led.days || (led.days = {});
  const dk = localDayKey();
  const b = booked[dk] || (booked[dk] = { in: 0, out: 0, cr: 0, cw: 0, credits: 0 });
  b.in += inc.in || 0;
  b.out += inc.out || 0;
  b.cr += inc.cr || 0;
  b.cw += inc.cw || 0;
  b.credits += inc.credits || 0;
  recordTokens(inc, project, tool, model);
}

// 按日分桶入账（qoder 全文件补账、claude 全文件补账、zcode 的 usage DB 对账）：
// 台账记下每个日期已入的累计，重扫/重启只补差额，且历史用量落到事件真实发生的那天，
// 而不是全砸在重启当天。byDay 各日是 { in, out, cr, cw, credits } 的累计目标，缺的字段按 0。
function bankByDay(name, byDay, project, tool, model) {
  if (!byDay) return;
  const led = ledgerFor(name, tool);
  const booked = led.days || (led.days = {});
  for (const [dk, v] of Object.entries(byDay)) {
    const prev = booked[dk] || (booked[dk] = { in: 0, out: 0, cr: 0, cw: 0, credits: 0 });
    const inc = {
      in: Math.max(0, (v.in || 0) - (prev.in || 0)),
      out: Math.max(0, (v.out || 0) - (prev.out || 0)),
      cr: Math.max(0, (v.cr || 0) - (prev.cr || 0)),
      cw: Math.max(0, (v.cw || 0) - (prev.cw || 0)),
      credits: Math.max(0, (v.credits || 0) - (prev.credits || 0)),
    };
    if (!inc.in && !inc.out && !inc.cr && !inc.cw && !inc.credits) continue;
    prev.in += inc.in;
    prev.out += inc.out;
    prev.cr += inc.cr;
    prev.cw += inc.cw;
    prev.credits += inc.credits;
    recordTokens(inc, project, tool, model, dk);
  }
  // 该文件的累计取各日已入账之和，保证 ledgerByTool 的分工具累计与日分桶口径一致
  const sum = f => { let t = 0; for (const v of Object.values(booked)) t += v[f] || 0; return t; };
  led.in = Math.max(led.in || 0, sum('in'));
  led.out = Math.max(led.out || 0, sum('out'));
  led.cr = Math.max(led.cr || 0, sum('cr'));
  led.cw = Math.max(led.cw || 0, sum('cw'));
  led.credits = Math.max(led.credits || 0, sum('credits'));
}

let warehouseTimer = null;
function saveWarehouseSoon() {
  if (warehouseTimer) return; // 5 秒合并写一次，统计不需要实时落盘
  warehouseTimer = setTimeout(() => {
    warehouseTimer = null;
    const dump = {
      days: Object.fromEntries(warehouse.days),
      projects: Object.fromEntries(warehouse.projects),
      files: Object.fromEntries(warehouse.files),
      localModels: warehouse.localModels || {},
      llamaLogs: warehouse.llamaLogs || {},
    };
    writeFileAtomic(path.join(ROOT, 'data', 'stats-daily.json'), JSON.stringify(dump), () => {});
  }, 5000);
}

// 小文件的原子写入：先写 .tmp 再改名。写一半崩溃/断电不会留下残废 JSON——
// 台账一丢历史 token 就再也补不回来，这类文件都值得走这条路径
function writeFileAtomic(file, text, cb) {
  const tmp = file + '.tmp';
  fs.writeFile(tmp, text, err => {
    if (err) return cb && cb(err);
    fs.rename(tmp, file, err2 => cb && cb(err2));
  });
}

// ---------- 工具清单：电脑上有哪些编程工具、各花了多少 token ----------
// 纳管工具的累计 token 从台账按文件名归类：zcode-db:* 是 zcode（usage DB 对账）、
// rollout-* 是 codex、trace_* 是 workbuddy、hermes:* 是 hermes、其余 jsonl 是 claude 的会话记录。
// zcode 旧日的 model-io-* 键已折抵进 zcode-db:*（见 pollZcodeDb），不再参与归类。
// CLI 会删自己的日志，台账不会，所以归类出的累计是完整历史——工具卸载后台账还在，
// 工具卡片照样显示历史用量。
// probe 是家目录下的安装标志：卸载后目录消失，installed=false，但统计原样保留。
// tokenKind 标明该工具的 token 数从哪来：缺省 'usage' = 日志直接给了 in/out；
// 'context' = 官方把 in/out 抹成 0，只报 context_usage_ratio，token 数按 ratio×contextWindow
// 的净增量算（真实流经的上下文体量，含模型输出与工具回读，官方未分列），卡片上要标口径。
const TOOL_META = [
  { tool: 'zcode', name: 'ZCode', level: 'token', probe: '.zcode' },
  { tool: 'codex', name: 'Codex', level: 'token', probe: '.codex' },
  { tool: 'claude', name: 'Claude Code', level: 'token', probe: '.claude' },
  { tool: 'workbuddy', name: 'WorkBuddy', level: 'token', probe: '.workbuddy' },
  { tool: 'qoder', name: 'Qoder CLI', level: 'token', probe: '.qoder', tokenKind: 'context' },
  // Hermes 的账本在 state.db（SQLite），不走 sessionDirs 文件监听，由 usageDbs 轮询入账；
  // 探测路径带子目录，path.join 家目录后即安装目录
  { tool: 'hermes', name: 'Hermes', level: 'token', probe: 'AppData/Local/hermes' },
  { tool: 'dsh', name: 'dsh', level: 'activity', probe: '.dsh' },
  // llama.cpp 直连：账本在 model-proxy 拉起的 llama-server 日志里（config.llamaLogDirs），
  // 不探测安装——没配 llamaLogDirs 的机器不出这张卡。token 是直连净额口径（展示层扣掉
  // hermes 名下已入账的本地请求），见 statsPayload 的 llamaNetForDay
  { tool: 'llamacpp', name: '本地直连(llama.cpp)', level: 'token' },
  // 未纳管的已知工具：只探测安装目录提示"已安装"，本地没有可统计的用量记录
  // LM Studio 也是本机推理器，但它的 API 调用不落任何本地用量记录，无法统计
  { tool: 'lmstudio', name: 'LM Studio', level: 'none', probe: '.lmstudio' },
  { tool: 'trae', name: 'Trae', level: 'none', probe: '.trae-cn' },
  { tool: 'codebuddy', name: 'CodeBuddy', level: 'none', probe: '.codebuddy' },
  { tool: 'copilot', name: 'Copilot CLI', level: 'none', probe: '.copilot' },
  { tool: 'gemini', name: 'Gemini CLI', level: 'none', probe: '.gemini' },
  { tool: 'cursor', name: 'Cursor', level: 'none', probe: '.cursor' },
  // 2026-09-23 复核：Grok Bot（Electron 桌面 bot + 本地执行守护）会话与用量全在服务端，
  // 本地只有设置、daemon 日志与登录身份；小米 MiMo 的三个库（rolechat/session-review/artifacts）
  // 均无 token 列，mimocode/llm-server 下只有推理端口注册与鉴权 token
  { tool: 'grokbot', name: 'Grok Bot', level: 'none', probe: '.grokbot' },
  { tool: 'mimo', name: 'Xiaomi MiMo', level: 'none', probe: 'AppData/Roaming/Xiaomi MiMo' },
  // CC Switch 有意不列：它的 proxy_request_logs（data_source=codex_session）是 Codex 会话日志的
  // 二手台账，塔台已在 codex 名下按 token 计量同一批 rollout 文件，接入即重复记账
];

const TOKEN_TOOLS = new Set(TOOL_META.filter(m => m.level === 'token').map(m => m.tool));

function ledgerToolOf(file, led) {
  if (led && led.tool) return led.tool; // 新台账条目自带归属，Qoder 与 Claude 的 <uuid>.jsonl 才分得开
  if (/^rollout-/.test(file)) return 'codex';
  if (/^trace_/.test(file)) return 'workbuddy';
  if (/^llama:/.test(file)) return 'llamacpp';
  return 'claude';
}

function buildToolsSummary(weekKeys, dayByKey, ledgerByTool, ledgerCreditsByTool, costOf) {
  const zero = { in: 0, out: 0, cr: 0, cw: 0 };
  const credByToolOf = keys => {
    const out = {};
    for (const k of keys) {
      const d = dayByKey.get(k);
      if (!d || !d.creditsByTool) continue;
      for (const [tool, c] of Object.entries(d.creditsByTool)) out[tool] = (out[tool] || 0) + c;
    }
    return out;
  };
  const home = os.homedir();
  const isInstalled = m => !m.probe || fs.existsSync(path.join(home, m.probe));
  const list = [];
  for (const m of TOOL_META) {
    if (m.level === 'none') {
      if (fs.existsSync(path.join(home, m.probe))) list.push({ tool: m.tool, name: m.name, level: m.level, installed: true });
      continue;
    }
    const entry = { tool: m.tool, name: m.name, level: m.level, monitored: true, installed: isInstalled(m) };
    if (m.level === 'token') {
      // llamacpp 展示直连净额：日分桶是毛额（含 hermes 已入账的本地请求），每天现扣；
      // 累计也从日分桶现算而不是台账——台账的 llama:* 键是毛额。其余工具毛额即净额。
      const isLlama = m.tool === 'llamacpp';
      const bucketOf = isLlama ? llamaToolBucketOf : (d => (d.tokByTool || {})[m.tool] || null);
      const modelsOf = isLlama ? llamaNetForDay : (d => (d.tokByToolModel || {})[m.tool] || null);
      const sumBuckets = keys => {
        const b = { ...zero };
        for (const k of keys) {
          const d = dayByKey.get(k);
          const u = d && bucketOf(d);
          if (!u) continue;
          b.in += u.in || 0; b.out += u.out || 0; b.cr += u.cr || 0; b.cw += u.cw || 0;
        }
        return b;
      };
      const all = isLlama ? sumBuckets([...warehouse.days.keys()]) : (ledgerByTool[m.tool] || { ...zero });
      entry.tokens = {
        all,
        today: sumBuckets([weekKeys[0]]),
        week: sumBuckets(weekKeys),
      };
      // tokenKind='context' 的工具：token 数来自上下文占比推算，另给一行真实 credits
      if (m.tokenKind) entry.tokenKind = m.tokenKind;
      const credAll = ledgerCreditsByTool[m.tool] || 0;
      const credToday = credByToolOf([weekKeys[0]])[m.tool] || 0;
      const credWeek = credByToolOf(weekKeys)[m.tool] || 0;
      if (credAll || credToday || credWeek) entry.credits = { all: credAll, today: credToday, week: credWeek };
      // 分模型累计（自分模型入账起）：日分桶按天求和，旧数据没有模型归属
      const models = {};
      for (const d of warehouse.days.values()) {
        const mm = modelsOf(d);
        if (!mm) continue;
        for (const [name, u] of Object.entries(mm)) {
          const b = models[name] || (models[name] = { in: 0, out: 0, cr: 0, cw: 0 });
          b.in += u.in || 0; b.out += u.out || 0; b.cr += u.cr || 0; b.cw += u.cw || 0;
        }
      }
      if (Object.keys(models).length) entry.models = models;
      if (costOf) entry.cost = costOf({ [m.tool]: all });
    } else {
      let ev = 0;
      for (const d of warehouse.days.values()) ev += (d.byTool && d.byTool[m.tool]) || 0;
      entry.events = ev;
    }
    list.push(entry);
  }
  return list;
}

// llamacpp 的日分桶是毛额：model-proxy 的 llama-server 日志包含所有直连请求，其中 Hermes
// 那部分已在 hermes 名下入过账（它的行带 base_url，已标成本地模型）。展示层在这里按
// 「模型 × 当日」减去 hermes 已入账的同模型用量，净额 = dsh / 运动平台等直连方的流量。
// 展示时现算而不是入账时扣：hermes 的轮询晚到一轮也会自动校正，台账本身不动、无需回写。
// hermes 若真用远端 API 跑了同名模型（这些别名只存在于本机 llama.cpp），扣减才会误伤，实际不会发生。
function llamaNetForDay(d) {
  const lm = d.tokByToolModel && d.tokByToolModel.llamacpp;
  if (!lm) return null;
  const hermes = (d.tokByToolModel && d.tokByToolModel.hermes) || {};
  const net = {};
  for (const [model, u] of Object.entries(lm)) {
    const h = hermes[model] || {};
    net[model] = {
      in: Math.max(0, (u.in || 0) - (h.in || 0)),
      out: Math.max(0, (u.out || 0) - (h.out || 0)),
      cr: Math.max(0, (u.cr || 0) - (h.cr || 0)),
      cw: Math.max(0, (u.cw || 0) - (h.cw || 0)),
    };
  }
  return net;
}

// 某天 llamacpp 的净额工具桶（按模型求和），没入账过就是 null
function llamaToolBucketOf(d) {
  const net = llamaNetForDay(d);
  if (!net) return null;
  const b = { in: 0, out: 0, cr: 0, cw: 0 };
  for (const u of Object.values(net)) {
    b.in += u.in; b.out += u.out; b.cr += u.cr; b.cw += u.cw;
  }
  return b;
}

// llamacpp 当天净额与毛额的差值：全机 token 总量、日热力图都直接累加日分桶（毛额），
// 减去 hermes 已入账部分后才是真实增量。llamacpp 没入账过时差值为 0。
function llamaDayDelta(d) {
  const lb = (d.tokByTool || {}).llamacpp;
  const net = llamaNetForDay(d);
  if (!lb || !net) return { in: 0, out: 0, cr: 0 };
  const n = { in: 0, out: 0, cr: 0 };
  for (const u of Object.values(net)) {
    n.in += u.in; n.out += u.out; n.cr += u.cr;
  }
  return { in: n.in - (lb.in || 0), out: n.out - (lb.out || 0), cr: n.cr - (lb.cr || 0) };
}

// ---------- 离线期间盘点（away report）----------
// 塔台关着的时候，各 CLI 照样烧 token；各数据源的重启补账会把这些用量补进台账，
// 但"补进来的属于哪个时段"没有专门呈现。心跳快照补上这一环：运行期间定期把
// 全机分工具累计落一小份到 data/heartbeat.json，下次启动读它当基线，两个快照一减
// 就是离线期间的消耗。启动补账陆陆续续落账，差额在 90 秒核对窗内自动长大，随后定格
// ——定格之后新烧的 token 属于在线时段，不能再算进"离线期间"。
const HEARTBEAT_FILE = path.join(ROOT, 'data', 'heartbeat.json');
const AWAY_SETTLE_MS = 90000;
const startedAt = new Date();
let awayBaseline = null; // 上次运行最后一跳：{ ts, byTool }
let awayFrozen = null;   // 核对窗结束后的定格报告，此后 snapshot 只回这一份

// 全机分工具累计（展示口径）：llamacpp 取当日净额（扣 hermes 已入账的部分），
// 其余工具取日分桶。心跳快照与离线差额必须用同一把尺子，减出来的差值才成立。
function byToolTotals() {
  const out = {};
  for (const d of warehouse.days.values()) {
    const llamaNet = llamaToolBucketOf(d);
    for (const [tool, u] of Object.entries(d.tokByTool || {})) {
      const src = tool === 'llamacpp' ? llamaNet : u;
      if (!src) continue;
      const b = out[tool] || (out[tool] = { in: 0, out: 0, cr: 0, cw: 0 });
      b.in += src.in || 0; b.out += src.out || 0; b.cr += src.cr || 0; b.cw += src.cw || 0;
    }
  }
  return out;
}

function parseHeartbeat(text, nowMs) {
  let hb = null;
  try { hb = JSON.parse(text); } catch { return null; }
  const ts = hb && Date.parse(hb.ts);
  if (!hb || !hb.byTool || typeof hb.byTool !== 'object' || !Number.isFinite(ts)) return null;
  if (ts > (nowMs || Date.now()) + 5 * 60000) return null; // 时钟漂到未来的一跳不可信
  return hb;
}

function readHeartbeat() {
  try { return parseHeartbeat(fs.readFileSync(HEARTBEAT_FILE, 'utf8')); } catch { return null; }
}

// 退出路径也要能写，所以用同步原子写；文件只有几百字节，不心疼
function writeHeartbeat() {
  try {
    const tmp = HEARTBEAT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), byTool: byToolTotals() }));
    fs.renameSync(tmp, HEARTBEAT_FILE);
  } catch (err) {
    console.error('[tower] 心跳落盘失败:', err.message);
  }
}

// 离线差额 = 当前累计 − 基线，逐字段钳非负：台账只会涨，负数只可能是基线口径比当前新
// （手动回拨时钟之类），宁可少报不多报。纯函数，自检直接喂夹具。
function awayDeltaOf(baseByTool, nowByTool) {
  const byTool = {};
  const total = { in: 0, out: 0, cr: 0, cw: 0 };
  for (const [tool, cur] of Object.entries(nowByTool || {})) {
    const base = (baseByTool || {})[tool] || {};
    const d = {
      in: Math.max(0, (cur.in || 0) - (base.in || 0)),
      out: Math.max(0, (cur.out || 0) - (base.out || 0)),
      cr: Math.max(0, (cur.cr || 0) - (base.cr || 0)),
      cw: Math.max(0, (cur.cw || 0) - (base.cw || 0)),
    };
    if (!d.in && !d.out && !d.cr && !d.cw) continue;
    byTool[tool] = d;
    total.in += d.in; total.out += d.out; total.cr += d.cr; total.cw += d.cw;
  }
  return { total, byTool };
}

// 核对窗内的实时视图：数值随补账长大，窗口标"基线 → 本轮启动"；定格后 snapshot 只回 awayFrozen
function awayLive() {
  if (!awayBaseline) return null;
  return {
    since: awayBaseline.ts,
    until: startedAt.toISOString(),
    ms: Math.max(0, startedAt - Date.parse(awayBaseline.ts)),
    settled: false,
    ...awayDeltaOf(awayBaseline.byTool, byToolTotals()),
  };
}

function freezeAway() {
  const report = awayLive();
  if (!report) return;
  report.until = new Date().toISOString();
  report.ms = Math.max(0, Date.parse(report.until) - Date.parse(report.since));
  report.settled = true;
  awayFrozen = report;
  const tot = report.total.in + report.total.out;
  // 时间线报一条，让"不在场也有账"这件事自己说话；阈值卡住短重启与零头用量，别刷屏
  if (report.ms >= 30 * 60000 && tot >= 1000) {
    const wan = n => n >= 1e8 ? (n / 1e8).toFixed(1) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : String(Math.round(n));
    const hours = report.ms / 3600000;
    const dur = hours >= 48 ? Math.floor(hours / 24) + ' 天' : hours.toFixed(1) + ' 小时';
    const parts = Object.entries(report.byTool)
      .sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out))
      .map(([t, u]) => `${t} ${wan(u.in + u.out)}`);
    addEvent({ tool: 'tower', kind: 'away', detail: `离线 ${dur}，全机消耗 ${wan(tot)} tok（${parts.join(' · ')}）` });
  }
}

function statsPayload() {
  const days = [...warehouse.days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-366)
    .map(([date, d]) => {
      const dl = llamaDayDelta(d); // 扣掉 llamacpp 毛额里 hermes 已入账的部分
      return {
        date, events: d.events,
        tokensIn: d.tokensIn + dl.in, tokensOut: d.tokensOut + dl.out, tokensCr: (d.tokensCr || 0) + dl.cr,
        byHour: d.byHour,
      };
    });
  const hiddenNames = hiddenProjectNames();
  const projs = [...warehouse.projects.entries()]
    .map(([name, p]) => ({ name, events: p.events, tokensIn: p.tokensIn, tokensOut: p.tokensOut, tokensCr: p.tokensCr, credits: p.credits || 0, lastActive: p.lastActive }))
    .filter(p => !hiddenNames.has(p.name)) // 被隐藏的项目不再出现在统计表，但台账数据原样保留
    .sort((a, b) => b.events - a.events);

  // 全机用量：今日 / 近 7 天 / 累计（累计不截断，天数多了也完整）
  const localModels = warehouse.localModels || {}; // 本地模型集合：模型 -> 本机推理端点
  const sum = list => {
    const t = { in: 0, out: 0, cr: 0, byTool: {}, byModel: {} };
    for (const d of list) {
      const dl = llamaDayDelta(d);
      t.in += d.tokensIn + dl.in; t.out += d.tokensOut + dl.out; t.cr += (d.tokensCr || 0) + dl.cr;
      const llamaNet = llamaNetForDay(d) || {};
      for (const [tool, u] of Object.entries(d.tokByTool || {})) {
        const b = t.byTool[tool] || (t.byTool[tool] = { in: 0, out: 0, cr: 0, cw: 0 });
        if (tool === 'llamacpp') {
          // 展示口径用直连净额，毛额里 hermes 的部分已在 hermes 名下计过
          for (const net of Object.values(llamaNet)) {
            b.in += net.in; b.out += net.out; b.cr += net.cr; b.cw += net.cw;
          }
          continue;
        }
        b.in += u.in || 0; b.out += u.out || 0; b.cr += u.cr || 0; b.cw += u.cw || 0;
      }
      for (const [tool, models] of Object.entries(d.tokByToolModel || {})) {
        for (const [model, u] of Object.entries(models)) {
          const eff = tool === 'llamacpp' ? (llamaNet[model] || u) : u;
          const b = t.byModel[model] || (t.byModel[model] = { in: 0, out: 0, cr: 0, cw: 0 });
          b.in += eff.in || 0; b.out += eff.out || 0; b.cr += eff.cr || 0; b.cw += eff.cw || 0;
          // 本地模型用量单列：跑在本机 GPU 上的 token 不花钱，但最能反映"本地算力用了多少"
          if (localModels[model]) t.local = (t.local || 0) + (eff.in || 0) + (eff.out || 0);
        }
      }
    }
    return t;
  };
  const byKey = new Map(warehouse.days.entries());
  const weekKeys = [];
  for (let i = 0; i < 7; i++) weekKeys.push(localDayKey(new Date(Date.now() - i * 86400000)));
  const totals = {
    today: sum(weekKeys.slice(0, 1).map(k => byKey.get(k)).filter(Boolean)),
    week: sum(weekKeys.map(k => byKey.get(k)).filter(Boolean)),
    all: sum(warehouse.days.values()),
  };
  // 累计档的分工具占比用台账归类补全：日分桶的 tokByTool 是修复后才有的，
  // 台账从第一天就按文件记账，能给出完整历史的分工具归属。
  // model-io-*（zcode 的日志时代台账）除外：那些账已按会话折抵进 zcode-db:* 键
  // （见 pollZcodeDb），再算一次就是重复累计。
  const ledgerByTool = {};
  const ledgerCreditsByTool = {};
  for (const [file, led] of warehouse.files) {
    if (/^model-io-/.test(file)) continue;
    const t = ledgerToolOf(file, led);
    const b = ledgerByTool[t] || (ledgerByTool[t] = { in: 0, out: 0, cr: 0, cw: 0 });
    b.in += led.in || 0; b.out += led.out || 0; b.cr += led.cr || 0; b.cw += led.cw || 0;
    if (led.credits) ledgerCreditsByTool[t] = (ledgerCreditsByTool[t] || 0) + led.credits;
  }
  totals.all.byTool = ledgerByTool;
  // llamacpp 的累计覆盖为直连净额：台账（llama:* 键）是毛额，含 hermes 已入账的本地请求
  const llamaNetAll = { in: 0, out: 0, cr: 0, cw: 0 };
  let hasLlama = false;
  for (const d of warehouse.days.values()) {
    const b = llamaToolBucketOf(d);
    if (!b) continue;
    hasLlama = true;
    llamaNetAll.in += b.in; llamaNetAll.out += b.out; llamaNetAll.cr += b.cr; llamaNetAll.cw += b.cw;
  }
  if (hasLlama) ledgerByTool.llamacpp = llamaNetAll;
  // 全机 credits 合计（Qoder 这类只报 credits 的工具）：与 token 分开，单独一个字段
  const creditsAll = {};
  for (const d of warehouse.days.values()) {
    for (const [t, c] of Object.entries(d.creditsByTool || {})) creditsAll[t] = (creditsAll[t] || 0) + c;
  }
  if (Object.keys(creditsAll).length) {
    totals.credits = creditsAll;
    totals.creditsToday = (() => {
      const d = byKey.get(weekKeys[0]);
      return d ? { ...(d.creditsByTool || {}) } : {};
    })();
  }
  // 成本估算：pricing 按"每百万 token 单价"配置（config.json），没配或全 0 就不输出
  const pricing = config.pricing || {};
  const hasPricing = Object.entries(pricing).some(([k, p]) =>
    k !== 'currency' && p && typeof p === 'object' && Object.values(p).some(v => v > 0));
  const costOf = byTool => {
    let cost = 0;
    for (const [tool, u] of Object.entries(byTool)) {
      const p = pricing[tool];
      if (!p || typeof p !== 'object') continue;
      cost += ((u.in || 0) * (p.in || 0) + (u.out || 0) * (p.out || 0) + (u.cr || 0) * (p.cr || 0) + (u.cw || 0) * (p.cw || 0)) / 1e6;
    }
    return Math.round(cost * 100) / 100;
  };
  if (hasPricing) {
    totals.currency = pricing.currency || '$';
    for (const k of ['today', 'week', 'all']) totals[k].cost = costOf(totals[k].byTool);
  }
  // 日预算线：config.json 里配了 budget.dailyTokens / budget.dailyCost 才输出，前端据此标红与提醒
  const budget = config.budget || {};
  if (budget.dailyTokens || budget.dailyCost) {
    totals.budget = { dailyTokens: budget.dailyTokens || null, dailyCost: budget.dailyCost || null };
  }
  return { now: new Date().toISOString(), totals, localModels, tools: buildToolsSummary(weekKeys, byKey, ledgerByTool, ledgerCreditsByTool, hasPricing ? costOf : null), days, projects: projs };
}

// ---------- 项目发现与 git 轮询 ----------
const DIRTY_EVENT_INTERVAL = 600000; // 未提交数的变化在 10 分钟内合并成一条事件，agent 干活时别让 git 抖动刷屏

// ---------- 项目隐藏（用户管理） ----------
// 自动扫描出来的项目不都是"在开发的项目"。隐藏 = 不再发现、不再轮询 git、面板与统计表不再展示，
// 但已入账的统计与台账原样保留，随时可恢复。列表落盘在 data/hidden-projects.json。
const hiddenFile = path.join(ROOT, 'data', 'hidden-projects.json');
const hiddenProjects = new Map(); // 规范化路径 -> 展示名

function loadHiddenProjects() {
  try {
    const arr = JSON.parse(fs.readFileSync(hiddenFile, 'utf8'));
    for (const it of Array.isArray(arr) ? arr : []) {
      if (it && it.path) hiddenProjects.set(normalizePath(it.path), String(it.name || path.basename(it.path)));
    }
  } catch { /* 首次启动还没有该文件 */ }
}

function saveHiddenProjects() {
  const dump = [...hiddenProjects.entries()].map(([p, name]) => ({ path: p, name }));
  writeFileAtomic(hiddenFile, JSON.stringify(dump, null, 1), () => {});
}

function hiddenProjectNames() {
  return new Set(hiddenProjects.values());
}

// ---------- 用户手动纳入的项目（新建 / 添加已有文件夹） ----------
// projectRoots 只扫一层，UI 新建或添加的项目可能藏在更深的地方，这里单独记账，
// 落盘 data/user-projects.json 与隐藏列表同一待遇
const userProjectsFile = path.join(ROOT, 'data', 'user-projects.json');
const userProjects = new Set(); // 规范化路径

function loadUserProjects() {
  try {
    const arr = JSON.parse(fs.readFileSync(userProjectsFile, 'utf8'));
    for (const p of Array.isArray(arr) ? arr : []) userProjects.add(normalizePath(p));
  } catch { /* 首次启动还没有该文件 */ }
}

function saveUserProjects() {
  writeFileAtomic(userProjectsFile, JSON.stringify([...userProjects], null, 1), () => {});
}

function discoverProjects() {
  const found = new Set((config.extraProjects || []).map(normalizePath));
  for (const p of userProjects) {
    if (fs.existsSync(p)) found.add(p); // 手动项目被删盘后就不再出现，不报错
  }
  for (const rootDir of config.projectRoots) {
    let entries;
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch (err) {
      console.error(`[tower] 无法读取项目根目录 ${rootDir}: ${err.message}`);
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = normalizePath(path.join(rootDir, ent.name));
      if (fs.existsSync(path.join(full, '.git'))) found.add(full);
    }
  }
  for (const h of hiddenProjects.keys()) found.delete(h);
  for (const p of found) {
    if (!projects.has(p)) {
      projects.set(p, { path: p, name: path.basename(p), branch: undefined, dirty: undefined, ahead: undefined, behind: undefined, lastCommit: null, lastAgentActivity: null, error: null });
    }
  }
  for (const p of [...projects.keys()]) {
    if (!found.has(p)) projects.delete(p);
  }
}

function git(args, cwd) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 8000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function gitInit(dir) {
  return new Promise(resolve => {
    execFile('git', ['init'], { cwd: dir, timeout: 10000, windowsHide: true }, err => resolve(!err));
  });
}

// -sb 首行形如 "## main...origin/main [ahead 2, behind 1]"。含 "..." 才有 upstream；
// 无上游（或 detached HEAD）时 ahead/behind 为 null，页面上不显示该芯片
function parseAheadBehind(statusText) {
  const head = (String(statusText).split('\n', 1)[0] || '').trim();
  if (!head.startsWith('## ')) return { ahead: null, behind: null };
  const tracked = head.includes('...');
  const out = { ahead: tracked ? 0 : null, behind: tracked ? 0 : null };
  const a = head.match(/ahead (\d+)/);
  if (a) out.ahead = Number(a[1]);
  const b = head.match(/behind (\d+)/);
  if (b) out.behind = Number(b[1]);
  return out;
}

async function pollProject(proj) {
  const [status, branch, lastCommit] = await Promise.all([
    git(['status', '-sb', '--porcelain'], proj.path),
    git(['branch', '--show-current'], proj.path),
    git(['log', '-1', '--format=%h%x00%s%x00%cI'], proj.path),
  ]);
  if (status === null) {
    proj.error = 'git 不可用或读取失败';
    return;
  }
  proj.error = null;

  const prevBranch = proj.branch;
  const prevDirty = proj.dirty;
  const prevAhead = proj.ahead;
  // -sb 的首行是 "## 分支..." 头，不算改动条目
  proj.dirty = status.split('\n').filter(l => l && !l.startsWith('## ')).length;
  proj.branch = (branch || '').trim() || '(无分支)';
  const { ahead, behind } = parseAheadBehind(status);
  proj.ahead = ahead;
  proj.behind = behind;

  if (lastCommit) {
    const [hash, msg, time] = lastCommit.split('\0').map(s => s.trim());
    if (proj.lastCommit && proj.lastCommit.hash !== hash) {
      addEvent({ tool: 'git', kind: 'commit', project: proj.name, detail: `${hash} ${msg}` });
    }
    proj.lastCommit = { hash, msg, time };
  }
  if (prevBranch !== undefined && prevBranch !== proj.branch) {
    addEvent({ tool: 'git', kind: 'branch', project: proj.name, detail: `${prevBranch} → ${proj.branch}` });
  }
  if (prevAhead !== undefined && prevAhead > 0 && ahead === 0) {
    addEvent({ tool: 'git', kind: 'push', project: proj.name, detail: `已推送（此前 ${prevAhead} 个未推送提交）` });
  }
  if (prevDirty !== undefined && prevDirty !== proj.dirty) {
    // 归零/起步（干净 ↔ 有改动）是值得记的转折点；期间的正负波动按 10 分钟节流
    const now = Date.now();
    if (prevDirty === 0 || proj.dirty === 0 || now - (proj.lastDirtyEmit || 0) >= DIRTY_EVENT_INTERVAL) {
      proj.lastDirtyEmit = now;
      addEvent({ tool: 'git', kind: 'dirty', project: proj.name, detail: `未提交改动 ${prevDirty} → ${proj.dirty}` });
    }
  }
}

let polling = false; // 上一轮 git 还没跑完（如卡到超时）就跳过本轮，避免堆积
async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    for (const proj of projects.values()) await pollProject(proj);
  } finally {
    polling = false;
  }
  scheduleBroadcast();
}

// ---------- 会话日志监听（内容感知） ----------
const ACTIVITY_EVENT_INTERVAL = 300000; // 同一会话至多每 5 分钟记一条活动事件；转折点（开始等待）不受此限
const TAIL_BYTES = 262144;              // claude/codex 的行都很小，256KB 尾部足够
const ZCODE_TAIL_BYTES = 4 * 1024 * 1024; // zcode 一行 model_io 内嵌全量消息数组，会话越长行越大，窗口必须大

// 会话状态：tokens 是给前端展示的"该会话至今"（zcode 的来自 usage DB，与台账同源）；
// claude/qoder 另用 wm / ratio 在实时窗口内跳过已计过的行
function newSession(tool, file) {
  const led = ledgerFor(path.basename(file), tool);
  return {
    tool, file, project: null, title: null, phase: null, phaseSince: null, model: null,
    tokens: { in: 0, out: 0, cr: 0, cw: 0 },
    credits: led.credits || 0,
    ratio: led.ratio || 0, // qoder 用：已入账的上下文峰值占比，实时窗口从这儿续算
    // wm 从台账种子化：重启后恢复旧会话时，实时窗口才能跳过已入账的行，否则尾部窗口整段重复计数
    lastSeen: 0, lastEmit: 0, wm: led.wm ? { ts: led.wm } : null,
  };
}

function readTail(file, maxBytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 掐掉被截断的半个残行
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function tryParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// 用户输入常被工具注入的提醒包裹，剥掉后再当会话标题
function cleanPromptText(t) {
  return String(t || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .trim();
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find(c => c.type === 'text');
    return (t && t.text) || '';
  }
  return '';
}

// 只统计"今天"的 usage：重启会丢内存水位线，按天截断能把重复计数限制在同一天的尾部窗口内
// 实时窗口内的水位线：只统计上次没见过的行。重启后的重复计数由启动全量补账对台账校正，
// 这里不再做"仅今天"过滤——Claude 的时间戳是 UTC，跟本地日比较会漏掉每天头几个小时的量。
function usageIsNew(ts, wm) {
  return !!ts && (!wm || ts > wm.ts);
}

function scanClaude(lines, wm, meta, full) {
  let maxTs = wm && wm.ts;
  const byDay = {}; // 按记录时间戳分日（与 qoder 同一策略）：实时增量与全量补账走同一本日记账，
  for (const line of lines) { // 重启补账对着台账按日补差额，两条路怎么混跑都不会重复计数
    const o = tryParse(line);
    if (!o) continue;
    if (o.cwd) meta.project = matchProject(o.cwd);
    if (o.type === 'summary' && o.summary) meta.title = o.summary;
    if (o.type === 'assistant' && o.message) {
      if (o.message.model) meta.model = o.message.model;
      const u = o.message.usage;
      // full=全文件口径（启动补账，不看水位线）；实时窗口才按水位线跳过已计的行
      if (u && (full || usageIsNew(o.timestamp, wm))) {
        const inc = { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 };
        if (inc.in || inc.out || inc.cr || inc.cw) {
          let dk = localDayKey();
          if (o.timestamp) {
            const t = Date.parse(o.timestamp);
            if (!Number.isNaN(t)) dk = localDayKey(new Date(t));
          }
          const b = byDay[dk] || (byDay[dk] = { in: 0, out: 0, cr: 0, cw: 0 });
          b.in += inc.in; b.out += inc.out; b.cr += inc.cr; b.cw += inc.cw;
        }
        maxTs = !maxTs || o.timestamp > maxTs ? o.timestamp : maxTs;
      }
      // 只有明确的"这轮说完了"才算等待；中间态宁可显示工作中，也不误报打扰
      const blocks = o.message.content;
      const sr = o.message.stop_reason;
      if ((Array.isArray(blocks) && blocks.some(b => b.type === 'tool_use')) || sr === 'tool_use') meta.phase = 'working';
      else if (sr === 'end_turn' || sr === 'stop_sequence') meta.phase = 'waiting';
      else meta.phase = 'working';
    } else if (o.type === 'user') {
      meta.phase = 'working';
      const t = cleanPromptText(contentText(o.message && o.message.content));
      if (t) meta.title = t.split('\n')[0].slice(0, 80);
    }
  }
  if (maxTs) meta.wm = { ts: maxTs };
  if (Object.keys(byDay).length) meta.byDay = byDay;
}

// ---------- Qoder CLI 会话日志 ----------
// 位置：~/.qoder/projects/<工作区路径编码>/<session-id>.jsonl，格式与 Claude 同源但有差异：
//   · 真实工作区在每条记录的顶层 cwd（不是 runs/manifest.json 里那个恒为安装目录的 cwd）
//   · message.usage 的 input_tokens/output_tokens 被官方抹成 0，token 数拿不到
//   · 但 context_usage_ratio（本轮上下文占窗口的比例）与 credits 是真实值，647/647 条都有
//   · runtime-config.contextWindow 给出窗口大小（qfmodel 实测 1,000,000；缺失时退到默认值）
//   · humanInput:true 标记真正的用户输入，用它取标题，不会被 tool_result / skill 注入文本污染
// token 口径 = Σ max(0, Δratio) × contextWindow：本轮真正新增进上下文的量（含上一轮模型输出
// 与工具回读），官方未分列，所以只记 in，out/cr 一律留 0 不伪造。
const QODER_DEFAULT_WINDOW = 1000000;

function scanQoder(lines, wm, meta, full, baseRatio) {
  let window = null;
  // 全文件口径从 0 起算（首轮的系统提示与工具 schema 也是真送进模型的输入）；
  // 实时尾部窗口从台账已入账的峰值起算，否则窗口首行会把整段上下文再算一遍
  let prevRatio = full ? null : (typeof baseRatio === 'number' ? baseRatio : null);
  let maxTs = wm && wm.ts;
  let peak = typeof baseRatio === 'number' ? baseRatio : 0;
  const byDay = {};          // full=true：按事件真实日期分桶的净增量
  const bump = (dk, inc) => {
    const b = byDay[dk] || (byDay[dk] = { in: 0, credits: 0 });
    b.in += inc.in || 0;
    b.credits += inc.credits || 0;
  };
  for (const line of lines) {
    const o = tryParse(line);
    if (!o) continue;
    if (o.cwd) {
      const p = matchProject(o.cwd);
      if (p) meta.project = p;
      else if (!meta.project) meta.fallbackPath = normalizePath(o.cwd); // 归不到已发现项目时退回完整路径
    }
    if (o.type === 'runtime-config' && o.contextWindow) window = o.contextWindow;
    const m = o.message;
    if (!m) continue;
    if (m.model) meta.model = m.model;
    if (o.type === 'assistant') {
      const blocks = m.content;
      const sr = m.stop_reason;
      // stop_reason 为 null 是流式中间态（thinking/tool_use 分片），不能据此改阶段
      if (sr === null) continue;
      if ((Array.isArray(blocks) && blocks.some(b => b.type === 'tool_use')) || sr === 'tool_use') meta.phase = 'working';
      else if (sr === 'end_turn' || sr === 'stop_sequence') meta.phase = 'waiting';
      else meta.phase = 'working';
    } else if (o.type === 'user') {
      meta.phase = 'working';
      if (o.humanInput) {
        const t = cleanPromptText(contentText(m.content));
        if (t) meta.title = t.split('\n')[0].slice(0, 80);
      }
    }
    const u = m.usage;
    if (!u) continue;
    if (!full && !usageIsNew(o.timestamp, wm)) continue;
    if (o.timestamp && (!maxTs || o.timestamp > maxTs)) maxTs = o.timestamp;
    const w = window || QODER_DEFAULT_WINDOW;
    const inc = { in: 0, credits: u.credits || 0 };
    const r = u.context_usage_ratio;
    if (typeof r === 'number') {
      if (prevRatio === null || r > prevRatio) inc.in = Math.round((r - (prevRatio || 0)) * w);
      prevRatio = prevRatio === null ? r : Math.max(prevRatio, r);
      peak = Math.max(peak, prevRatio);
    }
    // 全量与实时都按记录时间戳落到真实日期（时间戳缺失才退回今天）：实时若把尾部窗口
    // 里的跨天老行统统计到"今天"，之后的全量补账按日对账就会把同一批量数两遍；
    // 两条路走同一个日记账（bankByDay），增量+全量怎么混跑都只补差额
    let dk = localDayKey();
    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) dk = localDayKey(new Date(t));
    }
    bump(dk, inc);
  }
  if (maxTs) meta.wm = { ts: maxTs };
  if (peak) meta.peakRatio = peak; // 落台账，实时窗口下次从这里续算，不重复计整段上下文
  if (Object.keys(byDay).length) meta.byDay = byDay;
}

function scanCodex(lines, meta) {
  for (const line of lines) {
    const o = tryParse(line);
    if (!o) continue;
    const p = o.payload;
    if ((o.type === 'session_meta' || o.type === 'turn_context') && p) {
      if (p.cwd) meta.project = matchProject(p.cwd);
      if (p.model) meta.model = p.model;
    }
    if (o.type === 'response_item' && p && p.type === 'message' && p.role === 'user') {
      const t = cleanPromptText(contentText(p.content));
      if (t) meta.title = t.split('\n')[0].slice(0, 80);
    }
    if (o.type === 'event_msg' && p) {
      if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
        const u = p.info.total_token_usage; // 日志自带累计值，取最后一条即"截至现在"
        meta.usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cached_input_tokens || 0, cw: u.cache_write_input_tokens || 0 };
        meta.isCum = true;
      }
      if (p.type === 'task_started') meta.phase = 'working';
      if (p.type === 'task_complete') meta.phase = 'waiting';
    }
  }
}

// ---- zcode 标题提取的原始文本定位工具 ----
// user 消息的 content 有两种序列化：字符串 "content":"..." 或部件数组 "content":[{"type":"text","text":"..."}]，
// 正则难兼顾，用小的读取器按 JSON 结构走。raw[pos] 必须停在 '"'，返回引号内原文。
function readJsonString(raw, pos) {
  let j = pos + 1;
  while (j < raw.length) {
    if (raw[j] === '\\') { j += 2; continue; }
    if (raw[j] === '"') return raw.slice(pos + 1, j);
    j++;
  }
  return null;
}

// raw[pos] === '['，返回配对 ']' 的下标（跳过字符串里的括号）
function arrayEnd(raw, pos) {
  let depth = 0;
  for (let j = pos; j < raw.length; j++) {
    const c = raw[j];
    if (c === '"') {
      const s = readJsonString(raw, j);
      if (s === null) return -1;
      j += s.length + 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

const USER_ROLE = '"role":"user"';
const CONTENT_KEY = '"content":';
const TEXT_PART = '"text":"';

// 一行里从最后一条 user 消息往前找，返回第一条"剥掉注入后还有正文"的标题；
// 最后一条常是 task-notification 之类的注入，剥完就空，不能因为它丢了真标题
function zcodeLineTitle(line) {
  const positions = [];
  let i = line.indexOf(USER_ROLE);
  while (i !== -1) {
    positions.push(i);
    i = line.indexOf(USER_ROLE, i + 1);
  }
  for (let p = positions.length - 1; p >= 0; p--) {
    let cand = null;
    const k = line.indexOf(CONTENT_KEY, positions[p] + USER_ROLE.length);
    if (k === -1 || k - positions[p] > USER_ROLE.length + 20) continue;
    const v = k + CONTENT_KEY.length;
    if (line[v] === '"') {
      cand = readJsonString(line, v);
    } else if (line[v] === '[') {
      const end = arrayEnd(line, v);
      if (end !== -1) {
        const t = line.indexOf(TEXT_PART, v);
        if (t !== -1 && t < end) cand = readJsonString(line, t + TEXT_PART.length - 1);
      }
    }
    if (!cand) continue;
    const t = cleanPromptText(unescapeJson(cand));
    if (t) return t.split('\n')[0].slice(0, 80);
  }
  return null;
}

// zcode 的 model_io 行内嵌全量消息数组，会话后期单行可达数 MB，逐行 JSON.parse 不划算；
// 在原始行文本上定位提取。token 不再从日志入账——日志会滚动截断、会话结束即删，
// 只是完整账本的一个残卷；token 一律来自 usage DB 轮询的 model_usage 表（见 pollZcodeDb），
// 这里只出会话卡片要用的标题 / 阶段 / 模型 / 项目归属。
function extractZcode(file, s, meta) {
  const text = readTail(file, ZCODE_TAIL_BYTES);
  const lines = text.split('\n');
  if (lines.length && !text.endsWith('\n')) lines.pop(); // 最后一行可能写了一半，状态等下一轮
  for (const line of lines) {
    if (!line) continue;
    const fr = line.match(/"finishReason":"([^"]+)"/);
    if (fr) meta.phase = fr[1] === 'stop' ? 'waiting' : 'working';

    // 越新的行越能代表当前任务，行内找到就用该行结果覆盖旧行
    const lineTitle = zcodeLineTitle(line);
    if (lineTitle) meta.title = lineTitle;
  }
  // 当前模型：请求体顶层的 "model" 字段，取最后一次出现（越靠后的行越新）
  const mi = text.lastIndexOf('"model":"');
  if (mi !== -1) meta.model = readJsonString(text, mi + 8);
  meta.project = sniffProjectText(text.slice(-TAIL_BYTES));
  return meta;
}

// 各家 CLI 的 JSONL 格式不同，各配一个扫描器；都失败再走路径嗅探兜底。
// full=true 只在补账时用（claude/qoder 全文件按真实日期分桶），实时监听一律走尾部窗口。
function extractMeta(tool, file, s, full) {
  const meta = { project: null, fallbackPath: null, title: null, usage: null, phase: null, wm: null, model: null, isCum: false, credits: 0, byDay: null, peakRatio: null };
  try {
    if (tool === 'zcode') return extractZcode(file, s, meta);
    const wholeFile = full && (tool === 'claude' || tool === 'qoder');
    // qoder 一次会话能写到几十 MB（工具回读全进日志），全文件口径留 32MB 上限，超了退尾部
    const maxBytes = wholeFile ? (tool === 'qoder' ? 32 * 1024 * 1024 : Infinity) : TAIL_BYTES;
    const text = readTail(file, maxBytes);
    const lines = text.split('\n').filter(Boolean);
    if (tool === 'claude') scanClaude(lines, s.wm, meta, full);
    else if (tool === 'qoder') scanQoder(lines, s.wm, meta, full, s.ratio);
    else scanCodex(lines, meta);
    if (!meta.project) meta.project = sniffProjectText(text);
  } catch { /* 尾部读取失败（文件轮转/占用），下一轮再试 */ }
  return meta;
}

// 路径嗅探兜底：优先明确的 "cwd" 字段，再按 file_path / 绝对路径出现频率推断
function sniffProjectText(text) {
  try {
    const cwdMatch = text.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (cwdMatch) return matchProject(unescapeJson(cwdMatch[1]));

    const counts = new Map();
    const bump = p => { if (p) counts.set(p, (counts.get(p) || 0) + 1); };
    for (const m of text.matchAll(/"(?:file_path|cwd|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      bump(matchProject(unescapeJson(m[1])));
    }
    if (!counts.size) {
      // zcode 的日志没有 cwd 字段，但工具调用参数里全是绝对路径；
      // JSON 里反斜杠是 \\ 转义的，路径正则要把连续的转义符吃进来，到引号/空白才停
      for (const m of text.matchAll(/[A-Za-z]:(?:\\\\|\\\/|[^"\\\s])+/g)) bump(matchProject(unescapeJson(m[0])));
    }
    let best = null;
    let bestN = 0;
    for (const [p, n] of counts) {
      if (n > bestN) { best = p; bestN = n; }
    }
    return best;
  } catch {
    return null;
  }
}

function unescapeJson(s) {
  try { return JSON.parse('"' + s + '"'); } catch { return s; }
}

function matchProject(rawPath) {
  const key = normalizePath(rawPath);
  if (projects.has(key)) return key;
  for (const p of projects.keys()) {
    if (key.startsWith(p + '/') || key.startsWith(p + '\\')) return p;
  }
  return null;
}

// 会话归属到"项目"的展示名：命中已发现的项目用其目录名，否则退回日志里的完整路径，
// 页面上至少能看出这用量发生在哪（与活动目录监听层的口径一致）
function sessionProjName(s) {
  return s.project ? path.basename(s.project) : (s.fallbackPath || null);
}

function touchSession(tool, file, seenAt, silent, full) {
  const s = sessions.get(file) || newSession(tool, file);
  const wasPhase = s.phase;
  s.lastSeen = seenAt;

  const meta = extractMeta(tool, file, s, full);
  if (meta) {
    if (meta.project) { s.project = meta.project; s.fallbackPath = null; }
    else if (meta.fallbackPath && !s.project) s.fallbackPath = meta.fallbackPath;
    if (meta.title) s.title = meta.title;
    if (meta.phase) s.phase = meta.phase;
    if (meta.model) s.model = meta.model;
    if (meta.usage || meta.byDay) applyTokens(tool, file, s, meta);
    if (meta.wm) {
      s.wm = meta.wm;
      ledgerFor(path.basename(file), tool).wm = meta.wm.ts; // 水位线落台账，重启后仍有效
    }
  }
  sessions.set(file, s);

  const projName = sessionProjName(s);
  if (s.project && projects.has(s.project)) {
    const p = projects.get(s.project);
    // 只在更新的时候推进：补扫历史会话会拿旧 mtime 进来，不能把项目"最近活动"倒回去
    if (seenAt >= (p.lastAgentActivity || 0)) p.lastAgentActivity = seenAt;
  }

  // "开始等你"是值得进时间线的转折点；普通活动仍按 5 分钟节流
  const becameWaiting = !silent && s.phase === 'waiting' && wasPhase === 'working';
  if (s.phase !== wasPhase) s.phaseSince = seenAt; // 前端用它在等待卡片上显示"已等 N 分钟"
  if (becameWaiting || (!silent && seenAt - s.lastEmit >= ACTIVITY_EVENT_INTERVAL)) {
    s.lastEmit = seenAt;
    addEvent({
      tool,
      kind: becameWaiting ? 'waiting' : 'activity',
      project: projName,
      detail: becameWaiting ? (s.title || null) : (s.project ? null : path.basename(file)),
    });
  }
  if (s.phase !== wasPhase) scheduleBroadcast();
}

// 入账统一走台账：累计口径（codex 日志）对台账补差额，
// 按日分桶口径（claude/qoder 的全量补账与实时窗口）对着台账的日记账补差额，
// 历史用量落到事件真实发生的那天，台账冷启动也不会和补账数重。
// zcode 不走这里：token 从 usage DB 对账（pollZcodeDb），日志只出卡片状态。
// s.tokens 只负责前端展示"这个会话至今多少"。
function applyTokens(tool, file, s, meta) {
  const name = path.basename(file);
  const model = s.model || null; // 模型归属跟会话走，日分桶的分模型统计用它
  const projName = sessionProjName(s);
  if (meta.byDay) {
    bankByDay(name, meta.byDay, projName, tool, model);
    const led = ledgerFor(name, tool);
    if (meta.peakRatio) led.ratio = meta.peakRatio;
    s.tokens = { in: led.in || 0, out: led.out || 0, cr: led.cr || 0, cw: led.cw || 0 };
    s.credits = led.credits || 0;
    s.ratio = led.ratio || 0;
  }
  if (meta.isCum) {
    bankCumulative(name, meta.usage, projName, tool, model);
    s.tokens = { ...s.tokens, ...meta.usage };
  } else if (meta.usage && (meta.usage.in || meta.usage.out || meta.usage.credits)) {
    bankIncremental(name, meta.usage, projName, tool, model);
    s.tokens.in += meta.usage.in;
    s.tokens.out += meta.usage.out;
    s.tokens.cr += meta.usage.cr;
    s.tokens.cw += meta.usage.cw;
    if (meta.usage.credits) s.credits = (s.credits || 0) + meta.usage.credits;
    if (meta.peakRatio) { ledgerFor(name, tool).ratio = meta.peakRatio; s.ratio = meta.peakRatio; }
  }
}

// ---------- 目录监听与会话补扫 ----------
const watchedDirs = new Set();   // 已挂上 fs.watch 的目录
const warnedDirs = new Set();    // 尚不存在、已提示过一次的目录
const pendingWatches = new Map(); // 文件路径 -> 去抖定时器；Windows 上一次写入会触发多次通知
const WATCH_DEBOUNCE_MS = 400;   // zcode 单次解析要重读 4MB 尾部，合并短时间内的连续变更

// 目录被删（工具卸载、日志清理）时 watcher 会抛 ENOENT，没人接就整个进程崩掉；
// 接住并把目录从已监听集合放开，等目录回来时由周期 watchAllDirs 重新接管
function guardWatcher(watcher, dir, ownedSet) {
  watcher.on('error', err => {
    console.warn(`[tower] 目录监听中断（目录消失？回来后自动重接）: ${dir}: ${err.message}`);
    try { watcher.close(); } catch { /* 已失效，忽略 */ }
    ownedSet.delete(dir);
  });
  return watcher;
}

// 目录首次可监听时挂 watcher。mode='session' 盯活跃会话，mode='archive' 只做归档补账。
// 目录暂不存在（如 Claude Code 还没跑过第一次）不算错误，周期任务稍后会再试。
function setupDirWatch(tool, dir, mode) {
  if (watchedDirs.has(dir)) return false;
  if (!fs.existsSync(dir)) {
    if (!warnedDirs.has(dir)) {
      warnedDirs.add(dir);
      console.warn(`[tower] 目录不存在，出现后自动接管: ${dir}`);
    }
    return false;
  }
  try {
    const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      const fullPath = normalizePath(path.join(dir, filename));
      clearTimeout(pendingWatches.get(fullPath));
      pendingWatches.set(fullPath, setTimeout(() => {
        pendingWatches.delete(fullPath);
        // 去抖窗口过后文件可能已被轮转/删除，stat 失败直接忽略
        let stat;
        try { stat = fs.statSync(fullPath); } catch { return; }
        if (!stat.isFile()) return;
        if (mode === 'archive') harvestArchiveFile(tool, fullPath);
        else touchSession(tool, fullPath, Date.now(), false);
      }, WATCH_DEBOUNCE_MS));
    });
    guardWatcher(watcher, dir, watchedDirs);
  } catch (err) {
    console.error(`[tower] 监听失败 ${dir}: ${err.message}`);
    return false;
  }
  watchedDirs.add(dir);
  return true;
}

// 项目根目录监听：别处新建/克隆项目时立刻刷新面板，不用等 30 秒轮询。
// 非递归只看根下直接条目；"先建目录、.git 后到"（git clone/init）存在通知缺口，用双检兜底
const watchedRoots = new Set();
const rootWatchTimers = new Map();

// 工具安装探测：盯着家目录，纳管工具的 .dir 出现/消失（装了/卸载了）时推 type:'tools'，
// 前端立刻重拉 /api/stats——工具卡片实时更新，不用等 60 秒轮询。已入账的统计在卸载后
// 照常返回（台账不删），卡片区只是从"监控中"变成"已卸载"。
let toolProbeSig = null;
function toolProbeSignature() {
  const home = os.homedir();
  let sig = '';
  for (const m of TOOL_META) {
    if (!m.probe) continue;
    sig += m.tool + (fs.existsSync(path.join(home, m.probe)) ? '=1;' : '=0;');
  }
  return sig;
}
function pushToolsChanged() {
  const msg = JSON.stringify({ type: 'tools' });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}
function watchToolProbes() {
  if (toolProbeSig === null) toolProbeSig = toolProbeSignature(); // 首次调用只是记基线，不推送
  const home = os.homedir();
  if (watchedRoots.has(home)) return;
  let timer = null;
  try {
    const watcher = fs.watch(home, { recursive: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const sig = toolProbeSignature();
        if (sig === toolProbeSig) return;
        toolProbeSig = sig;
        pushToolsChanged();
      }, 1500); // 安装器可能连续建删目录，合并成一检
    });
    guardWatcher(watcher, home, watchedRoots);
  } catch (err) {
    console.error(`[tower] 家目录监听失败（工具安装探测降级为 60 秒轮询）: ${err.message}`);
    return;
  }
  watchedRoots.add(home);
}

function refreshProjectsNow() {
  discoverProjects();
  scheduleBroadcast();
}
function watchProjectRoots() {
  for (const rootDir of config.projectRoots) {
    if (watchedRoots.has(rootDir)) continue;
    try {
      const watcher = fs.watch(rootDir, { recursive: false }, () => {
        clearTimeout(rootWatchTimers.get(rootDir));
        rootWatchTimers.set(rootDir, setTimeout(refreshProjectsNow, 1200));
        clearTimeout(rootWatchTimers.get(rootDir + ':second'));
        rootWatchTimers.set(rootDir + ':second', setTimeout(refreshProjectsNow, 4000));
      });
      guardWatcher(watcher, rootDir, watchedRoots);
    } catch (err) {
      console.error(`[tower] 项目根目录监听失败 ${rootDir}: ${err.message}`);
      continue;
    }
    watchedRoots.add(rootDir);
  }
}

function watchAllDirs() {
  watchProjectRoots();
  watchToolProbes();
  for (const cfg of config.sessionDirs) {
    if (setupDirWatch(cfg.tool, cfg.dir, 'session')) {
      scanRecentSessionDir(cfg.tool, cfg.dir);
      if (cfg.backfill) backfillSessionDir(cfg.tool, cfg.dir); // 首次接管就把存量历史按真实日期补齐
    }
    if (cfg.archiveDir && setupDirWatch(cfg.tool, cfg.archiveDir, 'archive')) {
      harvestArchiveDir(cfg.tool, cfg.archiveDir); // 首次接管归档目录时，把存量历史一次补齐
    }
  }
  for (const cfg of config.activityDirs || []) setupActivityWatch(cfg);
  for (const cfg of config.traceDirs || []) setupTraceWatch(cfg);
  for (const cfg of config.llamaLogDirs || []) setupLlamaWatch(cfg);
  pollUsageDbs(); // SQLite 用量库（Hermes）：启动补账 + 随本轮周期轮询
}

// 全量回填：目录首次可监听时，把所有存量会话（不限 24 小时）按各自记录时间戳落到真实日期入账。
// 走台账差额，重复启动不会重复计数；silent=true 只补统计、不往时间线里灌历史事件。
const BACKFILL_MAX_AGE_MS = 180 * 86400000; // 半年前的会话不再回灌，避免无意义的全盘扫描
const BACKFILL_MAX_FILES = 3000;
function backfillSessionDir(tool, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }
  let done = 0;
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    if (++done > BACKFILL_MAX_FILES) return;
    const fullPath = normalizePath(path.join(ent.parentPath || dir, ent.name));
    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (Date.now() - stat.mtimeMs >= BACKFILL_MAX_AGE_MS) continue;
    try {
      touchSession(tool, fullPath, stat.mtimeMs, true, true);
      // 回填只为补台账数字。超过活跃窗口的旧会话不该在"正在发生"里挂一张
      // "等你确认"的僵尸卡片（那种卡片不会因超时而消失，会把面板占满）
      if (Date.now() - stat.mtimeMs >= (config.liveWindowMs || 180000)) sessions.delete(fullPath);
    } catch { /* 单个文件解析失败不拖累整体 */ }
  }
}

// 启动/目录首次出现时补扫最近 24 小时的会话文件：热文件让"正在发生"不空屏，
// 冷文件让重启前就处于"等你确认"的会话重新回到面板上（各工具入账都走台账，重扫不会重复计数）。
// full=true 让 claude 用全文件口径把 token 账补齐（其余工具自动忽略该标志）
function scanRecentSessionDir(tool, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const fullPath = normalizePath(path.join(ent.parentPath || dir, ent.name));
    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    const age = Date.now() - stat.mtimeMs;
    if (age >= 86400000) continue;
    touchSession(tool, fullPath, stat.mtimeMs, true, true);
  }
}

// 归档收割：会话结束被 Codex 移进 archived_sessions 的文件，在这里补最后一笔账。
// 对着台账补差额，与实时监听期间的入账互不重复。
function harvestArchiveFile(tool, file) {
  try {
    const meta = extractMeta(tool, file, { wm: null }, false);
    if (meta && meta.usage) {
      const projName = meta.project ? path.basename(meta.project) : null;
      bankCumulative(path.basename(file), meta.usage, projName, tool, meta.model || null);
    }
  } catch { /* 单个归档解析失败不拖累整体 */ }
}

function harvestArchiveDir(tool, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith('.jsonl')) harvestArchiveFile(tool, path.join(dir, ent.name));
  }
}

// ---------- 活动目录监听（没有 token 日志的工具） ----------
// Qoder CLI / dsh 的本地日志里没有 token 用量，只有"动过"的事实：一次 CLI 运行、一个 agent
// 会话。这里只发事件、挂一张无 token 的临时会话卡片（超过 liveWindow 自然消失），不进 token
// 台账；已升级 token 级的工具（workbuddy）审计流水只进时间线，不再挂临时卡片。
// 提取器各自认领自己的日志格式。
const ACTIVITY_EMIT_INTERVAL = 300000; // 同一活动源文件至多每 5 分钟发一条事件（workbuddy 的当日审计流水会持续追加）
const ACTIVITY_KIND = { qoder: 'run', dsh: 'activity', workbuddy: 'audit' };
const activitySigs = new Map();   // 活动源文件 -> 上次处理时的 mtime:size
const activityEmitAt = new Map(); // 活动源文件 -> 上次发事件时间

// 提取器：从活动源文件里找 { title, detail, project, fallbackPath }，返回 null 表示这条不算活动。
// 抛错（文件写了一半、格式变化）按"这次没动静"处理，等下一次变更再试。
// 用 session-id 反查 Qoder 会话的真实工作区（在会话流水开头找第一条带 cwd 的记录）。
// 结果缓存：一个会话只查一次；id 先过白名单正则，不让日志里的字符串拼进路径。
const qoderWsCache = new Map();
function qoderWorkspaceOf(sessionId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{6,63}$/.test(sessionId)) return null;
  if (qoderWsCache.has(sessionId)) return qoderWsCache.get(sessionId);
  let found = null;
  try {
    const cfg = (config.sessionDirs || []).find(c => c.tool === 'qoder');
    if (cfg && fs.existsSync(cfg.dir)) {
      const hit = fs.readdirSync(cfg.dir, { recursive: true, withFileTypes: true })
        .find(e => e.isFile() && e.name === sessionId + '.jsonl');
      if (hit) {
        const full = normalizePath(path.join(hit.parentPath || cfg.dir, hit.name));
        const fd = fs.openSync(full, 'r');
        try {
          const buf = Buffer.alloc(Math.min(262144, fs.fstatSync(fd).size));
          fs.readSync(fd, buf, 0, buf.length, 0);
          // 流水开头几行是 workspace-directories / runtime-config / worktree-state，都没有 cwd，
          // 要一直翻到第一条 user/assistant 记录才拿得到真实工作区
          for (const line of buf.toString('utf8').split('\n')) {
            const o = tryParse(line);
            if (o && o.cwd) { found = normalizePath(o.cwd); break; }
          }
        } finally { fs.closeSync(fd); }
      }
    }
  } catch { /* 反查失败就退回 manifest 的 cwd，至少不丢事件 */ }
  if (qoderWsCache.size > 2000) qoderWsCache.clear();
  qoderWsCache.set(sessionId, found);
  return found;
}

// dsh v3 的会话文件是"多帧 zstd"：每批事件一个独立帧追加进同一文件，Node 的一次式/流式解压
// 都只吃第一帧（只剩会话头）。按 RFC 8878 的帧结构走块头找真实边界，逐帧解出拼接；
// 走不动（格式变化）就退化为"解到文件尾"，单帧解失败按空串处理，绝不让整个提取器抛错。
function zstdFrameEnd(buf, p) {
  const fhd = buf[p + 4];
  if ((fhd >> 3) & 1) return -1; // reserved 位必须为 0，否则不是合法帧头
  let q = p + 5;
  const fcsFlag = fhd >> 6;
  if (!((fhd >> 5) & 1)) q += 1;                    // Single_Segment=0 时跟 1 字节窗口描述符
  q += [0, 1, 2, 4][fhd & 3];                       // 字典 ID：0/1/2/4 字节
  q += [((fhd >> 5) & 1) ? 1 : 0, 2, 4, 8][fcsFlag]; // 内容大小：0 字节（单段时 1）/2/4/8
  if (q > buf.length) return -1;
  for (;;) {
    if (q + 3 > buf.length) return -1;
    const u24 = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16);
    const type = (u24 >> 1) & 3;
    if (type === 3) return -1; // 保留块类型
    q += 3;
    q += type === 1 ? 1 : (u24 >> 3); // RLE 块载荷恒 1 字节，其余按块大小跳过
    if (q > buf.length) return -1;
    if (u24 & 1) break; // last_block
  }
  if ((fhd >> 2) & 1) q += 4; // 内容校验和
  return q <= buf.length ? q : -1;
}

function dshDecompressAll(buf) {
  const pieces = [];
  let start = 0;
  while (start + 5 <= buf.length) {
    const end = zstdFrameEnd(buf, start);
    if (end < 0) { // 帧头走不动：把剩余部分整体试解一次后放弃
      try { pieces.push(zlib.zstdDecompressSync(buf.slice(start))); } catch { }
      break;
    }
    try { pieces.push(zlib.zstdDecompressSync(buf.slice(start, end))); } catch { }
    start = end;
  }
  return pieces.join('');
}

const activityExtractors = {
  // Qoder CLI：logs/runs/<run_id>/manifest.json 只是进程启动记录，它的 cwd 恒为安装目录
  // （Qoder.exe 的落点），拿它去 matchProject 永远归不到真正的工作区。工作区要从 argv 里的
  // --session-id 反查会话流水的 cwd 才能拿到；查不到（会话还没落盘）才退回 manifest 的 cwd。
  qoder(file) {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!o || !o.run_id) return null;
    const argv = Array.isArray(o.argv) ? o.argv : [];
    const i = argv.indexOf('--session-id');
    // 带 --no-session-persistence / 没有 --session-id 的是 CLI 内部工具进程（索引、上下文蒸馏等），
    // 既没有会话流水也没有工作区可言，不算一次 agent 活动
    if (i < 0 || !argv[i + 1]) return null;
    const ws = qoderWorkspaceOf(String(argv[i + 1]));
    if (!ws) return null; // 反查不到工作区就不要拿安装目录充数：宁可少一条，也不记一条错的归属
    return {
      title: String(o.run_id).slice(0, 19), // run_id 以时间开头，截到秒正好当标题
      detail: o.cli_version ? `CLI ${o.cli_version}` : null,
      project: matchProject(ws),
      fallbackPath: ws,
    };
  },
  // dsh：sessions/<项目路径编码>/<session-id>/session*.jsonl.zstd。
  // 旧格式（v2）整个会话是一个 JSON；v3（2026-09 中旬起）是"多帧 zstd + JSONL 事件流水"，
  // 每批事件一个独立 zstd 帧——文件名也从 session.jsonl.zstd 变成了 session.v3.jsonl.zstd，
  // 塔台曾因 match 字面匹配漏掉全部 v3 会话。v3 里没有 token 用量（request/header 只有
  // provider/model/maxTokens），维持活动级，但标题/模型/cwd 都是真实的，卡片按此升级。
  dsh(file) {
    if (fs.statSync(file).size > 64 * 1024 * 1024) return null; // 异常大的会话不解析，宁缺毋滥
    const text = dshDecompressAll(fs.readFileSync(file));
    const whole = tryParse(text);
    if (whole && whole.type === 'session') {
      return {
        title: whole.agentPreset ? String(whole.agentPreset) : 'dsh 会话',
        detail: null,
        model: null,
        project: whole.cwd ? matchProject(whole.cwd) : null,
        fallbackPath: whole.cwd || null,
      };
    }
    // v3：逐行扫事件流水。标题取 LLM 生成的 session/title（provider 来源优先于 fallback），
    // 模型取最后一次真实模型请求（request/header）的配置，最后一条用户输入兜底当标题
    let cwd = null, preset = null, title = null, titleFromLlm = false, model = null, lastUser = null;
    for (const line of text.split('\n')) {
      const o = tryParse(line);
      if (!o || !o.type) continue;
      const d = o.data || {};
      if (o.type === 'session') {
        // 会话头的 cwd / agentPreset 在记录顶层，不在 data 里
        cwd = o.cwd || cwd;
        preset = o.agentPreset || preset;
      } else if (o.type === 'session/title' && d.title) {
        const llm = d.source && d.source.kind === 'provider';
        if (!title || (llm && !titleFromLlm)) { title = String(d.title); titleFromLlm = !!llm; }
      } else if (o.type === 'request/header' && d.header && d.header.config && d.header.config.model) {
        model = d.header.config.model;
      } else if (o.type === 'user/message' && !lastUser) {
        const t = cleanPromptText(contentText(d.content));
        if (t) lastUser = t.split('\n')[0].slice(0, 80);
      }
    }
    return {
      title: title || lastUser || 'dsh 会话',
      detail: preset ? String(preset) : null,
      model: model,
      project: cwd ? matchProject(cwd) : null,
      fallbackPath: cwd || null,
    };
  },
  // workbuddy：audit-log/<日期>.jsonl 安全审计流水，从尾部找最近一条能看出项目归属的记录
  workbuddy(file) {
    const lines = readTail(file).split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i]);
      if (!o || !o.eventType) continue;
      return {
        title: String(o.eventType),
        detail: null,
        project: sniffProjectText(lines[i]),
        fallbackPath: null,
      };
    }
    return null;
  },
};

function handleActivityChange(tool, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return; } // 去抖窗口过后文件可能已被删掉
  if (!stat.isFile()) return;
  const sig = stat.mtimeMs + ':' + stat.size;
  if (activitySigs.get(file) === sig) return;
  activitySigs.set(file, sig);
  if (activitySigs.size > 5000) activitySigs.delete(activitySigs.keys().next().value); // 常驻进程的兜底，别无限涨
  if (activityEmitAt.size > 5000) activityEmitAt.delete(activityEmitAt.keys().next().value);

  let info;
  try { info = activityExtractors[tool](file); } catch { return; }
  if (!info) return;

  // 节流只约束"同一文件的反复写入"；qoder/dsh 每次活动都是新文件，不受影响
  const now = Date.now();
  if (activityEmitAt.has(file) && now - activityEmitAt.get(file) < ACTIVITY_EMIT_INTERVAL) return;
  activityEmitAt.set(file, now);

  // 归不到已发现的项目时退回完整路径，页面上至少能看到活动发生在哪
  const projectName = info.project ? path.basename(info.project) : (info.fallbackPath || null);
  if (info.project && projects.has(info.project)) projects.get(info.project).lastAgentActivity = now;
  addEvent({ tool, kind: ACTIVITY_KIND[tool] || 'activity', project: projectName, detail: info.detail });

  // 已升级 token 级的工具（如 workbuddy）由 trace 监听提供带 token 的真会话卡片，
  // 审计流水只进时间线，别再挂 eventType 当标题的临时卡片
  if (TOKEN_TOOLS.has(tool)) return;

  // 挂一张临时会话卡片，让"正在发生"面板也能看到这些工具的动静
  const s = sessions.get(file) || {
    tool, file, project: null, title: null, phase: null, phaseSince: null, model: null,
    tokens: { in: 0, out: 0, cr: 0, cw: 0 }, lastSeen: 0, lastEmit: 0, wm: null,
  };
  s.lastSeen = now;
  if (info.project) s.project = info.project;
  if (info.title) s.title = info.title;
  if (info.model) s.model = info.model; // dsh v3 的活动卡片也带模型徽章
  sessions.set(file, s);
  scheduleBroadcast();
}

// 启动/目录首次出现时把存量文件标成"已见过"但不发事件：活动时间线只从接管那一刻开始记
function seedActivityDir(cfg) {
  let entries;
  try {
    entries = fs.readdirSync(cfg.dir, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(cfg.match)) continue;
    const full = normalizePath(path.join(ent.parentPath || cfg.dir, ent.name));
    try {
      const st = fs.statSync(full);
      activitySigs.set(full, st.mtimeMs + ':' + st.size);
    } catch { /* 竞态删除，忽略 */ }
  }
}

function setupActivityWatch(cfg) {
  if (watchedDirs.has(cfg.dir)) return;
  if (!fs.existsSync(cfg.dir)) {
    if (!warnedDirs.has(cfg.dir)) {
      warnedDirs.add(cfg.dir);
      console.warn(`[tower] 活动目录不存在，出现后自动接管: ${cfg.dir}`);
    }
    return;
  }
  try {
    const watcher = fs.watch(cfg.dir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.endsWith(cfg.match)) return;
      const fullPath = normalizePath(path.join(cfg.dir, filename));
      clearTimeout(pendingWatches.get(fullPath));
      pendingWatches.set(fullPath, setTimeout(() => {
        pendingWatches.delete(fullPath);
        handleActivityChange(cfg.tool, fullPath);
      }, WATCH_DEBOUNCE_MS));
    });
    guardWatcher(watcher, cfg.dir, watchedDirs);
  } catch (err) {
    console.error(`[tower] 活动目录监听失败 ${cfg.dir}: ${err.message}`);
    return;
  }
  watchedDirs.add(cfg.dir);
  seedActivityDir(cfg); // 挂上监听后立刻标记存量；竞态窗口内的重复通知由 sig 去重兜住
}

// ---------- trace 目录监听（整份 JSON 的 trace，generation span 里带完整 usage） ----------
// workbuddy 的 traces/<pid>/trace_<uuid>.json 是 OpenTelemetry 风格的整文件 JSON，不是追加式
// jsonl：generation span 的 toolOutput 存着 OpenAI chat.completion 响应（含 model 与完整 usage），
// toolInput 存着请求消息（在 100KB 处被截断，只能正则提取标题，不能整段 parse）。
// 入账走 bankCumulative：台账记该文件已入过的累计，文件重写/重启重扫都只补差额。
const TRACE_MAX_BYTES = 64 * 1024 * 1024; // 异常大的 trace 不解析，宁缺毋滥

// 真实用户请求包在 <user_query> 标签里；系统提示词里也有这句标签的字面说明（孤立开标签），
// 所以按栈配对，取最后一个完整闭合的对，截断的尾巴也够当标题
function traceTitle(toolInput) {
  const stack = [];
  let last = null;
  for (const m of String(toolInput).matchAll(/<(\/?)user_query>/g)) {
    if (m[1] === '/') {
      const start = stack.pop();
      if (start !== undefined) last = String(toolInput).slice(start, m.index);
    } else {
      stack.push(m.index + m[0].length);
    }
  }
  if (last === null) return null;
  return cleanPromptText(last).split('\n')[0].slice(0, 80) || null;
}

function harvestTraceFile(tool, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return; } // 去抖窗口过后文件可能已被清理
  if (!stat.isFile() || stat.size > TRACE_MAX_BYTES) return;
  // trace 写完即不可变：台账记下入账时的 mtime，重扫时 mtime 没变就只 stat 不 parse，
  // 上千个存量文件的启动补账才能收敛成毫秒级
  const led = ledgerFor(path.basename(file));
  if (led.mt === stat.mtimeMs) return;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; } // 写了一半，等下次变更
  const usage = { in: 0, out: 0, cr: 0, cw: 0 };
  let model = null;
  let title = null;
  let lastCreated = 0; // 最后一次模型响应的 unix 秒，补账时把 token 落到真实日期而不是启动当天
  for (const sp of doc.spans || []) {
    if (!sp || !/generation/i.test(sp.name || '')) continue;
    if (!title && typeof sp.toolInput === 'string') title = traceTitle(sp.toolInput);
    let out;
    try { out = JSON.parse(sp.toolOutput); } catch { continue; } // 输出预览同样可能被截断
    for (const comp of Array.isArray(out) ? out : [out]) {
      const u = comp && comp.usage;
      if (!u) continue;
      usage.in += u.prompt_tokens || 0; // OpenAI 口径：cached 是 prompt 的子集，同 codex 对待
      usage.out += u.completion_tokens || 0;
      usage.cr += (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
      if (comp.model) model = comp.model;
      if (Number.isFinite(comp.created)) lastCreated = Math.max(lastCreated, comp.created);
    }
  }
  const project = sniffProjectText(JSON.stringify(doc));
  // 只入 token 台账，不发时间线事件：存量补账会把几百条事件灌进统计，时间线由
  // 审计流水（activityDirs 的 workbuddy 项）负责，两边不重复
  if (usage.in || usage.out) {
    const dayKey = lastCreated ? localDayKey(new Date(lastCreated * 1000)) : null;
    bankCumulative(path.basename(file), usage, project, tool, model, dayKey);
  }
  led.mt = stat.mtimeMs;

  // 会话卡片：lastSeen 用文件 mtime 而不是当前时间——启动补扫老 trace 时不能让它们
  // 全体冒进"正在发生"面板（liveWindow 只认 3 分钟内的动静）
  const s = sessions.get(file) || newSession(tool, file);
  s.lastSeen = Math.max(s.lastSeen, stat.mtimeMs);
  if (project) s.project = project;
  if (title) s.title = title;
  if (model) s.model = model;
  if (usage.in || usage.out) s.tokens = { in: usage.in, out: usage.out, cr: usage.cr, cw: usage.cw };
  sessions.set(file, s);
  scheduleBroadcast();
}

// 存量 trace 首次接管时全量补账：上千个文件同步扫会卡住启动，分批让出事件循环；
// 台账 mtime 去重保证后续启动只剩 stat，几个毫秒就扫完
function harvestTraceDirAsync(cfg) {
  let entries;
  try {
    entries = fs.readdirSync(cfg.dir, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(cfg.match)) continue;
    files.push(normalizePath(path.join(ent.parentPath || cfg.dir, ent.name)));
  }
  let i = 0;
  const step = () => {
    const end = Math.min(files.length, i + 20);
    for (; i < end; i++) harvestTraceFile(cfg.tool, files[i]);
    if (i < files.length) setTimeout(step, 50);
  };
  step();
}

function setupTraceWatch(cfg) {
  if (watchedDirs.has(cfg.dir)) return;
  if (!fs.existsSync(cfg.dir)) {
    if (!warnedDirs.has(cfg.dir)) {
      warnedDirs.add(cfg.dir);
      console.warn(`[tower] trace 目录不存在，出现后自动接管: ${cfg.dir}`);
    }
    return;
  }
  try {
    const watcher = fs.watch(cfg.dir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.endsWith(cfg.match)) return;
      const fullPath = normalizePath(path.join(cfg.dir, filename));
      clearTimeout(pendingWatches.get(fullPath));
      pendingWatches.set(fullPath, setTimeout(() => {
        pendingWatches.delete(fullPath);
        harvestTraceFile(cfg.tool, fullPath);
      }, WATCH_DEBOUNCE_MS));
    });
    guardWatcher(watcher, cfg.dir, watchedDirs);
  } catch (err) {
    console.error(`[tower] trace 目录监听失败 ${cfg.dir}: ${err.message}`);
    return;
  }
  watchedDirs.add(cfg.dir);
  harvestTraceDirAsync(cfg);
}

// ---------- llama.cpp 直连用量（config.llamaLogDirs 的 server-<model>.log） ----------
// model-proxy 按需拉起 llama-server，每次运行把输出截断重写进 server-<model>.log。日志对
// 每个完成的请求打一组计时行（时间戳是开机以来的 uptime，没有墙钟，日归属只能落在读取当天）：
//   print_timing: ... | prompt eval time = ... ms / A tokens   实际评估的 prompt（不含缓存复用）
//   print_timing: ... |        eval time = ... ms / B tokens   生成的 token 数
//   slot release: ... | stop processing: n_tokens = N           请求结束时的上下文长度
// 与 Hermes 账本同口径的还原：in（完整 prompt，含缓存读）= N − B + 1（llama.cpp 的 n_tokens
// 不含最后一个采样 token，实测恰差 1），out = B，缓存读 = in − A。
// 直连方（dsh、运动平台等）不经 Hermes，只有这里能给它们记账；Hermes 自己的本地请求也在
// 同一份日志里，所以入账记毛额，展示层按「模型 × 当日」扣掉 hermes 已入账部分（llamaNetForDay）。
const LLAMA_RUN_MAX_BYTES = 32 * 1024 * 1024; // 与 qoder 全文件补账同限；真实日志是 MB 级，远够不到

// 一份日志 = 一次 llama-server 运行，整个文件解析出累计值后对台账补差额（重复轮询/重启都幂等）。
function parseLlamaRunTokens(text) {
  const tasks = new Map(); // task id -> { pe: 实评估 prompt, ev: 生成, nt: 结束时上下文 }
  for (const line of text.split('\n')) {
    const tm = /\| task (-?\d+) \|/.exec(line);
    if (!tm) continue;
    let t = tasks.get(tm[1]);
    if (!t) { t = {}; tasks.set(tm[1], t); }
    let m;
    if ((m = /prompt eval time =\s*[\d.]+ ms\s*\/\s*(\d+) tokens/.exec(line))) t.pe = +m[1];
    else if ((m = /\|\s+eval time =\s*[\d.]+ ms\s*\/\s*(\d+) tokens/.exec(line))) t.ev = +m[1];
    else if ((m = /stop processing: n_tokens = (\d+)/.exec(line))) t.nt = +m[1];
  }
  const sum = { in: 0, out: 0, cr: 0 };
  for (const t of tasks.values()) {
    const out = t.ev || 0;
    // 缺 release 行（读到时请求还在跑或被砍）：退回实评估 prompt 数、缓存读取 0，宁少勿多
    const inFull = t.nt != null ? Math.max(0, t.nt + 1 - out) : (t.pe || 0);
    sum.out += out;
    sum.in += inFull;
    sum.cr += Math.max(0, inFull - (t.pe || 0));
  }
  return sum;
}

function harvestLlamaLog(tool, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return; } // 去抖窗口过后文件可能已被清理
  if (!stat.isFile() || !stat.size) return;
  const mm = /^server-(.+)\.log$/.exec(path.basename(file));
  if (!mm || /\.err\.log$/i.test(file)) return; // server-*.err.log 是手动调试日志，不按模型账本解析
  const model = mm[1];
  const meta = warehouse.llamaLogs[file] || (warehouse.llamaLogs[file] = { run: '', size: 0 });
  if (stat.size < meta.size) { meta.run = ''; meta.size = 0; } // 比上次小 = 被新运行截断重写，换代
  const firstSight = !meta.run; // 首次见到，或换代后的新运行：按文件最后活动日入账
  if (stat.size > LLAMA_RUN_MAX_BYTES) return; // 异常膨胀的日志不解析，等它换代
  if (!meta.run) meta.run = 'llama:' + model + ':' + Date.now();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; } // 写了一半，等下次变更
  meta.size = stat.size;
  const cum = parseLlamaRunTokens(text);
  if (cum.in || cum.out) {
    // 日志里没有墙钟：存量文件的首次补账落到该运行最后活动的那天（与 hermes/Codex 累计口径一致），
    // 此后实时的增量落读取当天
    const dayKey = firstSight ? localDayKey(new Date(stat.mtimeMs)) : null;
    bankCumulative(meta.run, cum, null, tool, model, dayKey);
    // 日志里出现的模型必是本机推理的，登记成"其中本地模型"（键已存在则不动）
    if (!warehouse.localModels[model]) warehouse.localModels[model] = '127.0.0.1:8080';
  }
  saveWarehouseSoon(); // meta.size 变了也要落盘，重启后才能正确识别换代
}

function setupLlamaWatch(cfg) {
  if (watchedDirs.has(cfg.dir)) return;
  if (!fs.existsSync(cfg.dir)) {
    if (!warnedDirs.has(cfg.dir)) {
      warnedDirs.add(cfg.dir);
      console.warn(`[tower] llama 日志目录不存在，出现后自动接管: ${cfg.dir}`);
    }
    return;
  }
  try {
    const watcher = fs.watch(cfg.dir, { recursive: false }, (_eventType, filename) => {
      if (!filename || !/^server-.*\.log$/.test(filename)) return;
      const fullPath = normalizePath(path.join(cfg.dir, filename));
      clearTimeout(pendingWatches.get(fullPath));
      pendingWatches.set(fullPath, setTimeout(() => {
        pendingWatches.delete(fullPath);
        harvestLlamaLog(cfg.tool, fullPath);
      }, WATCH_DEBOUNCE_MS));
    });
    guardWatcher(watcher, cfg.dir, watchedDirs);
  } catch (err) {
    console.error(`[tower] llama 日志目录监听失败 ${cfg.dir}: ${err.message}`);
    return;
  }
  watchedDirs.add(cfg.dir);
  // 存量补账：日志文件个数是个位数，同步扫完即可
  let entries;
  try { entries = fs.readdirSync(cfg.dir); } catch { return; }
  for (const name of entries) {
    if (/^server-.*\.log$/.test(name)) harvestLlamaLog(cfg.tool, normalizePath(path.join(cfg.dir, name)));
  }
}

// ---------- usage DB 轮询（用量记在 SQLite 里的工具：Hermes） ----------
// Hermes 的账本不在日志文件里，而在 state.db：session_model_usage 每行是 (session, model, task)
// 的累计 token（in/out/缓存读写），billing_base_url 指明请求发往的推理端点——指向本机回环地址的
// 就是本地模型（llama.cpp 等）。sessions 表带标题与 cwd，messages 末条带 role/finish_reason，
// 足以还原"工作中 / 等你确认"。库是 WAL 且常被写，用 node:sqlite 只读连接轮询，读者不阻塞写者；
// 累计值对台账补差额（bankCumulative），重复轮询、重启、Hermes 清理旧会话都不会重复计数。
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node < 22.5：Hermes 接入降级为只探测安装 */ }

const usageDbWarned = new Set(); // 打开失败只警告一次的库
const usageSeeded = new Set();   // 已做过首轮静默补账的 tool（首轮不发时间线事件，不灌历史噪音）
const HERMES_CARD_MAX_AGE_MS = 24 * 3600000; // 与 pruneSessions 的会话卡片生命周期一致

// 本地端点判定：base_url 指向本机回环地址即本地推理（llama.cpp / LM Studio / Ollama）
function isLocalBaseUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(url || ''));
}

function localEndpointOf(url) {
  try { return new URL(url).host; } catch { return String(url || ''); }
}

// 阶段判定：轮到用户说话（assistant 自然收尾）= 等你确认；还在工具循环/生成中 = 工作中
function hermesPhaseOf(lastMsg) {
  if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.fin !== 'stop') return 'working';
  return 'waiting';
}

function pollUsageDbs() {
  if (!DatabaseSync) return;
  for (const cfg of config.usageDbs || []) pollUsageDb(cfg);
}

function pollUsageDb(cfg) {
  let db;
  try {
    db = new DatabaseSync(cfg.db, { readOnly: true });
  } catch (err) {
    if (!usageDbWarned.has(cfg.db)) {
      usageDbWarned.add(cfg.db);
      console.warn(`[tower] usage DB 打不开（卸载了？恢复后自动重试）: ${cfg.db}: ${err.message}`);
    }
    return;
  }
  usageDbWarned.delete(cfg.db);
  try {
    const silent = !usageSeeded.has(cfg.tool); // 首轮只补账不发事件
    if (cfg.tool === 'hermes') pollHermesDb(db, cfg.tool, silent);
    else if (cfg.tool === 'zcode') pollZcodeDb(db, cfg.tool);
    usageSeeded.add(cfg.tool);
  } catch (err) {
    console.warn(`[tower] usage DB 轮询失败（下轮再试）: ${cfg.db}: ${err.message}`);
  } finally {
    db.close();
  }
}

function pollHermesDb(db, tool, silent) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT u.session_id AS sid, u.model AS model, u.task AS task,
           u.billing_provider AS prov, u.billing_base_url AS base, u.billing_mode AS mode,
           u.input_tokens AS tin, u.output_tokens AS tout, u.cache_read_tokens AS tcr,
           u.cache_write_tokens AS tcw, u.last_seen AS seen,
           s.cwd AS cwd, s.git_repo_root AS repo
    FROM session_model_usage u LEFT JOIN sessions s ON s.id = u.session_id
  `).all();

  // 归属：cwd / git 仓库根按前缀归到已发现项目；归不进去退回完整路径，至少能看出发生在哪
  const projOf = raw => {
    if (!raw) return null;
    const p = matchProject(raw);
    return { project: p, display: p ? path.basename(p) : normalizePath(raw) };
  };

  const perSession = new Map(); // sid -> { in, out }，会话卡片上的累计（与台账同源同口径）
  for (const r of rows) {
    const where = projOf(r.cwd || r.repo || '');
    // 键必须含全部 billing 维度：Hermes 的行主键是 (session, model, provider, base, mode, task)，
    // 漏掉任何一维，配置改动产生的孪生行（如 base 尾斜杠差异）就会撞键、吞掉较小那行的账
    bankCumulative(
      `hermes:${r.sid}:${r.model}:${r.prov || ''}:${r.base || ''}:${r.mode || ''}:${r.task || ''}`,
      { in: r.tin || 0, out: r.tout || 0, cr: r.tcr || 0, cw: r.tcw || 0 },
      where ? where.display : null,
      tool,
      r.model || null,
      r.seen ? localDayKey(new Date(r.seen * 1000)) : null, // 历史账落到该行最后为真的那天
    );
    if (isLocalBaseUrl(r.base) && !warehouse.localModels[r.model]) {
      warehouse.localModels[r.model] = localEndpointOf(r.base);
      saveWarehouseSoon();
    }
    let ps = perSession.get(r.sid);
    if (!ps) { ps = { in: 0, out: 0 }; perSession.set(r.sid, ps); }
    ps.in += r.tin || 0;
    ps.out += r.tout || 0;
  }

  // ---- 会话卡片：活跃（未结束且 24 小时内有动静）的 Hermes 会话进"正在发生" ----
  const cands = db.prepare(`
    SELECT id, title, cwd, git_repo_root, model, last_activity_at
    FROM sessions WHERE ended_at IS NULL AND last_activity_at >= ?
  `).all((now - HERMES_CARD_MAX_AGE_MS) / 1000);
  const lastMsgs = new Map(); // sid -> 末条消息（判定阶段用）
  if (cands.length) {
    const marks = cands.map(() => '?').join(',');
    const lrows = db.prepare(`
      SELECT m.session_id AS sid, m.role AS role, m.finish_reason AS fin
      FROM messages m
      JOIN (SELECT session_id, MAX(id) AS mid FROM messages WHERE session_id IN (${marks}) GROUP BY session_id) t
        ON t.mid = m.id
    `).all(...cands.map(c => c.id));
    for (const l of lrows) lastMsgs.set(l.sid, l);
  }

  let changed = false;
  const seenSids = new Set();
  for (const c of cands) {
    seenSids.add(c.id);
    const key = `hermes-db/${c.id}`;
    const prev = sessions.get(key);
    const where = projOf(c.cwd || c.git_repo_root || '');
    const phase = hermesPhaseOf(lastMsgs.get(c.id));
    const usage = perSession.get(c.id) || { in: 0, out: 0 };
    const lastSeen = Math.round((c.last_activity_at || 0) * 1000);
    if (prev && prev.phase === phase && prev.lastSeen === lastSeen
      && prev.tokens.in === usage.in && prev.tokens.out === usage.out
      && prev.title === (c.title || null)) continue;
    changed = true;
    const s = prev || {
      tool, file: key, project: null, fallbackPath: null, title: null, phase: null, phaseSince: null,
      model: null, tokens: { in: 0, out: 0, cr: 0, cw: 0 }, credits: 0, lastSeen: 0, lastEmit: 0, hermesSid: c.id,
    };
    if (where && where.project) { s.project = where.project; s.fallbackPath = null; }
    else if (c.cwd && !s.project) s.fallbackPath = normalizePath(c.cwd);
    const projName = s.project ? path.basename(s.project) : (s.fallbackPath || null);
    if (where && where.project && projects.has(where.project)) {
      const p = projects.get(where.project);
      if (lastSeen >= (p.lastAgentActivity || 0)) p.lastAgentActivity = lastSeen;
    }
    if (c.title) s.title = c.title;
    if (c.model) s.model = c.model;
    s.tokens = { in: usage.in, out: usage.out, cr: 0, cw: 0 };
    s.lastSeen = Math.max(s.lastSeen, lastSeen);
    // 阶段转变才翻 phaseSince；working→waiting 是值得进时间线的转折点，普通活动按 5 分钟节流
    if (phase !== s.phase) {
      s.phaseSince = lastSeen;
      const becameWaiting = !silent && phase === 'waiting' && s.phase === 'working';
      s.phase = phase;
      if (becameWaiting || (!silent && lastSeen - s.lastEmit >= ACTIVITY_EVENT_INTERVAL)) {
        s.lastEmit = lastSeen;
        addEvent({ tool, kind: becameWaiting ? 'waiting' : 'activity', project: projName, detail: c.title || null });
      }
    } else if (!silent && lastSeen - s.lastEmit >= ACTIVITY_EVENT_INTERVAL) {
      s.lastEmit = lastSeen;
      addEvent({ tool, kind: 'activity', project: projName, detail: c.title || null });
    }
    sessions.set(key, s);
  }
  // 会话已结束（ended_at 落值）或冷却超过卡片生命周期：立刻撤卡，别挂一张不会再动的"等你确认"
  for (const [key, s] of sessions) {
    if (s.hermesSid && !seenSids.has(s.hermesSid)) { sessions.delete(key); changed = true; }
  }
  if (changed) scheduleBroadcast();
}

// ---------- zcode 的 usage DB（~/.zcode/cli/db/db.sqlite 的 model_usage 表） ----------
// zcode 自己的完整账本就在本地：model_usage 每行是一次模型请求的真实用量（含重试的每次
// attempt），带 model_id / session_id / started_at，加总与官方"使用统计"页逐 token 一致。
// 日志路径（model-io-*.jsonl）只是这份账本的一个残卷：滚动截断、会话结束即删，永远补不齐，
// 所以 token 一律从 DB 入账，日志只剩会话卡片的标题/阶段/模型。
// 口径：input_tokens 含缓存读（与官方一致），error/cancelled 行用量本就是 0，全部行都计入。
// 入账走 bankByDay 按 (会话, 模型, 日) 补差额：重复轮询、重启、行后补用量（发起时 0、完成时
// 回填）都只补差额；switch 之前日志时代已入账的量按会话折抵（见下），总量收敛到 DB 真值。
function pollZcodeDb(db, tool) {
  // 日志时代的历史账：model-io-*.jsonl 台账键按会话折抵。键名里的 sess_* 就是 DB 的 session id。
  const legacyBySid = new Map();
  for (const [file, led] of warehouse.files) {
    const m = file.match(/^model-io-(sess.+)\.jsonl$/);
    if (m) legacyBySid.set(m[1], led);
  }

  const rows = db.prepare(`
    SELECT u.session_id AS sid, u.model_id AS model, s.directory AS dir,
           strftime('%Y-%m-%d', u.started_at / 1000.0, 'unixepoch', 'localtime') AS dk,
           SUM(u.input_tokens) AS tin, SUM(u.output_tokens) AS tout,
           SUM(u.cache_read_input_tokens) AS tcr
    FROM model_usage u LEFT JOIN session s ON s.id = u.session_id
    WHERE u.started_at IS NOT NULL
    GROUP BY u.session_id, u.model_id, dk
  `).all();

  // 按 (会话, 模型) 聚出各日的累计目标；顺手聚出会话级合计给卡片用
  const groups = new Map();   // "sid\x00model" -> { sid, model, dir, byDay, totIn }
  const perSession = new Map(); // sid -> { in, out, cr }，zcode 会话卡片的 token 与台账同源
  for (const r of rows) {
    const model = r.model || '';
    const gkey = r.sid + '\x00' + model;
    let g = groups.get(gkey);
    if (!g) {
      g = { sid: r.sid, model: r.model || null, dir: r.dir || null, byDay: {}, totIn: 0 };
      groups.set(gkey, g);
    }
    g.byDay[r.dk] = { in: r.tin || 0, out: r.tout || 0, cr: r.tcr || 0 };
    g.totIn += r.tin || 0;
    let ps = perSession.get(r.sid);
    if (!ps) { ps = { in: 0, out: 0, cr: 0 }; perSession.set(r.sid, ps); }
    ps.in += r.tin || 0;
    ps.out += r.tout || 0;
    ps.cr += r.tcr || 0;
  }
  const dominantModel = new Map(); // sid -> 量最大的模型
  for (const g of groups.values()) {
    const cur = dominantModel.get(g.sid);
    if (!cur || g.totIn > cur.totIn) dominantModel.set(g.sid, { model: g.model, totIn: g.totIn });
  }

  // 归属：session.directory 按前缀归到已发现项目；归不进去退回完整路径（与 Hermes 一致）
  const projNameOf = dir => {
    if (!dir) return null;
    const p = matchProject(dir);
    return p ? path.basename(p) : normalizePath(dir);
  };

  // 折抵种子只种一次、只种在该会话用量最大的模型键上：legacy 是日志口径的会话总量，
  // 不分模型（日志时代 zcode 的量几乎全在一个模型上），种多份会把台账累计抬高成 legacy×N。
  // 有按日日记账的旧条目精确回放；日记账字段诞生前的老条目按 DB 的日分布比例摊派——
  // 总量仍然精确，日归属近似。
  const seedLegacy = (name, g) => {
    const legacy = g.model && g.model === (dominantModel.get(g.sid) || {}).model
      ? legacyBySid.get(g.sid) : null;
    if (!legacy) return;
    const led = ledgerFor(name, tool);
    const booked = led.days || (led.days = {});
    const bump = (dk, v) => {
      const b = booked[dk] || (booked[dk] = { in: 0, out: 0, cr: 0, cw: 0, credits: 0 });
      b.in += v.in || 0; b.out += v.out || 0; b.cr += v.cr || 0; b.cw += v.cw || 0; b.credits += v.credits || 0;
    };
    if (legacy.days && Object.keys(legacy.days).length) {
      for (const [dk, v] of Object.entries(legacy.days)) bump(dk, v);
      return;
    }
    const legacyIn = legacy.in || 0;
    if (!legacyIn) return;
    const days = Object.keys(g.byDay);
    for (const dk of days) {
      // 份额按该模型组自己的 in 合计归一（多模型会话不能跨模型归一）；
      // out / cr 与 in 同比例摊派
      const share = g.byDay[dk].in / (g.totIn || 1);
      bump(dk, {
        in: Math.round(legacyIn * share),
        out: Math.round((legacy.out || 0) * share),
        cr: Math.round((legacy.cr || 0) * share),
      });
    }
  };

  for (const g of groups.values()) {
    const name = `zcode-db:${g.sid}:${g.model || ''}`;
    if (!warehouse.files.has(name)) seedLegacy(name, g);
    bankByDay(name, g.byDay, projNameOf(g.dir), tool, g.model);
  }

  // legacy 里有、DB 里已经查不到的会话（DB 清理了旧行）：原账还在 model-io 键里，但那批键
  // 已从分工具累计里排除，搬进孤儿键保住这笔账，总量不丢
  for (const [sid, led] of legacyBySid) {
    if (perSession.has(sid) || !(led.in || led.out || led.cr)) continue;
    bankCumulative(`zcode-db:orphan:${sid}`, { in: led.in || 0, out: led.out || 0, cr: led.cr || 0, cw: led.cw || 0 }, null, tool, null);
  }

  // 会话卡片：zcode 的卡还是由日志监听挂（只有它能给出工作中的阶段），token 改从 DB 供给
  let changed = false;
  for (const [key, s] of sessions) {
    if (s.tool !== 'zcode') continue;
    const m = path.basename(key).match(/^model-io-(sess.+)\.jsonl$/);
    if (!m) continue;
    const tot = perSession.get(m[1]);
    if (!tot) continue;
    if (s.tokens.in !== tot.in || s.tokens.out !== tot.out || s.tokens.cr !== tot.cr) {
      s.tokens = { in: tot.in, out: tot.out, cr: tot.cr, cw: 0 };
      changed = true;
    }
  }
  if (changed) scheduleBroadcast();
}

function pruneSessions() {
  const dayAgo = Date.now() - 86400000;
  for (const [file, s] of sessions) {
    if (s.lastSeen < dayAgo) sessions.delete(file);
  }
}

// ---------- hook 事件端点 ----------
// POST body 统一读取：限长 + JSON 解析，失败回 400
function readJsonBody(req, res, cb) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 65536) req.destroy();
  });
  req.on('end', () => {
    let obj;
    try {
      obj = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad json');
      return;
    }
    cb(obj);
  });
}

function handleHookEvent(req, res) {
  // 自定义头是防伪造的关键：浏览器里任意网页都能向 localhost 发 no-cors POST，
  // 但带自定义头会触发 CORS 预检，服务端不应答预检，跨站请求就被浏览器自己拦下了
  if (req.headers['x-wb-hook'] !== '1') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing x-wb-hook header');
    return;
  }
  readJsonBody(req, res, ev => {
    if (!ev.tool || !ev.kind) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('need tool & kind');
      return;
    }
    let projectName = null;
    if (ev.project) {
      const key = normalizePath(ev.project);
      // 先精确命中，再按"项目根/子路径"前缀归到已发现的项目（必须遍历 keys，values 是状态对象拼不成路径）
      const prefix = projects.has(key) ? key : [...projects.keys()].find(p => key.startsWith(p + '/') || key.startsWith(p + '\\'));
      const proj = prefix ? projects.get(prefix) : null;
      if (proj) {
        projectName = proj.name;
        proj.lastAgentActivity = Date.now();
      } else {
        projectName = key; // 未注册的路径也照记，页面上能看到完整路径
      }
    }
    addEvent({
      tool: String(ev.tool).slice(0, 20),
      kind: String(ev.kind).slice(0, 30),
      project: projectName,
      detail: ev.detail ? String(ev.detail).slice(0, 500) : null,
    });
    sendJson(res, { ok: true });
  });
}

// 项目隐藏/恢复：body { path, restore? }。与 hook 端点共用 x-wb-hook 这道跨站防线
function handleProjectHide(req, res) {
  if (req.headers['x-wb-hook'] !== '1') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing x-wb-hook header');
    return;
  }
  readJsonBody(req, res, body => {
    const key = normalizePath(body.path || '');
    if (!key || key === '/') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('need path');
      return;
    }
    if (body.restore) {
      hiddenProjects.delete(key);
    } else {
      const proj = projects.get(key);
      if (!proj) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('unknown project');
        return;
      }
      hiddenProjects.set(key, proj.name);
    }
    saveHiddenProjects();
    discoverProjects(); // 立刻生效，不等下一轮轮询
    scheduleBroadcast();
    sendJson(res, { ok: true, hidden: [...hiddenProjects.entries()].map(([p, name]) => ({ path: p, name })) });
  });
}

// 项目新建/添加：path 不存在 → 创建目录并 git init；已存在 → 直接纳入监控（没有 .git 也补一个，
// "项目"在本工具里以 git 仓库为锚）。主动添加等于"重新计入"：该路径之前被隐藏过，这里自动恢复。
function handleProjectCreate(req, res) {
  if (req.headers['x-wb-hook'] !== '1') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing x-wb-hook header');
    return;
  }
  readJsonBody(req, res, body => {
    const raw = String(body.path || '').trim();
    if (!/^[a-zA-Z]:[\\/]/.test(raw)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('need absolute path like D:/foo/bar');
      return;
    }
    const key = normalizePath(raw);
    if (/^[a-zA-Z]:$/.test(key)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('path too shallow');
      return;
    }
    (async () => {
      const result = { created: false, gitInit: false };
      if (!fs.existsSync(key)) {
        fs.mkdirSync(key, { recursive: true });
        result.created = true;
      } else if (!fs.statSync(key).isDirectory()) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not a directory');
        return;
      }
      if (!fs.existsSync(path.join(key, '.git'))) {
        result.gitInit = await gitInit(key);
      }
      if (hiddenProjects.has(key)) {
        hiddenProjects.delete(key);
        saveHiddenProjects();
      }
      userProjects.add(key);
      saveUserProjects();
      discoverProjects();
      scheduleBroadcast();
      sendJson(res, { ok: true, path: key, name: path.basename(key), ...result });
    })().catch(err => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err.message);
    });
  });
}

// 在资源管理器里打开项目文件夹
function handleProjectOpen(req, res) {
  if (req.headers['x-wb-hook'] !== '1') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing x-wb-hook header');
    return;
  }
  readJsonBody(req, res, body => {
    const key = normalizePath(body.path || '');
    if (!projects.has(key) || !fs.existsSync(key)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unknown project');
      return;
    }
    // explorer.exe 打开成功也是退出码 1，不能当失败处理，发起即视为成功
    execFile('explorer.exe', [key], { windowsHide: true }, () => {});
    sendJson(res, { ok: true });
  });
}

// VS Code 可用性探测：PATH 里 where 得到 code 才算装了（code 实为 code.cmd，直 spawn 须经 shell）
let editorAvailable = false;
function probeEditor() {
  execFile('where', ['code'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
    editorAvailable = !err && String(stdout).trim().length > 0;
  });
}

// 用 VS Code 打开项目；没装（探测失败）回 404，前端按钮同样不显示
function handleProjectEdit(req, res) {
  if (req.headers['x-wb-hook'] !== '1') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing x-wb-hook header');
    return;
  }
  readJsonBody(req, res, body => {
    const key = normalizePath(body.path || '');
    if (!projects.has(key) || !fs.existsSync(key)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unknown project');
      return;
    }
    if (!editorAvailable) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('editor not available');
      return;
    }
    // code 实为 code.cmd，不能直接 spawn（Node 拒绝 .cmd）；经 cmd /d /s /c 包装，
    // 含空格的路径由 Node 按单参数加引号，不会被 shell 拆散。
    // detached + unref 让编辑器进程独立于服务存活；探测与实际启动之间可能变化，启动失败忽略
    const child = spawn('cmd', ['/d', '/s', '/c', 'code', key], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    sendJson(res, { ok: true });
  });
}

// ---------- 快照与推送 ----------
function snapshot() {
  const score = p => Math.max(p.lastAgentActivity || 0, (p.lastCommit && Date.parse(p.lastCommit.time)) || 0);
  return {
    now: new Date().toISOString(),
    liveWindowMs: config.liveWindowMs,
    editorAvailable,
    away: awayFrozen || awayLive(),
    projects: [...projects.values()]
      .map(p => ({
        name: p.name,
        path: p.path,
        branch: p.branch,
        dirty: p.dirty,
        ahead: p.ahead,
        behind: p.behind,
        error: p.error,
        lastCommit: p.lastCommit,
        lastAgentActivity: p.lastAgentActivity,
      }))
      .sort((a, b) => score(b) - score(a)),
    sessions: [...sessions.values()]
      .map(s => ({
        tool: s.tool,
        project: sessionProjName(s),
        file: path.basename(s.file),
        title: s.title,
        phase: s.phase,
        phaseSince: s.phaseSince,
        model: s.model,
        tokens: { in: s.tokens.in, out: s.tokens.out },
        credits: s.credits || undefined, // 只报 credits 的工具（Qoder）在卡片上单独一行
        lastSeen: s.lastSeen,
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen),
    hiddenProjects: [...hiddenProjects.entries()].map(([p, name]) => ({ path: p, name })),
    events,
  };
}

// Electron 壳在托盘态用的轻量端点：只有等待中的会话，几秒一轮也不拖带宽
function waitingPayload() {
  const list = [...sessions.values()]
    .filter(s => s.phase === 'waiting')
    .map(s => ({
      key: s.tool + '|' + path.basename(s.file),
      tool: s.tool,
      file: path.basename(s.file),
      title: s.title,
      project: sessionProjName(s), // 与主快照同口径：归不进已发现项目时退回日志里的真实路径
      phaseSince: s.phaseSince,
    }))
    .sort((a, b) => (b.phaseSince || 0) - (a.phaseSince || 0));
  return { now: new Date().toISOString(), waiting: list.length, sessions: list };
}

let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer) return; // 500ms 内的多次变化合并成一次推送
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = JSON.stringify({ type: 'state', state: snapshot() });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg);
    }
  }, 500);
}

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state' && req.method === 'GET') return sendJson(res, snapshot());
  if (url.pathname === '/api/waiting' && req.method === 'GET') return sendJson(res, waitingPayload());
  if (url.pathname === '/api/stats' && req.method === 'GET') return sendJson(res, statsPayload());
  if (url.pathname === '/api/event' && req.method === 'POST') return handleHookEvent(req, res);
  if (url.pathname === '/api/projects/hide' && req.method === 'POST') return handleProjectHide(req, res);
  if (url.pathname === '/api/projects/create' && req.method === 'POST') return handleProjectCreate(req, res);
  if (url.pathname === '/api/projects/open' && req.method === 'POST') return handleProjectOpen(req, res);
  if (url.pathname === '/api/projects/edit' && req.method === 'POST') return handleProjectEdit(req, res);
  if (url.pathname === '/' && req.method === 'GET') {
    return fs.readFile(path.join(ROOT, 'public', 'index.html'), (err, buf) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('页面文件缺失');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.on('error', err => {
  console.error('[tower] 启动失败:', err.message);
  process.exit(1);
});

const wss = new WebSocketServer({ server });

// ---------- 启动 ----------
// 导出内部函数供自检脚本只读复用；只有直接运行本文件才拉起服务
module.exports = {
  activityExtractors, discoverProjects, matchProject, sniffProjectText, parseAheadBehind,
  scanQoder, scanClaude, extractMeta, newSession, touchSession, sessions, config, warehouse, loadWarehouse,
  ledgerFor, bankByDay, bankCumulative, bankIncremental, applyTokens, normalizePath, localDayKey,
  pollUsageDbs, pollHermesDb, pollZcodeDb, isLocalBaseUrl, hermesPhaseOf, statsPayload, dshDecompressAll,
  parseLlamaRunTokens, harvestLlamaLog, llamaNetForDay, llamaToolBucketOf, llamaDayDelta,
  byToolTotals, readHeartbeat, parseHeartbeat, awayDeltaOf,
};

if (require.main === module) {
  loadHistory();
  loadWarehouse();
  awayBaseline = readHeartbeat();
  if (awayBaseline) {
    // 有基线：核对窗结束才落本轮第一跳。提前落跳会把"离线从何时算起"的基线冲掉，
    // 报告还没定格就没了（90 秒内崩溃重启的场景，报告就靠旧基线活下来）
    setTimeout(() => {
      freezeAway();
      writeHeartbeat();
      setInterval(writeHeartbeat, 60000).unref();
    }, AWAY_SETTLE_MS).unref();
  } else {
    // 首轮没有基线可冲：立刻开始给下一轮留基线
    writeHeartbeat();
    setInterval(writeHeartbeat, 60000).unref();
  }
  process.on('exit', writeHeartbeat); // 退出前补一跳，离线窗口的尾巴最多差一个心跳周期
  loadHiddenProjects();
  loadUserProjects();
  discoverProjects();
  watchAllDirs(); // 含启动时对每个会话目录的热文件补扫、归档存量的首次收割
  probeEditor();
  pollAll();
  setInterval(() => {
    pruneSessions();
    discoverProjects();
    watchAllDirs(); // 周期重试：晚出现的目录（如 Claude Code 首次运行）在这里被接管
    pollAll();
  }, config.pollIntervalMs);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[tower] 监控台已启动: http://localhost:${PORT}`);
  });
}

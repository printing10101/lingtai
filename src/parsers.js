// src/parsers.js — 纯文本解析层：不碰 IO、不碰网络，输入是命令/日志原文，输出是结构化对象。
// 拆成纯函数的理由：看板的可信度全押在解析对不对上，纯函数才能用固定样本（fixtures）钉死。
'use strict';

const ISO_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*(.*)$/;

// ---------- netstat ----------
// 目的：找出「此刻正连着网关的客户端进程 PID」。
// 两个必须守住的条件：
//   1) 只认回环地址。踩过的坑：QQ 有一条到 43.135.106.161:8080 的外网连接，
//      早期只按端口尾缀匹配，看板就把「谁在调用」报成了 QQ.exe —— 端口同号不等于同一个服务。
//   2) 只有 ESTABLISHED 行带得出客户端 PID；短连接会落进 TIME_WAIT 且 PID 恒为 0（Windows 行为），
//      那种抓不到调用方 —— 但条数是真有人在打的证据，所以单独计数返回，不假装全知。
const LOOP = ep => /^127\./.test(ep) || ep === '::1' || ep === '[::1]' || /^::1:/.test(ep);

function parseNetstat(text, port) {
  const clients = new Map(); // pid -> { pid, conns: [] }
  const closedPorts = new Set(); // 已关闭连接的「 ephemeral 端口」，两个方向去重后只算一条
  let listenerPid = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^TCP/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;
    const [, local, remote, state, pidStr] = cols;
    const pid = Number(pidStr);
    const bare = ep => ep.replace(/:(\d+)$/, '').replace(/^\[(.*)\]$/, '$1');
    const tail = ep => (ep.match(/:(\d+)$/) || [])[1];
    const toPort = tail(remote) === String(port);
    const fromPort = tail(local) === String(port);

    if (state === 'LISTENING' && fromPort && LOOP(bare(local))) { listenerPid = Number.isFinite(pid) ? pid : null; continue; }
    if ((!toPort && !fromPort) || !LOOP(bare(remote)) || !LOOP(bare(local))) continue; // 与本机网关无关
    if (state === 'TIME_WAIT' || state === 'CLOSE_WAIT' || state === 'LAST_ACK') {
      closedPorts.add(toPort ? tail(local) : tail(remote));
      continue;
    }
    if (state !== 'ESTABLISHED') continue;
    if (fromPort) continue; // 服务端侧那一行，别把网关自己算成调用方
    if (!Number.isFinite(pid) || pid === 0 || pid === listenerPid) continue;
    if (!clients.has(pid)) clients.set(pid, { pid, conns: [] });
    clients.get(pid).conns.push({ from: local, to: remote });
  }
  return {
    listenerPid,
    closedConns: closedPorts.size,
    clients: [...clients.values()].sort((a, b) => a.pid - b.pid),
  };
}

// ---------- tasklist /FO CSV /NH ----------
// 用 CSV 而不是默认表格：默认表头与列宽在中英文控制台里不稳，CSV 恒定 5 列。
function parseTasklistCsv(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = [];
    const re = /"((?:[^"]|"")*)"/g;
    let m;
    while ((m = re.exec(line))) cols.push(m[1].replace(/""/g, '"'));
    if (cols.length < 5) continue;
    const [name, pidStr, session, sessId, mem] = cols;
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) continue;
    map.set(pid, { pid, name, session: session, sessionId: Number(sessId) || 0, memText: mem });
  }
  return map;
}

// ---------- nvidia-smi ----------
// --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits
// 温度/功耗是后加的列：老样本只有 4 列，缺列时留 null，不能让解构炸掉。
function parseGpuCsv(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^name/i.test(line)) continue;
    const cols = line.split(',').map(s => s.trim());
    if (cols.length < 4) continue;
    const [name, total, used, util, temp, power] = cols;
    const n = s => { const v = parseFloat(String(s).replace(/[^\d.]/g, '')); return Number.isFinite(v) ? v : null; };
    out.push({ name, totalMiB: n(total), usedMiB: n(used), utilPct: n(util), tempC: n(temp), powerW: n(power) });
  }
  return out;
}

// --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
// 注意：桌面/图形上下文进程在这列常给 [N/A] 或空，不能据此判「没占显存」。
// 拆列只能从两端取：pid 与内存列都不含逗号，中间整段才是进程名（完整路径里可能有逗号），
// 因此不能用固定 split(',') —— 实测那样会把 "15846 MiB" 吃进名字里、memMiB 变 null。
function parseComputeApps(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstComma = line.indexOf(',');
    if (firstComma < 0) continue;
    const pid = Number(line.slice(0, firstComma).replace(/[^\d]/g, ''));
    const rest = line.slice(firstComma + 1).trim();
    const lastComma = rest.lastIndexOf(',');
    let name = rest, memRaw = '';
    if (lastComma > 0) { name = rest.slice(0, lastComma).trim(); memRaw = rest.slice(lastComma + 1); }
    const memMiB = parseFloat(String(memRaw).replace(/[^\d.]/g, ''));
    out.push({
      pid: Number.isFinite(pid) ? pid : null,
      name: name.replace(/^"|"$/g, ''),
      memMiB: Number.isFinite(memMiB) ? memMiB : null,
    });
  }
  return out;
}

// ---------- 网关进程命令行 ----------
// llama-server 的 -m 就是当前驻留权重的绝对路径，比 /props 更权威（不依赖上游活着）。
function parseLlamaCmdline(cmd) {
  const s = String(cmd || '');
  const flag = f => {
    const m = s.match(new RegExp('(?:^|\\s)' + f + '(?:\\s+|=)(?:"([^"]+)"|(\\S+))'));
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  };
  const num = f => { const v = flag(f); return v === null ? null : (Number(v) !== null && Number.isFinite(Number(v)) ? Number(v) : v); };
  return {
    modelFile: flag('-m') || flag('--model'),
    ctx: num('-c') ?? num('--ctx-size'),
    ngl: num('-ngl') ?? num('--n-gpu-layers'),
    np: num('-np') ?? num('--parallel'),
    port: num('--port') ?? num('-p'),
    threads: num('-t') ?? num('--threads'),
    cpuMoe: num('--n-cpu-moe'),
    alias: flag('--alias') || null,
    raw: s,
  };
}

// ---------- 注册表 ∩ 盘上文件 ----------
// 单独抽出来，是因为「注册了但 GGUF 不在盘上」与「请求了个压根没注册的名」是两种不同的病，
// 看板上要分得开：前者标 missing，后者由事件流里的 unknown-model 承担。
function joinRegistry(regObj, filesOnDisk) {
  const models = Array.isArray(regObj && regObj.models) ? regObj.models : [];
  return models.map(m => {
    const f = filesOnDisk[m.file] || null;
    return {
      id: m.id,
      file: m.file,
      ctx: m.ctx ?? null,
      ncpuMoe: m.ncmoe ?? 0,
      sizeMB: f ? Math.round(f.size / 1048576) : null,
      mtime: f ? f.mtime : null,
      exists: !!f,
    };
  });
}

// 客户端在请求、但既没注册或盘上没有的名 —— 幽灵请求。日志里表现为「从来没被 bringing up 成功过」。
function phantomIds(events, knownIds) {
  const known = new Set(knownIds);
  const counts = new Map();
  for (const e of events) {
    if (e.kind !== 'switch' || !e.model) continue;
    if (!known.has(e.model)) counts.set(e.model, (counts.get(e.model) || 0) + 1);
  }
  return [...counts.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n);
}

// ---------- proxy.log ----------
const EVENT_PATTERNS = [
  ['listen', /model-proxy v[\d.]+ listening on (\d+)/, m => ({ port: Number(m[1]) })],
  ['switch', /bringing up: (\S+) \(previous: (\S+|null)\)/, m => ({ model: m[1], prev: m[2] === 'null' ? null : m[2] })],
  ['launch', /launched (\S+) on port (\d+) \(wrapper pid (\d+)\)/, m => ({ model: m[1], port: Number(m[2]), wrapperPid: Number(m[3]) })],
  ['serving', /now serving: (\S+)/, m => ({ model: m[1] })],
  ['restart_for', /upstream alive but serving (\S+) - restarting for (\S+)/, m => ({ model: m[2], prev: m[1] })],
  ['fail', /respawn\/retry failed: (.*)/, m => ({ detail: m[1] })],
  ['dead', /upstream dead \((\w+)\), respawning (\S+)/, m => ({ code: m[1], model: m[2] })],
  ['idle_stop', /idle (\d+)min, stopping upstream/, m => ({ minutes: Number(m[1]) })],
  ['error', /proxy error: (.*)/, m => ({ detail: m[1] })],
  ['fatal', /FATAL: cannot listen on (\d+) - (.*)/, m => ({ port: Number(m[1]), detail: m[2] })],
  ['timeout', /model load timeout: (\S+)/, m => ({ model: m[1] })],
];

function parseProxyLog(text) {
  const events = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(ISO_RE);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts)) continue;
    const body = m[2];
    let hit = null;
    for (const [kind, re, pick] of EVENT_PATTERNS) {
      const mm = body.match(re);
      if (mm) { hit = { ts, iso: m[1], kind, text: body, ...pick(mm) }; break; }
    }
    if (!hit) hit = { ts, iso: m[1], kind: 'other', text: body };
    events.push(hit);
  }
  return events;
}

// 汇总：这一层就是「要不要上 B」的判据来源，所以口径要能自证。
// 冷加载耗时 = 同一条串行链上 bringing up → 紧随的 now serving，间隔 >200s 视为跨了别的周期，丢弃。
function summarizeEvents(events) {
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

  const switches = events.filter(e => e.kind === 'switch');
  const gaps = [];
  const pairs = new Map();
  for (let i = 1; i < switches.length; i++) {
    const a = switches[i - 1], b = switches[i];
    const sec = (b.ts - a.ts) / 1000;
    if (sec < 0) continue;
    if (sec < 60) gaps.push(Math.round(sec));
    if (a.model && b.model && a.model !== b.model) {
      const k = a.model + ' -> ' + b.model;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }

  const cold = [];
  let pending = null;
  for (const e of events) {
    if (e.kind === 'switch') { pending = { model: e.model, ts: e.ts }; continue; }
    if (e.kind === 'serving' && pending && pending.model === e.model) {
      const sec = (e.ts - pending.ts) / 1000;
      if (sec >= 0 && sec <= 200) cold.push(Math.round(sec));
      pending = null;
    }
  }
  cold.sort((a, b) => a - b);
  const pct = q => (cold.length ? cold[Math.min(cold.length - 1, Math.floor(cold.length * q))] : null);

  const byDay = {};
  for (const e of switches) {
    const d = e.iso.slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  }

  const topPairs = [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([edge, n]) => ({ edge, n }));

  // 乒乓按「无向边」计：A→B 与 B→A 是同一次互踢的两半，分开设成两行会把问题说小。
  const undirected = new Map();
  for (const { edge, n } of topPairs) {
    const [a, b] = edge.split(' -> ');
    const k = [a, b].sort().join(' <-> ');
    undirected.set(k, (undirected.get(k) || 0) + n);
  }
  const worstEdge = [...undirected.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  return {
    total: events.length,
    byKind,
    switches: switches.length,
    launches: byKind.launch || 0,
    fails: (byKind.fail || 0) + (byKind.timeout || 0) + (byKind.fatal || 0),
    pingPongPairs: gaps.length,
    shortestPingPongSec: gaps.length ? Math.min(...gaps) : null,
    coldSec: { samples: cold.length, min: cold.length ? cold[0] : null, p50: pct(0.5), p95: pct(0.95), max: cold.length ? cold[cold.length - 1] : null },
    byDay,
    topPairs,
    worstEdge: worstEdge ? { edge: worstEdge[0], n: worstEdge[1] } : null,
    firstTs: events.length ? events[0].ts : null,
    lastTs: events.length ? events[events.length - 1].ts : null,
    truncated: false, // 由调用方按「首行时间远晚于文件创建时间」推断，这里不自证
  };
}

// ---------- 自建历史抽稀 ----------
// 轮转用：samples.jsonl 15 s 一条 ≈ 700 KB/天，常驻一年 250 MB+，超限就按 factor 抽稀。
// 纯函数是为了能用固定样本钉死「首行末行必留、末行不重」——驻留时段的边界粗化到
// factor×15 s，对「各模型驻留多久」这个用途足够。
function thinHistoryLines(lines, factor) {
  const n = lines.length;
  const f = Math.max(2, Math.floor(factor) || 2);
  if (n <= f * 10) return lines.slice();
  const out = [];
  for (let i = 0; i < n; i += f) out.push(lines[i]);
  const last = lines[n - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// ---------- 自建事件归档 ----------
// 一条事件的唯一键：归档与日志重叠段的去重靠它。
// text 必须参与：同秒同 kind 的两行原文是两条证据，不能误删。
function eventKey(e) { return e.ts + '|' + e.kind + '|' + e.text; }

// 归档 ∪ 当前日志。输入不保证有序，输出必须按时间有序 ——
// summarizeEvents 的「相邻 switch」口径依赖顺序，乱序会把乒乓对算丢。
function mergeEvents(oldEvents, newEvents) {
  const seen = new Set();
  const out = [];
  for (const e of [...(oldEvents || []), ...(newEvents || [])]) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

module.exports = {
  parseNetstat,
  parseTasklistCsv,
  parseGpuCsv,
  parseComputeApps,
  parseLlamaCmdline,
  joinRegistry,
  phantomIds,
  parseProxyLog,
  summarizeEvents,
  thinHistoryLines,
  eventKey,
  mergeEvents,
};

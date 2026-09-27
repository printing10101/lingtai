// exp-live.js — 实验直播页：独立全屏，只读同一份 /api/state（+ /api/history 做算力走势）。
// 定位是「挂墙上看的大屏」：大进度、大曲线、大数字；口径与主看板实验台逐字一致。
'use strict';

const S = { st: null, samples: [], etaEnd: null, chainEtaEnd: null };
const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const fmtN = v => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1)); // 浮点垃圾到此为止

function fmtDurSec(sec) {
  if (sec == null) return '—';
  if (sec <= 0) return '0 s';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? h + ' h ' + String(m).padStart(2, '0') + ' min' : (m >= 1 ? m + ' min' : Math.round(sec) + ' s');
}
function fmtHm(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return esc((d.getMonth() + 1) + '-' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()));
}
function clockAt(ms) {
  const d = new Date(ms);
  const today = new Date();
  const day = d.getDate() !== today.getDate() ? (d.getMonth() + 1) + '/' + d.getDate() + ' ' : '';
  return day + d.toTimeString().slice(0, 5);
}
// tile：大数字小标签，直播屏的基本单元
const tile = (v, l, cls, note) => '<div class="ltile ' + (cls || '') + '"><b>' + (v == null ? '—' : v) + '</b><span>' + esc(l) + '</span>'
  + (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';

const EXP_TXT = { running: '运行中', stalled: '疑似卡住', interrupted: '中断', done: '完成', unknown: '未测到' };

/* ---------- 大曲线：best/mean 双线 + 阶段背景分隔 ---------- */
function bigCurve(curve, cfg) {
  if (!curve || curve.length < 3) return '<div class="empty-state">曲线数据还不足（≥3 代后出现）</div>';
  const W = 600, H = 170;
  const vals = curve.flatMap(p => [p.best, p.mean]).filter(v => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
  const X = i => (i / (curve.length - 1)) * W;
  const Y = v => H - 6 - ((v - lo) / span) * (H - 14);
  const line = key => curve.map((p, i) => X(i).toFixed(1) + ',' + (p[key] == null ? Y(lo) : Y(p[key])).toFixed(1)).join(' ');
  // 阶段分隔：曲线点自带 stage 列，边界处画竖线
  const marks = [];
  if (cfg && cfg.stageGens) {
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].stage != null && curve[i].stage !== curve[i - 1].stage) {
        marks.push('<line class="cmark" x1="' + X(i).toFixed(1) + '" y1="4" x2="' + X(i).toFixed(1) + '" y2="' + (H - 4) + '"/>');
      }
    }
  }
  const last = curve[curve.length - 1];
  return '<svg class="bigcurve" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<line class="cgrid" x1="0" y1="' + (H / 2).toFixed(1) + '" x2="' + W + '" y2="' + (H / 2).toFixed(1) + '"/>' +
    marks.join('') +
    '<polyline class="s-mean" points="' + line('mean') + '"/>' +
    '<polyline class="s-best" points="' + line('best') + '"/>' +
    '</svg>' +
    '<div class="curve-axis"><span>gen ' + esc(curve[0].g) + '</span>' +
    '<span>best 峰 ' + esc(fmtN(hi)) + ' · 谷 ' + esc(fmtN(lo)) + '</span>' +
    '<span>gen ' + esc(last.g) + '</span></div>' +
    '<div class="legend note">绿线 best · 蓝线 mean · 竖线 = 阶段边界（数据源 gen_log.csv，逐代）</div>';
}

/* ---------- 阶段药丸：S1 ✓ → S2 ● → S3 ○ ---------- */
function stagePills(r) {
  if (!r.cfg || !r.cfg.stagesCount || !r.cfg.stageGens) return '';
  const n = r.cfg.stagesCount;
  const cur = Math.min(n, Math.floor(r.gens / r.cfg.stageGens) + 1);
  const curName = r.stageLabel || ('S' + cur);
  let out = '';
  for (let i = 1; i <= n; i++) {
    const state = i < cur ? 'done' : i === cur ? (r.status === 'running' ? 'now' : 'stall') : 'todo';
    const name = i === cur ? curName : 'S' + i;
    out += '<span class="pill ' + state + '">' + esc(name) + '</span>';
    if (i < n) out += '<span class="pill-arrow">→</span>';
  }
  return '<div class="pills">' + out + '</div>';
}

/* ---------- 大进度条 ---------- */
function heroBar(r) {
  const pct = r.pct == null ? 0 : Math.max(0, Math.min(100, r.pct));
  const tone = r.status === 'stalled' || r.status === 'interrupted' ? ' bad' : '';
  return '<div class="hero-bar"><i class="' + tone.trim() + '" style="width:' + pct + '%"></i>' +
    '<b>' + (r.pct == null ? '—' : r.pct + '%') + '</b>' +
    '<em>' + esc(r.gens != null && r.totalGens ? r.gens + ' / ' + r.totalGens + ' 代' : '') + '</em></div>';
}

/* ---------- 链段时间轴：总组数分段，跳过/完成/当前/排队四色 ---------- */
function chainStrip(chain) {
  if (!chain || !chain.batches.length) return '';
  const b = chain.batches[chain.batches.length - 1];
  if (!b.total) return '';
  const segs = [];
  for (let i = 1; i <= b.total; i++) {
    let cls = 'queued';
    if (i <= b.counts.skip) cls = 'skip';
    else if (i <= b.counts.skip + b.counts.done) cls = 'done';
    else if (b.current && i === b.current.idx) cls = 'now';
    segs.push('<i class="' + cls + '"' + (b.current && i === b.current.idx ? ' title="当前 ' + esc(b.current.tag) + '"' : '') + '></i>');
  }
  const head = esc(b.name) + ' · 第 ' + (b.current ? b.current.idx : '—') + '/' + b.total + ' 组' +
    (b.current ? ' · ' + esc(b.current.tag) : '');
  return '<div class="chain"><div class="chain-head">' + head +
    '<span>跳过 ' + b.counts.skip + ' · 完成 ' + b.counts.done + ' · 排队 ' +
    Math.max(0, b.total - b.counts.skip - b.counts.done - (b.current ? 1 : 0)) + '</span></div>' +
    '<div class="chain-segs">' + segs.join('') + '</div></div>';
}

/* ---------- 遥测：GPU 大数字 + 近 4 h 利用率走势 ---------- */
function telemetry(st) {
  const g = st.gpu && st.gpu.gpus && st.gpu.gpus[0];
  if (!g) return '<div class="empty-state">GPU 遥测未测到</div>';
  const pts = S.samples.filter(s => s.utilPct != null).slice(-960); // 15 s/条 ≈ 4 h
  let spark = '';
  if (pts.length > 3) {
    const W = 100, H = 22;
    const poly = pts.map((p, i) => ((i / (pts.length - 1)) * W).toFixed(2) + ',' + (H - 1 - (p.utilPct / 100) * (H - 2)).toFixed(2)).join(' ');
    spark = '<svg class="gspark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><polyline points="' + poly + '"/></svg>' +
      '<div class="legend note">利用率走势 · 近 ' + Math.round((pts[pts.length - 1].ts - pts[0].ts) / 60000) + ' min（15 s/点）</div>';
  }
  return '<div class="tiles">' +
    tile(num(g.utilPct) + '%', 'GPU 核心利用率', g.utilPct > 85 ? 'hot' : '') +
    tile(num(g.tempC) != null ? num(g.tempC) + '°C' : '—', '温度（≥80°C 标红）', g.tempC != null && g.tempC >= 80 ? 'hot' : '') +
    tile(g.powerW != null ? num(g.powerW) + ' W' : '—', '整卡功耗') +
    tile(num(g.usedMiB), '显存 MiB / ' + num(g.totalMiB)) +
    '</div>' + spark;
}

/* ---------- 单个 run 的英雄块（primary 大、secondary 中） ---------- */
function runHero(r, big) {
  const bad = r.status === 'stalled' || r.status === 'interrupted';
  const startedMs = r.startedAt ? Date.parse(r.startedAt) : null;
  const elapsed = startedMs ? Math.max(0, (Date.now() - startedMs) / 1000) : null;
  const etaLine = r.etaSec != null
    ? '<b>' + clockAt(S._now + r.etaSec * 1000) + '</b><span>预计结束（' + fmtDurSec(r.etaSec) + ' 后）</span>'
    : '<b>—</b><span>预计结束（速率不足，暂估不出）</span>';
  const stats = '<div class="tiles">' +
    tile(fmtDurSec(elapsed), '已跑时长', '', startedMs ? '起于 ' + fmtHm(r.startedAt) : '') +
    tile(r.rateText ? esc(r.rateText.replace('s/gen', 's/代')) : (r.secPerGen != null ? Number(r.secPerGen).toFixed(1) + ' s/代' : '—'), '代速', '', r.etaBasis ? 'ETA：' + esc(r.etaBasis) : '') +
    tile(r.tqdmStep != null ? r.tqdmStep + '/' + r.tqdmTotal : (r.stageLabel || '—'), '当前阶段', '', r.stageLabel || '') +
    '</div>' +
    '<div class="eta-line">' + etaLine + '</div>';
  return '<section class="hero-run' + (bad ? ' trouble' : '') + (big ? '' : ' mini') + '">' +
    '<div class="run-head"><div class="run-title">' + (big ? '<i class="run-live"></i>' : '') + esc(r.id) +
    '<span class="run-tags">' + esc(EXP_TXT[r.status] || r.status) +
    (r.cfg && r.cfg.seed != null ? ' · seed ' + esc(r.cfg.seed) : '') +
    (r.cfg && r.cfg.encoding ? ' · ' + esc(r.cfg.encoding) : '') + '</span></div></div>' +
    heroBar(r) +
    stagePills(r) +
    stats +
    '</section>';
}

/* ---------- 页面主渲染 ---------- */
function render() {
  const st = S.st;
  if (!st) return;
  const root = el('live-root');
  const ex = st.experiments;
  el('live-clock').textContent = new Date().toTimeString().slice(0, 8);

  if (!ex || ex.status === 'absent') {
    el('live-dot').className = 'live-dot idle';
    el('live-sub').textContent = '实验观测未启用';
    root.innerHTML = '<div class="empty-state">实验观测未启用 —— 往 config.json 的 experiments.sources 加一条即出现</div>';
    return;
  }
  if (ex.status !== 'ok') {
    el('live-dot').className = 'live-dot idle';
    el('live-sub').textContent = '未测到';
    root.innerHTML = '<div class="empty-state">实验台未测到</div><div class="legend">' + esc(ex.error || '') + '</div>';
    return;
  }

  const sources = ex.sources || [];
  const activeAll = sources.flatMap(s => (s.runs || []).filter(r => r.status === 'running' || r.status === 'stalled').map(r => ({ s, r })));
  el('live-dot').className = 'live-dot' + (activeAll.length ? '' : ' idle');
  el('live-sub').textContent = activeAll.length
    ? activeAll.map(x => x.r.id).join(' · ')
    : '空闲 · 今日已完成 ' + sources.reduce((a, s) => a + ((s.summary && s.summary.done) || 0), 0) + ' 组';

  if (!activeAll.length) {
    // 直播间的「没有节目」也要如实：最近收尾的几组 + 各源汇总
    const recent = sources.flatMap(s => (s.runs || []).filter(r => r.status === 'done').slice(0, 4).map(r => ({ s, r })));
    root.innerHTML =
      '<section class="hero-run idle-hero"><div class="run-title">当前没有进行中的实验</div>' +
      '<div class="legend note">判据：' + esc(ex.stallMin) + ' min 内没有新的 gen_log 写入，且 python 进程命令行里没有已注册的 run。</div>' +
      '<div class="tiles">' + sources.map(s => tile(
        String((s.summary && s.summary.done) || 0),
        esc(s.name) + ' 已完成组',
        '', (s.summary && s.summary.interrupted) ? '另有 ' + s.summary.interrupted + ' 组中断未跑完' : ''
      )).join('') + '</div></section>' +
      (recent.length ? '<div class="inv"><div class="inv-head">最近收尾</div>' + recent.map(({ s, r }) => invRow(r, s)).join('') + '</div>' : '') +
      foot(ex);
    return;
  }

  // 主节目：第一个活跃 run 拿全屏英雄位；其余活跃 run 中块
  const primary = activeAll[0];
  const src = primary.s;
  const parts = [];
  parts.push('<div class="src-cap">' + esc(src.name) + '</div>');
  parts.push(runHero(primary.r, true));
  if (src.chain) {
    parts.push(chainStrip(src.chain));
    const ce = src.chainEta;
    if (ce && ce.etaSec != null) {
      S.chainEtaEnd = S._fetchAt + ce.etaSec * 1000;
      parts.push('<div class="chain-eta">全链预计 <b>' + esc(clockAt(S.chainEtaEnd)) + '</b> 完成（还剩 ' + fmtDurSec(ce.etaSec) + '）' +
        '<span>口径：' + esc(ce.basis || '') + '。链内后续批未启动前不可见。</span></div>');
    }
  } else {
    S.chainEtaEnd = null;
  }
  parts.push('<div class="grid-live"><div class="curve-panel"><div class="panel-cap">适应度曲线</div>' +
    bigCurve(primary.r.curve, primary.r.cfg) + '</div>' +
    '<div class="tele-panel"><div class="panel-cap">算力遥测</div>' + telemetry(st) + '</div></div>');

  const others = activeAll.slice(1);
  if (others.length) parts.push('<div class="src-cap">其他在跑</div>' + others.map(x => runHero(x.r, false)).join(''));

  // 全量清单：这个页面的本分是「所有实验的相关信息」
  for (const s of sources) {
    const runs = (s.runs || []).filter(r => r.status !== 'running' && r.status !== 'stalled');
    if (!runs.length && (s.summary && !s.summary.done && !s.summary.interrupted)) continue;
    parts.push('<div class="src-cap">' + esc(s.name) + ' · 全部 run（' + runs.length + '）</div>' +
      '<div class="inv">' + runs.map(r => invRow(r, s)).join('') + '</div>');
  }
  parts.push(foot(ex));
  root.innerHTML = parts.join('');
}

function invRow(r, s) {
  const bad = r.status === 'interrupted' || r.status === 'stalled';
  const durCell = r.status === 'done' && r.finishedAt && r.startedAt
    ? fmtDurSec(Math.max(0, (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000))
    : (r.status === 'running' && r.startedAt ? fmtDurSec((Date.now() - Date.parse(r.startedAt)) / 1000) : '—');
  return '<div class="inv-row' + (bad ? ' bad' : '') + '">' +
    '<div class="inv-name">' + esc(r.id) + '</div>' +
    '<span class="pill ' + (r.status === 'done' ? 'done' : bad ? 'stall' : 'todo') + '">' + esc(EXP_TXT[r.status] || r.status) + '</span>' +
    '<div class="inv-nums">' +
    '<div><b>' + (r.gens != null && r.totalGens ? r.gens + '/' + r.totalGens : '—') + '</b><span>代</span></div>' +
    '<div><b>' + (r.lastBest != null ? esc(fmtN(r.lastBest)) : '—') + '</b><span>best</span></div>' +
    '<div><b>' + esc(durCell) + '</b><span>用时</span></div>' +
    '<div><b>' + (r.finishedAt ? fmtHm(r.finishedAt) : '—') + '</b><span>完成于</span></div>' +
    '</div></div>';
}

function foot(ex) {
  return '<div class="live-foot">进度分母 = run 目录 config.json 的 stages × stage_gens；完成标志 = report.md；' +
    '心跳 = gen_log.csv / 日志 mtime，停 ≥ ' + esc(ex.stallMin) + ' min 且进程在场判「疑似卡住」；' +
    '全部信号只读自实验自产落盘物。数据每 3 s 刷新 · 主看板口径一致。</div>';
}

/* ---------- 取数与节拍 ---------- */
async function fetchState() {
  try {
    S.st = await (await fetch('/api/state')).json();
    S._fetchAt = Date.now();
    S._now = Date.now();
    render();
  } catch (_) { /* 下一轮再试；页面顶条时钟照走 */ }
}
async function fetchHistory() {
  try {
    const h = await (await fetch('/api/history?n=960')).json();
    S.samples = h.samples || [];
    if (S.st) render();
  } catch (_) { /* 遥测走势缺一轮不致命 */ }
}
fetchState();
fetchHistory();
setInterval(fetchState, 3000);
setInterval(fetchHistory, 60000);
setInterval(() => { el('live-clock').textContent = new Date().toTimeString().slice(0, 8); }, 1000);

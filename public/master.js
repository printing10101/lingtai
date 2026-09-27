// 总控大屏渲染层：每 3s 拉 /api/overview，按塔台的 status（ok/stale/down）如实渲染。
// 看板部分（console.state）与本服务同进程，恒为 ok——它就是本服务，不需要给自己亮灯。
// 控制动作直接打本服务已有的 /api/ctl/*，边界与主看板完全同一套。
'use strict';

const $ = sel => document.querySelector(sel);

// ---------- 格式化 ----------
function fmtTok(n) {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (a >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(Math.round(n));
}
function fmtDur(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' 小时 ' + (m % 60) + ' 分';
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 时';
}
function fmtAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  return isNaN(ms) ? '—' : fmtDur(ms) + '前';
}
function fmtMiB(v) { return v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : Math.round(v) + ' MiB'; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function localDayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------- 顶栏 ----------
function setTowerLight(tw) {
  const el = $('#light-tower');
  const dot = el.querySelector('.dot');
  dot.className = 'dot ' + (tw ? tw.status : '');
  el.title = tw ? (tw.status + (tw.error ? ' · ' + tw.error : '') +
    (tw.status === 'stale' ? ' · 数据是 ' + fmtAgo(tw.checkedAt) + ' 的' : '')) : '';
}

// 每张卡的兜底：源不在线时明说，不空转
function renderOffline(cardId, cls, text) {
  $('#' + cardId).innerHTML = $('#' + cardId).querySelector('h2').outerHTML +
    '<div class="offline ' + cls + '">' + esc(text) + '</div>';
}
function srcLine(tw) {
  if (tw && tw.status === 'stale') return '<div class="offline amber">数据是 ' + fmtAgo(tw.checkedAt) + ' 的（' + esc(tw.error || '塔台刚失联') + '），以下为上一份真数据</div>';
  return '';
}

// ---------- 第一排 ----------
function renderGpu(st) {
  const gpu = st && st.gpu;
  if (!gpu || gpu.status !== 'ok' || !gpu.gpus || !gpu.gpus.length) {
    return renderOffline('card-gpu', gpu && gpu.status === 'unknown' ? '' : 'red',
      gpu && gpu.error ? 'GPU 未测到：' + esc(gpu.error) : 'GPU 未测到');
  }
  $('#card-gpu').innerHTML = $('#card-gpu').querySelector('h2').outerHTML + gpu.gpus.map(g => {
    const pct = g.totalMiB ? Math.round(g.usedMiB / g.totalMiB * 100) : 0;
    return '<div class="gpu-row">' +
      '<div class="ring" style="--pct:' + pct + '"><span>' + pct + '%</span></div>' +
      '<div class="gpu-meta">' +
        '<div class="gname">' + esc(g.name) + '</div>' +
        '<div class="kv"><span>显存</span><b>' + fmtMiB(g.usedMiB) + ' / ' + fmtMiB(g.totalMiB) + '</b></div>' +
        '<div class="kv"><span>利用率</span><b class="num">' + g.utilPct + '%</b></div>' +
        '<div class="kv"><span>温度 / 功耗</span><b class="num' + (g.tempC >= 80 ? ' hot' : '') + '">' + g.tempC + '°C · ' + g.powerW + 'W</b></div>' +
      '</div></div>';
  }).join('') +
    (gpu.computeApps && gpu.computeApps.length
      ? '<div class="note">卡上计算进程 ' + gpu.computeApps.length + ' 个：' +
        gpu.computeApps.slice(0, 3).map(a => esc(a.name.split('\\').pop())).join('、') +
        (gpu.computeApps.length > 3 ? ' 等' : '') + '</div>'
      : '');
}

function renderResident(st) {
  const r = st && st.resident;
  const gw = st && st.gateway;
  if (!r || r.status !== 'ok') {
    return renderOffline('card-resident', 'red', '驻留状态未测到（网关 ' + ((gw && gw.health) || '?') + '）');
  }
  const served = (gw && gw.servedModels || []).map(m => '<span class="chip">' + esc(m) + '</span>').join('');
  $('#card-resident').innerHTML = $('#card-resident').querySelector('h2').outerHTML +
    '<div class="model-id">' + esc(r.id || '(未知)') + '</div>' +
    '<div class="resident-since">已驻留 ' + fmtDur(Date.now() - Date.parse(r.since)) + ' · 来源 ' + esc(r.source) +
    ' · 网关 <span class="' + (gw && gw.health === 'ok' ? 'st-running' : 'st-stalled') + '">' + esc(gw && gw.health) + '</span></div>' +
    (served ? '<div class="served">网关在服：' + served + '</div>' : '');
}

function renderTokens(tw) {
  const cardId = 'card-tokens';
  if (!tw || !tw.data || !tw.data.stats) {
    return renderOffline(cardId, tw && tw.status === 'stale' ? 'amber' : 'red',
      '塔台未运行 —— 在「自研软件」卡拉起后，这里显示全机 token');
  }
  const t = tw.data.stats.totals || {};
  const today = t.today || {};
  const all = t.all || {};
  const budget = tw.data.stats.budget;
  const over = budget && budget.dailyTokens && (today.in + today.out) > budget.dailyTokens;
  $('#card-tokens').innerHTML = $('#card-tokens').querySelector('h2').outerHTML + srcLine(tw) +
    '<div class="tok-big ' + (over ? 'over-budget' : '') + '">' + fmtTok((today.in || 0) + (today.out || 0)) +
    ' <small>今日 in+out' + (over ? ' · 超预算线' : '') + '</small></div>' +
    '<div class="tok-rows">' +
    '<div class="kv"><span>今日 进 / 出</span><b class="num">' + fmtTok(today.in) + ' / ' + fmtTok(today.out) + '</b></div>' +
    '<div class="kv"><span>近 7 天 in+out</span><b class="num">' + fmtTok(((t.week || {}).in || 0) + ((t.week || {}).out || 0)) + '</b></div>' +
    '<div class="kv"><span>累计 in+out</span><b class="num">' + fmtTok((all.in || 0) + (all.out || 0)) + '</b></div>' +
    ((all || {}).local != null ? '<div class="kv"><span>其中本地模型（累计 · GPU 真烧）</span><b class="num">' + fmtTok(all.local) + '</b></div>' : '') +
    ((today.cr || all.cr) ? '<div class="kv"><span>缓存读</span><b class="num">' + fmtTok(today.cr || 0) + ' / ' + fmtTok(all.cr) + '</b></div>' : '') +
    '</div>';
}

// ---------- 第二排：软件 ----------
function appState(a, ops) {
  const op = (ops || []).filter(o => o.appId === a.id).sort((x, y) => y.id - x.id)[0];
  if (op && op.status === 'running') return { cls: 'busy', text: '⏳ ' + (op.stage || '执行中') + '…', busy: true };
  if (a.running) return { cls: 'run', text: '● 运行中 · 我拉起 · PID ' + a.pid };
  if (a.external) return { cls: 'ext', text: '● 外部运行中（端口有主）' };
  return { cls: '', text: '○ 未运行' };
}

function renderApps(st) {
  const cardId = 'card-apps';
  const apps = st && st.apps;
  if (!apps || !apps.list) return renderOffline(cardId, 'red', '控制面未启用（config.json control.enabled）');
  const models = ((st.registry || {}).models || []).filter(m => m.exists);
  $('#card-apps').innerHTML = $('#card-apps').querySelector('h2').outerHTML +
    '<div class="note" style="margin:0 0 6px">控制动作经本服务 /api/ctl 执行（预热 → 校验 → 拉起），与主看板同一套边界</div>' +
    apps.list.map(a => {
      const st8 = appState(a, apps.ops);
      const sel = (a.modelEnv || a.modelArg)
        ? '<select class="model-sel" data-app="' + esc(a.id) + '">' +
          models.map(m => '<option value="' + esc(m.id) + '"' + (m.id === (a.model || a.defaultModel) ? ' selected' : '') + '>' + esc(m.id) + '</option>').join('') +
          '</select>'
        : '';
      const start = '<button class="act primary" data-act="start" data-app="' + esc(a.id) + '"' + (st8.busy ? ' disabled' : '') + '>拉起</button>';
      const stop = a.running
        ? '<button class="act danger" data-act="stop" data-app="' + esc(a.id) + '">停止</button>'
        : '';
      const lastErr = a.op && a.op.status === 'failed'
        ? '<div class="m" style="color:var(--bad);font-size:11px;margin-left:118px">' + esc((a.op.error || '').slice(0, 90)) + '</div>'
        : '';
      return '<div class="app-row"><span class="app-name" title="' + esc(a.name) + '">' + esc(a.name) + '</span>' +
        '<span class="app-state ' + st8.cls + '">' + esc(st8.text) + '</span>' +
        '<span class="app-actions">' + sel + start + stop + '</span></div>' + lastErr;
    }).join('');
}

// ---------- 第二排：会话 ----------
function renderSessions(tw) {
  const cardId = 'card-sessions';
  if (!tw || !tw.data || !tw.data.state) {
    return renderOffline(cardId, tw && tw.status === 'stale' ? 'amber' : 'red',
      '塔台未运行 —— 在「自研软件」卡拉起后，这里显示等你确认 / 工作中的会话');
  }
  const sess = (tw.data.state.sessions || []);
  if (!sess.length) {
    return void ($('#card-sessions').innerHTML = $('#card-sessions').querySelector('h2').outerHTML +
      '<div class="offline" style="border-left-color:var(--ok)">当前没有活跃的 AI 会话</div>');
  }
  const order = { waiting: 0, working: 1 };
  const list = sess.slice().sort((a, b) =>
    ((order[a.phase] ?? 2) - (order[b.phase] ?? 2)) || ((b.lastSeen || 0) - (a.lastSeen || 0))).slice(0, 8);
  $('#card-sessions').innerHTML = $('#card-sessions').querySelector('h2').outerHTML + srcLine(tw) +
    list.map(s => {
      const waiting = s.phase === 'waiting';
      const since = s.phaseSince ? fmtDur(Date.now() - s.phaseSince) : '';
      const title = String(s.title || '').replace(/\\n/g, ' ').trim() || '(无标题)';
      return '<div class="sess' + (waiting ? ' waiting' : '') + '">' +
        '<div class="t">' + (waiting ? '⏳ ' : '') + esc(title) + '</div>' +
        '<div class="m"><span class="chip">' + esc(s.tool) + '</span>' +
        (s.model ? '<span class="chip">' + esc(s.model) + '</span>' : '') +
        esc(s.project || '') +
        ' · ' + (waiting ? '<b>已等你 ' + since + '</b>' : '工作中 ' + since) +
        ' · tok ' + fmtTok((s.tokens || {}).in) + '/' + fmtTok((s.tokens || {}).out) + '</div></div>';
    }).join('');
}

// ---------- 第二排：实验 ----------
function renderExp(st) {
  const cardId = 'card-exp';
  const exp = st && st.experiments;
  if (!exp || exp.status === 'unknown') return renderOffline(cardId, '', '实验台未测到');
  // 计数从 runs 现算：看板的 summary 挂在每个 source 名下，界面上直接对可见清单计数，口径永远一致
  const active = (exp.sources || []).flatMap(s => (s.runs || [])
    .filter(r => r.status === 'running' || r.status === 'stalled' || r.status === 'interrupted')
    .map(r => ({ ...r, srcName: s.name })));
  const allRuns = (exp.sources || []).flatMap(s => s.runs || []);
  const count = k => allRuns.filter(r => r.status === k).length;
  $('#card-exp').innerHTML = $('#card-exp').querySelector('h2').outerHTML +
    '<div class="exp-sum">' +
    '<span class="chip st-running">跑 ' + count('running') + '</span>' +
    '<span class="chip st-stalled">卡 ' + count('stalled') + '</span>' +
    '<span class="chip st-interrupted">断 ' + count('interrupted') + '</span>' +
    '<span class="chip">完 ' + count('done') + '</span></div>' +
    (active.length ? active.slice(0, 6).map(r => {
      const eta = r.etaSec != null ? 'ETA ' + fmtDur(r.etaSec * 1000) + (r.etaBasis ? '（' + esc(r.etaBasis) + '）' : '') : 'ETA 未知';
      return '<div class="run">' +
        '<div class="head"><span class="id" title="' + esc(r.id) + '">' + esc(r.id) + '</span>' +
        '<span class="st-' + r.status + '">' + esc(r.status) + '</span></div>' +
        '<div class="meta">' + esc(r.srcName || '') +
        (r.stageLabel ? ' · ' + esc(r.stageLabel) : '') +
        ' · 第 ' + r.gens + '/' + r.totalGens + ' 代 · ' + eta + '</div>' +
        '<div class="pbar"><i style="width:' + Math.min(100, r.pct || 0) + '%"></i></div></div>';
    }).join('') : '<div class="mut" style="font-size:12.5px;padding:6px 0">当前没有进行中的 run</div>');
}

// ---------- 第三排 ----------
function renderClients(st) {
  const c = st && st.clients;
  if (!c || c.status !== 'ok') return renderOffline('card-clients', 'red', '调用方采样未测到');
  const rows = (c.list || []).map(x =>
    '<li><span class="grow" title="' + esc(x.name || '') + '">' + esc((x.name || '?').split('\\').pop()) + '</span>' +
    '<span class="mut num">PID ' + x.pid + '</span></li>');
  $('#card-clients').innerHTML = $('#card-clients').querySelector('h2').outerHTML +
    (rows.length ? '<ul class="plain">' + rows.join('') + '</ul>'
      : '<div class="mut" style="font-size:12.5px;padding:4px 0">此刻没有长连接在调用网关</div>') +
    '<div class="note">网关监听 PID ' + c.listenerPid + ' · 近期断开连接 ' + c.closedConns + ' 条' +
    '<br>' + esc(c.missedNote || '') + '</div>';
}

function renderProjects(tw) {
  const cardId = 'card-projects';
  if (!tw || !tw.data || !tw.data.state) return renderOffline(cardId, 'red', '塔台未运行');
  const ps = (tw.data.state.projects || []).slice(0, 8);
  $('#card-projects').innerHTML = $('#card-projects').querySelector('h2').outerHTML + srcLine(tw) +
    (ps.length ? '<ul class="plain">' + ps.map(p =>
      '<li><span class="grow" title="' + esc(p.path) + '">' + esc(p.name) + '</span>' +
      (p.error ? '<span style="color:var(--bad)">git 异常</span>'
        : '<span class="mut">' + esc(p.branch || '-') + '</span>' +
          (p.dirty ? ' <span class="dirty">●' + p.dirty + '</span>' : '') +
          (p.ahead ? ' <span class="up">↑' + p.ahead + '</span>' : '') +
          (p.behind ? ' <span class="dn">↓' + p.behind + '</span>' : '') +
          '<span class="mut">' + (p.lastAgentActivity ? fmtAgo(new Date(p.lastAgentActivity).toISOString()) : '') + '</span>') +
      '</li>').join('') + '</ul>' : '<div class="mut" style="padding:4px 0">暂无被监控的项目</div>');
}

function renderJitter(st) {
  const s = st && st.events && st.events.summary;
  if (!s) return renderOffline('card-jitter', 'red', '抖动账本未测到');
  const today = (s.byDay || {})[localDayKey()] || 0;
  const cold = s.coldSec || {};
  const phantom = st.events.phantom;
  const phantomN = Array.isArray(phantom) ? phantom.length : (typeof phantom === 'number' ? phantom : null);
  $('#card-jitter').innerHTML = $('#card-jitter').querySelector('h2').outerHTML +
    '<div class="tok-big">' + today + ' <small>今日换卡次数</small></div>' +
    '<div class="tok-rows">' +
    '<div class="kv"><span>最凶乒乓边</span><b>' + esc((s.worstEdge || {}).edge || '—') + ' × ' + ((s.worstEdge || {}).n || 0) + '</b></div>' +
    '<div class="kv"><span>乒乓对 / 失败</span><b class="num">' + (s.pingPongPairs ?? '—') + ' / ' + (s.fails ?? '—') + '</b></div>' +
    '<div class="kv"><span>冷加载 p50 / p95</span><b class="num">' + (cold.p50 ?? '—') + 's / ' + (cold.p95 ?? '—') + 's</b></div>' +
    (phantomN != null ? '<div class="kv"><span>幽灵请求（注册表外模型）</span><b class="num">' + phantomN + '</b></div>' : '') +
    '</div>';
}

// ---------- 控制动作（同源直达，无需转发） ----------
async function ctl(path, body) {
  const res = await fetch('/api/ctl/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    showBanner('控制动作被拒（http ' + res.status + '）：' + (j.error || ''));
    return null;
  }
  return j;
}

function showBanner(text) {
  const b = $('#banner');
  if (!text) { b.style.display = 'none'; return; }
  b.textContent = text;
  b.style.display = 'block';
}

document.addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.app;
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === 'start') {
      const sel = document.querySelector('select.model-sel[data-app="' + CSS.escape(id) + '"]');
      await ctl('apps/' + encodeURIComponent(id) + '/start', sel && sel.value ? { model: sel.value } : {});
    } else if (act === 'stop') {
      await ctl('apps/' + encodeURIComponent(id) + '/stop', {});
    }
  } finally {
    poll(); // 立即刷新一次，不等下个周期
  }
});

// ---------- 主循环 ----------
function renderAll(data) {
  setTowerLight(data.tower);
  const st = data.console && data.console.state;
  renderGpu(st);
  renderResident(st);
  renderTokens(data.tower);
  renderApps(st);
  renderSessions(data.tower);
  renderExp(st);
  renderClients(st);
  renderProjects(data.tower);
  renderJitter(st);
}

async function poll() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    renderAll(data);
    showBanner('');
  } catch (err) {
    showBanner('总控大屏自身异常：' + err.message);
  }
}

setInterval(() => { $('#clock').textContent = new Date().toTimeString().slice(0, 8); }, 1000);
$('#clock').textContent = new Date().toTimeString().slice(0, 8);
poll();
setInterval(poll, 3000);

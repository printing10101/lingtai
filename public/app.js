// app.js — 渲染层。核心要求没变：把「确认没有」和「没测到」分成两种显示，
// 绝不因为采集失败就画出一个看起来一切正常的界面。
// 这一版只重做表现层：数据字段、接口、采样节奏与上一版完全一致。
'use strict';

const S = { appModel: {} };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = id => document.getElementById(id);
const num = v => (v == null ? '—' : Number(v).toLocaleString('en-US'));

function ago(iso) {
  if (!iso) return '未采';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return '时钟差';
  if (s < 60) return s + ' s 前';
  if (s < 3600) return Math.round(s / 60) + ' min 前';
  return (s / 3600).toFixed(1) + ' h 前';
}
function dur(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + ' h ' : '') + (h || m ? m + ' min ' : '') + (s % 60) + ' s';
}
const STATUS_TXT = { ok: '正常', absent: '确认没有', unknown: '未测到' };

/* ---------- 通用小件 ---------- */

// 只有内容真的变了才淡入一下：3 s 一刷不能让整页闪。
function paint(node, html) {
  if (!node) return;
  if (node.__h === html) return;
  node.__h = html;
  node.innerHTML = html;
  node.classList.remove('bump');
  void node.offsetWidth;
  node.classList.add('bump');
}
function lamp(id, status, text) {
  const n = el(id);
  n.className = 'seg ' + status;
  n.querySelector('span').textContent = text;
}
const spec = (k, v, o) => '<div class="spec-item' + (o && o.wide ? ' wide' : '') + '"><b>' + esc(k) + '</b>'
  + '<span' + (o && o.dimm ? ' class="dimm"' : '') + '>' + esc(v) + '</span></div>';
const tag = (cls, txt) => '<span class="tag ' + cls + '">' + esc(txt) + '</span>';
const dot = cls => '<i class="dot ' + cls + '"></i>';

// 列表行：主行自带名字与标记，次行放完整路径（省略号 + title 出全文），数字右对齐等宽。
// 用这个代替原来的表格，是为了根治「文件名被折成 Qwen3-30B-A3 B-Instru ct-…」的列宽塌缩。
function row(o) {
  return '<div class="row"><div style="min-width:0">'
    + '<div class="row-title">' + esc(o.title) + (o.tags || '') + '</div>'
    + (o.sub ? '<div class="row-sub" title="' + esc(o.subTitle || o.sub) + '">' + esc(o.sub) + '</div>' : '')
    + '</div><div class="row-nums">'
    + (o.cells || []).map(c => '<div class="cell' + (c.cls ? ' ' + c.cls : '') + '"><b>' + esc(c.v) + '</b><span>' + esc(c.l) + '</span></div>').join('')
    + '</div></div>';
}

/* ---------- Tier 0 · 顶栏 ---------- */
function renderHeader(st) {
  el('target').textContent = st.config.proxyHost + ':' + st.config.proxyPort + ' / :' + st.config.upstreamPort;
  el('upstream-port').textContent = st.config.upstreamPort;
  const pausedUntil = st.pausedUntil && new Date(st.pausedUntil) > new Date() ? st.pausedUntil : null;
  paint(el('gen-time'), '采集于 ' + esc((st.generatedAt || '').replace('T', ' ').slice(0, 19)) +
    (pausedUntil ? ' <span class="stale">已暂停至 ' + esc(new Date(pausedUntil).toTimeString().slice(0, 8)) + '</span>' : '') +
    (st.lastError ? ' <span class="stale">' + esc(st.lastError) + '</span>' : ''));
  const pbtn = el('pause');
  pbtn.classList.toggle('paused', !!pausedUntil);
  pbtn.title = pausedUntil ? '采集中断至 ' + new Date(pausedUntil).toTimeString().slice(0, 8) + '，点击恢复' : '暂停采集 30 分钟';

  const g = st.gateway;
  lamp('lamp-gateway', g.status === 'ok' ? 'ok' : (g.status === 'absent' ? 'bad' : 'unknown'),
    g.status === 'ok' ? (g.servedModels ? g.servedModels.length + ' 模型可列' : '活着') : (STATUS_TXT[g.status] || g.status));

  const r = st.resident;
  lamp('lamp-resident', r.status === 'ok' ? 'ok' : (r.status === 'absent' ? 'absent' : 'unknown'),
    r.status === 'ok' ? r.id : (STATUS_TXT[r.status] || r.status));

  const gp = st.gpu.gpus && st.gpu.gpus[0];
  const gpuSt = st.gpu.status === 'ok' && gp ? 'ok' : (st.gpu.status === 'ok' ? 'unknown' : st.gpu.status);
  lamp('lamp-gpu', gp && gp.totalMiB && gp.usedMiB / gp.totalMiB > 0.9 ? 'warn' : gpuSt,
    gp ? Math.round(gp.usedMiB) + ' / ' + gp.totalMiB + ' MiB' : STATUS_TXT[st.gpu.status]);
}

/* ---------- Tier 1 · 驻留 ---------- */
function renderResident(st) {
  const r = st.resident, proc = ((st.llamaProc && st.llamaProc.gatewayProcs) || [])[0];
  el('resident-source').textContent = r.status === 'ok'
    ? '来源 ' + (r.source === 'props' ? '8081 /props' : '进程命令行') + ' · ' + ago(r.since)
    : '';
  if (r.status !== 'ok') {
    const strays = ((st.llamaProc && st.llamaProc.strays) || []).length;
    const gp = (st.gpu.gpus || [])[0] || {};
    paint(el('resident-body'), '<div class="display quiet ' + (r.status === 'absent' ? 'absent' : 'unknown') + '">' +
      (r.status === 'absent' ? '网关侧没有模型驻留' : '驻留状态未测到') + '</div>' +
      (r.status === 'absent' && strays && gp.usedMiB > 2048
        ? '<div class="legend miss" style="margin-top:10px">但整卡已用 ' + num(gp.usedMiB) + ' MiB —— 那部分不在网关账本里，看下方「显存账本」。</div>' : '') +
      '<div class="legend note">' + esc(r.status === 'absent'
        ? '判定依据：8081 无响应，且网关端口上没有 llama-server 进程（旁路实例不算，见下一张卡）'
        : ((st.llamaProc && st.llamaProc.error) || (st.upstream && st.upstream.error) || '探针未返回')) + '</div>');
    return;
  }
  const meta = (st.registry.models || []).find(m => m.id === r.id) || {};
  const np = proc ? num(proc.np) : '—';
  paint(el('resident-body'),
    '<div class="display">' + esc(r.id) + '</div>' +
    '<div class="spec">' +
    spec('默认模型', st.registry.default || '—') +
    spec('权重文件', proc && proc.modelFile ? proc.modelFile : (meta.file || '—'), { wide: true }) +
    spec('上下文 -c', proc ? num(proc.ctx) : num(meta.ctx)) +
    spec('并行槽 -np', np) +
    spec('GPU 层 -ngl', proc ? num(proc.ngl) : '—') +
    spec('CPU 专家层 --n-cpu-moe', proc ? num(proc.cpuMoe) : num(meta.ncpuMoe)) +
    spec('线程 -t', proc ? num(proc.threads) : '—') +
    spec('进程 PID', proc ? num(proc.pid) : '—') +
    spec('已驻留', dur(r.since)) +
    '</div>' +
    // 这句太长，留在规格条里会把整行挤变形；单独一行说，口径一个字不少
    (proc && proc.np === 1 ? '<div class="legend" style="margin-top:12px">并行槽 -np = 1：同模型请求只能串行。</div>' : ''));
}

/* ---------- Tier 1 · 显存环 ----------
   环要补间动画，所以结构只建一次，之后改属性；重建 DOM 会让 stroke-dashoffset 直接跳到终值。 */
const RING_C = 2 * Math.PI * 62;
function ringEnsure(node) {
  if (node.__ring) return node.__ring;
  node.innerHTML =
    '<div class="ring-wrap"><div class="ring">' +
    '<svg viewBox="0 0 152 152" aria-hidden="true"><defs>' +
    '<linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#0a84ff"/><stop offset="1" stop-color="#30d158"/></linearGradient></defs>' +
    '<circle class="track" cx="76" cy="76" r="62"/>' +
    '<circle class="prog" cx="76" cy="76" r="62" stroke="url(#ringGrad)" stroke-dasharray="' + RING_C.toFixed(2) + '" ' +
    'stroke-dashoffset="' + RING_C.toFixed(2) + '" transform="rotate(-90 76 76)"/></svg>' +
    '<div class="ring-center"><b>—</b><small>—</small></div></div>' +
    '<div class="ring-facts"></div></div>';
  node.__h = null;
  return (node.__ring = {
    prog: node.querySelector('.prog'),
    big: node.querySelector('.ring-center b'),
    small: node.querySelector('.ring-center small'),
    facts: node.querySelector('.ring-facts'),
  });
}
function renderVram(st) {
  const node = el('vram-body');
  const g = (st.gpu.gpus || [])[0];
  if (st.gpu.status !== 'ok' || !g) {
    node.__ring = null;
    paint(node, '<div class="display quiet unknown">显存未测到</div>' +
      '<div class="legend note">' + esc(st.gpu.error || 'nvidia-smi 无输出') + '</div>');
    return;
  }
  const refs = ringEnsure(node);
  const pct = g.totalMiB ? Math.min(100, (g.usedMiB / g.totalMiB) * 100) : 0;
  refs.prog.setAttribute('stroke-dashoffset', (RING_C * (1 - pct / 100)).toFixed(2));
  refs.prog.setAttribute('stroke', pct > 90 ? '#ff453a' : pct > 70 ? '#ffd60a' : 'url(#ringGrad)');
  const bigTxt = num(g.usedMiB);
  if (refs.big.textContent !== bigTxt) {
    refs.big.textContent = bigTxt;
    refs.big.classList.remove('bump'); void refs.big.offsetWidth; refs.big.classList.add('bump');
  }
  refs.small.textContent = pct.toFixed(0) + '%';
  paint(refs.facts,
    '<div><b class="name" title="' + esc(g.name) + '">' + esc(g.name) + '</b><span>GPU</span></div>' +
    '<div><b>' + num(g.totalMiB) + '</b><span>总量 MiB</span></div>' +
    '<div><b' + (g.tempC != null && g.tempC >= 80 ? ' style="color:var(--bad)"' : '') + '>' +
      (g.tempC != null ? num(g.tempC) + '°C' : '—') + '</b><span>温度（≥80°C 标红）</span></div>' +
    '<div><b>' + (g.powerW != null ? num(g.powerW) + ' W' : '—') + '</b><span>功耗</span></div>' +
    '<div><b>' + num(g.utilPct) + '%</b><span>核心利用率</span></div>' +
    '<div><b>' + esc(ago(st.gpu.checkedAt)) + '</b><span>采样（每 10 s）</span></div>');
}

/* ---------- Tier 1.5 · 自研软件（启动器） ---------- */
const OP_STAGE = {
  switching: '切换模型中（冷加载约 25–35 s）…',
  launching: '拉起中…',
  stopping: '停止中…',
  running: '已运行',
  launched: '已开窗（不托管）',
  done: '完成',
  failed: '失败',
};
function rememberedModel(id) {
  try { return localStorage.getItem('mc.appmodel.' + id); } catch (_) { return null; }
}
function renderApps(st) {
  const a = st.apps;
  const card = el('card-apps');
  el('apps-file').textContent = a && a.appsFile ? '· ' + a.appsFile : '';
  if (!a || !a.enabled) {
    card.dataset.tone = '';
    paintId('apps-body', '<div class="empty-state">控制层未启用（config.json 里 control.enabled）</div>');
    return;
  }
  const errHtml = a.errors && a.errors.length
    ? '<div class="legend miss" style="margin-bottom:8px">apps.json 有坏条目（已跳过）：' + esc(a.errors.join('；')) + '</div>'
    : '';
  if (!a.list.length) {
    paintId('apps-body', errHtml + '<div class="empty-state">注册表里还没有软件 —— 往 apps.json 加一条即可</div>');
    return;
  }
  const models = (st.registry.models || []).filter(m => m.exists);
  paintId('apps-body', errHtml + '<div class="rows">' + a.list.map(app => {
    const picked = rememberedModel(app.id) || app.model || app.defaultModel || st.registry.default || '';
    const warm = app.warm !== false;
    const win = app.launch === 'window';
    let tags = '';
    if (!warm) tags += tag('', '不驱动模型');
    if (win) tags += tag('', '开窗 · 不托管');
    if (app.op && app.op.status === 'running') tags += tag('warn', OP_STAGE[app.op.stage] || app.op.stage);
    else if (app.running) tags += tag('ok', '运行中 · PID ' + app.pid + ' · ' + app.model);
    else if (app.external) tags += tag('absent', '外部运行中（端口 ' + app.healthCheckPort + ' 有主）');
    const opNow = app.op && app.op.status === 'running';
    const opHtml = app.op
      ? '<div class="op-log' + (app.op.status === 'failed' ? ' bad' : '') + '">' +
        esc(app.op.status === 'failed' ? ('失败：' + app.op.error) : ((OP_STAGE[app.op.stage] || '') + '\n' + (app.op.lines || []).join('\n'))) + '</div>'
      : '';
    // 不驱动模型的软件没有「要用的模型」可言，不给下拉框
    const select = !warm ? '' : (models.length
      ? '<select class="model-pick" data-app="' + esc(app.id) + '" aria-label="' + esc(app.name) + ' 要用的模型">' +
        models.map(m => '<option value="' + esc(m.id) + '"' + (m.id === picked ? ' selected' : '') + '>' + esc(m.id) + '</option>').join('') +
        '</select>'
      : '<span class="legend miss">无在盘模型</span>');
    const startDisabled = opNow || app.running || (warm && !models.length);
    return '<div class="row app-row">' +
      '<div style="min-width:0">' +
        '<div class="row-title">' + esc(app.name) + tags + '</div>' +
        '<div class="row-sub" title="' + esc(app.command + '  ·  ' + app.cwd) + '">' + esc(app.command) + '</div>' +
        opHtml +
      '</div>' +
      '<div class="app-ops">' + select +
        '<button class="mini-btn primary" data-act="start" data-app="' + esc(app.id) + '"' +
          (startDisabled ? ' disabled' : '') + '>启动</button>' +
        // 开窗型的窗口进程不归本启动器管，停止钮干脆不给，免得点了没反应
        (win ? '' : '<button class="mini-btn" data-act="stop" data-app="' + esc(app.id) + '"' +
          (!app.running ? ' disabled' : '') + '>停止</button>') +
      '</div></div>';
  }).join('') + '</div>' +
    '<div class="legend note">口径：启动 = 先让网关驻留所选模型（预热请求 + /props 确认），再带环境变量拉起软件；' +
    '停止只杀本启动器拉起的进程树。「外部运行中」= 探测端口被别的进程占着，不接管也不双拉。' +
    '「不驱动模型」的软件跳过预热直接拉起；「开窗 · 不托管」= 软件跑在独立终端窗口里，本启动器记不了它的 PID，停止请直接关那个窗口。</div>');
}

// 按 id 重绘一个容器。id 始终以字面量出现在调用处 ——
// 契约测试靠扫这些字面量来保证「没有哪张卡被静默留空」，所以不要把它换成传变量的写法。
function paintId(id, html) { paint(el(id), html); }

/* ---------- Tier 3 · 显存账本（网关驻留进程 + 旁路实例 + 卡上计算进程） ---------- */
function renderVramLedger(st) {
  const lp = st.llamaProc || {};
  const strays = lp.strays || [];
  const parts = [];
  // 三态色调由 data-tone 控制：loud=真有旁路，quiet=枚举过且没有，unknown=没测到
  const enumerated = lp.status === 'ok' || lp.status === 'absent';
  el('card-vram-ledger').dataset.tone = strays.length ? 'loud' : (enumerated ? 'quiet' : 'unknown');

  if (!enumerated) {
    // 进程表没枚举成功，就无从判断有没有实例在网关账本之外 —— 不下"没有旁路"的结论（假绿回归）
    parts.push('<div class="display quiet unknown" style="font-size:18px">旁路实例未测到</div>');
    parts.push('<div class="legend miss" style="margin-top:4px">进程表没枚举成功，就无从判断有没有实例在网关账本之外 —— 这里不下"没有旁路"的结论。</div>');
    parts.push('<div class="legend note">' + esc(lp.error || '进程枚举未返回') + '。判据：进程命令行里的 --port 是否等于 ' +
      esc(String(st.config.upstreamPort)) + '。采样 ' + esc(ago(lp.checkedAt)) + '。</div>');
  } else {
    const gw = (lp.gatewayProcs || [])[0];
    parts.push(gw
      ? '<div class="legend" style="margin-bottom:8px">网关驻留：<b>' + esc((gw.modelFile || '?').split(/[\\/]/).pop()) +
        '</b>（端口 ' + esc(gw.port) + ' · PID ' + num(gw.pid) + '）</div>'
      : '<div class="legend" style="margin-bottom:8px">网关端口上没有 llama-server 进程。</div>');

    if (!strays.length) {
      parts.push('<div class="display quiet" style="font-size:17px">没有旁路实例（全部 llama-server 都在网关端口上）</div>');
      parts.push('<div class="legend note" style="margin-top:4px">判据：进程命令行里的 --port 是否等于 ' +
        esc(String(st.config.upstreamPort)) + '。采样 ' + esc(ago(lp.checkedAt)) + '。</div>');
    } else {
      parts.push('<div class="display" style="font-size:19px;color:var(--bad)">有 ' + strays.length + ' 个实例在网关账本之外</div>');
      parts.push('<div class="legend miss" style="margin-top:4px">' + esc(lp.killByImageRisk || '') + '</div>');
      // 「空卡但显存满」才有信息量；hero 环就在上面，驻留正常时不重复报数
      const gp = (st.gpu.gpus || [])[0] || {};
      if (st.resident.status !== 'ok' && gp.usedMiB) {
        parts.push('<div class="legend" style="margin:4px 0 0">网关视角"空卡"不代表显存真的空着 —— 整卡已用 ' +
          num(gp.usedMiB) + ' / ' + num(gp.totalMiB) + ' MiB。</div>');
      }
      parts.push('<div class="rows" style="margin-top:8px">' + strays.map(r => row({
        title: (r.modelFile || '?').split(/[\\/]/).pop(),
        tags: tag('absent', '端口 ' + r.port) + (r.parentAlive === false
          ? tag('bad', '父进程 ' + (r.parentName || r.ppid) + ' 已退出（孤儿）')
          : tag('', '父进程 ' + (r.parentName || r.ppid) + (r.parentAlive ? ' 在' : ''))),
        sub: r.modelFile || '',
        cells: [
          { v: num(r.ctx), l: 'ctx' },
          { v: num(r.pid), l: 'PID' },
          { v: r.alias || '—', l: '别名' },
        ],
      })).join('') + '</div>');
      parts.push('<div class="legend note" style="margin-top:6px">处置前先看这行命令：旁路实例可能是某个软件自带的服务，不是垃圾。' +
        '要看它是不是活的，用台账「驻留历史」里"显存没下来过"这一点判断。</div>');
    }
  }

  // 卡上其他计算进程：nvidia-smi 的名单。推理进程置顶，图形上下文收进计数
  const apps = st.gpu.computeApps || [];
  if (st.gpu.computeAppsError) {
    parts.push('<div class="legend miss" style="margin-top:12px">compute-apps 采集失败，下表不可用</div>' +
      '<div class="legend">' + esc(st.gpu.computeAppsError) + '</div>');
  } else if (st.gpu.status !== 'ok') {
    parts.push('<div class="legend note" style="margin-top:12px">显存未测到，计算进程名单无数据。</div>');
  } else if (!apps.length) {
    parts.push('<div class="legend note" style="margin-top:12px">整卡上没有任何计算进程。</div>');
  } else {
    // 判定"是不是推理进程"必须只看可执行文件名：拿 /node/i 匹配完整路径，
    // 会把 E:\...\node_modules\electron\dist\electron.exe 也标成「推理」
    const isInf = n => {
      const b = String(n).split(/[\\/]/).pop().toLowerCase();
      return /^(llama-server|llama-cli|llama-bench|python|pythonw|node)(\.exe)?$/.test(b);
    };
    const sorted = apps.slice().sort((a, b) => (isInf(b.name) ? 1 : 0) - (isInf(a.name) ? 1 : 0));
    const shown = sorted.filter(a => isInf(a.name) || a.memMiB != null);
    const hidden = sorted.length - shown.length;
    // 本机 nvidia-smi 把 compute-apps 的 used_memory 全报成 [N/A]：先把这件事说明白，别给一张假数据表
    const noAttribution = shown.length && shown.every(a => a.memMiB == null);
    parts.push('<div class="legend" style="margin:14px 0 2px">卡上计算进程（nvidia-smi）</div>');
    if (noAttribution) {
      parts.push('<div class="legend miss" style="margin-bottom:6px">nvidia-smi 在这台机器上不报每个进程的显存数（used_memory 全是 [N/A]）—— 只能给名单，给不出「谁占了多少」。整卡总数看上方环形。</div>');
    }
    parts.push('<div class="rows">' + shown.map(a => row({
      title: a.name.split(/[\\/]/).pop() || a.name,
      tags: isInf(a.name) ? tag('ok', '推理') : '',
      sub: a.name,
      cells: [
        { v: a.memMiB == null ? 'N/A' : num(a.memMiB), l: a.memMiB == null ? '不报数' : 'MiB' },
        { v: num(a.pid), l: 'PID' },
      ],
    })).join('') + '</div>');
    if (hidden) parts.push('<div class="legend note" style="margin-top:4px">另有 ' + hidden + ' 个图形上下文进程，不报它们的显存（[N/A]），未列出。</div>');
  }
  paintId('vram-ledger-body', parts.join(''));
}

/* ---------- Tier 3 · 调用方 ---------- */
// 断连计数走势：TIME_WAIT 是「有人在打但没点到名」的活动证据，
// 采样出走势后至少能看强度。只能参考，不能当请求速率读。
function closedSparkHtml() {
  const pts = (S.samples || []).filter(r => r.closedConns != null).slice(-240);
  if (pts.length < 4) return '';
  const maxV = Math.max(...pts.map(p => p.closedConns), 1);
  const W = 100, H = 18;
  const step = pts.length > 1 ? W / (pts.length - 1) : W;
  const poly = pts.map((p, i) => (i * step).toFixed(2) + ',' + (H - (p.closedConns / maxV) * (H - 2) - 1).toFixed(2)).join(' ');
  return '<div style="margin-top:12px"><svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<polyline points="' + poly + '"/></svg>' +
    '<div class="legend" style="margin-top:4px">断连计数走势 · 近 ' +
    Math.max(1, Math.round((pts[pts.length - 1].ts - pts[0].ts) / 60000)) + ' min（15 s/点）· 现值 ' +
    num(pts[pts.length - 1].closedConns) + '。强度参考：只能证明有人在打，不能点名。</div></div>';
}
function renderClients(st) {
  const c = st.clients;
  if (c.status !== 'ok') {
    paintId('clients-body', '<div class="display quiet unknown" style="font-size:19px">调用方未测到</div>' +
      '<div class="legend">' + esc(c.error || '') + '</div>');
    return;
  }
  if (!c.list.length) {
    paintId('clients-body', '<div class="display quiet absent" style="font-size:19px">此刻没有长连接客户端</div>' +
      '<div class="legend note">采样时刻 ' + esc(ago(c.checkedAt)) + '。' + esc(c.missedNote) + '。' +
      (c.closedConns ? ' <b>但内核里还留着 ' + c.closedConns + ' 条刚断开的连接</b>——说明近期确实有程序在打网关，只是连接太短没点到名。' : '') + '</div>' +
      closedSparkHtml());
    return;
  }
  paintId('clients-body', '<div class="rows">' + c.list.map(r => row({
    title: r.name,
    sub: 'PID ' + r.pid,
    cells: [
      { v: num(r.conns), l: '连接' },
      { v: r.heldSec + ' s', l: '本次已连' },
      { v: r.memText || '—', l: '内存' },
    ],
  })).join('') + '</div>' +
    '<div class="legend note">' + esc(c.missedNote) + '。' + (c.closedConns ? ' 另有 ' + c.closedConns + ' 条已断开连接未点名。' : '') + '</div>' +
    closedSparkHtml());
}

/* ---------- Tier 3 · 模型清单 ---------- */
function renderModels(st) {
  const rg = st.registry;
  el('registry-file').textContent = rg.file ? '· ' + rg.file : '';
  if (rg.status !== 'ok') {
    paintId('models-body', '<div class="display quiet unknown" style="font-size:19px">注册表未读到</div>' +
      '<div class="legend">' + esc(rg.error || '') + '</div>');
    return;
  }
  if (!rg.models.length) {
    paintId('models-body', '<div class="empty-state">注册表里一个模型都没有</div>' +
      '<div class="legend note">读到的是 ' + esc(rg.file || '') + '，里面 models 为空 —— 网关此刻也没有可列模型时，任何请求都会被拒或降级。</div>');
    return;
  }
  const phantom = {};
  ((st.events && st.events.phantom) || []).forEach(p => { phantom[p.id] = p.n; });
  const served = st.gateway.servedModels;
  const rows = rg.models.map(m => {
    let tags = '';
    if (!m.exists) tags += tag('bad', '权重不在盘');
    else if (rg.default === m.id) tags += tag('ok', '默认');
    if (served && !served.includes(m.id)) tags += tag('warn', '网关未列出');
    if (phantom[m.id]) tags += tag('bad', '幽灵请求 ' + phantom[m.id] + ' 次');
    // 驻留中的不给切换钮；其它的两段式确认（先变「确认切换？」再真发）
    if (m.exists && st.resident.id !== m.id) {
      tags += ' <button class="mini-btn act-model" data-model="' + esc(m.id) + '">切换</button>';
    }
    return row({
      title: m.id,
      tags: tags,
      sub: m.file + (m.exists ? '' : '  (缺)'),
      subTitle: m.file,
      cells: [
        { v: num(m.sizeMB), l: 'MB' },
        { v: num(m.ctx), l: 'ctx' },
        { v: num(m.ncpuMoe), l: 'cpu-moe' },
      ],
    });
  });
  // 注册表之外的盘上权重：显示所有本地模型的另一半。只列不判 —— 没注册的网关切不了，必须如实说
  const others = rg.others || [];
  const othersHtml = others.length
    ? '<div class="sub-head">盘上还有 · 不在网关注册表（网关切不了）</div><div class="rows">' +
      others.map(o => o.error
        ? row({ title: o.dir, tags: tag('bad', '读不到'), sub: o.error })
        : row({
            title: o.name,
            tags: o.sameName ? tag('warn', '注册表同名（另一份拷贝）') : '',
            sub: o.dir,
            cells: [{ v: num(o.sizeMB), l: 'MB' }],
          })).join('') + '</div>' +
      '<div class="legend note">这些 GGUF 没注册进 models.json（或不在网关 models 目录），网关列不出也切不了；要驱动它们得先注册。扫描目录清单在 config.json 的 extraModelDirs。</div>'
    : '';
  paintId('models-body', '<div class="rows">' + rows.join('') + '</div>' + othersHtml +
    (rg.disk ? '<div class="legend note">模型盘剩余 <b>' + num(rg.disk.freeGB) + ' GB</b>（共 ' + num(rg.disk.totalGB) + ' GB）' +
      (rg.disk.freeGB * 1024 < (rg.models || []).reduce((m, x) => Math.max(m, x.sizeMB || 0), 0)
        ? ' —— 比最大的单个权重还小，新模型可能放不下。' : '') + '</div>' : '') +
    '<div class="legend note">「切换」= 让网关预热驻留该模型（会杀掉当前模型，冷加载约 25–35 s，进行中的请求排队）。</div>' +
    '<div class="legend note">幽灵请求 = 日志里被点名、但注册表里没有的模型名。这类请求在网关里会被静默降级成当前/默认模型，客户端拿不到任何报错。</div>');
}

/* ---------- Tier 1.6 · 实验台 ---------- */
const EXP_STATUS = {
  running: { tag: 'ok', txt: '运行中' },
  stalled: { tag: 'bad', txt: '疑似卡住' },
  interrupted: { tag: 'bad', txt: '中断' },
  done: { tag: 'absent', txt: '完成' },
  unknown: { tag: '', txt: '未测到' },
};
function fmtDurSec(sec) {
  if (sec == null) return '—';
  if (sec <= 0) return '0 s';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? h + ' h ' + String(m).padStart(2, '0') + ' min' : (m >= 1 ? m + ' min' : Math.round(sec) + ' s');
}
function clockIn(sec) { // sec 秒后的墙钟时刻 —— 「多久会结束」的正答
  if (sec == null) return null;
  const d = new Date(Date.now() + sec * 1000);
  const now = new Date();
  const day = d.getDate() !== now.getDate() ? (d.getMonth() + 1) + '/' + d.getDate() + ' ' : '';
  return day + d.toTimeString().slice(0, 5);
}
// best/mean 双线曲线：reward 曲线的单机对应物，数据是 gen_log.csv 的逐代记录
function expCurveHtml(curve) {
  if (!curve || curve.length < 3) return '';
  const W = 100, H = 26;
  const vals = curve.flatMap(p => [p.best, p.mean]).filter(v => v != null);
  if (vals.length < 4) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
  const line = key => curve.map((p, i) =>
    ((i / (curve.length - 1)) * W).toFixed(2) + ',' + (H - 1 - ((p[key] == null ? lo : p[key]) - lo) / span * (H - 2)).toFixed(2)).join(' ');
  const last = curve[curve.length - 1];
  return '<svg class="expcurve" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<polyline class="s-mean" points="' + line('mean') + '"/><polyline class="s-best" points="' + line('best') + '"/></svg>' +
    '<div class="legend note" style="margin-top:2px">适应度曲线 · 首到尾 best ' + esc(last.best == null ? '—' : last.best) +
    ' / mean ' + esc(last.mean == null ? '—' : last.mean) + '（绿 best · 蓝 mean）</div>';
}
function expBarHtml(r) {
  const pct = r.pct == null ? 0 : Math.max(0, Math.min(100, r.pct));
  const tone = r.status === 'stalled' || r.status === 'interrupted' ? ' bad' : '';
  return '<div class="expbar"><i class="' + tone.trim() + '" style="width:' + pct + '%"></i>' +
    '<b>' + (r.pct == null ? '— %' : r.pct + '%') + '</b></div>';
}
function expRunHtml(r, stallMin) {
  const st = EXP_STATUS[r.status] || { tag: '', txt: r.status };
  let tags = tag(st.tag, st.txt);
  if (r.cfg && r.cfg.seed != null) tags += tag('', 'seed ' + esc(r.cfg.seed) + (r.cfg.encoding ? ' · ' + esc(r.cfg.encoding) : ''));
  if (r.status === 'stalled') tags += tag('bad', '心跳停 ' + fmtDurSec(r.heartbeatAgeSec) + '，进程还在');
  if (r.status === 'interrupted') tags += tag('bad', '进程已退出，未跑到完成');
  const cells = [
    { v: r.gens != null && r.totalGens ? r.gens + '/' + r.totalGens : '—', l: '代' },
    { v: r.rateText ? r.rateText.replace('s/gen', 's/代') : (r.secPerGen != null ? Number(r.secPerGen).toFixed(0) + 's/代' : '—'), l: '代速' },
  ];
  if (r.status === 'running') cells.push({ v: r.etaSec != null ? (clockIn(r.etaSec) || '—') : '—', l: '预计结束' });
  if (r.status === 'done' && r.finishedAt) cells.push({ v: r.finishedAt.slice(5, 16).replace('T', ' '), l: '完成于' });
  return '<div class="exp-run' + (r.status === 'stalled' || r.status === 'interrupted' ? ' trouble' : '') + '">' +
    '<div class="row"><div style="min-width:0"><div class="row-title">' + esc(r.id) + tags + '</div>' +
    '<div class="row-sub">' + esc(r.stageLabel ? '阶段 ' + r.stageLabel : '') +
    (r.tqdmStep != null ? ' · ' + esc(r.tqdmStep + '/' + r.tqdmTotal) : '') + '</div></div>' +
    '<div class="row-nums">' + cells.map(c => '<div class="cell"><b>' + esc(c.v) + '</b><span>' + esc(c.l) + '</span></div>').join('') +
    '</div></div>' +
    expBarHtml(r) +
    '<div class="legend note" style="margin-top:3px">' +
    (r.etaBasis ? 'ETA 口径：' + esc(r.etaBasis) + '。' : '') +
    (r.status !== 'done' ? '心跳 ' + esc(ago(new Date(Date.now() - (r.heartbeatAgeSec || 0) * 1000).toISOString())) +
      '（停 ≥ ' + esc(stallMin) + ' min 判卡住）' : 'report.md 已落盘，批脚本靠它断点续跑') +
    '</div>' +
    (r.status !== 'done' ? expCurveHtml(r.curve) : '') +
    '</div>';
}
function renderExperiments(st) {
  const ex = st.experiments;
  // 顶栏灯：有卡住/中断就红，有在跑就绿，全部闲着是冷蓝的「确认没有」
  let lampStatus = 'unknown', lampTxt = '未测到';
  if (ex && ex.status === 'ok') {
    const nRun = ex.sources.reduce((a, s) => a + ((s.summary && s.summary.running) || 0), 0);
    const nBad = ex.sources.reduce((a, s) => a + ((s.summary && (s.summary.stalled || 0) + (s.summary.interrupted || 0)) || 0), 0);
    lampStatus = nBad ? 'bad' : nRun ? 'ok' : 'absent';
    lampTxt = nBad ? nBad + ' 个异常' : nRun ? nRun + ' 个在跑' : '空闲';
  } else if (ex && ex.status === 'absent') { lampStatus = 'absent'; lampTxt = '未启用'; }
  lamp('lamp-exp', lampStatus, lampTxt);

  if (!ex || ex.status === 'absent') {
    paintId('exp-body', '<div class="empty-state">实验观测未启用 —— 往 config.json 的 experiments.sources 加一条即出现</div>');
    return;
  }
  if (ex.status !== 'ok') {
    paintId('exp-body', '<div class="display quiet unknown" style="font-size:19px">实验台未测到</div>' +
      '<div class="legend">' + esc(ex.error || '探针未返回') + '</div>');
    return;
  }
  const parts = [];
  for (const src of ex.sources) {
    if (ex.sources.length > 1) parts.push('<div class="sub-head">' + esc(src.name) + '</div>');
    if (src.status !== 'ok') {
      parts.push('<div class="display quiet unknown" style="font-size:16px">该实验源未测到</div>' +
        '<div class="legend miss">' + esc(src.error || '') + '</div>');
      continue;
    }
    const sm = src.summary || {};
    // 链行：批脚本自己报的总组数与 [n/m] 序号，是最可靠的「整件事到哪了」
    if (src.chain) {
      const b = src.chain.batches[src.chain.batches.length - 1];
      const ce = src.chainEta;
      const doneN = (b && b.counts.done || 0) + (b && b.counts.skip || 0);
      const batchTxt = src.chain.allEnded ? '链已全部结束'
        : (b ? esc(b.name) + ' ' + (b.current ? '第 ' + b.current.idx + '/' + b.total + ' 组' : '组序未报') +
            '（完成 ' + (b.counts.done || 0) + ' · 跳过 ' + (b.counts.skip || 0) + '）' : '链在跑');
      parts.push('<div class="legend" style="margin:2px 0 8px">' + batchTxt +
        (ce && ce.etaSec != null && !src.chain.allEnded ? ' —— <b>全链预计 ' + esc(clockIn(ce.etaSec) || '—') + ' 完成</b>' : '') +
        '</div>' +
        (ce && ce.basis ? '<div class="legend note" style="margin:-4px 0 8px">ETA 口径：' + esc(ce.basis) + '。链内后续批未启动前不可见，launcher 串行拉起后自动计入。</div>' : ''));
    }
    const active = src.runs.filter(r => r.status !== 'done');
    const done = src.runs.filter(r => r.status === 'done');
    if (active.length) {
      parts.push('<div class="rows" style="margin-bottom:6px">' + active.map(r => expRunHtml(r, ex.stallMin)).join('') + '</div>');
    } else {
      parts.push('<div class="display quiet absent" style="font-size:17px">此刻没有进行中的实验</div>' +
        '<div class="legend note" style="margin-top:4px">判据：' + esc(ex.stallMin) + ' min 内没有新的 gen_log 写入，且 python 进程命令行里没有本源的 run。' +
        (sm.done ? ' 近期完成 ' + sm.done + ' 组（见下）。' : '') + '</div>');
    }
    if (done.length) {
      parts.push('<div class="sub-head" style="margin-top:10px">已完成（最近 ' + Math.min(5, done.length) + ' / ' + done.length + '）</div>' +
        '<div class="rows">' + done.slice(0, 5).map(r => row({
          title: r.id,
          sub: r.finishedAt ? 'report.md 落盘于 ' + esc(r.finishedAt.replace('T', ' ').slice(5, 19)) : '',
          cells: [
            { v: (r.gens != null && r.totalGens ? r.gens + '/' + r.totalGens : '—'), l: '代' },
            { v: r.lastBest != null ? esc(r.lastBest) : '—', l: 'best' },
          ],
        })).join('') + '</div>');
    }
    if (src.errors) parts.push('<div class="legend miss" style="margin-top:8px">该源有读取问题：' + esc(src.errors.join('；')) + '</div>');
  }
  parts.push('<div class="legend note" style="margin-top:10px">进度分母 = run 目录 config.json 的 stages × stage_gens；完成标志 = report.md（批脚本断点续跑同款判据）；' +
    '全部信号只读自实验自产落盘物，不改实验一行。适合挂后台的判断：看到「疑似卡住/中断」再动手，平时不用盯。</div>');
  paintId('exp-body', parts.join(''));
}

/* ---------- Tier 2 · 抖动账本 ---------- */
const tile = (label, v, cls, note) => '<div class="tile ' + (cls || '') + '"><b>' + (v == null ? '—' : esc(v)) + '</b>'
  + '<span>' + esc(label) + '</span>' + (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';

// 换卡归因：事件流的换卡时刻 × 采样的调用方名单，给「谁在踢卡」一个嫌疑排行。
// 口径必须诚实：相关非因果；换卡时刻落在 ±20 s 采样空窗就不猜；只统计采样覆盖窗内的换卡。
function attributeSwitches(samples, events) {
  if (!samples || samples.length < 2 || !events) return null;
  const ts0 = samples[0].ts, ts1 = samples[samples.length - 1].ts;
  const switches = events.filter(e => e.kind === 'switch' && e.ts >= ts0 && e.ts <= ts1)
    .sort((a, b) => a.ts - b.ts); // recent 是新在前，这里必须排回时间线
  if (!switches.length) return null;
  let si = 0, named = 0;
  const tally = new Map();
  for (const sw of switches) {
    while (si + 1 < samples.length && Math.abs(samples[si + 1].ts - sw.ts) <= Math.abs(samples[si].ts - sw.ts)) si++;
    const s = samples[si];
    if (Math.abs(s.ts - sw.ts) > 20000) continue; // 采样空窗，不猜
    if (!s.clients || !s.clients.length) continue;
    named++;
    for (const c of new Set(s.clients)) tally.set(c, (tally.get(c) || 0) + 1);
  }
  return { switches: switches.length, named, tally: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) };
}

function renderThrash(st) {
  const ev = st.events;
  if (ev.status !== 'ok') {
    paintId('thrash-body', '<div class="display quiet unknown" style="font-size:19px">事件流未读到</div>' +
      '<div class="legend">' + esc(ev.error || '') + '</div>');
    return;
  }
  const s = ev.summary || {};
  const today = new Date().toISOString().slice(0, 10);
  const cold = s.coldSec || {};
  const todayN = s.byDay ? s.byDay[today] || 0 : null;

  const days = Object.entries(s.byDay || {}).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const maxDay = days.reduce((m, [, n]) => Math.max(m, n), 1);
  const W = 100, H = 62, gap = days.length > 40 ? 0.4 : 1.2;
  const bw = days.length ? (W - gap * (days.length - 1)) / days.length : 0;
  const bars = days.length
    ? '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      days.map(([d, n], i) => {
        const h = Math.max(2.5, (n / maxDay) * H);
        return '<rect class="' + (d === today ? 'today' : '') + '" x="' + (i * (bw + gap)).toFixed(2) + '" y="' + (H - h).toFixed(2) +
          '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="0.8"><title>' + esc(d + ' 换卡 ' + n + ' 次') + '</title></rect>';
      }).join('') + '</svg>' +
      '<div class="axis"><span>' + esc(days[0][0]) + '</span><span>共 ' + days.length + ' 天 · 累计 ' +
        num(s.switches) + ' 次 · 单日最多 ' + maxDay + '</span><span>' + esc(days[days.length - 1][0]) + '</span></div></div>'
    : '';

  const pairs = s.topPairs || [];
  const maxPair = pairs.reduce((m, p) => Math.max(m, p.n), 1);
  const rank = pairs.length
    ? '<div class="legend" style="margin:18px 0 2px">换卡方向（日志窗口内）</div><div class="rank">' +
      pairs.map(p => '<div class="rank-row"><div class="label" title="' + esc(p.edge) + '">' + esc(p.edge) + '</div>' +
        '<div class="bar"><i style="width:' + ((p.n / maxPair) * 100).toFixed(1) + '%"></i>' +
        '<em>' + esc(p.n) + '</em></div></div>').join('') + '</div>'
    : '';

  const attr = attributeSwitches(S.samples, ev.recent || []);
  const suspect = !attr ? '' : '<div class="sub-head">谁在踢卡</div>' + (attr.named
    ? '<div class="legend" style="margin:2px 0 6px">采样覆盖窗内 ' + attr.switches + ' 次换卡，' + attr.named +
      ' 次在换卡瞬间点到在场调用方（相关非因果，短连接会漏点名）</div><div class="rank">' +
      attr.tally.map(([k, n]) => '<div class="rank-row"><div class="label" title="' + esc(k) + '">' + esc(k) + '</div>' +
        '<div class="bar"><i style="width:' + ((n / attr.tally[0][1]) * 100).toFixed(1) + '%"></i>' +
        '<em>' + esc(n) + '</em></div></div>').join('') + '</div>'
    : '<div class="legend" style="margin-top:2px">采样覆盖窗内 ' + attr.switches +
      ' 次换卡，都没有在 ±20 s 采样窗里点到在场调用方 —— 短连接或采样空窗，不猜。</div>');

  paintId('thrash-body',
    '<div class="thrash-top">' +
    '<div class="hero-stat ' + (todayN > 5 ? 'hot' : '') + '"><b>' + (todayN == null ? '—' : esc(todayN)) + '</b>' +
    '<span>今日换卡 · ' + esc(today) + '</span></div>' +
    '<div class="tiles">' +
    tile('乒乓对（<60 s）', s.pingPongPairs, s.pingPongPairs > 10 ? 'hot' : '', s.shortestPingPongSec != null ? '最短间隔 ' + s.shortestPingPongSec + ' s' : '') +
    tile('拉起/重试失败', s.fails, s.fails > 10 ? 'warm' : '') +
    tile('冷加载 中位', cold.p50 != null ? cold.p50 + ' s' : null, '', 'p95 ' + (cold.p95 != null ? cold.p95 + ' s' : '—') + ' · 最长 ' + (cold.max != null ? cold.max + ' s' : '—') + ' · 样本 ' + (cold.samples || 0)) +
    tile('最凶的一条边', s.worstEdge ? s.worstEdge.n + ' 次' : null, 'hot', s.worstEdge ? s.worstEdge.edge : '双向合并计') +
    '</div></div>' + bars + rank + suspect);
}

/* ---------- Tier 4 · 事件流（带筛选） ---------- */
const KIND_TONE = { switch: 'warn', launch: 'ok', serving: 'ok', restart_for: 'warn', fail: 'bad', dead: 'bad', error: 'bad', fatal: 'bad', timeout: 'bad', idle_stop: 'absent', listen: 'absent', other: '' };
const KIND_GROUP = {
  switch: ['switch', 'restart_for'],
  fail: ['fail', 'dead', 'fatal', 'timeout', 'error'],
  launch: ['launch', 'serving', 'listen'],
  idle: ['idle_stop', 'other'],
};
const FILTERS = [
  { k: 'all', h: '全部' },
  { k: 'switch', h: '换卡' },
  { k: 'launch', h: '启动' },
  { k: 'fail', h: '失败' },
  { k: 'idle', h: '其他' },
];
function renderEvents(st) {
  const ev = st.events;
  // 日志路径由 applyLedgerTab 统一画进台账 meta，这里不再重复写
  S.archiveError = ev.archiveError || null;
  if (ev.status !== 'ok') {
    S.events = [];
    paintId('events-filter', '');
    paintId('events-body', '<div class="empty-state">读不到日志</div>');
    applyLedgerTab();
    return;
  }
  S.events = ev.recent || [];
  const counts = { all: S.events.length };
  Object.keys(KIND_GROUP).forEach(k => { counts[k] = S.events.filter(e => KIND_GROUP[k].includes(e.kind)).length; });
  S.eventCounts = counts;
  if (!S.filter) S.filter = 'all';
  drawFilters();
  drawEvents();
  applyLedgerTab();
}
function drawFilters() {
  const counts = S.eventCounts || {};
  paintId('events-filter', FILTERS.map(f => '<button class="fchip" type="button" data-k="' + f.k + '" aria-pressed="' +
    (S.filter === f.k ? 'true' : 'false') + '">' + esc(f.h) + '<em>' + (counts[f.k] || 0) + '</em></button>').join('') +
    '<a class="export" href="/api/export?what=events" download>导出 CSV</a>');
}
function drawEvents() {
  const want = S.filter === 'all' ? null : KIND_GROUP[S.filter];
  const list = (S.events || []).filter(e => !want || want.includes(e.kind)).slice(0, 200);
  paintId('events-body', (S.archiveError
    ? '<div class="legend miss" style="margin:4px 0 8px">事件归档写入在报错（截断后这段会丢）：' + esc(S.archiveError) + '</div>' : '') +
    (list.length ? '<ul class="events">' + list.map(e =>
      '<li><time>' + esc(e.iso.slice(5, 19).replace('T', ' ')) + '</time>' +
      '<span class="kind ' + (KIND_TONE[e.kind] || '') + '"><i></i>' + esc(e.kind) + '</span>' +
      '<span class="txt">' + esc(e.text) + '</span></li>').join('') + '</ul>'
      : '<div class="empty-state">这个筛选下没有事件</div>'));
}

/* ---------- 台账抽屉：事件流 | 驻留历史，两页共用一个抽屉壳 ---------- */
function applyLedgerTab() {
  const tab = S.ledgerTab || 'events';
  document.getElementById('tab-events').classList.toggle('hidden', tab !== 'events');
  document.getElementById('tab-history').classList.toggle('hidden', tab !== 'history');
  document.querySelectorAll('.seg-tab').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === tab ? 'true' : 'false'));
  const st = S.st || {};
  const s = (st.events && st.events.summary) || {};
  if (tab === 'events') {
    el('ledger-meta').innerHTML = '来自 <code>' + esc(st.config ? st.config.proxyLog : '') + '</code> · 已归档 ' +
      num(s.archivedEvents) + ' 条 · ' + (s.truncatedGuess ? '疑似已被 1 MB 截断' : '未检测到截断') +
      ' —— 归档在手，截断不再丢数据';
    el('ledger-count').textContent = (S.events || []).length + ' 条';
  } else {
    el('ledger-meta').textContent = 'samples.jsonl · 网关日志清空后仍可回溯';
    el('ledger-count').textContent = S.historyCount ? S.historyCount + ' 条采样' : '';
  }
}

/* ---------- Tier 4 · 自建历史 ---------- */
// 时间轴配色：模型 id 稳定散列到调色板，同一模型每次刷新颜色不变；空卡固定灰。
const TL_COLORS = ['#0a84ff', '#30d158', '#ffd60a', '#ff9f0a', '#bf5af2', '#64d2ff', '#ff6482'];
function tlColor(id) {
  if (id == null) return '#5a5f68';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TL_COLORS[h % TL_COLORS.length];
}
// 显存 × 驻留时间轴：上带是驻留模型（连续段合一块），下线是显存占用。
// 「换卡的显存锯齿」在这里一眼对上 —— 数据 15 s/条，早就采着了，只欠这张图。
function timelineHtml(samples, totalMiB) {
  if (!samples || samples.length < 2) return '';
  const ts0 = samples[0].ts, ts1 = samples[samples.length - 1].ts;
  if (ts1 - ts0 < 60000) return '';
  const X = ts => ((ts - ts0) / (ts1 - ts0)) * 100;
  const runs = [];
  let cur = null;
  for (const r of samples) {
    const id = r.resident || null;
    if (cur && cur.id === id) { cur.end = r.ts; continue; }
    if (cur) runs.push(cur);
    cur = { id, start: cur ? r.ts : ts0, end: r.ts };
  }
  if (cur) runs.push(cur);
  const pts = samples.filter(r => r.vramUsedMiB != null);
  const vmax = totalMiB || Math.max(...pts.map(p => p.vramUsedMiB), 1);
  const Y0 = 13, YH = 19;
  const poly = pts.map(r => X(r.ts).toFixed(2) + ',' + (Y0 + YH - (r.vramUsedMiB / vmax) * YH).toFixed(2)).join(' ');
  const ids = [];
  for (const r of samples) { const id = r.resident || '(空卡)'; if (!ids.includes(id)) ids.push(id); }
  return '<div style="margin-top:14px">' +
    '<div class="legend" style="margin-bottom:4px">时间轴 · 上带 驻留模型 · 下线 显存（0–' + num(vmax) + ' MiB）</div>' +
    '<svg class="tl" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">' +
    runs.map(r => '<rect x="' + X(r.start).toFixed(2) + '" y="0" width="' + Math.max(0.3, X(r.end) - X(r.start)).toFixed(2) +
      '" height="10" fill="' + tlColor(r.id) + '" rx="1"><title>' + esc(r.id || '(空卡)') + '</title></rect>').join('') +
    '<polyline points="' + poly + '"/></svg>' +
    '<div class="axis"><span>' + esc(new Date(ts0).toTimeString().slice(0, 5)) + '</span><span class="tl-legend">' +
    ids.map(id => '<i style="background:' + tlColor(id === '(空卡)' ? null : id) + '"></i>' + esc(id)).join('　') + '</span>' +
    '<span>' + esc(new Date(ts1).toTimeString().slice(0, 5)) + '</span></div></div>';
}
function renderHistory(h, st) {
  const rows = h.samples || [];
  S.historyCount = rows.length;
  if (!rows.length) {
    paintId('history-body', '<div class="empty-state">' + (st && st.histError
      ? '一条样本都没写进去：' + esc(st.histError)
      : '还没有历史样本') + '</div>' +
      '<div class="legend" style="margin-top:6px">每 15 s 落一条，攒够几分钟这里就会出现驻留时长分布。</div>');
    applyLedgerTab();
    return;
  }
  const histErr = st && st.histError
    ? '<div class="legend miss" style="margin:8px 0 0">历史写入正在报错（最新样本可能停在 ' + esc(ago(st.histLastWriteAt)) + '）：' + esc(st.histError) + '</div>'
    : '';
  // 从自己的采样里算「驻留了哪些模型、各多久」，与网关日志口径无关
  const spans = [];
  let cur = null;
  rows.forEach((r, i) => {
    if (r.resident !== (cur && cur.id)) {
      if (cur) { cur.end = r.ts; spans.push(cur); }
      cur = { id: r.resident, start: r.ts };
    }
    if (i === rows.length - 1 && cur) { cur.end = r.ts; spans.push(cur); }
  });
  const agg = new Map();
  spans.forEach(sp => {
    const sec = Math.round((sp.end - sp.start) / 1000);
    agg.set(sp.id || '(空卡)', (agg.get(sp.id || '(空卡)') || 0) + sec);
  });
  const used = rows.filter(r => r.vramUsedMiB != null);
  const maxV = used.reduce((m, r) => Math.max(m, r.vramUsedMiB), 0);
  // 旁路在场时段：samples.jsonl 里 strays>0 的连续段。老样本没有这个字段，统计自然从有了之后开始。
  let strayMs = 0, straySegs = 0, prevOn = false;
  rows.forEach((r, i) => {
    const on = (r.strays || 0) > 0;
    if (on && !prevOn) straySegs++;
    if (on && i + 1 < rows.length) strayMs += rows[i + 1].ts - r.ts;
    prevOn = on;
  });
  paintId('history-body',
    '<div class="legend" style="margin:10px 0 4px">采样 ' + rows.length + ' 条 · 覆盖 ' +
    Math.round((rows[rows.length - 1].ts - rows[0].ts) / 60000) + ' min · 峰值占用 ' + num(maxV) + ' MiB' +
    (straySegs ? ' · <span style="color:var(--warn-ink)">旁路实例在场 ' + straySegs + ' 段 · 约 ' +
      Math.max(1, Math.round(strayMs / 60000)) + ' min</span>' : '') +
    ' · <a class="export" href="/api/export?what=samples" download>导出 CSV</a></div>' + histErr +
    timelineHtml(rows, st && st.gpu && st.gpu.gpus && st.gpu.gpus[0] ? st.gpu.gpus[0].totalMiB : null) +
    '<div class="rows">' + [...agg.entries()].map(([id, sec]) => row({
      title: id,
      sub: '按本看板采样计的驻留时长',
      cells: [{ v: sec >= 3600 ? (sec / 3600).toFixed(1) + ' h' : Math.round(sec / 60) + ' min', l: '累计' }],
    })).join('') + '</div>');
  applyLedgerTab();
}

/* ---------- 脚注（口径说明，一条不减） ---------- */
function renderCaveat(st) {
  el('caveat').innerHTML =
    '<p><b>这个看板看不到的</b>：请求粒度（哪个软件这一把要的是哪个模型）、排队深度、每个请求的 token 数 —— 网关今天不打 per-request 日志也不暴露内部状态，' +
    '而本看板按约定<b>没有改动 model-proxy.js 一行</b>。「谁在调用」只能到进程粒度。</p>' +
    '<p><b>数据来源</b>：8080 /health 与 /v1/models、8081 /props（活着才探）、netstat+tasklist、nvidia-smi、llama-server 进程命令行、' +
    esc(st.config.proxyLog) + ' 尾部。全部只读。</p>';
}

/* ---------- 抽屉：展开状态记本地，别让每次刷新把用户的位置改掉 ---------- */
function initDrawer(id) {
  const node = el(id);
  const head = node.querySelector('.drawer-head');
  const key = 'mc.drawer.' + id;
  let open = '0';
  try { open = localStorage.getItem(key) || '0'; } catch (_) {}
  node.dataset.open = open;
  head.setAttribute('aria-expanded', open === '1' ? 'true' : 'false');
  head.addEventListener('click', () => {
    const next = node.dataset.open === '1' ? '0' : '1';
    node.dataset.open = next;
    head.setAttribute('aria-expanded', next === '1' ? 'true' : 'false');
    try { localStorage.setItem(key, next); } catch (_) {}
  });
}

/* ---------- 采集节拍线跟着真实刷新走 ---------- */
function restartCadence() {
  const bar = document.querySelector('.cadence > i');
  if (!bar) return;
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = '';
}

async function refresh() {
  const btn = el('now');
  btn.classList.add('busy');
  try {
    const st = await (await fetch('/api/state')).json();
    S.st = st;
    renderHeader(st); renderResident(st); renderVram(st); renderApps(st); renderExperiments(st);
    renderThrash(st); renderVramLedger(st); renderClients(st); renderModels(st);
    renderEvents(st); renderCaveat(st);
  } catch (e) {
    lamp('lamp-gateway', 'bad', '看板服务不可达');
    paint(el('gen-time'), '<span class="miss">采集服务未响应：' + esc(e.message) + '</span>');
  }
  try {
    const h = await (await fetch('/api/history?n=2000')).json();
    S.samples = h.samples || [];
    renderHistory(h, S.st);
    // 历史到得晚：靠它的卡（断连走势、换卡归因）拿到样本后补一次渲染；
    // paint() 自带 diff，内容没变就不会动
    if (S.st) { renderClients(S.st); renderThrash(S.st); }
  } catch (_) { /* 历史失败不影响主面板 */ }
  btn.classList.remove('busy');
  restartCadence();
}

el('now').addEventListener('click', refresh);
el('pause').addEventListener('click', async () => {
  try { await fetch('/api/pause', { method: 'POST' }); } catch (_) { /* 下一轮刷新会再试 */ }
  refresh();
});

/* ---------- 启动器交互 ---------- */
el('apps-body').addEventListener('click', async ev => {
  const b = ev.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const id = b.dataset.app;
  if (b.dataset.act === 'start') {
    const sel = document.querySelector('select.model-pick[data-app="' + id + '"]');
    const model = sel ? sel.value : null;
    if (model) {
      S.appModel[id] = model;
      try { localStorage.setItem('mc.appmodel.' + id, model); } catch (_) {}
    }
    try {
      await fetch('/api/ctl/apps/' + encodeURIComponent(id) + '/start', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
      });
    } catch (_) { /* 状态靠下一轮刷新核对 */ }
  } else {
    try { await fetch('/api/ctl/apps/' + encodeURIComponent(id) + '/stop', { method: 'POST' }); } catch (_) {}
  }
  refresh();
});
el('apps-body').addEventListener('change', ev => {
  const sel = ev.target.closest('select.model-pick');
  if (!sel) return;
  S.appModel[sel.dataset.app] = sel.value;
  try { localStorage.setItem('mc.appmodel.' + sel.dataset.app, sel.value); } catch (_) {}
});

/* 模型切换：两段式确认，防止顺手点一下就把正在跑的模型杀了 */
el('models-body').addEventListener('click', async ev => {
  const b = ev.target.closest('button.act-model');
  if (!b || b.disabled) return;
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = '确认切换？';
    b.classList.add('armed');
    setTimeout(() => {
      if (b.isConnected) { b.dataset.armed = ''; b.textContent = '切换'; b.classList.remove('armed'); }
    }, 4000);
    return;
  }
  try {
    await fetch('/api/ctl/model/activate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: b.dataset.model }),
    });
  } catch (_) { /* 状态靠下一轮刷新核对 */ }
  refresh();
});
el('events-filter').addEventListener('click', ev => {
  const b = ev.target.closest('.fchip');
  if (!b) return;
  S.filter = b.dataset.k;
  drawFilters();
  drawEvents();
});
/* 台账 tab 切换：必须先于 initDrawer 注册，点 tab 时用 stopImmediatePropagation 拦住抽屉开关 */
S.ledgerTab = (() => { try { return localStorage.getItem('mc.ledger.tab') || 'events'; } catch (_) { return 'events'; } })();
el('dr-ledger').querySelector('.drawer-head').addEventListener('click', ev => {
  const t = ev.target.closest('.seg-tab');
  if (!t) return;
  ev.stopImmediatePropagation();
  S.ledgerTab = t.dataset.tab;
  try { localStorage.setItem('mc.ledger.tab', S.ledgerTab); } catch (_) {}
  applyLedgerTab();
});
initDrawer('dr-ledger');
S.filter = 'all';
refresh();
setInterval(refresh, 3000);

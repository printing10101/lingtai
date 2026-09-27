// src/collect.js — 采集层：只读外部信号，一次都不写。
// 原则一：每个探针各自有节奏与各自的成败记录，绝不把「没测到」当成「没有」。
// 原则二：任何一项失败都要在 state 里留下 status/error，前端据此显式标灰，避免假绿。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const P = require('./parsers');
const { Experiments } = require('./experiments');

const OK = 'ok';
const NO = 'absent';      // 明确判定为「没有」（连接被拒 / 进程不存在）
const UNKNOWN = 'unknown'; // 测不出来（超时、命令失败、权限）—— 前端必须和「没有」区分显示

function run(cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? (String(err.message || err.code || err)) : null,
      }));
  });
}

function httpGet(host, port, urlPath, timeout = 2500, key = null) {
  return new Promise(resolve => {
    // agent: false —— 每请求一条新 socket 且用完即关。
    // 用默认全局 agent（Node 19+ keep-alive 为 true）会让看板的探测连接长时间挂在
    // ESTABLISHED 上，于是「谁在调用」里永远有一条自己。
    const headers = {};
    if (key) headers.authorization = 'Bearer ' + key;
    const req = http.get({ host, port, path: urlPath, timeout, agent: false, headers }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => resolve({
        status: res.statusCode,
        json: (() => { try { return JSON.parse(b); } catch (_) { return null; } })(),
        text: b.slice(0, 4000),
        error: null,
      }));
    });
    req.on('error', e => resolve({ status: 0, json: null, text: '', error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: '', error: 'timeout' }); });
  });
}

class Collector {
  constructor(cfg, root) {
    this.cfg = cfg;
    this.root = root;
    // 历史落盘点：dev 时在项目目录下；打成 portable exe 时 exe 每次解压到临时目录，
    // 写在那里等于每次开机失忆 —— 壳会把 LINGTAI_HOME 指到 userData，这里照它落。
    const histRoot = cfg.historyRoot || root;
    this.histFile = path.join(histRoot, cfg.historyDir || 'history', 'samples.jsonl');
    this.state = {
      generatedAt: null,
      lastError: null,
      gateway: { status: UNKNOWN },
      upstream: { status: UNKNOWN },
      resident: { status: UNKNOWN },
      gpu: { status: UNKNOWN, gpus: [] },
      clients: { status: UNKNOWN, list: [] },
      registry: { status: UNKNOWN, models: [], default: null },
      events: { status: UNKNOWN, summary: {}, recent: [] },
      // 自建历史的健康也属于 state：写失败只藏在自己的字段里，抽屉就会永远演"还没有样本"
      histError: null,
      histLastWriteAt: null,
      pausedUntil: null,
      config: { proxyHost: cfg.proxyHost, proxyPort: cfg.proxyPort, upstreamPort: cfg.upstreamPort, proxyLog: cfg.proxyLog },
    };
    this.lastClients = new Map(); // pid -> {firstSeen, name}
    this.prevResident = null;
    this.residentSince = null;
    this.timers = [];
    this.logCache = { size: -1, events: null };
    this.archived = null; // 事件自归档的内存镜像，懒加载
    this.archError = null;
    // 实验观测：config.json 的 experiments.sources 注册了源才启用。
    // 它与网关观测互相独立 —— 没注册就如实标 absent，不演一张空实验台
    this.experiments = this.cfg.experiments && Array.isArray(this.cfg.experiments.sources) && this.cfg.experiments.sources.length
      ? new Experiments(this.cfg) : null;
    this.state.experiments = this.experiments
      ? { status: UNKNOWN, checkedAt: null, sources: [] }
      : { status: 'absent', note: 'config.json 没有注册实验源（experiments.sources）', sources: [] };
  }

  start() {
    const c = this.cfg.cadenceMs || {};
    const every = (ms, fn) => {
      const tick = () => {
        // 暂停时连 generatedAt 都不盖章：让「采集于」停在过去才是如实，
        // 一边暂停一边刷新时间戳会把旧数据演成新数据
        if (this.isPaused()) return;
        Promise.resolve().then(fn).catch(e => {
          // 探针的崩要能被看见：只挂在实例字段上 state 永远不知道（顶栏那格就是死的）
          this.lastError = this.state.lastError = new Date().toISOString().slice(11, 19) + ' ' + String(e && e.message || e);
        });
      };
      tick();
      const t = setInterval(tick, ms);
      if (t.unref) t.unref();
      this.timers.push(t);
    };
    every(c.gateway || 5000, () => this.probeGateway());
    every(c.clients || 3000, () => this.probeClients());
    every(c.gpu || 10000, () => this.probeGpu());
    every(c.procCmdline || 15000, () => this.probeLlamaProc());
    every(c.events || 6000, () => { this.probeLog(); this.probeRegistry(); this.stamp(); });
    if (this.experiments) every(c.experiments || 15000, () => this.probeExperiments());
    return this;
  }

  stop() { this.timers.forEach(t => clearInterval(t)); this.timers = []; }

  stamp() { this.state.generatedAt = new Date().toISOString(); }

  // 上游密钥（只读进内存，缓存一次）：llama-server 开了 --api-key-file，
  // 不带 Bearer 的 /props 恒 401 —— 驻留别名通道就断在这
  propsKey() {
    if (this._propsKey === undefined) {
      try {
        this._propsKey = String(fs.readFileSync(this.cfg.apiKeyFile, 'utf8')).split(/\r?\n/)[0].trim() || null;
      } catch (_) { this._propsKey = null; }
    }
    return this._propsKey;
  }

  // ---- 暂停采集：观察者自己也是负载（3 s 一轮 netstat），跑基准/打游戏时用户需要能喊停 ----
  isPaused() { return Date.now() < this.pausedUntil; }
  setPause(ms) {
    this.pausedUntil = ms > 0 ? Date.now() + ms : 0;
    this.state.pausedUntil = this.pausedUntil || null;
    return this.state.pausedUntil;
  }

  // ---- 网关与上游：8080 活着吗、能列出哪些模型；8081 上到底驻留了哪个 ----
  async probeGateway() {
    const { proxyHost: host, proxyPort, upstreamPort } = this.cfg;
    const h = await httpGet(host, proxyPort, '/health', 2000);
    const m = h.status === 200 ? await httpGet(host, proxyPort, '/v1/models', 2000) : null;
    this.state.gateway = {
      status: h.status === 200 ? OK : (h.error === 'ECONNREFUSED' ? NO : UNKNOWN),
      checkedAt: new Date().toISOString(),
      health: h.status === 200 ? (h.json && h.json.status) || 'ok' : null,
      error: h.error || (h.status && h.status !== 200 ? 'http ' + h.status : null),
      servedModels: m && m.json && m.json.data ? m.json.data.map(d => d.id) : null,
    };
    const pr = await httpGet(host, upstreamPort, '/props', 1500, this.propsKey());
    if (pr.status === 200 && pr.json) {
      this.state.upstream = { status: OK, checkedAt: new Date().toISOString(), props: pr.json, via: '/props' };
    } else {
      this.state.upstream = {
        status: pr.error === 'ECONNREFUSED' ? NO : UNKNOWN,
        checkedAt: new Date().toISOString(), error: pr.error || (pr.status ? 'http ' + pr.status : null),
      };
    }
    const alias = pr.status === 200 && pr.json ? String(pr.json.model_alias || '').trim() : null;
    if (alias) this.state.upstream.alias = alias;
    this.reconcileResident();
  }

  // ---- 调用方：ESTABLISHED 连接的客户端 PID → 进程名 ----
  async probeClients() {
    const [ns, tl] = await Promise.all([
      run('netstat', ['-ano', '-p', 'TCP']),
      run('tasklist', ['/FO', 'CSV', '/NH']),
    ]);
    if (ns.error) {
      this.state.clients = { status: UNKNOWN, error: ns.error, checkedAt: new Date().toISOString(), list: [] };
      return;
    }
    const parsed = P.parseNetstat(ns.stdout, this.cfg.proxyPort);
    const names = P.parseTasklistCsv(tl.error ? '' : tl.stdout);
    // 直接把 pid→进程名 的 Map 交给 probeLlamaProc：判父进程存活要看「在不在」，
    // 旁路卡还要显示「叫什么」，所以这里必须是能 .get() 的 Map 而不是只有 .has() 的 Set
    this.knownPids = names || null;
    const now = Date.now();
    // 看板自己每 5 s 探一次 8080，node 的默认 agent 带 keep-alive，
    // 不排掉就会把「本看板」列成调用方 —— 观察者污染被观察对象，这类数一旦进去就没法信了。
    const selfPids = new Set([process.pid, ...(this.extraSelfPids || [])]);
    const list = parsed.clients.filter(cl => !selfPids.has(cl.pid)).map(cl => {
      const info = names.get(cl.pid) || {};
      if (!this.lastClients.has(cl.pid)) this.lastClients.set(cl.pid, { firstSeen: now });
      return {
        pid: cl.pid,
        name: info.name || '(已退出/查不到)',
        memText: info.memText || null,
        conns: cl.conns.length,
        since: new Date(this.lastClients.get(cl.pid).firstSeen).toISOString(),
        heldSec: Math.round((now - this.lastClients.get(cl.pid).firstSeen) / 1000),
      };
    });
    for (const pid of [...this.lastClients.keys()]) {
      if (!parsed.clients.some(c => c.pid === pid)) this.lastClients.delete(pid);
    }
    this.state.clients = {
      status: OK,
      checkedAt: new Date(now).toISOString(),
      listenerPid: parsed.listenerPid,
      selfPids: [...selfPids],
      closedConns: parsed.closedConns,
      // 采样空隙里已断开且未留 ESTABLISHED 的连接抓不到调用方；短连接尤其如此，这里如实报计数
      missedNote: '调用方只统计采样时刻处于 ESTABLISHED 的长连接；已断开/短连接在 Windows 里落进 TIME_WAIT 且 PID 恒为 0，只能计数不能点名',
      list: list.sort((a, b) => b.heldSec - a.heldSec),
      tasklistError: tl.error || null,
    };
  }

  // ---- 显存 ----
  async probeGpu() {
    const q = await run('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits',
    ]);
    if (q.error || !q.stdout.trim()) {
      this.state.gpu = { status: UNKNOWN, error: q.error || q.stderr || 'nvidia-smi 无输出', gpus: [], checkedAt: new Date().toISOString() };
      return;
    }
    const ca = await run('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader']);
    const gpus = P.parseGpuCsv(q.stdout);
    this.state.gpu = {
      status: OK, checkedAt: new Date().toISOString(), gpus,
      computeApps: ca.error ? null : P.parseComputeApps(ca.stdout),
      computeAppsError: ca.error || null,
    };
  }

  // ---- 网关侧的 llama-server 进程：命令行里有 -m 权重路径与全套调参 ----
  // 关键区分：只有 --port 等于 upstreamPort 的才算「网关驻留」。
  // 实测踩到：本机跑着一个 --port 8082 的孤儿实例（父进程已退出），占 ~12 GB；
  // 早期版本按「有 llama-server 就算驻留」上报，会把网关报成"正在服务 27B"，
  // 而网关其实空着 —— 这类张冠李戴比查不到更有害。
  async probeLlamaProc() {
    const ps = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | ForEach-Object { [string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + $_.CommandLine }"], 12000);
    if (ps.error && !ps.stdout) {
      this.state.llamaProc = { status: UNKNOWN, error: ps.error, checkedAt: new Date().toISOString(), gatewayProcs: [], strays: [] };
      return;
    }
    const procs = ps.stdout.split(/\r?\n/).filter(l => (l.match(/\|/g) || []).length >= 2).map(l => {
      const i1 = l.indexOf('|');
      const i2 = l.indexOf('|', i1 + 1);
      return {
        pid: Number(l.slice(0, i1)),
        ppid: Number(l.slice(i1 + 1, i2)),
        ...P.parseLlamaCmdline(l.slice(i2 + 1)),
      };
    });
    // 用上一次 tasklist 的 PID 集合判父进程是否还在（不在＝孤儿实例，没人会去收它），
    // 顺带把父进程的名字也带上 —— 判断「这个旁路是谁拉起来的」就差这个名字。
    if (this.knownPids) procs.forEach(p => {
      const parent = this.knownPids.get(p.ppid);
      p.parentAlive = !!parent;
      p.parentName = parent ? parent.name : null;
    });
    const up = String(this.cfg.upstreamPort);
    const gatewayProcs = procs.filter(p => String(p.port) === up);
    const strays = procs.filter(p => String(p.port) !== up);
    this.state.llamaProc = {
      status: procs.length ? OK : NO,
      checkedAt: new Date().toISOString(),
      procs, gatewayProcs, strays,
      // 网关的 killUpstream 用 `taskkill /IM llama-server.exe /F`：按镜像名全杀，
      // 旁路实例会在网关换模型时被一起吃掉 —— 数量不为 0 时必须显式警告。
      killByImageRisk: strays.length
        ? '网关 killUpstream() 按镜像名 taskkill /IM llama-server.exe /F，这 ' + strays.length + ' 个旁路实例会在换模型时被一并杀掉'
        : null,
      error: ps.stderr && !procs.length ? ps.stderr.trim().slice(0, 200) : null,
    };
    if (gatewayProcs.length) {
      const base = path.basename(gatewayProcs[0].modelFile || '');
      const hit = (this.state.registry.models || []).find(m => m.file === base || m.id === gatewayProcs[0].alias);
      this.setResident(hit ? hit.id : base, 'cmdline');
    }
    // 网关端口上没有实例时不在这里下结论 —— 交给 reconcileResident，
    // 它同时看 8081 的探测结果，避免把「还没采到」说成「确认没有」。
    this.reconcileResident();
  }

  // 驻留判定收口：两个探针各自只能看到一半（8081 活着但没有别名 / 有网关端口上的进程但 /props 还没探到），
  // 谁最后跑完谁来定档；定不了就老实留 unknown，不许默认成"没有"。
  reconcileResident() {
    const alias = this.state.upstream.status === OK && this.state.upstream.props
      ? String(this.state.upstream.props.model_alias || '').trim() : '';
    const gp = this.state.llamaProc && this.state.llamaProc.gatewayProcs;
    if (alias) return this.setResident(alias, 'props');
    if (gp && gp.length) {
      const base = path.basename(gp[0].modelFile || '');
      const hit = (this.state.registry.models || []).find(m => m.file === base || m.id === gp[0].alias);
      return this.setResident(hit ? hit.id : base || null, 'cmdline');
    }
    // 只有「确认 8081 拒连」且「确实枚举过进程表且网关端口上没有实例」才敢判 absent
    if (this.state.upstream.status === NO && Array.isArray(gp)) {
      return this.setResident(null, null, NO);
    }
    if (this.state.resident.status !== NO) this.state.resident = { status: UNKNOWN, since: new Date().toISOString() };
  }

  setResident(id, source, forcedStatus) {
    const cur = this.state.resident.id || null;
    const nextId = forcedStatus === NO ? null : (id || null);
    if (cur === nextId && this.state.resident.status === (forcedStatus || (nextId ? OK : NO))) return;
    if (nextId) {
      this.state.resident = { status: OK, id: nextId, source, since: new Date().toISOString() };
      this.residentSince = this.residentSince && this.prevResident === nextId ? this.residentSince : new Date().toISOString();
      this.state.resident.since = this.residentSince;
    } else {
      this.state.resident = { status: forcedStatus || NO, id: null, source: null, since: new Date().toISOString() };
      this.residentSince = null;
    }
    this.prevResident = nextId;
  }

  // 量模型盘的剩余空间。statfs 失败（权限/挂载点怪异）就给 null，由前端如实显示「量不出」
  probeDiskFree(dir) {
    try {
      const sf = fs.statfsSync(dir);
      const gb = n => Math.round(n * sf.bsize / 1073741824);
      return { freeGB: gb(sf.bavail), totalGB: gb(sf.blocks) };
    } catch (_) { return null; }
  }

  // 注册表之外的盘上权重：机器上还有不归网关管的 GGUF（旁路软件自带 / 嵌入模型 / 试验拷贝）。
  // 「显示所有本地模型」的另一半 —— 只列不判，网关切不了它们这一点必须如实说。
  scanExtraModels(registeredNames) {
    const dirs = Array.isArray(this.cfg.extraModelDirs) ? this.cfg.extraModelDirs : [];
    const out = [];
    for (const d of dirs) {
      if (path.resolve(d) === path.resolve(this.cfg.modelsDir)) continue;
      let entries;
      try { entries = fs.readdirSync(d); } catch (e) { out.push({ dir: d, error: String(e.message || e) }); continue; }
      for (const f of entries) {
        if (!/\.gguf$/i.test(f)) continue;
        try {
          const st = fs.statSync(path.join(d, f));
          out.push({ name: f, dir: d, sizeMB: Math.round(st.size / 1048576), mtime: st.mtime.toISOString(), sameName: registeredNames.has(f) });
        } catch (_) { /* 列到了却 stat 不到（竞态/权限），下轮自然重试 */ }
      }
    }
    return out;
  }

  // ---- 注册表 ∩ 盘上权重 ----
  probeRegistry() {
    try {
      const raw = fs.readFileSync(this.cfg.registryFile, 'utf8');
      const reg = JSON.parse(raw);
      const files = {};
      try {
        for (const f of fs.readdirSync(this.cfg.modelsDir)) {
          if (!/\.gguf$/i.test(f)) continue;
          const st = fs.statSync(path.join(this.cfg.modelsDir, f));
          files[f] = { size: st.size, mtime: st.mtime.toISOString() };
        }
      } catch (e) { /* 目录读不到时 models 全标 unknown，下面 exists 仍按 false 处理 */ }
      this.state.registry = {
        status: OK, checkedAt: new Date().toISOString(),
        file: this.cfg.registryFile,
        default: reg.default || null,
        models: P.joinRegistry(reg, files),
        others: this.scanExtraModels(new Set(Object.keys(files))),
        diskFiles: Object.keys(files).length,
        // 权重都是几个 GB 的大家伙，盘满是一类「冷加载失败」的隐性原因，顺手量出来
        disk: this.probeDiskFree(this.cfg.modelsDir),
      };
    } catch (e) {
      this.state.registry = { status: UNKNOWN, error: String(e.message || e), models: [], checkedAt: new Date().toISOString() };
    }
  }

  // ---- 事件流：网关日志只 1 MB 就整文件清空，所以历史必须自己落盘 ----
  archFile() { return path.join(path.dirname(this.histFile), 'events.jsonl'); }

  loadArchive() {
    if (this.archived) return this.archived;
    let lines = [];
    try { lines = fs.readFileSync(this.archFile(), 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { /* 首次启动还没有归档 */ }
    this.archived = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    return this.archived;
  }

  // 把日志里解析出的事件追加进自建归档。幂等：按 ts|kind|text 去重，
  // 崩溃重启后重放同一段日志不会写重 —— 归档是唯一能跨 1 MB 截断的账本。
  archiveEvents(fileEvents) {
    const archived = this.loadArchive();
    const seen = new Set(archived.map(P.eventKey));
    const fresh = [];
    for (const e of fileEvents) {
      const k = P.eventKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(e);
    }
    if (fresh.length) {
      try {
        fs.mkdirSync(path.dirname(this.archFile()), { recursive: true });
        fs.appendFileSync(this.archFile(), fresh.map(e => JSON.stringify(e)).join('\n') + '\n');
        this.archError = null;
      } catch (e2) { this.archError = String(e2.message || e2); }
      archived.push(...fresh);
    }
    return archived;
  }

  probeLog() {
    let st;
    try { st = fs.statSync(this.cfg.proxyLog); } catch (e) {
      this.state.events = { status: UNKNOWN, error: '读不到 ' + this.cfg.proxyLog, summary: {}, recent: [], checkedAt: new Date().toISOString() };
      return;
    }
    if (this.logCache.size !== st.size || !this.logCache.events) {
      const text = fs.readFileSync(this.cfg.proxyLog, 'utf8');
      const events = P.parseProxyLog(text);
      // 先归档再汇总：抖动账本的口径从「日志窗口」升级成「归档 ∪ 日志」，
      // 1 MB 截断从此吃不掉换卡历史
      const archived = this.archiveEvents(events);
      const merged = P.mergeEvents(archived, events);
      const fileFirstTs = events.length ? events[0].ts : null;
      this.logCache = {
        size: st.size, events, merged,
        summary: {
          ...P.summarizeEvents(merged),
          fileSizeBytes: st.size,
          // 首行时间远晚于文件出生时间 → 说明文件本身被截断过。
          // 有归档之后这只是「文件曾清空」的注脚，不再是数据丢失。
          truncatedGuess: !!(st.birthtimeMs && fileFirstTs && fileFirstTs - st.birthtimeMs > 3600 * 1000),
          archivedEvents: archived.length,
          mtime: st.mtime.toISOString(),
        },
      };
    }
    const { events, summary } = this.logCache;
    const phantom = P.phantomIds(this.logCache.merged, (this.state.registry.models || []).map(m => m.id));
    this.state.events = {
      status: OK, checkedAt: new Date().toISOString(),
      summary, phantom,
      archiveError: this.archError,
      recent: events.slice(-260).reverse(),
    };
  }

  // 导出用：归档 ∪ 当前日志的合并视图（probeLog 没跑过时退化为纯归档）
  getMergedEvents(limit) {
    const merged = this.logCache.merged || this.loadArchive();
    return merged.slice(-limit);
  }

  // ---- 实验台：实验自产落盘物 + python 进程归因。探针失败照旧显式留痕，不演空台 ----
  async probeExperiments() {
    try {
      this.state.experiments = await this.experiments.probe();
    } catch (e) {
      this.state.experiments = {
        status: UNKNOWN,
        error: String(e.message || e),
        checkedAt: new Date().toISOString(),
        sources: this.state.experiments && this.state.experiments.sources || [],
      };
    }
  }

  // ---- 自主历史：网关日志会被截断，这份不会 ----
  appendHistory() {
    if (this.isPaused()) return; // 暂停期间不落样本，否则历史里全是复读的旧值
    try {
      fs.mkdirSync(path.dirname(this.histFile), { recursive: true });
      this.rotateHistoryIfNeeded();
      const g = this.state.gpu.gpus && this.state.gpu.gpus[0];
      fs.appendFileSync(this.histFile, JSON.stringify({
        ts: Date.now(),
        resident: this.state.resident.id || null,
        vramUsedMiB: g ? g.usedMiB : null,
        utilPct: g ? g.utilPct : null,
        // 旁路实例数量进采样：孤儿「来去无常」，不落盘就永远只是轶事
        strays: this.state.llamaProc ? (this.state.llamaProc.strays || []).length : null,
        // TIME_WAIT 计数进采样：差分/走势是「网关繁忙程度」唯一的诚实估计
        closedConns: this.state.clients.status === OK ? this.state.clients.closedConns : null,
        clients: this.state.clients.list.map(c => c.name + ':' + c.pid),
      }) + '\n');
      this.state.histError = null;
      this.state.histLastWriteAt = new Date().toISOString();
    } catch (e) { this.state.histError = String(e.message || e); }
  }

  // samples.jsonl 超过上限就按 4 抽稀（保首尾）：15 s 一条 ≈ 700 KB/天，
  // 常驻一年 250 MB+，这份文件是打算永远写下去的，必须自己会瘦身。
  rotateHistoryIfNeeded() {
    const max = this.cfg.historyMaxBytes || 8 * 1024 * 1024;
    let st;
    try { st = fs.statSync(this.histFile); } catch (_) { return; }
    if (st.size < max) return;
    const lines = fs.readFileSync(this.histFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const thinned = P.thinHistoryLines(lines, 4);
    fs.writeFileSync(this.histFile, thinned.join('\n') + '\n');
  }

  getState() { return this.state; }
}

module.exports = { Collector, OK, NO, UNKNOWN };

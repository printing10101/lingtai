// src/experiments.js — 实验观测采集器：只读实验自产的落盘物（日志尾 / gen_log.csv / run config.json / report.md），
// 外加一遍 python 进程枚举做「进程还在不在」的归因。不改实验脚本一行，不发任何会改变实验状态的请求。
// 纪律与 collect.js 一致：每个源各自记录成败；「没测到」与「确认没有」在 state 里必须分得开。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const X = require('./exparsers');

const OK = 'ok';
const UNKNOWN = 'unknown';

// 文件读取上限：日志超过它就读尾部（tqdm 现势只在尾部，历史帧不值得整读）
const LOG_TAIL_BYTES = 512 * 1024;

function run(cmd, args, timeout = 10000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: String(stdout || ''),
        error: err ? (String(err.message || err.code || err)) : null,
      }));
  });
}

// 目录边界：readdir 给的名字先过一道白名单（不含分隔符、不是点项），再 resolve 回根内。
// 实验源目录来自 config.json 属可信配置，但扫描出的条目名仍按外部输入对待 —— 越界宁可漏看也不放行。
function safeJoin(root, name) {
  if (typeof name !== 'string' || !name.length) return null;
  if (/[\\/]/.test(name) || name === '.' || name === '..') return null;
  const rootRes = path.resolve(root);
  const full = path.resolve(rootRes, name);
  return full === rootRes || full.startsWith(rootRes + path.sep) ? full : null;
}

// 读文件尾部（不必整读大日志）：从文件末尾取最多 maxBytes，掐掉开头那半行避免半行 UTF-8
function readTail(file, maxBytes = LOG_TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally { fs.closeSync(fd); }
}

class Experiments {
  constructor(cfg) {
    this.cfg = cfg.experiments || {};
    this.sources = Array.isArray(this.cfg.sources) ? this.cfg.sources : [];
    this.stallSec = (this.cfg.stallMin || 10) * 60;
    this.activeHorizonSec = (this.cfg.activeHours || 24) * 3600;
    this.lookbackMs = (this.cfg.lookbackDays || 45) * 86400 * 1000;
    // 代速差分的上一帧：runKey -> { gens, ts }。ETA 的兜底口径（无 tqdm 时）全靠它
    this.prevGens = new Map();
    this.prevRate = new Map(); // runKey -> secPerGen（EMA 平滑）
  }

  async probe() {
    const procs = await this.probePythonProcs();
    const sources = [];
    for (const src of this.sources) {
      try { sources.push(await this.probeSource(src, procs)); }
      catch (e) {
        sources.push({ id: src.id || '?', name: src.name || src.id || '?', status: UNKNOWN,
          error: String(e.message || e), checkedAt: new Date().toISOString(), runs: [], summary: {} });
      }
    }
    return {
      status: OK,
      checkedAt: new Date().toISOString(),
      stallMin: Math.round(this.stallSec / 60),
      procs,
      sources,
    };
  }

  // python 进程枚举：实验归因的另一半。只认命令行，不猜镜像名
  async probePythonProcs() {
    const ps = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='pythonw.exe'\" | ForEach-Object { [string]$_.ProcessId + '|' + $_.CommandLine }"], 12000);
    if (ps.error && !ps.stdout) return { status: UNKNOWN, error: ps.error, count: 0, list: [], checkedAt: new Date().toISOString() };
    const list = ps.stdout.split(/\r?\n/).filter(l => l.includes('|')).map(l => {
      const i = l.indexOf('|');
      return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) };
    }).filter(p => Number.isFinite(p.pid) && p.pid > 0);
    return { status: OK, count: list.length, list, checkedAt: new Date().toISOString() };
  }

  async probeSource(src, procs) {
    const now = Date.now();
    const logsDir = src.logsDir || null;
    const runsDir = src.runsDir || null;
    const errors = [];
    if (!runsDir && !logsDir) throw new Error('实验源既没有 runsDir 也没有 logsDir');

    // ---- 日志：launcher 链记录 + 每个 run 的 tqdm 现势 ----
    let chain = null;
    let chainMtime = 0;
    let chainLogFile = null;
    const logTextByRun = new Map(); // run 目录名 -> 日志原文（取含其 CMD 的那份）
    if (logsDir) {
      let entries;
      try { entries = fs.readdirSync(logsDir); } catch (e) { errors.push('logsDir 读不到: ' + e.message); entries = []; }
      for (const f of entries) {
        const full = safeJoin(logsDir, f);
        if (!full || !/\.log$/i.test(f)) continue;
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        let text;
        try { text = st.size > LOG_TAIL_BYTES ? readTail(full) : fs.readFileSync(full, 'utf8'); }
        catch (_) { continue; }
        // 链记录：哪个日志带「链启动」就用哪个（只取最后一段，历史段解析器自己会切掉）
        const c = X.parseLauncherLog(text);
        if (c && st.mtimeMs > chainMtime) { chain = c; chainMtime = st.mtimeMs; chainLogFile = full; }
        // CMD 头里的 --out 路径 = run 目录。一个日志只挂一个 run
        const cmd = text.match(/^CMD: (.+)$/m);
        if (cmd) {
          const out = (cmd[1].match(/--out (?:")?([^\s"]+)/) || [])[1];
          if (out) logTextByRun.set(path.basename(out), text);
        }
      }
    }

    // ---- 批脚本进程：tj 这类「批进程不点名 run」的源，靠它把 stalled 判出来 ----
    let batchAlive = false;
    if (src.batchScriptRe) {
      let re;
      try { re = new RegExp(src.batchScriptRe, 'i'); } catch (_) { re = null; errors.push('batchScriptRe 编译失败'); }
      if (re) batchAlive = procs.list.some(p => re.test(p.cmd));
    }

    // ---- run 目录扫描 ----
    const runs = [];
    if (runsDir) {
      let entries;
      try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); }
      catch (e) { errors.push('runsDir 读不到: ' + e.message); entries = []; }
      for (const ent of entries) {
        const dir = safeJoin(runsDir, ent.name);
        if (!dir || !ent.isDirectory()) continue;
        const cfgFile = path.join(dir, 'config.json');
        let cfgSt;
        try { cfgSt = fs.statSync(cfgFile); } catch (_) { continue; } // 没有 config.json 的不是 run 目录
        const reportFile = path.join(dir, 'report.md');
        let reportSt = null;
        try { reportSt = fs.statSync(reportFile); } catch (_) { /* 未完成 */ }
        // 双向时限：太老的未完成 run（超时被杀的残骸）与太老的完成 run 都不进现势
        if (!reportSt && now - cfgSt.mtimeMs > this.lookbackMs) continue;
        if (reportSt && now - reportSt.mtimeMs > this.lookbackMs) continue;

        const genFile = path.join(dir, 'gen_log.csv');
        let genSt = null;
        let genlog = null;
        try {
          genSt = fs.statSync(genFile);
          genlog = X.parseGenLogCsv(fs.readFileSync(genFile, 'utf8'));
        } catch (_) { /* 还没写出第一代 */ }

        let cfg = null;
        try { cfg = X.parseRunConfig(fs.readFileSync(cfgFile, 'utf8')); } catch (_) { /* 下轮重试 */ }
        const logText = logTextByRun.get(ent.name) || null;
        const tqdm = logText ? X.lastTqdm(logText) : null;

        // 心跳 = 最后一次写出进度证据的时刻。gen_log 优先（它在长），有 tqdm 帧的日志视为刚写过
        const hb = Math.max(genSt ? genSt.mtimeMs : 0, reportSt ? reportSt.mtimeMs : 0, tqdm ? now : 0) || cfgSt.mtimeMs;
        const heartbeatAgeSec = Math.round((now - hb) / 1000);

        // 进程归因：run 级（命令行点名 run 目录名）或批级（batchScriptRe 命中）
        const needle = ent.name.toLowerCase();
        const runProcs = procs.list.filter(p => p.cmd.toLowerCase().replace(/\//g, '\\').includes(needle));
        const procAlive = runProcs.length > 0 || batchAlive;

        // 代速差分：15 s 一轮，攒几轮就有可信的 secPerGen（EMA 平滑毛刺）
        const key = (src.id || '?') + '/' + ent.name;
        let secPerGen = this.prevRate.get(key) || null;
        const prev = this.prevGens.get(key);
        if (prev && genlog && genlog.gens > prev.gens) {
          const dtMs = now - prev.ts;
          if (dtMs > 9000) {
            const spg = dtMs / 1000 / (genlog.gens - prev.gens);
            secPerGen = secPerGen == null ? spg : secPerGen * 0.5 + spg * 0.5;
          }
        }
        this.prevGens.set(key, { gens: genlog ? genlog.gens : 0, ts: now });
        if (secPerGen != null) this.prevRate.set(key, secPerGen);

        const totalGens = cfg ? cfg.totalGens : null;
        // 进度现值：gen_log.csv 按阶段刷盘，会落后整整一个阶段；
        // tqdm 在场时用「标签里的阶段号 × stageGens + tqdm 步数」推到实时位置，两者取大
        let gens = genlog ? genlog.gens : 0;
        if (tqdm && cfg && cfg.stageGens) {
          const stageNum = Number((String(tqdm.label).match(/^S(\d+)/) || [])[1]);
          if (Number.isFinite(stageNum) && stageNum >= 1) {
            gens = Math.max(gens, (stageNum - 1) * cfg.stageGens + tqdm.step);
          }
        }
        const eta = X.runEta({ tqdm, gensDone: gens, totalGens, secPerGenFallback: secPerGen });
        const status = X.classifyRun({
          done: !!reportSt,
          heartbeatAgeSec,
          procAlive,
          stallSec: this.stallSec,
          activeHorizonSec: this.activeHorizonSec,
        });
        runs.push({
          id: ent.name,
          dir,
          cfg,
          startedAt: cfgSt.mtime.toISOString(), // config.json 落盘 = 该 run 启动时刻（批脚本开跑即写）
          gens,
          totalGens,
          pct: totalGens ? Math.min(100, Math.round((gens / totalGens) * 1000) / 10) : null,
          stageLabel: tqdm ? tqdm.label : (genlog && genlog.last && genlog.last.stage != null ? 'S' + genlog.last.stage : null),
          tqdmStep: tqdm ? tqdm.step : null,
          tqdmTotal: tqdm ? tqdm.total : null,
          secPerGen: tqdm && tqdm.secPerStep != null ? tqdm.secPerStep : secPerGen,
          rateText: tqdm ? tqdm.rateText : null,
          etaSec: eta.etaSec, etaBasis: eta.basis,
          lastBest: genlog && genlog.last ? genlog.last.best : null,
          lastMean: genlog && genlog.last ? genlog.last.mean : null,
          curve: genlog ? genlog.curve : [],
          status,
          heartbeatAgeSec,
          procPids: runProcs.map(p => p.pid),
          finishedAt: reportSt ? reportSt.mtime.toISOString() : null,
          genMtime: genSt ? genSt.mtime.toISOString() : null,
        });
      }
    }

    const order = { running: 0, stalled: 1, interrupted: 2, unknown: 3, done: 4, archive: 5 };
    runs.sort((a, b) => (order[a.status] - order[b.status]) ||
      ((b.finishedAt || '').localeCompare(a.finishedAt || '')) ||
      b.gens - a.gens);
    const shown = runs.filter(r => r.status !== 'archive'); // 残骸不进现势列表，summary 也不含
    const summary = {
      running: shown.filter(r => r.status === 'running').length,
      stalled: shown.filter(r => r.status === 'stalled').length,
      interrupted: shown.filter(r => r.status === 'interrupted').length,
      done: shown.filter(r => r.status === 'done').length,
      archived: runs.length - shown.length,
    };

    // 链级 ETA：拿唯一在跑 run 的 eta 当当前组剩余（多组并跑的链不猜，只按组数估）
    const runningRuns = shown.filter(r => r.status === 'running');
    let chainEta = null;
    if (chain) {
      const curEta = runningRuns.length === 1 ? runningRuns[0].etaSec : null;
      chainEta = X.chainEta(chain, curEta);
    }

    return {
      id: src.id || '?',
      name: src.name || src.id || '?',
      status: OK,
      checkedAt: new Date(now).toISOString(),
      runsDir, logsDir,
      chainLogFile,
      chain, chainEta,
      batchAlive,
      runs: shown,
      summary,
      errors: errors.length ? errors : null,
    };
  }
}

module.exports = { Experiments, OK, UNKNOWN, readTail };

// src/exparsers.js — 实验观测的纯解析层：输入是实验自产的真实文本
// （tqdm 日尾 / launcher 链日志 / gen_log.csv / run config.json），输出是结构化进度。
// 与 parsers.js 同一条纪律：不碰 IO，才能用 fixtures/experiments 里的真实样本钉死。
// 这些格式都不是我们发明的协议，是实验脚本碰巧已经落盘的东西 —— 解析必须宽容（缺列给 null），
// 但「没解析出来」和「解析出来是零」要分得开。
'use strict';

// ---------- tqdm 帧 ----------
// run_evolution.py 每个 stage 一条 tqdm，stdout 重定向进 results/logs/*.log。
// 文件里 \r 分隔的历史帧全部保留，「当前状态」= 全文最后一个能解析的帧
// （新帧永远追加在后面；文件末尾若被写到半行，残帧解析不出来，自然回退到上一完整帧）。
// 形态：S1 代谢:  70%|███████ | 28/40 [22:07<12:45, 63.76s/gen, best=90.0, food=3.3, mean=44.5]
const TQDM_RE = /^(.+?):\s*(\d{1,3})%\|[^|]*\|\s*(\d+)\/(\d+)\s*\[([^<\]]*)<([^\],]*),\s*([^\],]+?)(?:,\s*(.*))?\]\s*$/;

function hmsToSec(s) {
  const parts = String(s).trim().split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseTqdmFrame(line) {
  const m = String(line).match(TQDM_RE);
  if (!m) return null;
  const metrics = {};
  for (const kv of String(m[8] || '').split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) {
      const v = parseFloat(kv.slice(i + 1));
      metrics[kv.slice(0, i).trim()] = Number.isFinite(v) ? v : null;
    }
  }
  // 速率两种口径：63.76s/gen（每代秒数）或 1.49it/s（每秒代数），统一折成「每步秒数」
  const rateRaw = m[7].trim();
  let secPerStep = null;
  const perStep = rateRaw.match(/^([\d.]+)s\/(\S+)$/);
  const perSec = rateRaw.match(/^([\d.]+)(?:it|gen)?\/s$/);
  if (perStep) secPerStep = parseFloat(perStep[1]);
  else if (perSec && parseFloat(perSec[1]) > 0) secPerStep = 1 / parseFloat(perSec[1]);
  return {
    label: m[1].trim(),
    pct: Number(m[2]),
    step: Number(m[3]),
    total: Number(m[4]),
    elapsedSec: hmsToSec(m[5]),
    etaSec: hmsToSec(m[6]),
    rateText: rateRaw,
    secPerStep,
    metrics,
  };
}

function lastTqdm(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const f = parseTqdmFrame(lines[i]);
    if (f) return f;
  }
  return null;
}

// ---------- launcher（链）日志 ----------
// launch_p0_d_then_a.py 的落盘格式（真实样本见 fixtures/experiments/launch-pa-d-a.log）：
//   ######## 链启动 2026-09-26 15:07:23 ########
//   === 实验D 启动 15:07:23 ===
//   实验 D: 12 组
//   [9/12] direct-real-s3 启动...
//   [8/12] direct-real-s2 完成 129.1 min log=expd_direct-real_s2.log
//   [1/12] modular-real-s1 SKIP (report.md 已存在)
//   === 实验D 结束 exit=1 耗时=11.42h ===
//   全部结束: {'D': 1, 'A': 1}
// 只取最后一段链记录当「当前链」，前面的段落是历史（以前死过的链），不掺进进度。
function parseLauncherLog(text) {
  const t = String(text);
  const starts = [...t.matchAll(/^######## 链启动 (.+?)\s*#+\s*$/gm)];
  if (!starts.length) return null;
  const seg = t.slice(starts[starts.length - 1].index);
  const chain = { startedAt: starts[starts.length - 1][1].trim(), batches: [], allEnded: false };
  let cur = null;
  for (const raw of seg.split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/^=== (.+?) 启动 ([0-9:]{4,8}) ===$/);
    if (m) {
      cur = { name: m[1], startedAt: m[2], total: null, exit: null, durationH: null,
        counts: { done: 0, skip: 0 }, current: null, doneMinSamples: [] };
      chain.batches.push(cur);
      continue;
    }
    m = line.match(/^=== (.+?) 结束 exit=(\d+) 耗时=([\d.]+)h ===$/);
    if (m) {
      const b = chain.batches.find(b => b.name === m[1] && b.exit == null) || cur;
      if (b) { b.exit = Number(m[2]); b.durationH = parseFloat(m[3]); if (b.current) b.current = null; }
      continue;
    }
    m = line.match(/^(.+?):\s*(\d+)\s*组$/);
    if (m && cur) { cur.total = Number(m[2]); continue; }
    m = line.match(/^\[(\d+)\/(\d+)\]\s*(\S+)\s+(启动|完成|SKIP)/);
    if (m) {
      const b = cur;
      if (!b) continue;
      if (m[4] === '启动') b.current = { idx: Number(m[1]), tag: m[3] };
      else {
        if (b.current && b.current.idx === Number(m[1])) b.current = null;
        if (m[4] === '完成') {
          b.counts.done++;
          const min = parseFloat(line.match(/完成\s+([\d.]+)\s*min/)[1]);
          if (Number.isFinite(min)) b.doneMinSamples.push(min);
        } else b.counts.skip++;
      }
      continue;
    }
    if (/^全部结束/.test(line)) chain.allEnded = true;
  }
  return chain;
}

// 链 ETA = 当前组 tqdm 剩余 + 排队组数 × 本链已完成组的平均耗时。
// 平均只用「完成 X min」的实测样本，SKIP 不算（它没花时间）；没有样本就如实给 null。
function chainEta(chain, currentRunEtaSec) {
  const b = chain && chain.batches.find(b => b.exit == null && b.total);
  if (!b) return { leftGroups: 0, etaSec: null, basis: null };
  const left = Math.max(0, b.total - b.counts.done - b.counts.skip - (b.current ? 1 : 0));
  const samples = b.doneMinSamples;
  const avgMin = samples.length ? samples.reduce((a, x) => a + x, 0) / samples.length : null;
  let etaSec = null;
  let basis = null;
  if (left === 0 && currentRunEtaSec != null) { etaSec = currentRunEtaSec; basis = '最后一组，按当前组剩余'; }
  else if (avgMin != null) {
    etaSec = Math.round((currentRunEtaSec || 0) + left * avgMin * 60);
    basis = '排队 ' + left + ' 组 × 近 ' + samples.length + ' 组平均 ' + Math.round(avgMin) + ' min' +
      (currentRunEtaSec != null ? ' + 当前组剩余' : '');
  } else if (currentRunEtaSec != null) { etaSec = currentRunEtaSec; basis = '只有当前组剩余（排队组暂无实测耗时）'; }
  return { leftGroups: left, etaSec, basis };
}

// ---------- run 目录 ----------
// gen_log.csv：每代一行，stage 列阶段内 gen 从 0 计。已完成的代数 = 解析出的完整点数
// （不用行数：末行可能被写到半截，残行 parseFloat 失败被过滤，进度不能被半行虚增）。
// best_fit / mean_fit 就是曲线数据源 —— 「reward 曲线」的单机对应物。
function parseGenLogCsv(text, maxPoints = 90) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { gens: 0, last: null, curve: [] };
  const header = lines[0].split(',').map(s => s.trim());
  const iStage = header.indexOf('stage'), iGen = header.indexOf('gen'),
    iBest = header.indexOf('best_fit'), iMean = header.indexOf('mean_fit');
  if (iGen < 0) return { gens: 0, last: null, curve: [] };
  const pts = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const g = Number(c[iGen]);
    // 列在表头里存在但这一行缺值/半截 = 残行，整行不收：进度不能被写到一半的行虚增
    if (!Number.isFinite(g)) continue;
    if (iBest >= 0 && !Number.isFinite(parseFloat(c[iBest]))) continue;
    if (iMean >= 0 && !Number.isFinite(parseFloat(c[iMean]))) continue;
    pts.push({
      g,
      stage: iStage >= 0 ? Number(c[iStage]) : null,
      best: iBest >= 0 ? parseFloat(c[iBest]) : null,
      mean: iMean >= 0 ? parseFloat(c[iMean]) : null,
    });
  }
  const last = pts.length ? pts[pts.length - 1] : null;
  let curve = pts;
  if (pts.length > maxPoints) {
    const stride = Math.ceil(pts.length / maxPoints);
    curve = pts.filter((_, i) => i % stride === 0);
    if (curve[curve.length - 1] !== pts[pts.length - 1]) curve.push(pts[pts.length - 1]);
  }
  return { gens: pts.length, last, curve };
}

// run 目录里的 config.json 是该 run 的权威参数（比解析 CMD 行可靠）：
// totalGens = stages × stage_gens，是进度百分比的分母。
function parseRunConfig(jsonText) {
  try {
    const c = JSON.parse(jsonText);
    const stages = Array.isArray(c.stages) ? c.stages : null;
    return {
      seed: c.seed != null ? c.seed : null,
      encoding: c.encoding || null,
      popSize: c.pop_size != null ? c.pop_size : null,
      stageGens: c.stage_gens != null ? c.stage_gens : null,
      stagesCount: stages ? stages.length : null,
      totalGens: stages && c.stage_gens ? stages.length * c.stage_gens : null,
    };
  } catch (_) { return null; }
}

// ---------- 状态机 ----------
// 判据全部来自外部信号，组合出五种结论（前端据此显式配色，绝不并入一档）：
//   done        report.md 在 —— 与批脚本断点续跑同一判据
//   running     心跳新鲜（gen_log / 日志 mtime 在 stallSec 内）
//   stalled     匹配的进程还活着，但心跳停了 ≥ stallSec —— 最该喊人的一档
//   interrupted 心跳停了、进程也不在、又没跑到完成 —— 需要人工续跑的那种死法
//   archive     心跳太老（超过 activeHorizonSec）的未完成 run：历史残骸（trunc_e018 这类），不进现势列表
function classifyRun({ done, heartbeatAgeSec, procAlive, stallSec, activeHorizonSec }) {
  if (done) return 'done';
  if (heartbeatAgeSec == null) return 'unknown';
  if (heartbeatAgeSec <= stallSec) return 'running';
  if (procAlive) return 'stalled';
  if (heartbeatAgeSec <= activeHorizonSec) return 'interrupted';
  return 'archive';
}

// ---------- 单 run 的 ETA ----------
// 口径（界面注脚逐字引用，一条不能少）：
//   有 tqdm：当前阶段剩余用 tqdm 自带 ETA，跨阶段按当前阶段实测每代秒数外推 —— 标「当前阶段速度外推」
//   无 tqdm：gen_log 行数差分出的近期代速 × 剩余代数 —— 标「近期代速外推」
//   都没有：如实 null，不编一个数出来
function runEta({ tqdm, gensDone, totalGens, secPerGenFallback }) {
  if (!totalGens) return { etaSec: null, basis: null };
  const remain = Math.max(0, totalGens - (gensDone || 0));
  if (remain === 0) return { etaSec: 0, basis: '已到终点代数' };
  if (tqdm && tqdm.etaSec != null && tqdm.secPerStep != null) {
    const stageRemain = Math.max(0, tqdm.total - tqdm.step);
    const cross = Math.max(0, remain - stageRemain);
    return { etaSec: Math.round(tqdm.etaSec + cross * tqdm.secPerStep), basis: '当前阶段速度外推' };
  }
  if (secPerGenFallback != null && secPerGenFallback > 0) {
    return { etaSec: Math.round(remain * secPerGenFallback), basis: '近期代速外推' };
  }
  return { etaSec: null, basis: null };
}

module.exports = {
  TQDM_RE,
  hmsToSec,
  parseTqdmFrame,
  lastTqdm,
  parseLauncherLog,
  chainEta,
  parseGenLogCsv,
  parseRunConfig,
  classifyRun,
  runEta,
};

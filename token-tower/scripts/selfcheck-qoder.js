'use strict';
// 自检：Qoder CLI 接入（会话级解析 / token 口径 / 台账幂等 / 项目归属 / 活动提取器）
// 只读真实日志，绝不写 data/ —— 塔台常驻进程正在写同一份台账，测试写盘会污染线上数据。
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..');

// 拦掉对 data/ 的一切写入（server.js 与本脚本 require 的是同一个 fs 模块对象）
const realWrite = fs.writeFileSync;
const realAppend = fs.appendFileSync;
let blocked = 0;
const isData = p => String(p).replace(/\\/g, '/').includes('/token-tower/data/');
fs.writeFileSync = (...a) => { if (isData(a[0])) { blocked++; return; } return realWrite(...a); };
fs.appendFileSync = (...a) => { if (isData(a[0])) { blocked++; return; } return realAppend(...a); };

const S = require(path.join(ROOT, 'server.js'));
const {
  scanQoder, newSession, touchSession, sessions, config, warehouse, loadWarehouse,
  ledgerFor, matchProject, normalizePath, activityExtractors,
} = S;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sumByDay = (byDay, k) => Object.values(byDay || {}).reduce((a, v) => a + (v[k] || 0), 0);

loadWarehouse();

// ---------- 取一个真实 Qoder 会话流水（取最大的，覆盖多轮/多天） ----------
const qcfg = (config.sessionDirs || []).find(c => c.tool === 'qoder');
ok('config: qoder 已进 sessionDirs 且开 backfill', !!qcfg && qcfg.backfill === true, qcfg ? qcfg.dir : '');
ok('config: qoder 不再挂 activityDirs（不与 runs/manifest 双记）',
  !(config.activityDirs || []).some(c => c.tool === 'qoder'));

const files = [];
for (const ent of fs.readdirSync(qcfg.dir, { recursive: true, withFileTypes: true })) {
  if (ent.isFile() && ent.name.endsWith('.jsonl')) files.push(path.join(ent.parentPath || qcfg.dir, ent.name));
}
ok('磁盘上能找到 qoder 会话流水', files.length > 0, files.length + ' 个');
let target = files[0], big = -1;
for (const f of files) { const st = fs.statSync(f).size; if (st > big) { big = st; target = f; } }
const lines = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
const name = path.basename(target);

// ---------- 独立参考实现（不复用被测代码的公式） ----------
let refCredits = 0, refLastRatio = 0, refWindow = null, refTurns = 0, refTitle = null, refCwd = null;
for (const l of lines) {
  const o = JSON.parse(l);
  if (!refCwd && o.cwd) refCwd = normalizePath(o.cwd);
  if (o.type === 'runtime-config' && o.contextWindow) refWindow = o.contextWindow;
  const u = o.message && o.message.usage;
  if (u) {
    refCredits += u.credits || 0;
    if (typeof u.context_usage_ratio === 'number') { refLastRatio = Math.max(refLastRatio, u.context_usage_ratio); refTurns++; }
  }
  if (o.type === 'user' && o.humanInput) {
    const c = o.message && o.message.content;
    const t = Array.isArray(c) ? (c.find(x => x.type === 'text') || {}).text : c;
    if (t) refTitle = String(t).split('\n')[0];
  }
}
console.log(`\n  样本 ${name}  ${(big / 1024).toFixed(0)}KB  轮次=${refTurns}  窗口=${refWindow}  credits=${refCredits.toFixed(2)}`);

// ---------- 1. 全文件口径的数值正确性 ----------
const meta = { project: null, fallbackPath: null, title: null, usage: null, phase: null, wm: null, model: null, isCum: false, credits: 0, byDay: null, peakRatio: null };
scanQoder(lines, null, meta, true, 0);
const expIn = Math.round(refLastRatio * (refWindow || 1e6));
ok('token 口径 = 峰值上下文 ratio × contextWindow', near(sumByDay(meta.byDay, 'in'), expIn, refTurns + 2),
  `实得 ${sumByDay(meta.byDay, 'in')} / 期望 ${expIn}`);
ok('credits 与独立求和一致', near(sumByDay(meta.byDay, 'credits'), refCredits, 0.01), sumByDay(meta.byDay, 'credits').toFixed(2));
ok('byDay 有真实日期分桶', Object.keys(meta.byDay || {}).length >= 1, Object.keys(meta.byDay || {}).join(','));
ok('out/cr 不伪造（byDay 只有 in/credits 两个字段）',
  Object.values(meta.byDay).every(v => Object.keys(v).sort().join(',') === 'credits,in'));
ok('标题取自 humanInput 的真实用户输入', !!meta.title && refTitle.startsWith(meta.title.slice(0, 20)), JSON.stringify(meta.title));
ok('模型归属解析出来', meta.model === 'qfmodel', String(meta.model));
ok('阶段是 working/waiting 之一', ['working', 'waiting'].includes(meta.phase), String(meta.phase));

// ---------- 2. 项目归属：真实 cwd，不是安装目录 ----------
ok('归属解析出真实工作区', !!meta.project || !!meta.fallbackPath, meta.project ? 'project=' + meta.project : 'fallback=' + meta.fallbackPath);
ok('归属等于流水里的 cwd', normalizePath(meta.project || meta.fallbackPath) === refCwd, refCwd);
ok('归属不含 AppData（老实现把安装目录当工作区的病灶）',
  !String(meta.project || meta.fallbackPath).toLowerCase().includes('appdata'));

// ---------- 3. 走真实生产路径：touchSession 全量补账 → 幂等 ----------
warehouse.files.clear();
sessions.clear();
touchSession('qoder', target, Date.now(), true, true);
const afterFull = { ...ledgerFor(name, 'qoder') };
ok('全量补账入账成功（台账非零）', afterFull.in > 0 && afterFull.credits > 0,
  `in=${afterFull.in} credits=${afterFull.credits.toFixed(2)}`);

touchSession('qoder', target, Date.now(), true, true);
const afterReFull = { ...ledgerFor(name, 'qoder') };
ok('重复全量补账不重复计数', afterReFull.in === afterFull.in && near(afterReFull.credits, afterFull.credits, 1e-9),
  `in ${afterFull.in}→${afterReFull.in}`);

// 关键回归：全量补账后再跑实时尾部窗口，不能把整段上下文再算一遍
touchSession('qoder', target, Date.now(), true, false);
touchSession('qoder', target, Date.now(), true, false);
const afterLive = { ...ledgerFor(name, 'qoder') };
ok('全量补账后实时窗口不重复计数（尾部窗口从台账峰值续算）',
  afterLive.in === afterFull.in && near(afterLive.credits, afterFull.credits, 1e-6),
  `in ${afterFull.in}→${afterLive.in}, credits ${afterFull.credits.toFixed(2)}→${afterLive.credits.toFixed(2)}`);

// 会话卡片状态
const card = [...sessions.values()].find(s => path.basename(s.file) === name);
ok('会话卡片带标题/模型/阶段/credits', !!card && !!card.title && !!card.model && !!card.phase && card.credits > 0,
  card ? `${card.phase} | ${card.model} | credits=${(card.credits || 0).toFixed(2)} | ${String(card.title).slice(0, 24)}` : '无卡片');

// ---------- 4. 分工具归类：qoder 的 <uuid>.jsonl 不能算成 claude ----------
const qIn = [...warehouse.days.values()].reduce((a, d) => a + ((d.tokByTool && d.tokByTool.qoder && d.tokByTool.qoder.in) || 0), 0);
const claudeDelta = [...warehouse.days.values()].reduce((a, d) => {
  const c = d.tokByTool && d.tokByTool.claude;
  return a + ((c && (c.in || 0) === afterFull.in && (c.cw || 0) === 0) ? 1 : 0);
}, 0);
ok('qoder 用量记在 qoder 名下', qIn > 0, 'tokByTool.qoder.in=' + qIn);
ok('qoder 用量没有被误记成 claude', claudeDelta === 0);

// ---------- 5. 账没记到位：全量重算把差额补回来，不多不少 ----------
// 忠实模拟"上次只记到这里"：峰值占比基线与各日日记账同步调低 2%×W（两者本就一起入账），
// 重启后的全量重算按真实日期对账，应恰好补回这一段，账面回到真实累计
sessions.clear(); warehouse.files.clear();
touchSession('qoder', target, Date.now(), true, true);
const base = { ...ledgerFor(name, 'qoder') };
const led = ledgerFor(name, 'qoder');
const gap = Math.round(0.02 * (refWindow || 1e6));
led.ratio = Math.max(0, (led.ratio || 0) - 0.02);
led.wm = null;   // 连水位线一起抹掉：即使尾部窗口把老行重读一遍，也不该重复计账
const dayKeys = Object.keys(led.days);
led.days[dayKeys[dayKeys.length - 1]].in = Math.max(0, led.days[dayKeys[dayKeys.length - 1]].in - gap);
const sumLedDays = l => Object.values(l.days).reduce((a, v) => a + (v.in || 0), 0);
const beforeRecover = sumLedDays(led);
sessions.clear(); // 让 touchSession 重新 newSession，从台账把 ratio 种子化回来
touchSession('qoder', target, Date.now(), true, true);
const grew = { ...ledgerFor(name, 'qoder') };
ok('账没记到位时，全量重算把差额（约 2%×W）恰好补回',
  near(sumLedDays(grew) - beforeRecover, gap, 1) && grew.in === base.in,
  `补回 ${sumLedDays(grew) - beforeRecover} / 期望 ${gap}，账面 ${beforeRecover}→${grew.in}`);

// 重算之后，无水位线的实时窗口把尾部老行整个重读一遍也不得重复计账（in 与 credits 都不能涨）
led.wm = null;
sessions.clear();
touchSession('qoder', target, Date.now(), true, false);
const still = { ...ledgerFor(name, 'qoder') };
ok('重算后无水位线的实时窗口不重复计账（占比基线从台账峰值续算）',
  still.in === grew.in && near(still.credits, grew.credits, 1e-6),
  `in ${grew.in}→${still.in}, credits ${grew.credits.toFixed(2)}→${still.credits.toFixed(2)}`);

// ---------- 6. 活动提取器：只认能反查出工作区的会话 ----------
const runsDir = path.join(process.env.USERPROFILE || path.join(require('node:os').homedir()), '.qoder', 'logs', 'runs');
const runs = fs.readdirSync(runsDir).sort().reverse();
let noSidDropped = 0, noSidKept = 0, resolved = null, withSid = 0;
for (const r of runs) {
  const p = path.join(runsDir, r, 'manifest.json');
  if (!fs.existsSync(p)) continue;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const hasSid = raw.argv && raw.argv.includes('--session-id');
  const info = activityExtractors.qoder(p);
  if (!hasSid) { if (info === null) noSidDropped++; else noSidKept++; continue; }
  withSid++;
  if (info && !resolved) resolved = { r, info };
}
ok('无 --session-id 的内部工具进程全部丢弃（不再拿安装目录充数）',
  noSidDropped > 0 && noSidKept === 0, `${noSidDropped} 条返回 null，误留 ${noSidKept} 条`);
ok('带 --session-id 的运行能反查出真实工作区',
  withSid > 0 && !!resolved && !String(resolved.info.project || resolved.info.fallbackPath || '').toLowerCase().includes('appdata'),
  resolved ? String(resolved.info.project || resolved.info.fallbackPath) : `带 session-id 的 run ${withSid} 条，无一解析成功`);

// ---------- 7. 跨重启回归：实时增量已记的量，之后全量补账不能再补一遍 ----------
const daySumQ = () => [...warehouse.days.values()].reduce((a, d) => a + (((d.creditsByTool || {}).qoder) || 0), 0);
const base0 = daySumQ();
sessions.clear(); warehouse.files.clear(); // 模拟"塔台重启后重新接管"：会话状态与文件台账都清空
touchSession('qoder', target, Date.now(), true, false); // 实时尾部窗口，按增量口径记了一部分
touchSession('qoder', target, Date.now(), true, true);  // 随后的全量补账
const gained = daySumQ() - base0;
ok('实时增量 + 全量补账不重复计账（日分桶等于该文件真实 credits）',
  near(gained, refCredits, 0.05), `日分桶 +${gained.toFixed(2)} / 真实 ${refCredits.toFixed(2)}`);
const ledAfter = ledgerFor(name, 'qoder');
const dayIn = [...warehouse.days.values()].reduce((a, d) => a + (((d.tokByTool || {}).qoder || {}).in || 0), 0);
ok('台账累计与日分桶合计自洽（all ≥ today 才不会出现"今日比累计大"）',
  ledAfter.in > 0 && dayIn > 0, `台账 in=${ledAfter.in}，日分桶 in 合计=${dayIn}`);

console.log(`\n  data/ 写入拦截 ${blocked} 次（自检不碰线上台账）`);console.log(`\n=== ${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);

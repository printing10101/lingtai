'use strict';
// 自检：ZCode usage DB 接入（model_usage 对账 / 日志时代折抵 / 分日归属 / 幂等与增量 /
// 多模型折抵种子 / 孤儿会话保全 / 会话卡片同源 / claude 按日分桶）。
// 不碰真实的 db.sqlite 与 data/：夹具库建在临时目录；对账全程不发事件；
// 收尾时 loadWarehouse() 把内存台账重新从磁盘同步，就算 5 秒落盘定时器在退出前触发，
// 写回的也只是磁盘上原有的真实数据。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');

const S = require('../server.js');
const { sessions, config, warehouse, ledgerFor, pollZcodeDb, scanClaude } = S;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

// ---------- 随附配置检查（先读文件原件，再动内存里的 config） ----------
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
ok('config: zcode 已进 usageDbs', (shipped.usageDbs || []).some(c => c.tool === 'zcode'));
ok('config: zcode 会话目录仍在监听（卡片要用）', (shipped.sessionDirs || []).some(c => c.tool === 'zcode'));
ok('config: claude 已开历史回填', (shipped.sessionDirs || []).some(c => c.tool === 'claude' && c.backfill));
ok('config: hermes 不受影响', (shipped.usageDbs || []).some(c => c.tool === 'hermes'));

// ---------- 夹具库：四个会话，覆盖折抵 / 多模型 / 跨日 / 无会话行 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-selfcheck-'));
const projRoot = path.join(tmp, 'myproj').replace(/\\/g, '/');
fs.mkdirSync(path.join(tmp, 'myproj', '.git'), { recursive: true });

const noonToday = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const noonYesterday = noonToday - 86400000; // 取正午，避开日界线的时区歧义
const dayKeyOf = ms => S.localDayKey(new Date(ms));
const todayKey = dayKeyOf(noonToday);
const yesterdayKey = dayKeyOf(noonYesterday);

const db = new DatabaseSync(path.join(tmp, 'db.sqlite'));
db.exec(`
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
  CREATE TABLE model_usage (session_id TEXT, model_id TEXT, started_at INTEGER,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_input_tokens INTEGER DEFAULT 0);
`);
db.prepare('INSERT INTO session VALUES (?, ?)').run('sess_a', projRoot);        // 有日记账折抵的主会话
db.prepare('INSERT INTO session VALUES (?, ?)').run('sess_b', projRoot);        // 无日记账折抵（比例摊派）
db.prepare('INSERT INTO session VALUES (?, ?)').run('sess_c', null);            // 多模型 + 无 directory
db.prepare("INSERT INTO session VALUES (?, ?)").run('sess_subagent_agent_x', null); // 子智能体会话
const insUsage = db.prepare('INSERT INTO model_usage (session_id, model_id, started_at, input_tokens, output_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)');
insUsage.run('sess_a', 'GLM-5.3-Flash', noonToday, 1000, 50, 800);
insUsage.run('sess_b', 'GLM-5.3-Flash', noonYesterday, 250, 10, 200);
insUsage.run('sess_b', 'GLM-5.3-Flash', noonToday, 550, 30, 440);
insUsage.run('sess_c', 'GLM-A', noonToday, 900, 40, 700);   // 量大的模型：折抵种子落这里
insUsage.run('sess_c', 'GLM-B', noonToday, 100, 5, 0);      // 量小的模型：不种折抵
insUsage.run('sess_subagent_agent_x', 'GLM-5.3-Flash', noonToday, 60, 3, 0);

// ---------- 日志时代的折抵夹具：一个带日记账、一个不带、一个 DB 里已不存在 ----------
warehouse.files.clear();
warehouse.days.clear();
warehouse.files.set('model-io-sess_a.jsonl', {
  tool: 'zcode', in: 300, out: 20, cr: 250, cw: 0, credits: 0,
  days: { [todayKey]: { in: 300, out: 20, cr: 250, cw: 0, credits: 0 } },
});
warehouse.files.set('model-io-sess_b.jsonl', {
  tool: 'zcode', in: 400, out: 0, cr: 0, cw: 0, credits: 0, // 日记账字段诞生前的老条目
});
warehouse.files.set('model-io-sess_orphan.jsonl', {
  tool: 'zcode', in: 500, out: 10, cr: 0, cw: 0, credits: 0, days: { [yesterdayKey]: { in: 500, out: 10, cr: 0, cw: 0, credits: 0 } },
});

// 会话卡片夹具：zcode 日志监听挂的卡，token 应改为与 DB 同源
const cardKey = `${tmp.replace(/\\/g, '/')}/rollout/model-io-sess_subagent_agent_x.jsonl`;
sessions.set(cardKey, {
  tool: 'zcode', file: cardKey, project: null, title: null, phase: 'working', phaseSince: null, model: null,
  tokens: { in: 0, out: 0, cr: 0, cw: 0 }, credits: 0, ratio: 0, lastSeen: noonToday, lastEmit: 0, wm: null,
});

const openFixture = () => new DatabaseSync(path.join(tmp, 'db.sqlite'), { readOnly: true });
const zled = (sid, model) => ledgerFor(`zcode-db:${sid}:${model || ''}`, 'zcode');
const dayZcode = dk => ((warehouse.days.get(dk) || {}).tokByTool || {}).zcode || {};

// 项目归属：让 matchProject 认得夹具目录（与 hermes 自检同一做法）
config.projectRoots = [tmp.replace(/\\/g, '/')];
S.discoverProjects();

// ---------- 1. 首轮对账：数值、折抵、分日、归属 ----------
let poll = openFixture();
pollZcodeDb(poll, 'zcode');
poll.close();

// 台账键的语义：收敛到 DB 真值 = 日志时代折抵种子 + 差额入账（model-io 旧键已从
// 分工具累计排除，由 zcode-db 键独占承担，所以这里看到的是会话全量）
ok('折抵: 会话总量收敛到 DB 真值（种子300 + 差额700）', zled('sess_a', 'GLM-5.3-Flash').in === 1000,
  `in=${zled('sess_a', 'GLM-5.3-Flash').in}`);
ok('折抵: out/cr 同步收敛（out 20+30、cr 250+550）', zled('sess_a', 'GLM-5.3-Flash').out === 50 && zled('sess_a', 'GLM-5.3-Flash').cr === 800,
  `out=${zled('sess_a', 'GLM-5.3-Flash').out} cr=${zled('sess_a', 'GLM-5.3-Flash').cr}`);
// 比例摊派的会话：昨天 125 + 今天 275 的种子让日分桶只补差额，会话总量仍是 DB 真值
ok('比例摊派: 无日记账按 DB 日分布折抵', zled('sess_b', 'GLM-5.3-Flash').in === 800
  && (dayZcode(yesterdayKey).in || 0) === 125
  && dayZcode(todayKey).in === 700 + 275 + 1000 + 60 + 500, // a差额 + b差额 + c全量 + 子智能体 + 孤儿(落今日)
  `昨日=${dayZcode(yesterdayKey).in} 今日=${dayZcode(todayKey).in}`);
ok('多模型: 折抵种子只落量大的模型', zled('sess_c', 'GLM-A').in === 900 && zled('sess_c', 'GLM-B').in === 100,
  `A=${zled('sess_c', 'GLM-A').in} B=${zled('sess_c', 'GLM-B').in}`);
ok('孤儿: DB 里查不到的会话原账保全', ledgerFor('zcode-db:orphan:sess_orphan', 'zcode').in === 500,
  String(ledgerFor('zcode-db:orphan:sess_orphan', 'zcode').in));
// 差额入账归属项目：只有带 directory 的会话入项目（a 700 + b 400）；
// c / 子智能体 / 孤儿在夹具里没有 directory，只入全局不冒领项目
ok('归属: directory 前缀归到夹具项目', (warehouse.projects.get('myproj') || {}).tokensIn === 700 + 400,
  String((warehouse.projects.get('myproj') || {}).tokensIn));
ok('台账: 归属工具是 zcode', zled('sess_a', 'GLM-5.3-Flash').tool === 'zcode');

// ---------- 2. 卡片 token 与台账同源 ----------
const card = sessions.get(cardKey);
ok('卡片: token 从 DB 供给', card && card.tokens.in === 60 && card.tokens.out === 3,
  card ? `in=${card.tokens.in}` : '无卡片');

// ---------- 3. 幂等：重复轮询台账与日分桶纹丝不动 ----------
const snap = () => JSON.stringify([zled('sess_a', 'GLM-5.3-Flash'), zled('sess_b', 'GLM-5.3-Flash'), dayZcode(todayKey), dayZcode(yesterdayKey)]);
const before = snap();
poll = openFixture();
pollZcodeDb(poll, 'zcode');
poll.close();
ok('幂等: 重复轮询不重复计数', snap() === before);

// ---------- 4. 增量：新行落到真实日期；旧行用量回填只补差额 ----------
const wdb = new DatabaseSync(path.join(tmp, 'db.sqlite'));
insUsage.run('sess_a', 'GLM-5.3-Flash', noonYesterday, 200, 10, 150); // 新增：昨天的请求
wdb.prepare("UPDATE model_usage SET input_tokens = 1200, output_tokens = 60 WHERE session_id = 'sess_a' AND started_at = ?").run(noonToday);
wdb.close();
poll = openFixture();
pollZcodeDb(poll, 'zcode');
poll.close();
ok('增量: 新行按真实日期入账 + 用量回填只补差额', zled('sess_a', 'GLM-5.3-Flash').in === 1400 && (dayZcode(yesterdayKey).in || 0) === 325,
  `in=${zled('sess_a', 'GLM-5.3-Flash').in} 昨日=${dayZcode(yesterdayKey).in}`);

// ---------- 5. claude 按日分桶：scanClaude 出 byDay，bankByDay 两条路不重复计 ----------
const claudeLines = [
  JSON.stringify({ type: 'assistant', timestamp: new Date(noonYesterday).toISOString(), cwd: projRoot,
    message: { model: 'claude-x', usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  JSON.stringify({ type: 'assistant', timestamp: new Date(noonToday).toISOString(),
    message: { model: 'claude-x', usage: { input_tokens: 200, output_tokens: 8, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } } }),
].join('\n');
const cmeta = { project: null, fallbackPath: null, title: null, usage: null, phase: null, wm: null, model: null, isCum: false, credits: 0, byDay: null, peakRatio: null };
scanClaude(claudeLines.split('\n'), null, cmeta, true);
ok('claude: 全文件扫描产出按日分桶', !!cmeta.byDay && !cmeta.isCum, JSON.stringify(cmeta.byDay));
const cledName = 'c-fixture.jsonl';
S.bankByDay(cledName, cmeta.byDay, 'myproj', 'claude', 'claude-x');
S.bankByDay(cledName, cmeta.byDay, 'myproj', 'claude', 'claude-x'); // 重扫一遍
ok('claude: 台账按日补差额不重复', ledgerFor(cledName, 'claude').in === 300
  && (((warehouse.days.get(yesterdayKey).tokByTool || {}).claude || {}).in) === 100
  && (((warehouse.days.get(todayKey).tokByTool || {}).claude || {}).in) === 200,
  `in=${ledgerFor(cledName, 'claude').in}`);

// ---------- 汇总 ----------
console.log(`\n  结果: ${pass} 通过, ${fail} 失败`);
// 收尾防线：内存台账从磁盘重新同步，任何未触发的落盘定时器都只能写回磁盘原有数据
S.loadWarehouse();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 偶发文件锁延迟，留给系统临时目录清理 */ }
process.exit(fail ? 1 : 0);

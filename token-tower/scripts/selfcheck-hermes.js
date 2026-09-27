'use strict';
// 自检：Hermes 接入（usage DB 轮询 / 台账幂等 / 分日归属 / 本地模型标记 / 会话卡片与阶段）
// 不碰真实的 Hermes state.db 与 data/：夹具库建在临时目录；所有轮询走 silent 模式，
// 全程不产生时间线事件；收尾时 loadWarehouse() 把内存台账重新从磁盘同步，
// 就算 5 秒落盘定时器在退出前触发，写回的也只是磁盘上原有的真实数据。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');

const S = require(path.join(ROOT, 'server.js'));
const { sessions, config, warehouse, ledgerFor, pollUsageDbs, isLocalBaseUrl, hermesPhaseOf } = S;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

// ---------- 随附配置检查（先读文件原件，再动内存里的 config） ----------
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
ok('config: hermes 已进 usageDbs', (shipped.usageDbs || []).some(c => c.tool === 'hermes'));
ok('config: hermes 已进 TOOL_META 探测名单', fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').includes("tool: 'hermes'"));

// ---------- 单元：本地端点判定与阶段判定 ----------
ok('isLocalBaseUrl: 127.0.0.1 命中', isLocalBaseUrl('http://127.0.0.1:8080/v1'));
ok('isLocalBaseUrl: 带尾斜杠命中', isLocalBaseUrl('http://127.0.0.1:8080/v1/'));
ok('isLocalBaseUrl: localhost 命中', isLocalBaseUrl('http://localhost:1234/v1'));
ok('isLocalBaseUrl: 远端 API 不命中', !isLocalBaseUrl('https://api.deepseek.com/v1'));
ok('isLocalBaseUrl: 空值不命中', !isLocalBaseUrl(''));
ok('hermesPhaseOf: assistant/stop = 等你确认', hermesPhaseOf({ role: 'assistant', fin: 'stop' }) === 'waiting');
ok('hermesPhaseOf: 还在工具循环 = 工作中', hermesPhaseOf({ role: 'assistant', fin: 'tool_calls' }) === 'working');
ok('hermesPhaseOf: 刚收到用户输入 = 工作中', hermesPhaseOf({ role: 'user', fin: null }) === 'working');
ok('hermesPhaseOf: 无消息 = 工作中', hermesPhaseOf(null) === 'working');

// ---------- 夹具库：两个活跃会话 + 一个已结束会话 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-selfcheck-'));
const projRoot = path.join(tmp, 'myproj').replace(/\\/g, '/');
const projSub = `${projRoot}/sub`;
fs.mkdirSync(path.join(tmp, 'myproj', '.git'), { recursive: true });

const nowSec = Date.now() / 1000;
const tActive = nowSec - 30;      // 活跃会话最后动静
const tDeepseek = nowSec - 86400; // deepseek 那笔账落在昨天
const tEnded = nowSec - 120;      // 已结束会话

const db = new DatabaseSync(path.join(tmp, 'state.db'));
db.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, git_repo_root TEXT,
    model TEXT, started_at REAL, ended_at REAL, last_activity_at REAL);
  CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT DEFAULT '',
    billing_base_url TEXT DEFAULT '', billing_mode TEXT DEFAULT '', task TEXT DEFAULT '',
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
    first_seen REAL, last_seen REAL);
  CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, finish_reason TEXT);
`);
const insSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
insSession.run('sess-local', '本地推理测试会话', projSub, null, 'qwen38-27b', tActive - 600, null, tActive);
insSession.run('sess-ended', '已结束的会话', projRoot, null, 'gpt-oss-20b', tEnded - 300, tEnded, tEnded);
insSession.run('sess-work', '还在干活的会话', projRoot, null, 'qwen38-27b', tActive - 60, null, tActive - 5);
const insUsage = db.prepare(`INSERT INTO session_model_usage
  (session_id, model, billing_provider, billing_base_url, task, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
insUsage.run('sess-local', 'qwen38-27b', 'custom', 'http://127.0.0.1:8080/v1', '', 1000, 50, 200, 10, tActive, tActive);
// 孪生行：同一 (session, model, task) 下 base_url 尾斜杠不同（配置改动的真实产物），
// 台账键若漏掉 billing 维度就会撞键、吞掉较小那行的账
insUsage.run('sess-local', 'qwen38-27b', 'custom', 'http://127.0.0.1:8080/v1/', '', 400, 30, 0, 0, tActive, tActive);
insUsage.run('sess-local', 'deepseek-v4-flash', 'deepseek', 'https://api.deepseek.com/v1', '', 500, 100, 0, 0, tDeepseek, tDeepseek);
insUsage.run('sess-ended', 'gpt-oss-20b', 'custom', 'http://127.0.0.1:8080/v1/', '', 300, 20, 0, 0, tEnded, tEnded);
const insMsg = db.prepare('INSERT INTO messages (session_id, role, finish_reason) VALUES (?, ?, ?)');
insMsg.run('sess-local', 'user', null);
insMsg.run('sess-local', 'assistant', 'stop');
insMsg.run('sess-ended', 'assistant', 'stop');
insMsg.run('sess-work', 'assistant', 'tool_calls');
db.close();

// 把塔台指到夹具：项目根与 usage DB 都换成临时目录（process 随测试结束，无需还原）
config.projectRoots = [`${path.join(tmp, '').replace(/\\/g, '/')}`];
config.usageDbs = [{ tool: 'hermes', db: path.join(tmp, 'state.db').replace(/\\/g, '/') }];
S.discoverProjects();

const dayOf = ts => S.localDayKey(new Date(ts * 1000));
const todayKey = dayOf(tActive);
const yesterdayKey = dayOf(tDeepseek);
const tokToday = () => (warehouse.days.get(todayKey) || {}).tokByToolModel || {};
const tokYesterday = () => (warehouse.days.get(yesterdayKey) || {}).tokByToolModel || {};

// ---------- 1. 首轮补账：数值、分日归属、本地模型标记（首轮走 config 包装，静默） ----------
pollUsageDbs();
const ledLocal = ledgerFor('hermes:sess-local:qwen38-27b:custom:http://127.0.0.1:8080/v1::');
ok('台账: 本地行 in/out/cr/cw 逐项入账',
  ledLocal.in === 1000 && ledLocal.out === 50 && ledLocal.cr === 200 && ledLocal.cw === 10,
  `in=${ledLocal.in} out=${ledLocal.out} cr=${ledLocal.cr} cw=${ledLocal.cw}`);
ok('台账: 归属工具是 hermes', ledLocal.tool === 'hermes', String(ledLocal.tool));
const ledSlash = ledgerFor('hermes:sess-local:qwen38-27b:custom:http://127.0.0.1:8080/v1/::');
ok('台账: 孪生行（base 尾斜杠）不撞键、足额入账', ledSlash.in === 400 && ledSlash.out === 30,
  `in=${ledSlash.in} out=${ledSlash.out}`);
ok('分日: 本地行落在最后为真的那天', ((tokToday().hermes || {})['qwen38-27b'] || {}).in === 1000 + 400);
ok('分日: deepseek 行落在昨天', ((tokYesterday().hermes || {})['deepseek-v4-flash'] || {}).in === 500);
ok('分日: 今天的桶里没有 deepseek', !((tokToday().hermes || {})['deepseek-v4-flash']));
const endedLed = ledgerFor('hermes:sess-ended:gpt-oss-20b:custom:http://127.0.0.1:8080/v1/::');
ok('台账: 已结束会话的账也补齐', endedLed.in === 300 && endedLed.out === 20);
ok('本地模型: qwen38-27b 已登记端点', warehouse.localModels['qwen38-27b'] === '127.0.0.1:8080',
  String(warehouse.localModels['qwen38-27b']));
ok('本地模型: 带尾斜杠的 base_url 同样命中', warehouse.localModels['gpt-oss-20b'] === '127.0.0.1:8080');
ok('本地模型: 远端模型不进本地集合', !warehouse.localModels['deepseek-v4-flash']);

// ---------- 2. 幂等：重复轮询不重复计数（直连 pollHermesDb 的等价路径，保持静默） ----------
const fixtureDb = path.join(tmp, 'state.db');
const openFixture = () => new DatabaseSync(fixtureDb, { readOnly: true });
let dbPoll = openFixture();
S.pollHermesDb(dbPoll, 'hermes', true);
S.pollHermesDb(dbPoll, 'hermes', true);
dbPoll.close();
ok('幂等: 重复轮询台账不变', ledgerFor('hermes:sess-local:qwen38-27b:custom:http://127.0.0.1:8080/v1::').in === 1000);
ok('幂等: 日分桶不变', ((tokToday().hermes || {})['qwen38-27b'] || {}).in === 1000 + 400);

// ---------- 3. 增量：累计值增长只补差额 ----------
const db2 = new DatabaseSync(fixtureDb);
db2.prepare("UPDATE session_model_usage SET input_tokens = 1200, last_seen = ? WHERE session_id = 'sess-local' AND model = 'qwen38-27b' AND billing_base_url = 'http://127.0.0.1:8080/v1'").run(nowSec + 5);
db2.close();
dbPoll = openFixture();
S.pollHermesDb(dbPoll, 'hermes', true);
dbPoll.close();
ok('增量: 只补增长的那部分',
  ledgerFor('hermes:sess-local:qwen38-27b:custom:http://127.0.0.1:8080/v1::').in === 1200,
  `in=${ledgerFor('hermes:sess-local:qwen38-27b:custom:http://127.0.0.1:8080/v1::').in}`);
ok('增量: 增量落今天的桶', ((tokToday().hermes || {})['qwen38-27b'] || {}).in === 1200 + 400);

// ---------- 4. 会话卡片：活跃会话、阶段、项目归属、token ----------
const card = sessions.get('hermes-db/sess-local');
ok('卡片: 活跃会话有卡片', !!card);
ok('卡片: 标题取自 sessions 表', card && card.title === '本地推理测试会话', String(card && card.title));
ok('卡片: 末条 assistant/stop → 等你确认', card && card.phase === 'waiting', String(card && card.phase));
ok('卡片: token 与台账同源', card && card.tokens.in === 1200 + 400 + 500 && card.tokens.out === 50 + 30 + 100,
  card ? `in=${card.tokens.in} out=${card.tokens.out}` : '');
ok('卡片: lastSeen 用真实活动时间（毫秒）', card && card.lastSeen === Math.round(tActive * 1000));
ok('卡片: cwd 前缀归到夹具项目', card && card.project === projRoot, String(card && card.project));
ok('卡片: 已结束会话不挂卡', !sessions.has('hermes-db/sess-ended'));
const workCard = sessions.get('hermes-db/sess-work');
ok('卡片: 工具循环中的会话是工作中', workCard && workCard.phase === 'working');
ok('卡片: 无 usage 行的会话 token 为 0', workCard && workCard.tokens.in === 0 && workCard.tokens.out === 0);

// ---------- 5. 阶段翻转与结束撤卡 ----------
const db3 = new DatabaseSync(fixtureDb);
db3.prepare("INSERT INTO messages (session_id, role, finish_reason) VALUES ('sess-work', 'assistant', 'stop')").run();
db3.prepare("UPDATE sessions SET ended_at = ? WHERE id = 'sess-local'").run(nowSec + 10);
db3.close();
dbPoll = openFixture();
S.pollHermesDb(dbPoll, 'hermes', true);
dbPoll.close();
ok('阶段: 末条变 stop 后翻成等你确认', sessions.get('hermes-db/sess-work')?.phase === 'waiting');
ok('撤卡: 会话结束立即撤卡', !sessions.has('hermes-db/sess-local'));

// ---------- 汇总 ----------
console.log(`\n  结果: ${pass} 通过, ${fail} 失败`);
// 收尾防线：内存台账从磁盘重新同步，任何未触发的落盘定时器都只能写回磁盘原有数据
S.loadWarehouse();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

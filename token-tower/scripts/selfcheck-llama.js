'use strict';
// 自检：llama.cpp 直连接入（server-<model>.log 解析 / 运行换代 / 台账幂等 / 展示层净额）
// 不碰真实的 llama.cpp 日志目录与 data/：夹具日志建在临时目录，直接驱动 harvestLlamaLog，
// 不挂 fs.watch；收尾时 loadWarehouse() 把内存台账重新从磁盘同步，就算 5 秒落盘定时器
// 在退出前触发，写回的也只是磁盘上原有的真实数据。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');

const S = require(path.join(ROOT, 'server.js'));
const { warehouse, parseLlamaRunTokens, harvestLlamaLog, llamaNetForDay, statsPayload } = S;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

// ---------- 单元：计时行还原公式（行样例取自真实日志） ----------
// 无缓存复用的首个请求（task 0 实录）：pe=153, ev=71, nt=223 → in=153, cr=0
const t0 = parseLlamaRunTokens([
  '0.22.535.286 I slot launch_slot_: id  0 | task 0 | processing task, is_child = 0',
  '0.33.282.665 I slot print_timing: id  0 | task 0 | prompt eval time =    1590.70 ms /   153 tokens (   10.40 ms per token,    96.18 tokens per second)',
  '0.33.282.672 I slot print_timing: id  0 | task 0 |        eval time =    9124.60 ms /    71 tokens (   130.35 ms per token,     7.67 tokens per second)',
  '0.33.282.674 I slot print_timing: id  0 | task 0 |       total time =   10715.30 ms /   224 tokens',
  '0.33.282.675 I slot print_timing: id  0 | task 0 |    graphs reused =         70',
  '0.33.283.075 I slot      release: id  0 | task 0 | stop processing: n_tokens = 223, truncated = 0',
  '',
].join('\n'));
ok('解析: 无缓存请求 in=nt+1-ev', t0.in === 153 && t0.out === 71 && t0.cr === 0, JSON.stringify(t0));

// 缓存复用请求（task 280545 实录）：pe=52, ev=88, nt=815 → in=728, 缓存读=676
const tc = parseLlamaRunTokens([
  '322.08.967.434 I slot launch_slot_: id  0 | task 280545 | processing task, is_child = 0',
  '322.14.535.055 I slot print_timing: id  0 | task 280545 | prompt eval time =     793.80 ms /    52 tokens (   15.27 ms per token,    65.51 tokens per second)',
  '322.14.535.074 I slot print_timing: id  0 | task 280545 |        eval time =    4773.77 ms /    88 tokens (   54.87 ms per token,    18.22 tokens per second)',
  '322.14.535.076 I slot print_timing: id  0 | task 280545 |       total time =    5567.57 ms /   140 tokens',
  '322.14.535.236 I slot      release: id  0 | task 280545 | stop processing: n_tokens = 815, truncated = 0',
  '',
].join('\n'));
ok('解析: 缓存复用请求 in=728/cr=676', tc.in === 728 && tc.out === 88 && tc.cr === 676, JSON.stringify(tc));

// 全缓存命中：没有 prompt eval 行 → 缓存读 = 全部输入
const th = parseLlamaRunTokens([
  '1.00.000.001 I slot print_timing: id  0 | task 9 |        eval time =    100.00 ms /    10 tokens',
  '1.00.000.002 I slot      release: id  0 | task 9 | stop processing: n_tokens = 500, truncated = 0',
  '',
].join('\n'));
ok('解析: 全缓存命中 cr=in', th.in === 491 && th.out === 10 && th.cr === 491, JSON.stringify(th));

// 还在读到的请求没有 release 行：退回实评估数，宁少勿多
const tr = parseLlamaRunTokens([
  '1.00.000.001 I slot print_timing: id  0 | task 10 | prompt eval time =    10.00 ms /    7 tokens',
  '',
].join('\n'));
ok('解析: 缺 release 行退回 pe', tr.in === 7 && tr.out === 0 && tr.cr === 0, JSON.stringify(tr));

// 只有启动行、没有 task 行的日志不影响
const tm2 = parseLlamaRunTokens('0.00.100.000 I cmn  common_param: common_params_print_info: verbosity = 3\n');
ok('解析: 无 task 行的日志全为 0', tm2.in === 0 && tm2.out === 0 && tm2.cr === 0);

// ---------- 展示层净额：llamacpp 毛额扣 hermes 已入账（空仓库上先测，干净） ----------
const todayKey = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
const seedDay = ll => {
  const d = warehouse.days.get(todayKey) || { events: 0, tokensIn: 0, tokensOut: 0, tokensCr: 0, tokensCw: 0, tokByTool: {}, tokByToolModel: {}, creditsByTool: {}, byTool: {}, byHour: new Array(24).fill(0) };
  warehouse.days.set(todayKey, d);
  d.tokByTool.llamacpp = { in: ll.llIn, out: ll.llOut, cr: 0, cw: 0 };
  d.tokByTool.hermes = { in: ll.hIn, out: ll.hOut, cr: 0, cw: 0 };
  d.tokByToolModel.llamacpp = { netmodel: { in: ll.llIn, out: ll.llOut, cr: 0, cw: 0 } };
  d.tokByToolModel.hermes = { netmodel: { in: ll.hIn, out: ll.hOut, cr: 0, cw: 0 } };
  d.tokensIn = ll.llIn + ll.hIn; d.tokensOut = ll.llOut + ll.hOut;
};
warehouse.localModels.netmodel = '127.0.0.1:8080';

seedDay({ llIn: 150, llOut: 20, hIn: 100, hOut: 10 });
let p = statsPayload();
ok('净额: byTool.llamacpp = 毛额−hermes', p.totals.all.byTool.llamacpp.in === 50 && p.totals.all.byTool.llamacpp.out === 10, `in=${p.totals.all.byTool.llamacpp.in}`);
ok('净额: byModel = hermes + 直连净额', p.totals.all.byModel.netmodel.in === 150, `in=${p.totals.all.byModel.netmodel.in}`);
ok('净额: 全机总量不重复计', p.totals.all.in === 150 && p.totals.all.local === 170, `in=${p.totals.all.in} local=${p.totals.all.local}`);
ok('净额: llamacpp 卡片 tokens.all = 净额', (() => {
  const card = p.tools.find(t => t.tool === 'llamacpp');
  return card && card.tokens.all.in === 50;
})());

seedDay({ llIn: 150, llOut: 20, hIn: 200, hOut: 10 }); // hermes 同日入账 > 毛额：钳到 0，不出负数
p = statsPayload();
ok('净额: hermes 偏大时钳 0 不出负', p.totals.all.byTool.llamacpp.in === 0 && p.totals.all.byModel.netmodel.in === 200 && p.totals.all.in === 200,
  `llamacpp=${p.totals.all.byTool.llamacpp.in} model=${p.totals.all.byModel.netmodel.in}`);
ok('净额: llamacpp 未入账时日净额为 null', llamaNetForDay({ tokByToolModel: {} }) === null);

// ---------- harvest：夹具目录 ----------
warehouse.days.clear(); // 清掉净额测试的种子，后续断言从零开始
delete warehouse.localModels.netmodel;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-selfcheck-'));
const logFile = path.join(tmp, 'server-testmodel.log');
fs.writeFileSync(logFile, [
  '0.00.100.000 I cmn  common_params_print_info: verbosity = 3',
  '0.33.282.665 I slot print_timing: id  0 | task 0 | prompt eval time =    1590.70 ms /   153 tokens',
  '0.33.282.672 I slot print_timing: id  0 | task 0 |        eval time =    9124.60 ms /    71 tokens',
  '0.33.283.075 I slot      release: id  0 | task 0 | stop processing: n_tokens = 223, truncated = 0',
  '0.40.000.000 I slot print_timing: id  0 | task 1 | prompt eval time =     793.80 ms /    52 tokens',
  '0.40.500.000 I slot print_timing: id  0 | task 1 |        eval time =    4773.77 ms /    88 tokens',
  '0.40.500.100 I slot      release: id  0 | task 1 | stop processing: n_tokens = 815, truncated = 0',
  '',
].join('\n'));

const day = () => (warehouse.days.get(todayKey) || { tokByToolModel: {} }).tokByToolModel.llamacpp || {};
const todayBuckets = () => {
  const t = { in: 0, out: 0, cr: 0 };
  for (const u of Object.values(day())) { t.in += u.in; t.out += u.out; t.cr += u.cr; }
  return t;
};
const llamaLedgers = () => [...warehouse.files.entries()].filter(([k, v]) => /^llama:/.test(k) && v.tool === 'llamacpp');

harvestLlamaLog('llamacpp', logFile);
let b = todayBuckets();
ok('入账: 两请求入账(153+71 / 88+728)', b.in === 881 && b.out === 159 && b.cr === 676, JSON.stringify(b));
ok('入账: 模型登记为本地模型', warehouse.localModels.testmodel === '127.0.0.1:8080');
ok('入账: 台账键 llama:* 归属 llamacpp', llamaLedgers().length === 1 && llamaLedgers()[0][1].in === 881);

harvestLlamaLog('llamacpp', logFile);
ok('幂等: 重复 harvest 不重复计账', todayBuckets().in === 881);

fs.appendFileSync(logFile, [
  '0.50.000.000 I slot print_timing: id  0 | task 2 | prompt eval time =    100.00 ms /    10 tokens',
  '0.50.100.000 I slot print_timing: id  0 | task 2 |        eval time =    500.00 ms /    50 tokens',
  '0.50.100.100 I slot      release: id  0 | task 2 | stop processing: n_tokens = 400, truncated = 0',
  '',
].join('\n'));
harvestLlamaLog('llamacpp', logFile);
b = todayBuckets();
ok('增量: 追加请求只补差额', b.in === 881 + 351 && b.out === 159 + 50 && b.cr === 676 + 341, JSON.stringify(b));

// 换代：llama-server 每次运行截断重写日志。旧运行的账原样保留，新运行从零入账
const runKeysBefore = llamaLedgers().map(([k]) => k);
fs.writeFileSync(logFile, [
  '1.00.000.000 I slot print_timing: id  0 | task 0 | prompt eval time =     10.00 ms /    5 tokens',
  '1.00.100.000 I slot print_timing: id  0 | task 0 |        eval time =     50.00 ms /     5 tokens',
  '1.00.100.100 I slot      release: id  0 | task 0 | stop processing: n_tokens = 10, truncated = 0',
  '',
].join('\n'));
harvestLlamaLog('llamacpp', logFile);
b = todayBuckets();
const runKeysAfter = llamaLedgers().map(([k]) => k);
// 旧键还在（旧账保留）且多出一个新键（本次运行另起一册）
ok('换代: 换新台账键且旧账保留', runKeysAfter.length === runKeysBefore.length + 1 && runKeysAfter.includes(runKeysBefore[0]), runKeysAfter.join(','));
// 新运行：pe=5, ev=5, nt=10 → in=6, out=5, cr=1
ok('换代: 新运行按新内容入账', b.in === 881 + 351 + 6 && b.out === 159 + 50 + 5 && b.cr === 676 + 341 + 1, JSON.stringify(b));

// 忽略规则：.err.log / 非 server- 前缀 / 空文件
fs.writeFileSync(path.join(tmp, 'server-testmodel.err.log'), 'x\n'.repeat(50));
fs.writeFileSync(path.join(tmp, 'proxy.log'), 'log\n');
fs.writeFileSync(path.join(tmp, 'server-empty.log'), '');
const filesBefore = warehouse.files.size;
harvestLlamaLog('llamacpp', path.join(tmp, 'server-testmodel.err.log'));
harvestLlamaLog('llamacpp', path.join(tmp, 'proxy.log'));
harvestLlamaLog('llamacpp', path.join(tmp, 'server-empty.log'));
ok('忽略: err.log / 非 server-*/ 空文件不入账', warehouse.files.size === filesBefore && !warehouse.localModels.empty && !warehouse.localModels['testmodel.err']);

// ---------- 随附配置检查 ----------
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
ok('config: llamaLogDirs 至少配了一个目录', (shipped.llamaLogDirs || []).length > 0);
ok('config: LM Studio 已进未纳管探测', fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').includes("probe: '.lmstudio'"));

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}: ${pass} pass / ${fail} fail`);
S.loadWarehouse(); // 内存台账重新从磁盘同步，丢掉本自检的写入，真实数据不受影响
process.exit(fail === 0 ? 0 : 1);

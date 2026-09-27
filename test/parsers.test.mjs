// test/parsers.test.mjs — 解析层的牙齿。所有样本都是从这台机器上真实抓下来的原文，
// 不是手写理想格式：netstat 的 PID=0、tasklist 的千分位逗号、nvidia-smi 的 [N/A] 都是实测踩到的形状。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/parsers.js');

const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       2120',
  '  TCP    127.0.0.1:8080         127.0.0.1:60626        ESTABLISHED     2120',
  '  TCP    127.0.0.1:60626        127.0.0.1:8080         ESTABLISHED     39036',
  '  TCP    127.0.0.1:62430        127.0.0.1:8080         TIME_WAIT       0',
  '  TCP    127.0.0.1:62431        127.0.0.1:8080         TIME_WAIT       0',
  '  TCP    [::1]:8080             [::]:0                 LISTENING       2120',
  '  TCP    [::1]:61000            [::1]:8080             ESTABLISHED     4411',
  '  TCP    10.255.254.2:56473     43.135.106.161:8080    ESTABLISHED     2876',
  '  TCP    192.168.1.5:52000      104.18.1.1:443         ESTABLISHED     7777',
].join('\r\n');

test('parseNetstat: 只把连到网关的 ESTABLISHED 客户端算作调用方', () => {
  const r = P.parseNetstat(NETSTAT, 8080);
  assert.equal(r.listenerPid, 2120);
  assert.deepEqual(r.clients.map(c => c.pid), [4411, 39036].sort((a, b) => a - b));
  // 服务端自己那一行（本地端点 8080）不能被当成调用方
  assert.ok(!r.clients.some(c => c.pid === 2120), '网关进程不该把自己算成调用方');
  // TIME_WAIT 的 PID=0 与无关外网连接都要被排除
  assert.ok(!r.clients.some(c => c.pid === 0 || c.pid === 7777));
});

test('parseNetstat: 同号端口的外网连接不能被当成本地网关调用方（QQ 误报回归）', () => {
  const r = P.parseNetstat(NETSTAT, 8080);
  assert.ok(!r.clients.some(c => c.pid === 2876),
    '10.255.254.2:56473 → 43.135.106.161:8080 是腾讯服务器的 8080，与本机 127.0.0.1:8080 无关');
});

test('parseNetstat: 已关闭连接按 ephemeral 端口去重计数（抓不到 PID 但能证明有人在打）', () => {
  const r = P.parseNetstat(NETSTAT, 8080);
  // 样本里 62430/62431 两条客户端侧 TIME_WAIT；两个方向都出现时也只算两条
  assert.equal(r.closedConns, 2);
  const bothWays = NETSTAT + '\r\n  TCP    127.0.0.1:8080         127.0.0.1:62430        TIME_WAIT       0';
  assert.equal(P.parseNetstat(bothWays, 8080).closedConns, 2, '服务端侧同一端口重复出现不加重');
});

test('parseNetstat: 同一进程多条连接聚合成 conns 计数', () => {
  const two = NETSTAT + '\r\n  TCP    127.0.0.1:60700        127.0.0.1:8080         ESTABLISHED     39036';
  const r = P.parseNetstat(two, 8080);
  const c = r.clients.find(x => x.pid === 39036);
  assert.equal(c.conns.length, 2);
});

test('parseTasklistCsv: 带千分位的内存列不能把列数打散', () => {
  const t = [
    '"node.exe","2120","Console","1","36,184 K"',
    '"System Idle Process","0","Services","0","8 K"',
    '"hermes.exe","4411","Console","1","1,234,567 K"',
  ].join('\r\n');
  const m = P.parseTasklistCsv(t);
  assert.equal(m.get(2120).name, 'node.exe');
  assert.equal(m.get(2120).memText, '36,184 K');
  assert.equal(m.get(4411).name, 'hermes.exe');
  // PID 0（System Idle Process）如实保留在映射里：这一层只负责忠实翻译 tasklist，
  // 「不把它当调用方」的判断在 parseNetstat 里做（那里已显式排除 pid===0），两层各管一件事。
  assert.equal(m.get(0).name, 'System Idle Process');
  assert.equal(m.get(0).sessionId, 0);
});

test('parseGpuCsv: nounits 下的 MiB 与利用率', () => {
  const g = P.parseGpuCsv('NVIDIA GeForce RTX 3080 Laptop GPU, 16384, 1273, 5\r\n');
  assert.equal(g.length, 1);
  assert.equal(g[0].totalMiB, 16384);
  assert.equal(g[0].usedMiB, 1273);
  assert.equal(g[0].utilPct, 5);
  // 老形状只有 4 列：温度/功耗留 null，不能变成 NaN 或炸掉
  assert.equal(g[0].tempC, null);
  assert.equal(g[0].powerW, null);
});

test('parseGpuCsv: 温度与功耗列，[N/A] 归 null', () => {
  const g = P.parseGpuCsv('NVIDIA GeForce RTX 3080 Laptop GPU, 16384, 14200, 21, 76, 88.50\r\n' +
    'NVIDIA GeForce RTX 3080 Laptop GPU, 16384, 1200, 0, [N/A], [N/A]\r\n');
  assert.equal(g[0].tempC, 76);
  assert.equal(g[0].powerW, 88.5);
  assert.equal(g[1].tempC, null, '[N/A] 是驱动没给数，不能当 0');
  assert.equal(g[1].powerW, null);
});

test('parseComputeApps: [N/A] 的显存列要变 null，不能变 0', () => {
  const rows = P.parseComputeApps([
    '23492, C:\\Windows\\SystemApps\\x\\TextInputHost.exe, [N/A]',
    '17676, E:\\llama\\llama-server.exe, 15846 MiB',
  ].join('\r\n'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].memMiB, null);
  assert.equal(rows[1].memMiB, 15846);
  assert.match(rows[1].name, /llama-server\.exe$/);
});

test('parseLlamaCmdline: 调参全套从命令行取回', () => {
  const c = P.parseLlamaCmdline(
    'E:\\llama\\llama-server.exe -m "E:\\llama\\models\\Qwen3-30B-A3B-Q4_K_M.gguf" -c 65536 -np 1 -ngl 99 -fa on -ctk q8_0 --jinja --threads 8 --port 8081 --alias qwen3-30b --n-cpu-moe 0');
  assert.equal(c.modelFile, 'E:\\llama\\models\\Qwen3-30B-A3B-Q4_K_M.gguf');
  assert.equal(c.ctx, 65536);
  assert.equal(c.np, 1);
  assert.equal(c.ngl, 99);
  assert.equal(c.port, 8081);
  assert.equal(c.alias, 'qwen3-30b');
  assert.equal(c.cpuMoe, 0);
  assert.equal(c.threads, 8);
});

test('joinRegistry: 注册了但盘上没有 → exists=false 且 sizeMB=null', () => {
  const reg = { models: [{ id: 'a', file: 'a.gguf', ctx: 4 }, { id: 'ghost', file: 'gone.gguf' }] };
  const out = P.joinRegistry(reg, { 'a.gguf': { size: 1048576 * 900, mtime: 'x' } });
  assert.equal(out[0].exists, true);
  assert.equal(out[0].sizeMB, 900);
  assert.equal(out[1].exists, false);
  assert.equal(out[1].sizeMB, null);
});

const LOG = [
  '[2026-09-23T04:42:39.197Z] upstream alive but serving qwen38-27b - restarting for qwen3-instruct-30b',
  '[2026-09-23T04:42:39.198Z] bringing up: qwen3-instruct-30b (previous: qwen38-27b)',
  '[2026-09-23T04:42:41.512Z] launched qwen3-instruct-30b on port 8081 (wrapper pid 22072)',
  '[2026-09-23T04:43:01.720Z] now serving: qwen3-instruct-30b',
  '[2026-09-23T04:43:01.724Z] bringing up: qwen38-27b (previous: qwen3-instruct-30b)',
  '[2026-09-23T04:43:02.283Z] respawn/retry failed: read ECONNRESET',
  '[2026-09-23T04:43:15.946Z] now serving: qwen38-27b',
  '[2026-09-23T04:58:19.247Z] model-proxy v3.2 listening on 8080 (upstream 8081, idle-stop 10min, cold-start on first request)',
  '[2026-09-23T05:58:19.247Z] idle 10min, stopping upstream to free VRAM',
  '[2026-09-23T06:00:00.000Z] garbage line that matches nothing',
].join('\n');

test('parseProxyLog: 事件分类不吞未知行', () => {
  const ev = P.parseProxyLog(LOG);
  const kinds = ev.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 5), ['restart_for', 'switch', 'launch', 'serving', 'switch']);
  assert.ok(kinds.includes('fail') && kinds.includes('listen') && kinds.includes('idle_stop'));
  assert.equal(ev[ev.length - 1].kind, 'other', '认不出的行必须留下，不能静默丢弃');
});

test('summarizeEvents: 乒乓按无向边合并，冷加载按同模型配对', () => {
  const s = P.summarizeEvents(P.parseProxyLog(LOG));
  assert.equal(s.switches, 2, '两次 bringing up');
  assert.equal(s.pingPongPairs, 1, '两次切换间隔 22 s → 一次乒乓');
  assert.equal(s.fails, 1);
  // 样本 1：04:42:39.198 → 04:43:01.720 = 22.5 s；样本 2：04:43:01.724 → 04:43:15.946 = 14.2 s
  assert.equal(s.coldSec.samples, 2);
  assert.equal(s.coldSec.min, 14, '第二次切换的冷加载');
  assert.equal(s.coldSec.p50, 23, '两样本时 p50 取上位 —— 样本太少时中位数不可当典型值');
  assert.equal(s.coldSec.max, 23);
  assert.equal(s.byKind.restart_for, 1);
  // 无向边：instruct<->27b 应把两个方向合到一行
  const und = s.topPairs.map(p => p.edge.split(' -> ')).flat();
  assert.ok(und.includes('qwen3-instruct-30b') && und.includes('qwen38-27b'));
});

test('phantomIds: 被点名但注册表里没有的模型名', () => {
  const ev = P.parseProxyLog(LOG);
  const ph = P.phantomIds(ev, ['qwen38-27b']);
  assert.deepEqual(ph, [{ id: 'qwen3-instruct-30b', n: 1 }]);
});

test('thinHistoryLines: 抽稀保首尾，样本太少不动', () => {
  const lines = Array.from({ length: 100 }, (_, i) => 'L' + i);
  const t = P.thinHistoryLines(lines, 4);
  assert.equal(t[0], 'L0', '首行必留：驻留时段的起点');
  assert.equal(t[t.length - 1], 'L99', '末行必留：最新状态');
  assert.equal(t.length, 26); // 0,4,…,96 共 25 行 + 末行
  assert.ok(!t.includes('L1'));
  assert.deepEqual(P.thinHistoryLines(['a', 'b', 'c'], 4), ['a', 'b', 'c'], '行数太少不值得抽稀');
});

test('mergeEvents: 归档与日志重叠段去重，输出按时间有序', () => {
  const a = [{ ts: 100, kind: 'switch', text: 'x', iso: '1' }, { ts: 300, kind: 'serving', text: 'z', iso: '3' }];
  const b = [{ ts: 300, kind: 'serving', text: 'z', iso: '3' }, { ts: 200, kind: 'switch', text: 'y', iso: '2' }];
  assert.deepEqual(P.mergeEvents(a, b).map(e => e.ts), [100, 200, 300],
    '重叠段只算一次，乱序输入也要排出时间线');
  // 同 ts 同 kind 但 text 不同 = 两行不同原文，是两条证据
  const c = P.mergeEvents([{ ts: 5, kind: 'other', text: 'p' }], [{ ts: 5, kind: 'other', text: 'q' }]);
  assert.equal(c.length, 2);
});

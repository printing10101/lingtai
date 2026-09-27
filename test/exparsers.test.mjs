// test/exparsers.test.mjs — 实验解析层的钉子。样本全部从本机真实实验输出抓取
// （fixtures/experiments/，2026-09-26 E-019 补跑链现场），断言的是「真实长这样的东西必须解析成这样」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import X from '../src/exparsers.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'experiments');
const read = f => readFileSync(join(FIX, f), 'utf8');

/* ---------- tqdm 帧 ---------- */

test('真实 tqdm 行逐字段解析（2026-09-26 direct-real-s3 现场原行）', () => {
  const f = X.parseTqdmFrame('S1 代谢:  70%|███████ | 28/40 [22:07<12:45, 63.76s/gen, best=90.0, food=3.3, mean=44.5]');
  assert.equal(f.label, 'S1 代谢');
  assert.equal(f.pct, 70);
  assert.equal(f.step, 28);
  assert.equal(f.total, 40);
  assert.equal(f.elapsedSec, 22 * 60 + 7);
  assert.equal(f.etaSec, 12 * 60 + 45);
  assert.equal(f.secPerStep, 63.76);
  assert.equal(f.metrics.best, 90.0);
  assert.equal(f.metrics.food, 3.3);
  assert.equal(f.metrics.mean, 44.5);
});

test('it/s 速率口径折成每步秒数；未知速率（?gen/s）给 null 不装懂', () => {
  const f1 = X.parseTqdmFrame('S2 权重:  10%|█         | 4/40 [00:10<01:30, 1.49it/s]');
  assert.ok(Math.abs(f1.secPerStep - 1 / 1.49) < 1e-9);
  const f2 = X.parseTqdmFrame('S1 代谢:   0%|          | 0/40 [00:19<?, ?gen/s, best=1.7, food=0.0, mean=1.3]');
  assert.equal(f2.secPerStep, null);
  assert.equal(f2.etaSec, null);
  assert.equal(f2.metrics.best, 1.7);
});

test('lastTqdm：跨 \\r 历史帧取最后一帧；残帧回退到上一完整帧', () => {
  const text = 'S1 代谢:   2%|▎ | 1/40 [00:19<12:38, 19.44s/gen, best=1.7]\r' +
    'S1 代谢:   5%|▌ | 2/40 [01:10<24:00, 37.91s/gen, best=25.3]\r' +
    'S1 代谢:   8%|▊ | 3/40 [01:58<26:21, 42.73s/gen, best=20.4';
  const f = X.lastTqdm(text);
  assert.equal(f.step, 2); // 第三帧被截断解析不出，回退到第二帧
  assert.equal(f.metrics.best, 25.3);
});

test('真实 s3 日志整体解析：最后帧落在 S1 代谢、总代数 40', () => {
  const f = X.lastTqdm(read('expd-direct-real-s3.log'));
  assert.ok(f, '真实日志里必须解析得出 tqdm 帧');
  assert.equal(f.label, 'S1 代谢');
  assert.equal(f.total, 40);
  assert.ok(f.step >= 28, '快照时刻至少跑到 28 代');
  assert.ok(f.secPerStep > 0);
});

/* ---------- launcher 链日志 ---------- */

test('真实 launcher 日志：只取最后一段链，批/组事件齐全', () => {
  const c = X.parseLauncherLog(read('launch-pa-d-a.log'));
  assert.ok(c, '链记录必须解析得出');
  assert.equal(c.startedAt, '2026-09-26 15:07:23');
  assert.equal(c.batches.length, 1, '2026-09-17 那条死链是历史，不能掺进当前链');
  const d = c.batches[0];
  assert.equal(d.name, '实验D');
  assert.equal(d.total, 12);
  assert.equal(d.counts.skip, 7);
  assert.equal(d.counts.done, 1);
  assert.equal(d.exit, null, '当前批还没结束');
  assert.deepEqual(d.current, { idx: 9, tag: 'direct-real-s3' });
  assert.ok(d.doneMinSamples.includes(129.1));
});

test('历史段的 结束 exit=1 在整段被正确跳过（当前链没有 exit）', () => {
  const c = X.parseLauncherLog(read('launch-pa-d-a.log'));
  assert.ok(c.batches.every(b => b.exit == null));
  assert.equal(c.allEnded, false);
});

test('chainEta：当前组剩余 + 排队组数 × 实测平均', () => {
  const c = X.parseLauncherLog(read('launch-pa-d-a.log'));
  const e = X.chainEta(c, 600);
  assert.equal(e.leftGroups, 3); // 12 - 7 SKIP - 1 完成 - 1 进行中
  assert.ok(e.etaSec > 3 * 129 * 60, '三组排队必须吃掉三份平均耗时');
  assert.match(e.basis, /排队 3 组/);
});

/* ---------- run 目录 ---------- */

test('真实 gen_log.csv：逐点解析 + 曲线抽稀', () => {
  const r = X.parseGenLogCsv(read('gen-log-head.csv'), 90);
  assert.ok(r.gens >= 30, '至少解析出 30 个完整代点，实际 ' + r.gens);
  assert.ok(r.last.g > r.curve[0].g, 'last 必须是最大的 gen');
  assert.ok(r.last.best > 0);
  assert.equal(r.curve.length, r.gens, '少于 maxPoints 时不抽稀');
  const dense = X.parseGenLogCsv(read('gen-log-head.csv'), 10);
  assert.ok(dense.curve.length <= 11, '超限必须抽稀');
  assert.equal(dense.curve[dense.curve.length - 1].g, r.last.g, '抽稀后末点必留');
});

test('gen_log 残行（写到半截）不计入进度', () => {
  const r = X.parseGenLogCsv('stage,gen,best_fit,mean_fit\n1,0,29.6,29.6\n1,1,32.0,28.4\n1,2,33.');
  assert.equal(r.gens, 2);
  assert.equal(r.last.g, 1);
});

test('真实 run config：totalGens = stages × stage_gens', () => {
  const c = X.parseRunConfig(read('run-config.json'));
  assert.equal(c.seed, 3);
  assert.equal(c.encoding, 'direct');
  assert.equal(c.popSize, 60);
  assert.equal(c.stagesCount, 3);
  assert.equal(c.stageGens, 40);
  assert.equal(c.totalGens, 120);
});

test('坏 config 给 null（防御边界：外部文件不可信）', () => {
  assert.equal(X.parseRunConfig('{broken'), null);
});

/* ---------- 状态机 ---------- */

test('classifyRun 五态判据', () => {
  const base = { stallSec: 600, activeHorizonSec: 86400 };
  assert.equal(X.classifyRun({ ...base, done: true, heartbeatAgeSec: 99999, procAlive: false }), 'done');
  assert.equal(X.classifyRun({ ...base, done: false, heartbeatAgeSec: 30, procAlive: true }), 'running');
  assert.equal(X.classifyRun({ ...base, done: false, heartbeatAgeSec: 1800, procAlive: true }), 'stalled');
  assert.equal(X.classifyRun({ ...base, done: false, heartbeatAgeSec: 1800, procAlive: false }), 'interrupted');
  assert.equal(X.classifyRun({ ...base, done: false, heartbeatAgeSec: 30 * 86400, procAlive: false }), 'archive');
  assert.equal(X.classifyRun({ ...base, done: false, heartbeatAgeSec: null, procAlive: false }), 'unknown');
});

/* ---------- ETA ---------- */

test('runEta：tqdm 在场时跨阶段按当前速率外推', () => {
  const tqdm = { step: 28, total: 40, etaSec: 765, secPerStep: 63.76 };
  const e = X.runEta({ tqdm, gensDone: 28, totalGens: 120 });
  // 当前阶段剩 12 代由 tqdm ETA 覆盖；跨阶段 80 代 × 63.76s 外推（runEta 内部取整）
  assert.equal(e.etaSec, Math.round(765 + 80 * 63.76));
  assert.equal(e.basis, '当前阶段速度外推');
});

test('runEta：无 tqdm 退化为代速差分；全无数据如实 null', () => {
  const e1 = X.runEta({ tqdm: null, gensDone: 10, totalGens: 80, secPerGenFallback: 90 });
  assert.equal(e1.etaSec, 70 * 90);
  assert.equal(e1.basis, '近期代速外推');
  const e2 = X.runEta({ tqdm: null, gensDone: 10, totalGens: 80, secPerGenFallback: null });
  assert.equal(e2.etaSec, null);
  assert.equal(e2.basis, null);
  const e3 = X.runEta({ tqdm: null, gensDone: 80, totalGens: 80, secPerGenFallback: null });
  assert.equal(e3.etaSec, 0);
});

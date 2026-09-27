// 总控大屏聚合断言：塔台源的三态语义（ok/stale/down）与端点编排。
// 塔台是外部进程，没在跑是常态——down 必须响亮、stale 必须保留上一份真数据。
// 全部用注入的假 fetch，不发真请求、不依赖塔台在跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTowerSource, wrapSource } from '../src/tower.js';

const okFetch = data => async () => ({ ok: true, data });
const badFetch = msg => async () => ({ ok: false, error: msg });

test('wrapSource：刚抓到 → ok，数据原样透传', () => {
  const w = wrapSource({ ok: true, data: { state: { a: 1 } } }, null);
  assert.equal(w.status, 'ok');
  assert.equal(w.ageMs, 0);
  assert.equal(w.error, null);
  assert.deepEqual(w.data, { state: { a: 1 } });
  assert.ok(w.checkedAt);
});

test('wrapSource：这次没抓到、手里有上次好的 → stale，保留旧数据与错误', () => {
  const lastGood = { checkedAt: new Date(Date.now() - 5000).toISOString(), data: { state: { a: 0 } } };
  const w = wrapSource({ ok: false, error: '超时 1500ms' }, lastGood);
  assert.equal(w.status, 'stale');
  assert.equal(w.error, '超时 1500ms');
  assert.deepEqual(w.data, { state: { a: 0 } });
  assert.ok(w.ageMs >= 5000);
});

test('wrapSource：从没抓到过 → down，data 为 null，ageMs 是 null（没测到就没有"多旧"可言）', () => {
  const w = wrapSource({ ok: false, error: 'connect ECONNREFUSED' }, null);
  assert.equal(w.status, 'down');
  assert.equal(w.data, null);
  assert.equal(w.ageMs, null);
  assert.match(w.error, /ECONNREFUSED/);
});

test('塔台源并行拉 state/stats/waiting 三个端点，全部成功 → ok 且 error 为 null', async () => {
  const seen = [];
  const src = createTowerSource({
    base: 'http://127.0.0.1:7345',
    fetchJson: async (base, p) => { seen.push(base + p); return { ok: true, data: { ep: p } }; },
  });
  const w = await src.overview();
  assert.equal(w.status, 'ok');
  assert.equal(w.error, null);
  assert.deepEqual(Object.keys(w.data).sort(), ['state', 'stats', 'waiting']);
  assert.deepEqual(seen.map(s => s.replace('http://127.0.0.1:7345', '')).sort(),
    ['/api/state', '/api/stats', '/api/waiting']);
});

test('部分端点失败仍算在线，缺了哪个如实记进 error', async () => {
  const src = createTowerSource({
    base: 'http://127.0.0.1:7345',
    fetchJson: async (_, p) => p === '/api/stats' ? { ok: false, error: 'http 500' } : { ok: true, data: {} },
  });
  const w = await src.overview();
  assert.equal(w.status, 'ok');
  assert.deepEqual(Object.keys(w.data).sort(), ['state', 'waiting']);
  assert.match(w.error, /stats: http 500/);
});

test('上一拍 ok、这一拍全挂 → stale，页面还能拿到上一份真数据', async () => {
  let fail = false;
  const src = createTowerSource({
    base: 'http://127.0.0.1:7345',
    fetchJson: async (_, p) => fail ? { ok: false, error: 'connect ECONNREFUSED' } : { ok: true, data: { ep: p } },
  });
  assert.equal((await src.overview()).status, 'ok');
  fail = true;
  const w = await src.overview();
  assert.equal(w.status, 'stale');
  assert.deepEqual(w.data, {
    state: { ep: '/api/state' },
    stats: { ep: '/api/stats' },
    waiting: { ep: '/api/waiting' },
  });
  assert.match(w.error, /state: connect ECONNREFUSED/);
  assert.match(w.error, /stats: connect ECONNREFUSED/);
  // 不会把 down 的空数据当成新的"上一份好数据"
  fail = false;
  assert.equal((await src.overview()).status, 'ok');
});

test('一直没抓到过 → down；未配置 tower.base 也直接 down（不发请求）', async () => {
  let calls = 0;
  const down = createTowerSource({
    base: 'http://127.0.0.1:7345',
    fetchJson: async () => { calls++; return { ok: false, error: 'x' }; },
  });
  assert.equal((await down.overview()).status, 'down');
  assert.equal(calls, 3); // 三个端点都试过

  let unconfiguredCalls = 0;
  const unconfigured = createTowerSource({
    fetchJson: async () => { unconfiguredCalls++; return { ok: true, data: {} }; },
  });
  const w = await unconfigured.overview();
  assert.equal(w.status, 'down');
  assert.match(w.error, /tower\.base/);
  assert.equal(unconfiguredCalls, 0); // 未配置就没发请求
});

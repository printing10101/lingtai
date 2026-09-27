// test/exp-live-contract.test.mjs — 实验直播页的契约。独立页面最容易死在两种静默上：
//   1) JS 引用的元素 id 在 HTML 里不存在 → 整页空白还以为数据没到（假绿）；
//   2) 手滑引了外链资源 → 离线/打包态白屏。
// 像素的事交给肉眼，这里只钉结构。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public', 'experiments.html'), 'utf8');
const js = readFileSync(join(ROOT, 'public', 'exp-live.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'experiments.css'), 'utf8');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');

test('直播页引用的元素 id 都必须真实存在', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const jsIds = new Set([...js.matchAll(/\bel\('([^']+)'\)/g)].map(m => m[1]));
  assert.ok(jsIds.size >= 3, '只抽到 ' + jsIds.size + ' 个 id 引用，正则没对上');
  const missing = [...jsIds].filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, [], '这些 id 在 experiments.html 里不存在：' + missing.join(', '));
});

test('直播页不引任何外部资源（离线打包必须自足）', () => {
  assert.equal(null, html.match(/src="https?:|href="https?:|@import\s+url\(https?:/), 'experiments.html 出现外链');
  assert.equal(null, js.match(/fetch\(['"`]https?:/), 'exp-live.js 只许 fetch 相对路径 /api/*');
  assert.equal(null, css.match(/@import\s+url\(https?:|url\(https?:/), 'experiments.css 出现外链');
});

test('诚实空态文案在（未启用/未测到是两种不同状态，不许合并成一句）', () => {
  assert.ok(js.includes('实验观测未启用'), '未启用文案没了');
  assert.ok(js.includes('实验台未测到'), '未测到文案没了');
  assert.ok(js.includes('当前没有进行中的实验'), '空闲态文案没了');
  assert.ok(js.includes('判据：'), '空闲态没有判据脚注');
});

test('口径脚注与主看板同源（换皮不许丢）', () => {
  assert.ok(js.includes('进度分母 = run 目录 config.json 的 stages × stage_gens'), '进度分母口径没了');
  assert.ok(js.includes('完成标志 = report.md'), '完成标志口径没了');
  assert.ok(js.includes('疑似卡住'), '卡住判据文案没了');
});

test('server.js 暴露 /experiments 路由（独立入口是这块屏的存在方式）', () => {
  assert.match(server, /url === '\/experiments' \|\| url === '\/live'/, '路由没挂上');
});

test('直播页关键样式类都有 css 落点（漏一个就是一块裸奔的区域）', () => {
  const cssAll = css + readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
  const defined = new Set([...cssAll.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
  // 逐个列关键类，不做全量提取：JS 里 class 是字符串拼接，正则一抓一个准地误伤
  const REQUIRED = ['live-top', 'live-dot', 'live-wrap', 'src-cap', 'hero-run', 'run-title', 'run-tags',
    'hero-bar', 'pills', 'pill', 'pill-arrow', 'tiles', 'ltile', 'eta-line', 'grid-live',
    'curve-panel', 'tele-panel', 'panel-cap', 'bigcurve', 'curve-axis', 'gspark',
    'chain', 'chain-head', 'chain-segs', 'chain-eta', 'inv', 'inv-head', 'inv-row',
    'inv-name', 'inv-nums', 'live-foot', 'empty-state', 'legend'];
  const lost = REQUIRED.filter(c => !defined.has(c));
  assert.deepEqual(lost, [], '这些关键类没有 css 定义：' + lost.join(', '));
  // 状态修饰类也要在（done/now/todo/stall/skip/queued/bad/hot/trouble/idle）
  const MODS = ['done', 'now', 'todo', 'stall', 'skip', 'queued', 'bad', 'hot', 'trouble', 'idle'];
  const lostMods = MODS.filter(m => !defined.has(m));
  assert.deepEqual(lostMods, [], '这些状态修饰类没有 css 定义：' + lostMods.join(', '));
});

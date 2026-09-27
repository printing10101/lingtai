// test/master-render.test.mjs — 总控大屏表现层的契约（与 render-contract 同一哲学：钉结构，不钉像素）。
// 最容易死的方式依旧是「静默」：打错一个元素 id → 那张卡永远空白；换皮时把三态口径删掉 →
// 「确认没有」和「没测到」又混回一锅。这些都在这里钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const html = read('public', 'master.html');
const js = read('public', 'master.js');
const css = read('public', 'master.css');
const indexHtml = read('public', 'index.html');
const expHtml = read('public', 'experiments.html');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]));

test('抽取本身有效：master.js 至少引用 9 个元素 id（低于此值说明正则没对上）', () => {
  assert.ok(jsIds.size >= 9, '只抽到 ' + jsIds.size + ' 个 id 引用：' + [...jsIds].join(', '));
});

test('master.js 引用的每个元素 id 都必须真实存在于 master.html', () => {
  const missing = [...jsIds].filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, [], '这些 id 在 master.html 里不存在，对应卡片会静默空白：' + missing.join(', '));
});

test('master.html 每张卡都必须有渲染代码（容器在、渲染代码没了 = 永远空白的卡）', () => {
  const cards = [...htmlIds].filter(id => /^card-/.test(id));
  assert.ok(cards.length >= 9, '只找到 ' + cards.length + ' 张卡，选择器没对上');
  const orphan = cards.filter(id => !jsIds.has(id));
  assert.deepEqual(orphan, [], '这些卡没有任何渲染代码引用：' + orphan.join(', '));
});

test('master.html 里每个 id 唯一', () => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const dup = all.filter((v, i) => all.indexOf(v) !== i);
  assert.deepEqual(dup, [], '重复的 id: ' + dup.join(', '));
});

test('塔台三态口径一条不许少：down 明说未运行、stale 亮出数据年龄', () => {
  assert.ok(js.includes('塔台未运行'), 'down 态的「塔台未运行」没了');
  assert.ok(js.includes('数据是 '), 'stale 态的数据年龄提示没了');
  assert.ok(js.includes('上一份真数据'), 'stale 态「上一份真数据」的交代没了');
  assert.ok(js.includes("tw.status === 'stale'"), 'stale 判据没了');
});

test('token 卡的口径行在位：本地模型单列 + 预算线描红', () => {
  assert.ok(js.includes('其中本地模型'), '「其中本地模型」行没了（GPU 真烧的账不能藏）');
  assert.ok(js.includes('超预算线'), '预算线描红没了');
});

test('三个页面互相可达：总控入口挂进看板与实验直播，总控页能切回去', () => {
  assert.ok(indexHtml.includes('href="/master"'), '主看板没有总控入口');
  assert.ok(expHtml.includes('href="/master"'), '实验直播没有总控入口');
  assert.ok(html.includes('href="/"') && html.includes('href="/experiments"'), '总控页回看板/直播的切换没了');
  assert.ok(html.includes('class="vt on"'), '总控页没有高亮当前视图');
});

test('渲染层不引任何外部资源（离线打包必须自足）', () => {
  assert.equal(null, html.match(/src="https?:|href="https?:(?!\/\/127\.0\.0\.1:7345)/), 'master.html 里出现了外链资源');
  assert.equal(null, css.match(/@import\s+url\(https?:|url\(https?:/), 'master.css 里出现了外链');
});

test('外部输入不许裸拼进 HTML（会话标题、进程名、git 分支都来自外部工具）', () => {
  const codeOnly = s => s.replace(/^\s*\/\/.*$/gm, '');
  const RISKY = /\+\s*[A-Za-z_$][\w$]*\.(title|name|error|path|branch|project|model|edge|text)\b(?!\s*\()/g;
  // 豁免两类天然安全的位置：textContent 与 el.title = 这类属性赋值（浏览器按纯文本处理，不解析 HTML）
  const hits = codeOnly(js).split('\n')
    .filter(line => !/textContent|\.title\s*=/.test(line))
    .flatMap(line => [...line.matchAll(RISKY)].map(m => m[0].trim()));
  assert.deepEqual(hits, [], '这些位置把外部字段裸拼进了 HTML：' + hits.join(' | '));
  assert.match(js, /const esc =|function esc\(/, 'esc() 不见了');
});

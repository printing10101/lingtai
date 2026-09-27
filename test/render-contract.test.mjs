// test/render-contract.test.mjs — 表现层的契约，不是像素级快照。
// 重写渲染层最容易死在两个地方，而且都是「静默」的：
//   1) 打错一个元素 id → 那张卡永远空白，页面看着正常、数据其实没渲染（假绿）；
//   2) 换皮时把判据/口径脚注顺手删掉 → 界面更好看了，但用户再也分不清「确认没有」和「没测到」。
// 这两条都在这里钉住。像素的事交给肉眼与截图，不在这儿断言。
//
// 注意：本文件自己也错过两次（el() 抽不到 lamp('lamp-gpu') 传的 id、去 index.html 找 style.css 的令牌），
// 所以下面每条抽取都配了「抽到的数量太少就判失败」的自检 —— 抽取失效必须报错，不能变成静默通过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const js = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
const parsers = readFileSync(join(ROOT, 'src', 'parsers.js'), 'utf8');

// 测试只看代码，不看散文：整行注释会污染"谁先谁后""有没有裸拼"这类形状判断。
const codeOnly = s => s.replace(/^\s*\/\/.*$/gm, '');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// app.js 拿 id 的四种写法：el('x') / getElementById('x') / lamp('x', …) / paintId('x', …)。
// 少抽一种就是漏测，所以这里都收，并检查总数。
function referencedIds() {
  const pats = [
    /\bel\('([^']+)'\)/g, /getElementById\('([^']+)'\)/g,
    /\blamp\('([^']+)'/g, /\bpaintId\('([^']+)'/g,
  ];
  const out = new Set();
  for (const re of pats) for (const m of js.matchAll(re)) out.add(m[1]);
  return out;
}
const jsIds = referencedIds();

test('抽取本身有效：app.js 至少引用 20 个元素 id（低于此值说明正则没对上，测试失去牙齿）', () => {
  assert.ok(jsIds.size >= 20, '只抽到 ' + jsIds.size + ' 个 id 引用：' + [...jsIds].join(', '));
});

test('app.js 引用的每个元素 id 都必须真实存在于 index.html', () => {
  const missing = [...jsIds].filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, [], '这些 id 在 index.html 里不存在，对应卡片会静默空白：' + missing.join(', '));
});

test('index.html 里每个数据容器都得有人写（反向漏测：容器在、渲染代码没了 = 永远空白的卡）', () => {
  // 只管 *-body / *-count 这类真正承载数据的容器；card-xxx 是纯样式挂钩，本来就不需要 JS 碰
  const dataIds = [...htmlIds].filter(id => /(-body|-count)$/.test(id));
  assert.ok(dataIds.length >= 8, '只找到 ' + dataIds.length + ' 个数据容器，选择器没对上');
  const orphan = dataIds.filter(id => !jsIds.has(id));
  assert.deepEqual(orphan, [], '这些承载数据的容器没有任何渲染代码引用：' + orphan.join(', '));
});

test('index.html 里每个 id 唯一（重复会让 getElementById 只拿到第一个）', () => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const dup = all.filter((v, i) => all.indexOf(v) !== i);
  assert.deepEqual(dup, [], '重复的 id: ' + dup.join(', '));
});

test('「确认没有」与「未测到」仍是两套文案 + 两种颜色，不许合并', () => {
  assert.match(js, /absent:\s*'确认没有'/);
  assert.match(js, /unknown:\s*'未测到'/);
  assert.ok(js.includes('quiet absent'), '没有渲染「确认没有」专用的样式类了');
  assert.ok(js.includes('quiet unknown'), '没有渲染「未测到」专用的样式类了');

  const absent = (css.match(/--absent:\s*(#[0-9a-f]{6})/i) || [])[1];
  const unknown = (css.match(/--unknown:\s*(#[0-9a-f]{6})/i) || [])[1];
  assert.ok(absent && unknown, 'style.css 里缺 --absent / --unknown 令牌');
  assert.notEqual(absent.toLowerCase(), unknown.toLowerCase(), '确认没有与未测到不能同色');
  assert.match(css, /\.display\.absent\s*\{[^}]*var\(--absent\)/, '.display.absent 没接到 --absent');
  assert.match(css, /\.display\.unknown\s*\{[^}]*var\(--unknown\)/, '.display.unknown 没接到 --unknown');
});

// 一条判据脚注都不许在换皮时消失。逐条按原文子串查，改写了就得显式来改这张表。
const CAVEATS = [
  '判定依据：8081 无响应，且网关端口上没有 llama-server 进程',
  '那部分不在网关账本里',
  '没有旁路实例（全部 llama-server 都在网关端口上）',
  '判据：进程命令行里的 --port 是否等于',
  '处置前先看这行命令：旁路实例可能是某个软件自带的服务，不是垃圾',
  '网关视角"空卡"不代表显存真的空着',
  'compute-apps 采集失败，下表不可用',
  '不报它们的显存',
  '同模型请求只能串行',
  '但内核里还留着',
  '幽灵请求 = 日志里被点名、但注册表里没有的模型名',
  '疑似已被 1 MB 截断',
  '未检测到截断',
  '双向合并计',
  '换卡方向（日志窗口内）',
  '每 15 s 落一条',
  '这个看板看不到的',
  '没有改动 model-proxy.js 一行',
  '看板服务不可达',
  '采集服务未响应',
  '来源 ',
  '采样（每 10 s）',
  // 启动器（控制层）的口径：换皮时一条都不许丢
  '控制层未启用',
  '先让网关驻留所选模型',
  '只杀本启动器拉起的进程树',
  '外部运行中',
  '确认切换？',
  '冷加载约 25–35 s',
  // 开窗型 / 免预热软件与「盘上还有」模型的口径（2026-09-24 启动器扩容）
  '不驱动模型',
  '开窗 · 不托管',
  '已开窗（不托管）',
  '停止请直接关那个窗口',
  '盘上还有 · 不在网关注册表',
  '要驱动它们得先注册',
  // 实验台（2026-09-26）：观测口径换皮时一条都不许丢
  'report.md = 完成标志',
  'gen_log.csv 心跳 = 进度',
  'ETA 口径：',
  '进度分母 = run 目录 config.json 的 stages × stage_gens',
  '链内后续批未启动前不可见',
  'min 内没有新的 gen_log 写入',
  '实验观测未启用',
  '实验台未测到',
  '该实验源未测到',
  '停 ≥ ',
  '批脚本靠它断点续跑',
];
test('判据/口径脚注一条不少', () => {
  const lost = CAVEATS.filter(s => !js.includes(s) && !html.includes(s));
  assert.deepEqual(lost, [], '这些口径文案在重写后找不到了：' + lost.join(' | '));
});

test('渲染层不引任何外部资源（离线打包必须自足）', () => {
  assert.equal(null, html.match(/src="https?:|href="https?:|@import\s+url\(https?:/), 'index.html 里出现了外链');
  assert.equal(null, js.match(/fetch\(['"`]https?:/), 'app.js 里出现了外部请求');
  assert.equal(null, css.match(/@import\s+url\(https?:|url\(https?:/), 'style.css 里出现了外链（离线会白屏）');
});

test('外部输入不许裸拼进 HTML（旁路权重路径、进程名、日志原文都来自命令输出）', () => {
  // 危险形状：`+ 对象.字段` —— 外部字段直接跟在字符串加号后面，没被 esc()/num() 包。
  // 必须带点号：'mc.drawer.' + id 这种局部变量拼 localStorage key 不是 XSS 面。
  // 走 textContent 的赋值天然不解析 HTML，不在打击范围（写进 innerHTML 才要转义）。
  // 走 row()/tag()/spec() 的字段由这几个函数内部统一转义，形状是 `sub: a.name`，不会被抓到。
  const RISKY = /\+\s*[A-Za-z_$][\w$]*\.(modelFile|proxyLog|killByImageRisk|missedNote|error|name|text|alias|file|edge|id)\b(?!\s*\()/g;
  const hits = codeOnly(js).split('\n')
    .filter(line => !/textContent/.test(line))
    .flatMap(line => [...line.matchAll(RISKY)].map(m => m[0].trim()));
  assert.deepEqual(hits, [], '这些位置把外部字段裸拼进了 HTML：' + hits.join(' | '));
  assert.ok(js.includes('const esc ='), 'esc() 不见了');
  // 转义必须真的发生在 row()/tag() 内部，否则上面那条只是自欺
  assert.match(js, /function row\(o\)[\s\S]{0,400}esc\(o\.title\)/, 'row() 不再转义主行文字');
  assert.match(js, /const tag = [\s\S]{0,200}esc\(txt\)/, 'tag() 不再转义标签文字');
});

test('事件流的筛选组与配色必须覆盖 parsers 里全部 kind，否则"筛完看不见"就是漏了', () => {
  const block = parsers.match(/const\s+EVENT_PATTERNS\s*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(block, 'parsers.js 里找不到 EVENT_PATTERNS，这条测试会失去牙齿，必须一起改');
  const kinds = new Set([...block[1].matchAll(/^\s*\['([a-z_]+)'/gm)].map(x => x[1]));
  assert.ok(kinds.size >= 8, '只解析出 ' + kinds.size + ' 个 kind，正则没对上');
  kinds.add('other'); // parseProxyLog 的兜底分支

  const tone = js.match(/const\s+KIND_TONE\s*=\s*\{([\s\S]*?)\};/);
  const group = js.match(/const\s+KIND_GROUP\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(tone && group, 'app.js 里找不到 KIND_TONE / KIND_GROUP');

  // 这两张表的键是不带引号的标识符，值才是字符串。
  // （上一版这里我把筛选组键名也当成字符串去重，结果把合法的 kind 'switch' 一起误删了 —— 键不带引号，根本不会被这个正则匹配到。）
  const toned = new Set([...tone[1].matchAll(/(?:^|[,{])\s*([a-z_]+)\s*:/g)].map(x => x[1]));
  assert.ok(toned.size >= 8, 'KIND_TONE 只抽到 ' + toned.size + ' 个键，正则没对上');
  const grouped = new Set([...group[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]));
  assert.ok(grouped.size >= 8, 'KIND_GROUP 只抽到 ' + grouped.size + ' 个 kind，正则没对上');

  const noTone = [...kinds].filter(k => !toned.has(k));
  const noGroup = [...kinds].filter(k => !grouped.has(k));
  assert.deepEqual(noTone, [], '这些 kind 没有配色（圆点会全灰，看不出轻重）：' + noTone.join(', '));
  assert.deepEqual(noGroup, [], '这些 kind 不在任何筛选组里（选中任一筛选都会把它们藏起来）：' + noGroup.join(', '));
});

test('进程枚举未测到时，显存账本不许说「没有旁路实例」（假绿回归）', () => {
  const fn = js.match(/function renderVramLedger\(st\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, '找不到 renderVramLedger，这条测试会失去牙齿');
  const body = codeOnly(fn[1]);
  assert.ok(body.includes('旁路实例未测到'), '账本没有「未测到」分支了');
  assert.ok(body.indexOf('旁路实例未测到') < body.indexOf('没有旁路实例'),
    '未测到分支必须排在「确认没有」之前，否则 status=unknown 时会先撞上那句下死结论的话');
  assert.ok(/enumerated/.test(body), '没有区分「枚举过=确认没有」和「没枚举=未测到」');
  assert.match(body, /'loud'\s*:\s*\(enumerated\s*\?\s*'quiet'\s*:\s*'unknown'\)/, '左沿颜色没有 unknown 档');
});

test('台账抽屉：两页容器、分段切换与记忆必须齐全', () => {
  assert.ok(htmlIds.has('tab-events') && htmlIds.has('tab-history'), '台账两页容器缺一不可');
  assert.ok(html.includes('data-tab="events"') && html.includes('data-tab="history"'), '分段 tab 缺失');
  assert.match(js, /function applyLedgerTab/, 'tab 应用函数没了');
  assert.match(js, /mc\.ledger\.tab/, 'tab 记忆没了');
  assert.match(js, /stopImmediatePropagation/, '点 tab 必须拦住抽屉开关，否则一按两件事');
});

test('进程分类只看可执行文件名，不被 node_modules 这类路径片段骗到', () => {
  assert.match(js, /const isInf = n => \{[\s\S]{0,220}?\.pop\(\)[\s\S]{0,160}?\.test\(b\);/,
    'isInf 又变成拿完整路径做正则了 —— 那会把 node_modules 里的任何进程标成「推理」');
});

test('等宽字体栈必须有中文兜底（本机路径含中文，否则渲染成豆腐块）', () => {
  const mono = (css.match(/--font-mono:\s*([^;]*);/) || [])[1] || '';
  assert.ok(mono.length > 10, '没抽到 --font-mono，测试本身失效');
  assert.ok(/YaHei|PingFang|Noto Sans CJK|Heiti/.test(mono), '--font-mono 缺中文字体：' + mono.trim());
});

test('磨砂只用在一处（克制要求：顶栏 blur，卡片不许再叠 backdrop-filter）', () => {
  const blurs = [...css.matchAll(/backdrop-filter:/g)].length;
  assert.ok(blurs >= 1, '顶栏的磨砂没了，与「深色磨砂」的定稿不符');
  assert.equal(blurs, 1, 'backdrop-filter 出现了 ' + blurs + ' 次，磨砂过头了（定稿：只顶栏一处）');
});

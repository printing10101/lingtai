'use strict';
// 自检：DSH 活动级接入（多帧 zstd 解码 / v3 事件流提取 / 新旧格式兼容）。
// 只读真实会话文件，提取器是纯函数，全程不写任何东西，可以和常驻塔台同时跑。
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

const S = require('../server.js');
const { activityExtractors, dshDecompressAll, config } = S;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

// ---------- 配置：v3 文件名必须能被 match 命中（曾经的漏检根因） ----------
const dshCfg = (config.activityDirs || []).find(c => c.tool === 'dsh');
ok('config: dsh match 能命中旧格式', 'session.jsonl.zstd'.endsWith(dshCfg.match));
ok('config: dsh match 能命中 v3 格式', 'session.v3.jsonl.zstd'.endsWith(dshCfg.match),
  `match=${dshCfg.match}`);
ok('回归: 旧 match 字面量确实漏掉 v3（这是本次修的 bug）',
  !('session.v3.jsonl.zstd'.endsWith('session.jsonl.zstd')));

// ---------- 收集真实会话文件 ----------
const files = [];
for (const ent of fs.readdirSync(dshCfg.dir, { recursive: true, withFileTypes: true })) {
  if (ent.isFile() && ent.name.endsWith(dshCfg.match)) {
    files.push(path.join(ent.parentPath || dshCfg.dir, ent.name));
  }
}
const v3Files = files.filter(f => path.basename(f) === 'session.v3.jsonl.zstd');
const v2Files = files.filter(f => path.basename(f) === 'session.jsonl.zstd');
ok('磁盘: 能找到 v3 会话', v3Files.length > 0, `${v3Files.length} 个 v3 / ${v2Files.length} 个旧格式`);

// ---------- 多帧解码：帧走向器与"按 magic 切"的朴素解法逐文件对拍 ----------
// 朴素解法：magic 出现处切片各自解（zstd 压缩数据里撞出 magic 的概率 ~1/2^32，这里当参考实现）
const MAGIC = 0x28b52ffd;
function naiveSliceDecode(buf) {
  const offs = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf.readUInt32BE(i) === MAGIC) offs.push(i);
  }
  let out = '';
  for (let k = 0; k < offs.length; k++) {
    const slice = buf.slice(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length);
    try { out += zlib.zstdDecompressSync(slice).toString('utf8'); } catch { }
  }
  return out;
}
let walked = 0, parity = 0;
for (const f of v3Files) {
  const buf = fs.readFileSync(f);
  const a = dshDecompressAll(buf);
  const b = naiveSliceDecode(buf);
  if (a.length > 0) walked++;
  if (a === b) parity++;
}
ok('解码: 全部 v3 文件至少解出内容', walked === v3Files.length, `${walked}/${v3Files.length}`);
ok('解码: 帧走向器与朴素切片逐字节一致', parity === v3Files.length, `${parity}/${v3Files.length}`);

// ---------- v3 提取器：标题 / 模型 / 项目归属 ----------
let titled = 0, modeled = 0, located = 0, sample = null;
for (const f of v3Files) {
  const info = activityExtractors.dsh(f);
  if (!info) continue;
  if (info.title && info.title !== 'dsh 会话') titled++;
  if (info.model) modeled++;
  if (info.project || info.fallbackPath) located++;
  if (!sample && info.title && info.model) {
    sample = `标题「${info.title}」 模型 ${info.model} 归属 ${info.project || info.fallbackPath}`;
  }
}
ok('v3 提取: 大多数会话有标题', titled >= v3Files.length * 0.6, `${titled}/${v3Files.length}`);
ok('v3 提取: 有模型徽章数据', modeled > 0, `${modeled}/${v3Files.length}`);
ok('v3 提取: 有项目或路径归属', located === v3Files.length, `${located}/${v3Files.length}`);
console.log(`  样本: ${sample || '（无）'}`);

// ---------- 旧格式兼容：不抛错、能给出归属 ----------
let v2Ok = 0;
for (const f of v2Files) {
  try {
    const info = activityExtractors.dsh(f);
    if (info && (info.project || info.fallbackPath || info.title)) v2Ok++;
  } catch { }
}
ok('v2 兼容: 旧格式会话照常提取', v2Files.length === 0 || v2Ok > 0, `${v2Ok}/${v2Files.length}`);

console.log(`\n  结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

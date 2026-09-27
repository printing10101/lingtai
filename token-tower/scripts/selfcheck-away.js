'use strict';
// 自检：离线期间盘点（心跳基线 − 当前累计 = 离线差额）
// 覆盖：byToolTotals 的 llamacpp 净额口径与毛额桶缺模型明细时的降级、
// awayDeltaOf 的逐字段钳非负与零行跳过、parseHeartbeat 的坏输入拒绝。
// 不碰真实 data/：夹具日分桶直接塞进内存 warehouse，收尾 loadWarehouse() 从磁盘同步回来。
const S = require('../server.js');
const { warehouse, byToolTotals, awayDeltaOf, parseHeartbeat } = S;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

// ---------- 单元：byToolTotals（展示口径的分工具累计） ----------
// 两天夹具：llamacpp 的毛额里含 hermes 已入账的同模型请求，展示层要按「模型 × 当日」扣掉
warehouse.days.set('2099-01-01', {
  tokByTool: { codex: { in: 100, out: 50, cr: 10, cw: 5 }, llamacpp: { in: 1000, out: 100, cr: 0, cw: 0 } },
  tokByToolModel: {
    llamacpp: { 'qwen3-8b': { in: 1000, out: 100, cr: 0, cw: 0 } },
    hermes: { 'qwen3-8b': { in: 400, out: 40, cr: 0, cw: 0 } },
  },
});
warehouse.days.set('2099-01-02', {
  tokByTool: { zcode: { in: 2000, out: 300, cr: 1500, cw: 0 }, llamacpp: { in: 500, out: 50, cr: 0, cw: 0 } },
  tokByToolModel: { llamacpp: { 'qwen3-8b': { in: 500, out: 50, cr: 0, cw: 0 } }, hermes: {} },
});
// 毛额桶有数但没有分模型明细：净额算不出来，这一天不进 llamacpp 累计（宁少不多）
warehouse.days.set('2099-01-03', { tokByTool: { llamacpp: { in: 999, out: 99, cr: 0, cw: 0 } }, tokByToolModel: {} });

const t = byToolTotals();
ok('累计: 普通工具直接按日求和', t.codex.in === 100 && t.codex.out === 50 && t.codex.cr === 10 && t.codex.cw === 5, JSON.stringify(t.codex));
ok('累计: zcode 两天各桶独立', t.zcode.in === 2000 && t.zcode.cr === 1500, JSON.stringify(t.zcode));
ok('累计: llamacpp 扣 hermes 已入账部分', t.llamacpp.in === 600 + 500 && t.llamacpp.out === 60 + 50, JSON.stringify(t.llamacpp));

// ---------- 单元：awayDeltaOf（基线差额） ----------
const cur = {
  codex: { in: 100, out: 30, cr: 0, cw: 0 },      // 基线 in=500 比当前还大：钳成 0，out 照常
  zcode: { in: 2000, out: 300, cr: 1500, cw: 0 }, // 与基线全等：整行跳过
  hermes: { in: 7, out: 3, cr: 0, cw: 0 },        // 基线没有此工具：全额计
};
const d = awayDeltaOf({ codex: { in: 500, out: 0, cr: 0, cw: 0 }, zcode: { in: 2000, out: 300, cr: 1500, cw: 0 } }, cur);
ok('差额: 负数钳非负', d.byTool.codex.in === 0 && d.byTool.codex.out === 30, JSON.stringify(d.byTool.codex));
ok('差额: 与基线全等的工具不出现', !d.byTool.zcode, Object.keys(d.byTool).join(','));
ok('差额: 基线没有的工具全额计', d.byTool.hermes.in === 7 && d.byTool.hermes.out === 3, JSON.stringify(d.byTool.hermes));
ok('差额: total 只汇总出现过的行', d.total.in === 0 + 7 && d.total.out === 30 + 3, JSON.stringify(d.total));
const d0 = awayDeltaOf(null, cur);
ok('差额: 没有基线（首轮）全额计', d0.total.in === 100 + 2000 + 7, JSON.stringify(d0.total));

// ---------- 单元：parseHeartbeat（坏输入拒绝） ----------
const NOW = Date.parse('2026-09-25T10:00:00Z');
ok('心跳: 合法快照通过', !!parseHeartbeat(JSON.stringify({ ts: '2026-09-25T09:30:00Z', byTool: { codex: { in: 1 } } }), NOW));
ok('心跳: 坏 JSON 拒绝', parseHeartbeat('{oops', NOW) === null);
ok('心跳: 缺 byTool 拒绝', parseHeartbeat(JSON.stringify({ ts: '2026-09-25T09:30:00Z' }), NOW) === null);
ok('心跳: 来自动未来的拒绝', parseHeartbeat(JSON.stringify({ ts: '2026-09-25T12:00:00Z', byTool: {} }), NOW) === null);
ok('心跳: 时间不是日期的拒绝', parseHeartbeat(JSON.stringify({ ts: '昨天', byTool: {} }), NOW) === null);

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}: ${pass} pass / ${fail} fail`);
S.loadWarehouse(); // 内存台账重新从磁盘同步，丢掉本自检的夹具，真实数据不受影响
process.exit(fail === 0 ? 0 : 1);

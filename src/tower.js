// src/tower.js — Token 塔台聚合源：只读拉取塔台的公开 GET API，包上三态语义给总控大屏用。
// 塔台是独立软件、随时可能没在跑——down 是常态之一而不是故障；页面按 status 如实渲染。
// 口径继承看板第 1 条：「确认没有」和「没测到」是两种状态，绝不演"一切正常"。
'use strict';

const http = require('http');

function fetchJson(base, pathname, timeoutMs) {
  return new Promise(resolve => {
    const req = http.request(base + pathname, { method: 'GET', timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: 'http ' + res.statusCode });
        try { resolve({ ok: true, data: JSON.parse(body) }); }
        catch (_) { resolve({ ok: false, error: '响应不是 JSON' }); }
      });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时 ' + timeoutMs + 'ms' }); });
    req.end();
  });
}

// 三态包装：
//   刚抓到                       → { status:'ok',   checkedAt:现在, ageMs:0,   error:null,   data }
//   这次没抓到、但手里有上次好的 → { status:'stale', checkedAt:上次, ageMs:>0,  error,        data(旧) }
//   从来没抓到过                 → { status:'down',  checkedAt:null, ageMs:null, error,       data:null }
function wrapSource(fetched, lastGood) {
  if (fetched.ok) {
    return { status: 'ok', checkedAt: new Date().toISOString(), ageMs: 0, error: fetched.error || null, data: fetched.data };
  }
  if (lastGood && lastGood.data) {
    return {
      status: 'stale',
      checkedAt: lastGood.checkedAt,
      ageMs: Math.max(0, Date.now() - Date.parse(lastGood.checkedAt)),
      error: fetched.error,
      data: lastGood.data,
    };
  }
  return { status: 'down', checkedAt: null, ageMs: null, error: fetched.error, data: null };
}

// 一个塔台源 = 并行拉全部端点；有任一成功即算在线，缺了哪个如实记进 error。
// lastGood 闭包内持有：上游短暂失联时大屏还有上一份真数据可看（stale 而不是变白）。
// fetchJson 可注入——测试用假 fetch，不发真请求、不依赖塔台在跑。
function createTowerSource(cfg) {
  const base = cfg && cfg.base;
  const timeoutMs = (cfg && cfg.timeoutMs) || 1500;
  const doFetch = (cfg && cfg.fetchJson) || fetchJson;
  const ENDPOINTS = { state: '/api/state', stats: '/api/stats', waiting: '/api/waiting' };
  let lastGood = null;
  return {
    async overview() {
      if (!base) {
        return { status: 'down', checkedAt: null, ageMs: null, error: 'config.json 未配置 tower.base', data: null };
      }
      const names = Object.keys(ENDPOINTS);
      const results = await Promise.all(names.map(n => doFetch(base, ENDPOINTS[n], timeoutMs)));
      const data = {};
      const missing = [];
      names.forEach((n, i) => {
        const r = results[i];
        if (r.ok) data[n] = r.data;
        else missing.push(n + ': ' + r.error);
      });
      const wrapped = wrapSource(
        Object.keys(data).length > 0
          ? { ok: true, data, error: missing.length ? missing.join('；') : null }
          : { ok: false, error: missing.join('；') },
        lastGood,
      );
      if (wrapped.status === 'ok') lastGood = { checkedAt: wrapped.checkedAt, data: wrapped.data };
      return wrapped;
    },
  };
}

module.exports = { createTowerSource, wrapSource, fetchJson };

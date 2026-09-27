// src/control.js — 控制层：看板从「只读观测」升级出的唯一写入口。
// 只做三类写操作，一件都不多：
//   1) 向网关 8080 发公开 API 请求（/v1/completions 预热切换 —— model-proxy 的官方换模型方式，不改它一行）
//   2) 拉起 apps.json 里注册过的软件（没有任意命令执行端点）
//   3) 杀自己拉起的进程树（按 PID /T，绝不按镜像名全杀）
// .api-key 只读进内存：不进日志、不进响应、不落盘。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const OPS_KEEP = 50;          // op 历史条数
const LINES_KEEP = 80;        // 每个 op 的输出尾部行数
const LINE_MAX = 500;         // 单行截断
const WARM_TIMEOUT = 200000;  // 预热超时 < 网关 5 min 冷加载上限
const SPAWN_PROBE_MS = 3000;  // 秒退判定窗：拉起后这么久还活着才算「起来了」
// 所有自研软件消费同一个上游密钥，但读的 env 名各不相同（探查结论），统一都给备上
const API_KEY_ENVS = ['LLAMA_API_KEY', 'AI_API_KEY', 'SCANDETECTION_LLM_API_KEY'];

/* ---------- 纯函数（可测试） ---------- */

// 注册表校验：坏条目报错并跳过，绝不让一条坏配置拖死整个启动器
function validateApps(raw) {
  const apps = Array.isArray(raw && raw.apps) ? raw.apps : [];
  const errors = [];
  const clean = [];
  const seen = new Set();
  for (const a of apps) {
    const at = 'apps[' + (a && a.id ? a.id : '?') + ']';
    if (!a || typeof a !== 'object') { errors.push(at + ' 不是对象'); continue; }
    if (!a.id || typeof a.id !== 'string') { errors.push(at + ' 缺 id'); continue; }
    if (seen.has(a.id)) { errors.push(a.id + ' 重复'); continue; }
    if (!Array.isArray(a.command) || !a.command.length || a.command.some(c => typeof c !== 'string')) {
      errors.push(a.id + ' 的 command 必须是非空字符串数组'); continue;
    }
    if (!a.cwd || typeof a.cwd !== 'string') { errors.push(a.id + ' 缺 cwd'); continue; }
    if (a.healthCheckPort != null &&
        (!Number.isInteger(a.healthCheckPort) || a.healthCheckPort < 1 || a.healthCheckPort > 65535)) {
      errors.push(a.id + ' 的 healthCheckPort 非法'); continue;
    }
    if (a.modelArg != null) {
      if (typeof a.modelArg !== 'string' || !/^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(a.modelArg)) {
        errors.push(a.id + ' 的 modelArg 必须是命令行旗标形状（如 "-m" / "--model"）'); continue;
      }
    }
    if (a.launch != null && a.launch !== 'window') {
      errors.push(a.id + ' 的 launch 只支持 "window"'); continue;
    }
    seen.add(a.id);
    clean.push({
      id: a.id,
      name: a.name || a.id,
      command: a.command,
      cwd: a.cwd,
      modelEnv: a.modelEnv || null,
      modelArg: a.modelArg || null,
      defaultModel: a.defaultModel || null,
      healthCheckPort: a.healthCheckPort || null,
      launch: a.launch || null,
      warm: a.warm !== false,
      note: a.note || '',
    });
  }
  return { apps: clean, errors };
}

// 启动时的环境变量：模型注入 + 各家 API key 全名备上（探查结论：三家读的键名不一样）
function buildEnv(app, model, baseEnv, apiKey) {
  const env = { ...baseEnv };
  if (app.modelEnv) env[app.modelEnv] = model;
  if (apiKey) for (const k of API_KEY_ENVS) env[k] = apiKey;
  return env;
}

// 进命令行的模型 id / 旗标白名单：注册表 id（qwen3-instruct-30b 这类）与常见旗标（-m / --model）一向满足。
// 命令行注入是「请求体的 model 串到 argv」的唯一路径，这里是与注册表校验无关的第二道格式关。
const MODEL_ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 命令行注入模型（与环境变量注入二选一）：modelArg 软件把所选模型追加到注册命令尾部，
// 如 hermes 的 `-m <id>`。没选模型就不追加，原样用注册的命令。
function modelArgs(app, model) {
  return app.modelArg && model ? [app.modelArg, model] : [];
}

// 预热请求体：官方推荐的切换方式（README 示例认可），max_tokens=1 把代价压到最小
function warmBody(model) {
  return { model, prompt: 'hi', max_tokens: 1 };
}

/* ---------- IO 小件 ---------- */

function httpJson(method, host, port, urlPath, { body, key, timeout = 8000 } = {}) {
  return new Promise(resolve => {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (key) headers.authorization = 'Bearer ' + key;
    const req = http.request({ host, port, path: urlPath, method, headers, timeout }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => resolve({
        status: res.statusCode,
        json: (() => { try { return JSON.parse(b); } catch (_) { return null; } })(),
      }));
    });
    req.on('error', e => resolve({ status: 0, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 端口有人监听吗。超时按「有主」算：误拦一次启动事小，双拉一个软件事大
function portBusy(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/', timeout: 1200, agent: false }, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(true); });
  });
}

function readApiKey(file) {
  if (!file) return null;
  try { return String(fs.readFileSync(file, 'utf8')).split(/\r?\n/)[0].trim() || null; } catch (_) { return null; }
}

/* ---------- 控制器 ---------- */

class Controller {
  constructor(cfg, root, { registryModels } = {}) {
    this.cfg = cfg;
    this.registryModels = registryModels || (() => []);
    // apps.json 解析顺序：userData（打包态可覆盖）→ 项目根（dev/模板）。跟 history 同一套解耦思路
    const home = process.env.LINGTAI_HOME || process.env.MODEL_CONSOLE_HOME;
    this.appsFile = (home && fs.existsSync(path.join(home, 'apps.json')))
      ? path.join(home, 'apps.json')
      : path.join(root, 'apps.json');
    this.enabled = !cfg.control || cfg.control.enabled !== false;
    this.apps = [];
    this.appsErrors = [];
    this.appsMtime = -1;
    this.state = { enabled: this.enabled, appsFile: this.appsFile, list: [], ops: [] };
    this.inflight = new Map(); // appId|__model__ -> op
    this.running = new Map();  // appId -> { pid, model, startedAt, proc }
    this.apiKey = null;
    this.timer = null;
    this.seq = 0;
  }

  start() {
    this.loadApps();
    this.probeApps();
    this.timer = setInterval(() => this.probeApps(), 5000);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  loadApps() {
    let raw = null;
    let mtime = -1;
    try {
      mtime = fs.statSync(this.appsFile).mtimeMs;
      if (mtime === this.appsMtime) return;
      raw = JSON.parse(fs.readFileSync(this.appsFile, 'utf8'));
    } catch (e) {
      if (mtime === this.appsMtime) return;
      this.appsErrors = ['读不到/解析不了 ' + this.appsFile + '：' + String(e.message || e)];
      this.apps = [];
      this.appsMtime = mtime;
      return;
    }
    const { apps, errors } = validateApps(raw);
    this.apps = apps;
    this.appsErrors = errors;
    this.appsMtime = mtime;
  }

  // 周期巡检：外部运行探测（healthCheckPort）+ 自己拉起的进程是否还活着
  async probeApps() {
    this.loadApps();
    for (const a of this.apps) {
      const mine = this.running.get(a.id);
      if (mine && mine.proc && mine.proc.exitCode !== null) {
        // 本启动器拉起的进程已退出：如实降级，不留假「运行中」
        this.pushOpLine(mine.opRef, '进程已退出（exit ' + mine.proc.exitCode + '）');
        this.running.delete(a.id);
      }
      let external = null;
      if (!mine && a.healthCheckPort) external = await portBusy(a.healthCheckPort);
      a._external = external;
    }
    this.renderState();
  }

  renderState() {
    this.state = {
      enabled: this.enabled,
      appsFile: this.appsFile,
      errors: this.appsErrors,
      list: this.apps.map(a => {
        const mine = this.running.get(a.id);
        const op = this.inflight.get(a.id);
        return {
          id: a.id,
          name: a.name,
          command: a.command.join(' '),
          cwd: a.cwd,
          modelEnv: a.modelEnv,
          modelArg: a.modelArg,
          defaultModel: a.defaultModel,
          note: a.note,
          healthCheckPort: a.healthCheckPort,
          launch: a.launch,
          warm: a.warm,
          running: !!mine,
          pid: mine ? mine.pid : null,
          model: mine ? mine.model : null,
          startedAt: mine ? new Date(mine.startedAt).toISOString() : null,
          external: !mine && a._external === true,
          op: op ? { stage: op.stage, status: op.status, error: op.error || null, lines: op.lines.slice(-3) } : null,
        };
      }),
      ops: this.ops.slice(0, 20).map(o => ({ ...o, lines: o.lines.slice(-6) })),
    };
  }

  get ops() { return this._ops || (this._ops = []); }

  pushOp(op) {
    this.ops.unshift(op);
    if (this.ops.length > OPS_KEEP) this.ops.length = OPS_KEEP;
  }
  pushOpLine(op, text) {
    if (!op) return;
    const line = String(text).replace(/\s+$/, '').slice(0, LINE_MAX);
    if (!line) return;
    op.lines.push(line);
    if (op.lines.length > LINES_KEEP) op.lines.splice(0, op.lines.length - LINES_KEEP);
  }

  newOp(app, model, kind) {
    const op = {
      id: ++this.seq,
      kind, // start | stop | activate
      appId: app ? app.id : null,
      appName: app ? app.name : '(手动切换)',
      model: model || null,
      stage: kind === 'stop' ? 'stopping' : 'switching',
      status: 'running',
      lines: [],
      error: null,
      pid: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.pushOp(op);
    return op;
  }

  // 模型合法性：必须注册且在盘。网关对未注册名会静默降级，这里必须先替用户把住
  modelOk(model) {
    const m = (this.registryModels() || []).find(x => x.id === model);
    return !!(m && m.exists);
  }

  async propsAlias() {
    if (!this.apiKey) this.apiKey = readApiKey(this.cfg.apiKeyFile);
    const r = await httpJson('GET', this.cfg.proxyHost, this.cfg.upstreamPort, '/props',
      { key: this.apiKey, timeout: 3000 });
    return r.status === 200 && r.json ? String(r.json.model_alias || '').trim() : null;
  }

  // 预热到目标模型并验证。返回 null = 成功，字符串 = 失败原因
  async warmTo(model, op) {
    const gw = await httpJson('GET', this.cfg.proxyHost, this.cfg.proxyPort, '/health', { timeout: 3000 });
    if (gw.status !== 200) return '网关 ' + this.cfg.proxyPort + ' 不可达（' + (gw.error || 'http ' + gw.status) + '），先确认 model-proxy 在跑';
    const alias = await this.propsAlias();
    if (alias === model) {
      this.pushOpLine(op, '网关已驻留 ' + model + '，跳过切换');
      return null;
    }
    this.pushOpLine(op, '驻留 ' + (alias || '空/未测到') + ' → 预热 ' + model + '（冷加载约 25–35 s，请耐心等）');
    if (!this.apiKey) this.apiKey = readApiKey(this.cfg.apiKeyFile);
    if (!this.apiKey) return '读不到上游密钥 ' + this.cfg.apiKeyFile + '，无法通过鉴权发预热请求';
    const warm = await httpJson('POST', this.cfg.proxyHost, this.cfg.proxyPort, '/v1/completions',
      { key: this.apiKey, body: warmBody(model), timeout: WARM_TIMEOUT });
    if (warm.status === 0) return '预热请求失败：' + warm.error;
    if (warm.status !== 200) return '预热请求被拒：http ' + warm.status;
    const alias2 = await this.propsAlias();
    if (alias2 !== model) return '切换未确认：/props 别名是 ' + (alias2 || '未知') + '，期望 ' + model + '（未注册的模型名会被网关静默降级）';
    this.pushOpLine(op, '网关已确认服务 ' + model);
    return null;
  }

  async activate(model) {
    if (!this.enabled) return { error: '控制层未启用（config.json control.enabled）' };
    if (!this.modelOk(model)) return { error: '模型 ' + model + ' 未注册或权重不在盘，网关会静默降级，已拒绝' };
    const key = '__model__';
    if (this.inflight.has(key)) return { error: '已有进行中的切换/启动' };
    const op = this.newOp(null, model, 'activate');
    this.inflight.set(key, op);
    this.renderState();
    this.runActivate(op, model);
    return { opId: op.id };
  }

  async runActivate(op, model) {
    try {
      const err = await this.warmTo(model, op);
      if (err) throw new Error(err);
      op.stage = 'done';
      op.status = 'ok';
    } catch (e) {
      op.status = 'failed';
      op.stage = 'failed';
      op.error = String(e.message || e);
    } finally {
      op.finishedAt = new Date().toISOString();
      this.inflight.delete('__model__');
      this.renderState();
    }
  }

  async startApp(appId, model) {
    if (!this.enabled) return { error: '控制层未启用（config.json control.enabled）' };
    this.loadApps();
    const app = this.apps.find(a => a.id === appId);
    if (!app) return { error: 'apps.json 里没有 ' + appId };
    if (this.inflight.has(appId)) return { error: app.name + ' 已有进行中的操作，稍等' };
    if (this.running.has(appId)) return { error: app.name + ' 已由本启动器拉起（PID ' + this.running.get(appId).pid + '），先停止再启动' };
    // warm:false = 不消费网关的软件（监控台这类）：没有「目标模型」可言，跳过校验与预热
    const target = app.warm === false ? null
      : (model || app.defaultModel || (this.registryModels()[0] || {}).id);
    if (app.warm !== false) {
      if (!target) return { error: '没有可用模型（注册表为空）' };
      if (!this.modelOk(target)) return { error: '模型 ' + target + ' 未注册或权重不在盘，已拒绝' };
    }
    if (app.healthCheckPort && await portBusy(app.healthCheckPort)) {
      return { error: '端口 ' + app.healthCheckPort + ' 已有人监听 —— ' + app.name + ' 可能已在外部运行，不双拉' };
    }
    const op = this.newOp(app, target, 'start');
    this.inflight.set(appId, op);
    this.renderState();
    this.runStart(op, app, target);
    return { opId: op.id, model: target };
  }

  async runStart(op, app, model) {
    try {
      if (app.warm !== false) {
        const err = await this.warmTo(model, op);
        if (err) throw new Error(err);
      }
      op.stage = 'launching';
      // 进命令行的模型 id 还要过一道字符白名单（注册表 id 一向满足）：
      // 这是与 modelOk 无关的独立格式关，串进来的任何奇怪字符到不了 argv。
      if (model && !MODEL_ID_OK.test(model)) throw new Error('模型 id 含非白名单字符，拒绝拼进命令行');
      // 命令行注入模型（如 hermes -m <id>）：extra 只可能是 [modelArg, 过了白名单的模型 id]
      const extra = modelArgs(app, model);
      const env = buildEnv(app, model, process.env, this.apiKey);
      this.pushOpLine(op, '拉起：' + app.command.concat(extra).join(' ') +
        (app.warm === false ? '（免预热）' : (app.modelEnv ? '（' + app.modelEnv + '=' + model + '）' : '')));
      if (app.launch === 'window') {
        await this.launchWindow(op, app, extra, env);
        return;
      }
      const proc = spawn(app.command[0], app.command.slice(1).concat(extra), {
        cwd: app.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', d => this.pushOpLine(op, d));
      proc.stderr.on('data', d => this.pushOpLine(op, '[err] ' + d));
      // 秒退判定窗：这些启动命令都是阻塞型的，窗口内退出（哪怕 exit 0）都算失败 ——
      // 3 s 后还活着才登记为「运行中」
      const exited = await new Promise(resolve => {
        proc.once('error', e => resolve('spawn 失败：' + e.message));
        proc.once('exit', code => resolve('进程在启动后 ' + (SPAWN_PROBE_MS / 1000) + ' s 内退出（exit ' + code + '）'));
        setTimeout(() => resolve(null), SPAWN_PROBE_MS);
      });
      if (exited) throw new Error(exited + ' —— 上面是它的输出尾部');
      this.running.set(app.id, { pid: proc.pid, model, startedAt: Date.now(), proc, opRef: op });
      op.stage = 'running';
      op.status = 'ok';
      op.pid = proc.pid;
      this.pushOpLine(op, '已运行（PID ' + proc.pid + '）');
    } catch (e) {
      op.status = 'failed';
      op.stage = 'failed';
      op.error = String(e.message || e);
    } finally {
      op.finishedAt = new Date().toISOString();
      this.inflight.delete(app.id);
      this.renderState();
    }
  }

  // 开窗型（launch:"window"）：`cmd start` 给软件开一个独立终端窗口后自己立刻退出，
  // 窗口里的进程不归本启动器管 —— 记不了 PID、给不了「停止」。
  // 所以判定标准也不同：开窗命令退出码非 0 才算失败，「3 s 还活着」不再要求。
  async launchWindow(op, app, extra, env) {
    // `start` 对不在盘上的 exe 会弹系统对话框而非报退出码，这里先替用户把文件查掉。
    // 注册约定：command 形如 [cmd, /c, start, "", exe, ...]，exe 在第 5 位。
    const exeArg = app.command.length > 4 ? app.command[4] : null;
    const exePath = exeArg && path.isAbsolute(exeArg) ? exeArg : (exeArg ? path.join(app.cwd, exeArg) : null);
    if (!exePath || !fs.existsSync(exePath)) {
      throw new Error('开窗目标不在盘上：' + (exeArg || 'command 缺少 start 后面的 exe（约定 [cmd,/c,start,"",exe,...]）'));
    }
    const proc = spawn(app.command[0], app.command.slice(1).concat(extra), {
      cwd: app.cwd, env, detached: true, windowsHide: true, stdio: 'ignore',
    });
    const fail = await new Promise(resolve => {
      proc.once('error', e => resolve('spawn 失败：' + e.message));
      proc.once('exit', code => resolve(code === 0 ? null : '开窗命令退出码 ' + code));
      setTimeout(() => resolve(null), SPAWN_PROBE_MS);
    });
    if (fail) throw new Error(fail);
    proc.unref();
    op.stage = 'launched';
    op.status = 'ok';
    this.pushOpLine(op, '已在新终端窗口拉起（不托管：停止请直接关那个窗口）');
  }

  stopApp(appId) {
    if (!this.enabled) return { error: '控制层未启用（config.json control.enabled）' };
    const mine = this.running.get(appId);
    if (!mine) return { error: '该软件不是本启动器拉起的（或已退出），没有可停止的记录' };
    const app = this.apps.find(a => a.id === appId);
    const op = this.newOp(app || { id: appId, name: appId }, mine.model, 'stop');
    try {
      execFile('taskkill', ['/PID', String(mine.pid), '/T', '/F'], { windowsHide: true }, () => {});
      this.pushOpLine(op, '已发 taskkill /PID ' + mine.pid + ' /T /F（只杀自己拉起的这棵进程树）');
    } catch (e) {
      op.status = 'failed';
      op.error = String(e.message || e);
    }
    this.running.delete(appId);
    op.stage = 'done';
    op.status = 'ok';
    op.finishedAt = new Date().toISOString();
    this.renderState();
    return { opId: op.id };
  }
}

module.exports = { Controller, validateApps, buildEnv, modelArgs, warmBody, portBusy, readApiKey, API_KEY_ENVS, MODEL_ID_OK };

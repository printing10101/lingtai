// test/control.test.mjs — 控制层的纯函数面。启动/切换的 IO 流程交给实测，
// 这里钉住的是三件「错了会静默变事故」的事：坏配置要报错、模型注入要落对键、
// 预热请求体必须是网关认可的切换方式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/control.js');

test('validateApps: 坏条目逐个报错并跳过，好条目补齐默认值', () => {
  const { apps, errors } = C.validateApps({ apps: [
    { id: 'a', name: 'A', cwd: 'D:\\a', command: ['py', 'a.py'], modelEnv: 'M', defaultModel: 'm1', healthCheckPort: 8001 },
    { id: 'a', cwd: 'D:\\dup', command: ['x'] },                    // 重复 id
    { id: 'nocmd', cwd: 'D:\\x', command: [] },                     // 空 command
    { id: 'badport', cwd: 'D:\\x', command: ['x'], healthCheckPort: 99999 }, // 端口非法
    { cwd: 'D:\\x', command: ['x'] },                               // 缺 id
    'not-an-object',                                                // 非对象
  ] });
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'a');
  assert.equal(apps[0].modelEnv, 'M');
  assert.equal(apps[0].healthCheckPort, 8001);
  assert.equal(errors.length, 5, '每条坏配置都要点名，不许静默丢弃：' + errors.join(' | '));
});

test('buildEnv: 模型注入到 app 指定的键，API key 三家名字都备上，且不污染 baseEnv', () => {
  const base = { PATH: 'C:\\windows', AI_MODEL: 'old-value' };
  const env = C.buildEnv({ modelEnv: 'AI_MODEL' }, 'qwen3-14b', base, 'sk-test');
  assert.equal(env.AI_MODEL, 'qwen3-14b');
  for (const k of C.API_KEY_ENVS) assert.equal(env[k], 'sk-test', k + ' 必须备好');
  assert.equal(base.AI_MODEL, 'old-value', '不得原地改调用方的环境');
  const noKey = C.buildEnv({ modelEnv: null }, 'm', {}, null);
  assert.ok(!(C.API_KEY_ENVS[0] in noKey), '没有密钥时不能注入空串占位');
});

test('validateApps: 开窗/免预热/命令行注入新字段过校验，非法值逐个点名', () => {
  const { apps, errors } = C.validateApps({ apps: [
    { id: 'win', cwd: 'C:\\', command: ['cmd', '/c', 'start', '', 'C:\\x\\hermes.exe'], modelArg: '-m', launch: 'window' },
    { id: 'nowarm', cwd: 'D:\\t', command: ['cmd', '/c', 'start.bat'], warm: false, healthCheckPort: 7345 },
    { id: 'badlaunch', cwd: 'D:\\x', command: ['x'], launch: 'popup' },
    { id: 'badarg', cwd: 'D:\\x', command: ['x'], modelArg: 'not-a-flag' },
  ] });
  assert.equal(apps.length, 2, '好条目必须全部通过：' + errors.join(' | '));
  const win = apps.find(a => a.id === 'win');
  assert.equal(win.modelArg, '-m');
  assert.equal(win.launch, 'window');
  assert.equal(win.warm, true, '没写 warm 的默认必须预热（防静默跳过网关切换）');
  assert.equal(apps.find(a => a.id === 'nowarm').warm, false);
  assert.equal(errors.length, 2, '每条坏配置都要点名：' + errors.join(' | '));
});

test('modelArgs: 只有 modelArg 软件且选了模型才追加 [旗标, id]，其余命令原样', () => {
  const app = { command: ['cmd', '/c', 'start', '', 'hermes.exe'], modelArg: '-m' };
  assert.deepEqual(C.modelArgs(app, 'qwen3-14b'), ['-m', 'qwen3-14b']);
  assert.deepEqual(C.modelArgs(app, null), [], '没选模型不追加');
  assert.deepEqual(C.modelArgs({ command: ['x'], modelArg: null }, 'm'), [], '环境变量型软件不受影响');
});

test('MODEL_ID_OK: 注册表 id 全过，带命令元字符或空串的一律拦下', () => {
  for (const id of ['qwen3-instruct-30b', 'gpt-oss-20b', 'qwen38-27b', 'qwen3-14b']) {
    assert.ok(C.MODEL_ID_OK.test(id), id + ' 应通过');
  }
  for (const bad of ['a b', 'a;b', '$(x)', 'a|b', 'a&b', '', '-leading-dash']) {
    assert.ok(!C.MODEL_ID_OK.test(bad), JSON.stringify(bad) + ' 必须被拦');
  }
});

test('warmBody: 必须是网关官方认可的极短生成请求（body.model 触发切换链路）', () => {
  assert.deepEqual(C.warmBody('qwen3-14b'), { model: 'qwen3-14b', prompt: 'hi', max_tokens: 1 });
});

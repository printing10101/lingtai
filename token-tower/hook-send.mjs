// 供各 AI CLI 的 hook 调用：把一条事件 POST 给监控台。
// 任何失败都静默退出——hook 绝不能反过来卡住或报错打断开发工具，
// 这是少数"静默失败是对的"的场景（监控台没开就当没发生）。
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);

const argOf = name => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};

// 有些 CLI（Qoder CLI、Claude Code）把事件 JSON 从 stdin 喂进来，而不是拼在命令行参数里。
// 只在确实有管道时读，且限时 300ms：手敲测试时没有 stdin 也不能挂住。
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  const until = Date.now() + 300;
  try {
    for await (const c of process.stdin) {
      chunks.push(c);
      if (Date.now() > until) break;
    }
  } catch { /* 管道异常就当没有 stdin */ }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text.startsWith('{')) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Qoder / Claude 的 hook_event_name 映射成塔台时间线里读得懂的 kind
const EVENT_KIND = {
  UserPromptSubmit: 'prompt', Stop: 'stop', SessionStart: 'start', SessionEnd: 'end',
  Notification: 'notify', SubagentStart: 'substart', SubagentStop: 'substop',
  PostToolUseFailure: 'fail', PreCompact: 'compact', PostCompact: 'compact',
};

const stdin = await readStdin();
const eventName = stdin && stdin.hook_event_name;

const payload = {
  tool: argOf('tool') || 'unknown',
  // 显式 --event 优先（保留 `--event waiting` 这类手工语义），其次用 stdin 的事件名
  kind: argOf('event') || (eventName && (EVENT_KIND[eventName] || String(eventName).toLowerCase())) || 'hook',
  // --project-env 让 hook-send 自己从环境变量取项目路径：Windows 上 hook 可能经 cmd 执行，
  // "$CLAUDE_PROJECT_DIR" 这种 shell 展开不一定生效，进程环境变量才是各 CLI 都靠得住的通道
  project: argOf('project') || process.env[argOf('project-env')] || (stdin && stdin.cwd) || null,
  detail: argOf('detail') || (stdin && (stdin.tool_name || null)) || null,
};

// Codex 的 notify 会把一段 JSON 作为最后一个参数传进来，顺手解析出 cwd 当作项目路径
const last = args[args.length - 1];
if (last && last.startsWith('{')) {
  try {
    const j = JSON.parse(last);
    payload.project = payload.project || j.cwd || j.project || null;
    payload.detail = payload.detail || j.type || null;
  } catch { /* 不是 JSON 就当普通参数忽略 */ }
}

try {
  await fetch(`http://localhost:${config.port}/api/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wb-hook': '1' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  });
} catch { /* 监控台没开就放弃 */ }

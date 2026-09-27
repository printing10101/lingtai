# 灵台（lingtai）

本地 LLM 网关总控台：观测 llama.cpp 网关的**驻留模型、显存、调用方与换卡史**，再通过控制层把软件**一键拉起到指定模型**。实验进度有独立的直播大屏；配合同仓库的 Token 塔台（`token-tower/`，独立进程）可拼出整机总控大屏。

纯本地运行：观测层**绝对只读**（不改网关一行代码，所有结论都从外部信号推出）；控制层只走公开 API 与白名单，没有任意命令执行端点。

## 三块屏

| 页面 | 地址 | 回答的问题 |
|---|---|---|
| 主看板 | `/` | 网关现在什么状态：谁驻留、显存被谁占、谁在调用、今天换了几次卡 |
| 实验直播 | `/experiments` | 正在跑的实验到哪了、还要多久、死没死 |
| 总控大屏 | `/master` | 这台电脑整体怎样：看板 + 塔台账本拼成一屏 |

## 三条设计军规

1. **观测层绝对只读。** 结论全部从外部信号推出：进程命令行、`nvidia-smi`、`netstat`、网关与实验自己的日志文件。不改网关、不改实验脚本一行。
2. **「确认没有」和「没测到」是两种状态。** 任何探针失败都在 state 里留下 `status/error`，前端据此显式标灰（蓝 = 确认没有，灰 = 未测到），绝不退化成"看起来一切正常"。
3. **控制层只做三件事，一件不多。** ① 向网关发公开 API 预热请求（官方换模型方式）；② 拉起 `apps.json` 里注册过的软件；③ 杀**自己拉起的**进程树（按 PID `/T`，绝不按镜像名全杀）。

## 快速开始

前置：Windows、Node.js ≥ 18（塔台自检需 ≥ 22.5）、NVIDIA GPU（`nvidia-smi`）、一个在跑的 llama.cpp model-proxy 网关。

```bat
npm install
copy config.example.json config.json   & rem 改成自己的网关/模型路径
copy apps.example.json  apps.json      & rem 软件注册表，按需增删
npm test                               & rem 71 条断言
npm run app                            & rem 桌面壳：托盘常驻 + 桌面告警
```

只跑采集服务（浏览器看 / 远程看）：`node server.js`，然后开 `http://127.0.0.1:8099`。
打包便携 exe：`npm run dist`（electron-builder portable，产物在 `dist/`）。

## 看板观测什么

| 卡 | 回答的问题 | 数据来源 |
|---|---|---|
| 当前驻留 | 网关上正服务哪个模型、`-c/-ngl/-np` 实际值、已驻留多久 | llama-server 进程命令行 + 上游 `/props` |
| 显存环形 | 整卡用了多少、还剩多少、利用率、温度、功耗 | `nvidia-smi --query-gpu` |
| 自研软件 | 把哪个软件拉到哪个模型上；谁在运行、谁在外部运行 | 启动器 op 状态（`src/control.js`） |
| 实验台 | 本机正在跑的实验到哪了、还要多久、死没死 | 实验自产落盘物 + python 进程命令行 |
| 抖动账本 | 今天换了几次卡、乒乓对、冷加载分位、最凶的边 | 网关日志 ∪ 自建事件归档 全量重算 |
| 显存账本 | 整卡显存都被谁占着：网关驻留、旁路实例（含连坐风险）、其他计算进程 | 进程命令行 + `--query-compute-apps` |
| 谁在调用 | 此刻哪个进程连着网关；近期活跃强度 | `netstat -ano` + `tasklist` |
| 可用模型 | 注册表里有哪些、权重在不在盘；一键切换驻留 | 模型注册表 ∩ 盘上 GGUF ∪ 额外目录扫描 |
| 台账抽屉 | 逐条事件证据；驻留历史与显存 × 驻留时间轴 | 日志尾部 ∪ 事件归档 ∪ 自建采样 |

自建历史（15 s 一条采样 + 事件归档）是这套观测的关键一环：网关日志满 1 MB 会整体清空，看板自己落盘的账不会丢。采样文件超限自动按 1/4 抽稀（保首尾），可以常驻一年。

## 启动器（控制层）

`apps.json` 注册一个软件，看板上就多一张可拉起的卡。四类注入方式：

| 字段 | 说明 |
|---|---|
| `command` / `cwd` | argv 形式的启动命令与工作目录 |
| `modelEnv` | 把所选模型注入指定环境变量（环境变量优先于软件自己的 .env） |
| `modelArg` | 把所选模型追加到命令行（如 `-m <id>`，进 argv 前另过字符白名单） |
| `launch: "window"` | 开独立终端窗口跑交互式 TUI（不托管：记不了 PID、没有停止钮） |
| `warm: false` | 不消费网关的软件：跳过模型校验与预热直接拉起 |
| `defaultModel` | 必须是注册表里注册且权重在盘的 id，否则启动被拒 |
| `healthCheckPort` | 防双拉探测：端口有主 = 已在外部运行，不接管也不重复拉起 |

「先切换再启动」的完整链路：校验目标模型注册且在盘（防网关静默降级假成功）→ 防双拉 → 驻留不符则预热 + `/props` 确认 → 带环境变量拉起 → 3 s 秒退判定。每一步的状态与输出尾部都进 `GET /api/state`。

## 实验台：不改实验脚本一行的进度观测

观测原料全部是实验本来就自产落盘的东西：

| 信号 | 用途 |
|---|---|
| 日志里的 tqdm 帧 | 阶段名、当前代/总代、s/代、自带 ETA、best/mean 现值 |
| launcher 链日志 | 批总组数、组序、实测耗时、SKIP、exit |
| run 目录 `config.json` | 进度分母（stages × stage_gens） |
| run 目录 `gen_log.csv` | 已完成代数、逐代曲线、文件 mtime = 心跳 |
| run 目录 `report.md` | 完成标志（与批脚本断点续跑同一判据） |
| python 进程命令行 | run 级 / 批级归因 |

状态机五态，判据全部外显：`done`（report.md 在）/ `running`（心跳新鲜）/ `stalled`（进程在但心跳停了——最该喊人）/ `interrupted`（进程没了、没跑完、report.md 不在）/ `archive`（历史残骸，不进现势）。

ETA 口径逐字外显、不编数：当前阶段用 tqdm 自带 ETA；跨阶段按当前阶段速度外推；无 tqdm 的源退化为 gen_log 行数差分的近期代速；链级 = 当前组剩余 + 排队组数 × 实测平均。

## 总控大屏与塔台

`/master` 把看板（管"卡"）与 Token 塔台（管"token"，见 `token-tower/README.md`）拼成一屏。塔台是独立进程，随时可能没在跑，聚合层用三态如实包装：

- `ok` —— 刚抓到；
- `stale` —— 这次没抓到但手里有上一份真数据，界面明说"数据是 N 前的"；
- `down` —— 从没抓到过，明说"塔台未运行"。

塔台不在，看板其余功能一概不受影响。

## 桌面壳（electron/）

双击即用；关窗收进托盘继续盯（常驻哨兵定位），托盘菜单才真正退出。壳内轮询驱动一套**越变告警**（同类有冷却）：旁路实例出现、网关掉线、幽灵请求、空卡满显存、10 min 换卡 ≥ 3 次、实验完成/卡住/中断。

## 配置参考

`config.json`（见 `config.example.json`）：

| 字段 | 说明 |
|---|---|
| `serverPort` | 看板自身端口（默认 8099，只绑 127.0.0.1） |
| `proxyPort` / `upstreamPort` | 网关端口 / 上游 llama-server 端口 |
| `proxyLog` / `registryFile` / `modelsDir` / `apiKeyFile` | 网关日志、模型注册表、权重目录、上游密钥文件 |
| `extraModelDirs` | 注册表之外的盘上 GGUF 目录（只列不判：网关切不了） |
| `historyDir` / `historyMaxBytes` | 自建历史落盘点与抽稀阈值 |
| `alerts` | 桌面告警开关与冷却 |
| `cadenceMs` | 各探针的采样节奏 |
| `experiments` | 实验源注册（`stallMin`/`sources[]`：logsDir + runsDir），加一个项目就加一条 |
| `tower` | 塔台地址与超时（总控大屏用） |
| `control.enabled` | 控制层总开关 |

`apps.json`（见 `apps.example.json`）：字段表见上文「启动器」。

## 目录

```
server.js          采集与页面服务（/api 只读 + /api/overview 聚合 + /api/ctl 控制面 + /api/pause + /api/export）
src/parsers.js     纯解析层：netstat / tasklist / nvidia-smi / 命令行 / 网关日志 / 历史抽稀 / 事件合并
src/exparsers.js   实验纯解析层：tqdm 帧 / 链日志 / gen_log.csv / 状态机 / ETA
src/experiments.js 实验采集层：run 目录扫描 + 日志尾 + 进程归因（纯只读）
src/collect.js     采集层：分节奏探针 + 状态收口 + 自落历史 + 事件归档（纯只读）
src/control.js     控制层：唯一的写入口 —— 预热切换、拉起注册的软件、杀自己的进程树
src/tower.js       塔台聚合源：只读拉塔台公开 API，三态包装 ok/stale/down
public/            页面（原生 HTML/CSS/JS，无框架）：主看板 + 实验直播 + 总控大屏
electron/          桌面壳：托盘常驻 + 越变告警
token-tower/       Token 塔台完整源码：独立进程，多项目 git 状态 + AI CLI 的 token 用量聚合
test/              71 条断言：解析层 + 渲染契约 + 实验直播契约 + 控制层 + 总控聚合
fixtures/          解析层钉子样本（脱敏后的实验现场快照）
```

## 已知取舍

- 预热后若长时间没有软件真正调用，网关 idle-stop 会卸载模型——网关既有行为，看板不对抗，驻留灯如实变化。
- 3 s 轮询而不是 WebSocket：全景粒度够用，要实时事件流去塔台原界面。
- 控制端点只绑 127.0.0.1 且无鉴权——单用户本机的约定边界，别把端口转发出去。
- 调用方只能到进程粒度：网关不打 per-request 日志，短连接在 Windows 里落进 TIME_WAIT 且 PID 恒为 0，只能计数不能点名。

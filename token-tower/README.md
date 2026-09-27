# Token 塔台 · 个人开发监控台

单进程本地服务，实时监控本机所有开发项目与多个 AI 编程工具的工作状态。
不只是"有动静"：会话卡片直接显示**当前任务标题、token 消耗、工作中/等待你确认**；agent 干完一轮活时弹通知+响铃+闪任务栏。
页面顶部是**全机用量**：今日 / 近 7 天 / 累计，本机所有被监听 CLI 的 token 都算进来——包括 Codex 已归档的历史会话；卡片下方有分工具占比条，配好单价还能估算花费。
塔台自己不在线的时段也有账：启动时自动对出「塔台离线期间」的消耗（见「离线期间盘点」一节）。

**覆盖的工具**：

- **token 级**（有会话日志，能算 token）：Codex（含归档历史）、Claude Code（首次运行后自动接管），
  WorkBuddy（traces 里的模型请求流水，含全部历史回填与分模型明细），
  **Qoder CLI**（`~/.qoder/projects/<工作区>/<session-id>.jsonl`，含 180 天历史回填；口径特殊，见下），
  **Hermes**（`state.db` SQLite 用量库轮询，分模型真值 + 会话卡片，本地模型单独标记），
  **llama.cpp 直连**（model-proxy 拉起的 llama-server 运行日志 `server-*.log`，
  不经 Hermes 的直连调用在这里记账，直连净额口径，见下）
- **token 级 · 完整账本**：**ZCode**（`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表按
  (会话×模型×日) 对账，含官方"使用统计"页同一份完整历史——桌面端聊天、子智能体、上下文压缩、
  标题生成全部在内；日志时代的旧账按会话折抵，不会重复计。见下）
- **活动级**（日志里没有 token 用量，只记"动过"：事件 + 临时卡片）：dsh（agent 会话，v3 事件流里有真实标题/模型/cwd，卡片带模型徽章）、
  workbuddy（安全审计流水，只进时间线，token 走 traces）
- **暂无法统计**：Trae、CodeBuddy、Qoder IDE、Copilot CLI 的会话数据存在 LevelDB/LocalStorage 里，本地没有可解析的用量记录；
  LM Studio 装了（本机推理器之一），但它的 API 调用不落任何本地用量记录，只能以"已安装·未纳管"出现
  （2026-09-21 复核：copilot 只有进程启停日志、codebuddy CLI 家目录无会话数据、dsh 会话日志里无 usage 字段；
  2026-09-22 复核：dsh v3 事件流同样无 usage，request/header 只报 provider/model/maxTokens）

> **Qoder CLI 的 token 口径与别家不同**：它的会话日志里 `input_tokens`/`output_tokens` 被官方抹成 0，
> 但 `context_usage_ratio`（本轮上下文占窗口的比例）与 `credits` 是真实值（实测 849/849 条 usage 记录都有）。
> 所以 token 数取 `Σ max(0, Δcontext_usage_ratio) × contextWindow`（`contextWindow` 从 `runtime-config` 读，
> qfmodel 实测 1,000,000），含义是**真正流经模型的新增上下文体量**（含上一轮模型输出与工具回读，官方未分列），
> 不是计费 token。因此：`out`/`缓存读` 一律留 0 不伪造，卡片不参与成本估算，另起一行显示官方 `credits` 原值。

> **ZCode 的完整账本在本地 SQLite**：`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表每次模型请求一行
> （含重试的每次 attempt），带 `model_id`/`session_id`/`started_at`，加总与 ZCode 官方"使用统计"页
> 逐 token 一致（2026-09-24 实测偏差 <0.2%）。此前塔台从 `model-io-*.jsonl` 日志累加——那只是残卷：
> 日志滚动截断、会话结束即删，只能截到官方数字的一成。现在 token 一律从 DB 对账：
> 入账走 `bankByDay` 按 (会话, 模型, 日) 补差额，桌面端聊天、子智能体、上下文压缩、标题生成全在内；
> 项目归属取 `session.directory` 前缀匹配。切换之前日志时代已入账的量按会话折抵进新台账
> （有日记账的精确回放，老条目按 DB 日分布比例摊派），总量收敛到 DB 真值、不重复计。
> 会话卡片的标题/阶段仍由日志监听提供（只有它能给出"工作中"），卡片上的 token 数字改与 DB 同源。
> 口径说明：`input_tokens` 含缓存读（官方同口径），error/cancelled 行用量本就是 0，全部行都计入。

> **Hermes 与本地模型用量**：Hermes 的账本在 `AppData/Local/hermes/state.db`，`session_model_usage` 表
> 每行是 (会话, 模型, 计费端点, 任务) 的**累计 token 真值**（in/out/缓存读写），`billing_base_url` 指明请求
> 发往哪个推理端点。塔台用 `node:sqlite` 只读连接轮询（读者不阻塞写者），对台账补差额；
> base_url 指向本机回环地址（llama.cpp 等）的模型被登记为**本地模型**——全机用量卡片单列
> "其中本地模型"一行，分模型明细里本地模型带 ⚙ 标记。会话卡片与"等你确认"来自 `sessions` 表
> （标题、cwd、项目归属）与 `messages` 末条（`finish_reason=stop` → 等你确认，还在工具循环 → 工作中）。

> **llama.cpp 直连与"其中本地模型"的完整口径**：本机的本地推理中枢是 model-proxy
> （8080，按需拉起 llama-server 于 8081），调用方有三家——Hermes、dsh、自研服务的后端。
> Hermes 的账在自己库里（上节）；其余直连调用没有任何工具账本，唯一的流水是
> llama-server 每次运行截断重写的 `server-<model>.log`：每个完成的请求有一组计时行
> （`prompt eval … / A tokens`、`eval … / B tokens`、`n_tokens = N`），由此还原与 Hermes 同口径的
> **in = N − B + 1（完整 prompt，含缓存读）、out = B、缓存读 = in − A**。日志里没有墙钟（时间戳是
> 开机以来的 uptime），也没有调用方身份，所以：入账记**毛额**（同一份日志里也有 Hermes 的请求），
> 展示层按「模型 × 当日」扣掉 hermes 名下已入账的同模型用量，净额才是其余直连调用方的流量
> ——现算而非入账时扣，hermes 轮询晚到一轮也自动校正，两类账永不重复。llama.cpp 卡片的数字
> 一律是净额；"其中本地模型"= hermes 的本地标记 + 直连净额 = 本机 GPU 真实烧掉的全部 token。

## 数据来源（七层）

1. **会话日志监听（实时）**：`fs.watch` 监听各 CLI 自己的会话日志目录，从日志尾部解析出
   会话标题（最后一轮用户输入）、token 消耗、当前阶段（工作中 / 等你确认），
   并尽力从日志里的路径把会话归属到项目。ZCode 的日志只出标题/阶段/模型（token 走 usage DB 对账）；
   Qoder 的标题取 `humanInput: true` 的那条用户记录，
   不会被 `tool_result` 与 skill 注入文本污染。
2. **git 轮询（30 秒）**：对发现的项目跑 `git status -sb / branch / log -1`，分支切换、未提交数变化、新提交、
   推送清零都会进时间线（未提交数的抖动按 10 分钟合并成一条，不让 git 噪音刷屏）；
   `-sb` 头还带出 ahead/behind，项目卡片上有 `↑未推送 / ↓落后` 芯片（分支设置了 upstream 才显示）。
3. **hook 事件端点（最精确）**：`POST /api/event`（需带 `x-wb-hook: 1` 头，防止浏览器里恶意网页伪造事件），
   各工具的 hook 主动上报（会话开始/结束、任务完成等）。
4. **活动目录监听（无 token 的工具）**：`activityDirs` 监听 dsh / workbuddy 的日志目录，
   命中 `match` 后缀的文件有变更时解析出项目归属与标题，发一条事件 + 挂一张临时会话卡片；
   只入事件统计，不进 token 台账。已升级 token 级的工具（workbuddy）审计流水只进时间线，
   临时卡片让位给 trace 会话卡片。
   **Qoder 曾挂在这里（监听 `~/.qoder/logs/runs/*/manifest.json`），2026-09-21 迁到会话日志层**：
   manifest 只是进程启动记录，它的 `cwd` 恒为 Qoder 安装目录而不是工作区，归不到任何项目；
   且多数 run 带 `--no-session-persistence`、连 `--session-id` 都没有，是 CLI 内部的索引/上下文进程。
   提取器仍保留并改成用 `--session-id` 反查会话流水里的真实 `cwd`，反查不到就整条丢弃——
   宁可少一条事件，也不记一条错的归属。
5. **trace 目录监听（整份 JSON 的工具）**：`traceDirs` 监听 WorkBuddy 的 `traces/<pid>/trace_*.json`
   （OpenTelemetry 风格，generation span 的 toolOutput 里是完整 chat.completion 响应）。
   解析出 model 与 usage 入 token 台账，按响应时间戳落到**真实日期**（不是启动当天）；
   台账按文件 mtime 去重，上千个存量文件启动时只 stat 不 parse，写完即不可变的 trace 不会重复计数。
   toolInput 在 100KB 处被截断，会话标题从 `<user_query>` 标签按栈配对提取。
6. **usage DB 轮询（账本在 SQLite 里的工具）**：轮询 ZCode 的 `db.sqlite`（`model_usage` 按
   (会话, 模型, 日) 对账，日志时代旧账按会话折抵）与 Hermes 的 `state.db`
   （`session_model_usage` 累计值对台账补差额，`sessions`/`messages` 出会话卡片与阶段）。
   Hermes 首轮静默补账不往时间线灌历史事件；Hermes 清理旧会话不影响已入账的台账；
   需要 Node ≥ 22.5（`node:sqlite`），缺了就降级为只探测安装。
7. **llama.cpp 运行日志监听（直连本地模型的工具）**：`llamaLogDirs` 盯 model-proxy 所在目录的
   `server-<model>.log`（模型名从文件名取），按计时行还原 token 入台账，出现的模型自动登记为本地模型。
   每次运行截断重写：文件比上次记录小 = 换代，换新台账键、旧运行账原样保留，顺序错乱也只少记不多记。

## 离线期间盘点（塔台不在场时烧了多少）

塔台关着的时候各 CLI 照样跑、token 照样烧——重启后各数据源会把离线期间的用量**补进台账**，
但"补进来的属于哪个时段"没有专门呈现。心跳快照补上这一环：

- **运行期间**，塔台定期把全机分工具累计写进 `data/heartbeat.json`——这就是"我最后活着是什么时候、
  账走到了哪儿"的一跳。
- **下次启动**读它当基线，各数据源的重启补账把离线用量陆续落账后，`当前累计 − 基线` 就是离线期间
  的消耗。启动后留 90 秒核对窗让补账到齐，随后定格：全机用量区多出一张**「塔台离线期间」卡**
  （分工具拆分与占比条同款）；离线 ≥ 30 分钟且消耗 ≥ 1000 token 时，时间线也报一条。
- 数字是**两次快照之差**：窗口两端各有不超过一个心跳周期的毛边，核对窗内新烧的 token 会被算进
  离线账，定格之后就不算了；差值逐字段钳非负，手动回拨时钟也宁少报不多报。

已知少报：llama.cpp 的 `server-<model>.log` 每次 llama-server 启动都截断重写——若塔台离线期间
llama-server 重启过，被截掉的那几段直连用量无从补起，离线卡会如实少计（累计台账不受影响，
丢的只是"这段发生在离线期"这个呈现）。

## 启动

- **桌面应用（推荐）**：双击桌面快捷方式 **Token 塔台**（或 `npm run app`）。
  Electron 壳（`electron/main.js`）自动拉起 server.js 并把监控台装进桌面窗口；
  **关窗只是缩到托盘**，服务在后台继续收事件（首次关窗有气泡提示），托盘左键唤出窗口、
  右键可退出或开关**开机自启**。服务已在跑（如先执行了 start.bat）时壳只复用、不重复拉起。
  改图标后跑 `node scripts/make-icon.js` 重新生成 `electron/app.ico`。
- **命令行**：`start.bat` 或 `npm start`，然后打开 http://localhost:7345
  （只绑定 127.0.0.1，不暴露局域网）。
- 开发/测试时可 `WB_PORT=xxx` 临时换端口（`node server.js` 与 `npm run app` 都认）。

## 会话感知与通知

- **正在发生面板**：每个活跃会话一张卡片——工具徽章、任务标题、`工作中 / 等你确认` 状态、
  当前模型芯片（从日志解析）、累计 token（输入/输出）、最近活动时间。"等你确认"的会话排最前、橙色高亮，
  **不会因为日志没动静而消失**（最长保留 24 小时），卡片上显示"已等 N 分钟"；
  工作中的卡片对称显示"已干 N 分钟"（本轮从最近一次阶段切换起算）；
  挂超过 30 分钟的等待卡片会置灰降级，亮的才是刚等你的。
- **任务栏可见性**：窗口标题实时显示 `(N 等确认)`；窗口最小化或被遮挡时，
  有新的"等你确认"会闪任务栏，点回窗口自动熄灭。
- **托盘态提醒**：窗口缩到托盘后，Electron 主进程常驻轮询轻量的 `GET /api/waiting`，
  新出现的"等你确认"弹 Windows 原生通知，点击唤出窗口并高亮对应会话卡片；
  托盘图标悬停提示"N 个会话等你确认"。窗口可见时仍由页面通知 + 任务栏闪烁负责，两路不重复吵。
- **通知**：点右上角 🔔 启用（浏览器通知 + 一声轻响）。agent 从"工作中"转入"等你确认"时提醒你，
  同一会话 2 分钟内不重复吵，点通知会滚到并高亮对应会话卡片。开关记在 `localStorage`。
- **统计区**：近 84 天活动热力图（事件数 / token 两种口径可切换）+ 近 84 天各时段（0–23 时）
  事件分布柱图 + 项目累计表（事件数、累计 token）；全机用量卡片下一行是"近 7 天"回顾
  （token、事件数、最忙的一天，配了 pricing 还带成本估算）。
- **时间线过滤**：活动时间线顶部一排 chips——按工具筛选、只看"等确认"，选择记在 `localStorage`。

## 项目管理

**新建 / 添加**：项目标题旁的「＋ 新建」展开表单，输入路径或点「选择文件夹」（桌面端原生对话框，纯浏览器降级为手输）：

- 目录不存在 → 自动创建并 `git init`（真正的"新建项目"）；
- 目录已存在 → 直接纳入监控，没有 `.git` 也补一个；
- **主动添加等于重新计入**：该路径之前被隐藏过，这里会自动解除隐藏；
- 手动纳入的项目记录在 `data/user-projects.json`，不受"只扫 projectRoots 一层"的深度限制，换重启不丢。

**打开文件夹**：项目卡片悬停出现 📂，点开在资源管理器里打开项目目录。
**VS Code 打开**：悬停出现 🆚（服务端探测到 PATH 里有 `code` 才显示），点开在 VS Code 里打开项目。

**实时发现**：projectRoots 有目录监听，别处新建/克隆的项目 1~4 秒内自动出现在面板上（30 秒轮询仍是兜底）；
**已隐藏的项目不会被实时发现带回来**，除非通过「恢复」或重新主动添加。

**隐藏**：自动扫描出来的项目不都是"在开发的项目"（比如一次性实验仓库）。项目卡片右上角的 **✕** 可以把它移出监控：

- 隐藏后不再被项目发现、不再轮询 git（分支/提交/改动噪音一起消失），项目面板和统计表都不再展示；
- **已入账的统计与台账原样保留**，恢复后原封不动地回来；
- 面板底部的「已隐藏 N 个项目 · 点开恢复」条可以随时恢复；
- 隐藏列表落盘在 `data/hidden-projects.json`，手工编辑同样生效。

**每个项目的 token**：项目卡片上有 `tok 入/出` 芯片（累计口径，统计接口按项目名取），下方统计表里也有逐项目的入/出/缓存读明细。

管理接口（与 hook 端点一样要求 `x-wb-hook: 1` 头，挡掉浏览器里恶意网页的跨站伪造）：

- `POST /api/projects/hide`：body `{ "path": "D:/foo" }` 隐藏、`{ "path": "D:/foo", "restore": true }` 恢复
- `POST /api/projects/create`：body `{ "path": "D:/foo/bar" }` 新建或添加
- `POST /api/projects/open`：body `{ "path": "D:/foo" }` 在资源管理器中打开
- `POST /api/projects/edit`：body `{ "path": "D:/foo" }` 在 VS Code 中打开（未装则 404）

## 工具用量

「工具用量」区列出电脑上检测到的编程工具和各自的用量：

- **token 级**（ZCode / Codex / Claude Code / WorkBuddy / Hermes / llama.cpp 直连）：累计、今日、近 7 天的输入/输出/缓存读，
  配了 pricing 还有累计成本估算；
  累计口径从台账按文件名归类（`zcode-db:*`=zcode、`rollout-*`=codex、`trace_*`=workbuddy、
  `hermes:*`=hermes、`llama:*`=llamacpp、其余=claude），**含修复分工具入账之前的全部历史**；
  今日/近 7 天来自按工具的日分桶（2026-09-17 修复后才有数据）。全机用量卡片的累计档分工具占比条用的也是这份台账归类。
  zcode 的分模型明细自 2026-09-24 起从 DB 直取（按 `model_id`），含全部历史。
- **本地模型用量**（2026-09-22 起；2026-09-24 起覆盖直连）：服务端从各工具账本认出"跑在本机推理端点（llama.cpp 等）"的模型
  （Hermes 的 `billing_base_url` 指向 127.0.0.1/localhost），在 `localModels` 落盘；
  llama.cpp 运行日志里出现的模型也自动登记。全机用量卡片多一行"其中本地模型"
  （= hermes 本地标记 + llamacpp 直连净额，即本机 GPU 烧掉的全部 token），
  分模型明细里本地模型带 ⚙；本地模型烧的是本机 GPU，不参与成本估算的口径提醒照常生效。
- **llama.cpp 直连**（2026-09-24 起）：卡片数字是**直连净额**——llama-server 日志的毛额按
  「模型 × 当日」扣掉 hermes 已入账部分后的余量（不经 Hermes 的直连调用方的真实消耗）。
  集成前直连调用的历史不可补：日志每次运行截断重写，旧运行的文件早已不在；
  首次接管把现存日志按各自最后活动的那天一次性入账。
- **分模型用量**（2026-09-20 起）：三家日志里的 model 字段被解析进日分桶的 `tokByToolModel`，
  全机用量卡片与工具卡片各有一行"模型"明细；**之前的存量历史只有工具归属，无模型明细**，`pricing` 仍按工具配单价。
  WorkBuddy 从接入起就有模型明细（deepseek-v4.1-flash / glm-5.3-flash / hy3 等，来自 trace 的响应体）。
  Hermes 从接入起就有分模型明细（qwen38-27b / qwen3-instruct-30b / gpt-oss-20b / deepseek-v4-flash 等，来自用量库）。
- **活动级**（Qoder CLI / dsh）：显示累计活动事件数，它们的日志里没有 token 用量。
  dsh 自 2026-09 中旬改用 v3 会话格式（`session.v3.jsonl.zstd`，多帧 zstd + JSONL 事件流水）——
  塔台曾因文件名字面匹配漏掉全部 v3 会话，2026-09-22 修复并把活动卡片升级为带真实标题与模型徽章。
- **已安装 · 未纳管**（Trae / CodeBuddy / Copilot CLI / Gemini CLI / Cursor / Grok Bot / Xiaomi MiMo / LM Studio）：
  只探测家目录下有没有安装目录，本地没有可统计的用量记录；没装的不会出现。
  2026-09-18 已逐一深挖确认无本地 token 记录：Trae 与 CodeBuddy 的 state.vscdb 全部键值、IndexedDB 二进制、
  CodeBuddy 的 genie-history（仅 conversationId）均无 token 字段；小米 MiMo 的 rolechat.db 无 token 列；
  Copilot CLI 只有进程启停日志；Qoder 运行日志无 usage/credit（"usage" 命中只是 usagePromotionItems 推广字段）；
  dsh 会话 zstd 解开后无 usage；WorkBuddy 的 session_usage 是配额额度（非 token）。
  这些工具的用量在各自服务端，本地拿不到——若以后某家开始落盘用量，在 config.json 的 `sessionDirs`/
  `activityDirs`/`traceDirs` 加一条并配上解析器即可纳管。
  2026-09-23 复核（Grok Bot / Xiaomi MiMo / CC Switch）：Grok Bot 本地只有设置、daemon 日志与登录身份 blob，
  会话与用量全在服务端；MiMo 更新后再次复核 rolechat / session-review / artifacts 三库仍无 token 列，
  `mimocode/llm-server/` 下只有推理端口注册与鉴权 token——两者以"已安装·未纳管"卡片出现在面板上。
  **CC Switch 有意不纳管**：它的 `cc-switch.db` 里虽有带真实 token 字段的 `proxy_request_logs`，
  但 `data_source=codex_session`，同步的正是 `~/.codex/sessions` 与归档目录的 rollout 日志
  （塔台已在 codex 名下对同一批文件按 token 计量），接入只会重复记账。
  Qoder CLI 的 `~/.qoder-cli/ai-stats/` 是 AI 改动行审计流水（filePath + aiAddedLines/aiDeletedLines），
  无 token 字段，Qoder 的 token 仍走 `~/.qoder/projects` 的会话日志。
- **装卸实时感知，卸载不清账**：工具卡片上的 `installed` 标志来自家目录探测（`.zcode` / `.codex` /
  `.workbuddy` 等），服务盯着家目录，装上/卸载几秒内推给前端刷新，不用重启也不用等轮询。
  卸载只是目录消失：台账里的累计 token 原样保留，卡片继续显示历史用量、标签变"已卸载"（置灰），
  重装后自动回到"监控中"。

## 统计仓库与全机用量

- 事件明细只保留 500 条（`events.ndjson` 在启动时截回尾部，不会无限膨胀），但每日/每项目的聚合
  （事件数、token、小时分布、分工具 token）落盘在 `data/stats-daily.json`，跨重启累积——
  CLI 会清理自己的旧日志，这里的数据要活得比它们久。
- `sessionDirs` 里每项可加 `archiveDir`（Codex 用）：归档目录会被监听并在首次接管时把存量
  历史一次补齐，会话结束移入归档时自动补最后一笔账。
- 所有 token 入账都对着 `stats-daily.json` 里的**台账**（每个源文件已入账的累计值）补差额：
  服务重启、文件归档移动、日志滚动重写，都不会重复计数。
- 查询接口：`GET /api/stats`（含 `totals`：今日 / 近 7 天 / 累计，每档带 `byTool` 分工具用量与 `byModel` 分模型用量；
  配好 `pricing` 时还带 `cost` 估算与 `currency`，配好 `budget` 时带 `budget` 日预算线）；
  `GET /api/waiting`（只有等待中的会话，Electron 壳托盘态轮询用）。
- 会话目录暂不存在（如 Claude Code 还没跑过第一次）不算错误，服务每轮轮询会自动重试接管。
- 启动时补扫最近 24 小时的会话文件：重启前就在"等你确认"的会话会重新回到面板上。

## 配置（config.json）

| 字段 | 说明 |
| --- | --- |
| `port` | 服务端口 |
| `projectRoots` | 项目发现根目录，向下扫描一层找 `.git` |
| `extraProjects` | 手工补充的项目路径（如 C 盘的仓库） |
| `pollIntervalMs` | git 轮询间隔 |
| `liveWindowMs` | 会话多久没动静算"不活跃"（页面"正在发生"面板；等待中的会话不受此限） |
| `pricing` | 可选。分工具的**每百万 token 单价**（`in`/`out`/`cr`），配了非零值后用量卡片显示成本估算（`currency` 是货币符号）；全 0 或删掉该字段即关闭 |
| `budget` | 可选。`dailyTokens` / `dailyCost` 设日预算，超限时"今日"卡片描红并弹一次通知（每天至多提醒一回） |
| `sessionDirs` | 各工具会话日志目录及工具名，可选 `archiveDir` 为归档目录；可选 `backfill: true` 表示首次接管时把 180 天内的存量会话按事件真实日期一次补齐 |
| `activityDirs` | 没有 token 日志的工具：`tool` + `dir` + `match`（文件名后缀），有变更即发活动事件 |
| `traceDirs` | 整份 JSON 的 trace 目录：`tool` + `dir` + `match`，解析模型请求流水入 token 台账（当前是 WorkBuddy） |
| `llamaLogDirs` | llama.cpp 运行日志目录：`tool` + `dir`，监听目录下 `server-<model>.log`（计时行还原 token，模型名取自文件名；`*.err.log` 跳过），直连本地模型的工具靠它记账 |
| `usageDbs` | 账本在 SQLite 里的工具：`tool` + `db`（库文件路径），塔台用只读连接轮询入账（当前是 ZCode 与 Hermes） |

## hook 接入

通用格式（任何能执行命令的 hook 都可以）：

```
node <塔台目录>/token-tower/hook-send.mjs --tool <工具名> --event <事件名> [--project <目录>] [--detail <说明>]
```

`--event waiting` 会在时间线记一条橙色"等你确认"，与自动检测的效果一致。

失败静默退出，绝不会拖累开发工具本身。直连 `POST /api/event` 的调用方需自带 `x-wb-hook: 1` 请求头
（hook-send 已内置；该头用于拒绝浏览器跨站伪造的事件）。

**Claude Code / ZCode**（settings.json 风格的 hooks 配置）：

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "node <塔台目录>/token-tower/hook-send.mjs --tool claude --event prompt --project-env CLAUDE_PROJECT_DIR" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "node <塔台目录>/token-tower/hook-send.mjs --tool claude --event stop --project-env CLAUDE_PROJECT_DIR" }] }]
  }
}
```

`--project-env` 让 hook-send 自己从进程环境变量取项目路径——Windows 上 hook 可能经 cmd 执行，
`"$CLAUDE_PROJECT_DIR"` 这种 shell 展开不一定生效；不传 `--project` / `--project-env` 也能用，只是归不到具体项目。
`~/.claude/settings.json` 与 `~/.codex/config.toml` 都可按上例接入；ZCode 首次产生会话日志后由日志监听自动覆盖。

**Codex**（`~/.codex/config.toml`）：

```toml
notify = ["node", "<塔台目录>/token-tower/hook-send.mjs", "--tool", "codex", "--event", "notify"]
```

hook-send 会自动解析 notify 传入的 JSON 参数里的 `cwd`。

**Qoder CLI**（`~/.qoder/settings.json` 的 `hooks`，事件 JSON 走 **stdin** 而不是命令行参数）：

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<塔台目录>/token-tower/hook-send.mjs", "--tool", "qoder", "--project-env", "QODER_PROJECT_DIR"],
      "name": "token-tower", "async": true, "timeout": 5 }] }],
    "Stop":        [{ "hooks": [{ /* 同上 */ }] }],
    "SessionEnd":  [{ "hooks": [{ /* 同上 */ }] }],
    "SubagentStop": [{ "hooks": [{ /* 同上 */ }] }]
  }
}
```

`hook-send.mjs` 会在 stdin 有管道时读那段 JSON（限时 300ms，手敲测试没有 stdin 也不会挂住），
把 `hook_event_name` 映射成时间线 kind（`UserPromptSubmit`→收到新指令、`Stop`→这轮干完、
`SessionEnd`→会话结束…），并用里面的 `cwd` 兜项目归属。`args` 形式是 exec form：`command`
带空格路径也不用操心 shell 引号。`async: true` 保证 hook 只旁路观察，绝不拖住会话。
**改完要新开会话才生效**（settings 只在启动时读）。

## 自检

`npm run selfcheck` 一键跑完全部各套（也可单独 `node scripts/selfcheck-*.js`）。

`node scripts/selfcheck-qoder.js` —— Qoder 接入的 24 项断言：token 口径与独立参考实现数值对齐、
credits 求和一致、项目归属取真实 `cwd` 而非安装目录、台账幂等（重复补账/实时窗口重放/跨重启
增量+全量混跑都不重复计账）、qoder 用量不被误记成 claude、无 `--session-id` 的内部进程被丢弃。
脚本会拦掉对 `data/` 的一切写入，可以和常驻塔台同时跑。

`node scripts/selfcheck-zcode.js` —— ZCode usage DB 接入的 16 项断言：model_usage 对账数值、
日志时代折抵（有日记账精确回放 / 无日记账比例摊派 / 多模型只种量大的键 / DB 里查不到的孤儿会话保全）、
分日归属、幂等（重复轮询不重复计）、增量（新行落真实日期、用量回填只补差额）、
会话卡片 token 与台账同源、claude 全文件按日分桶不重复计。
夹具 SQLite 库在临时目录，不碰真实 `db.sqlite` 与 `data/`。

`node scripts/selfcheck-hermes.js` —— Hermes 接入的 36 项断言：夹具 SQLite 库上的入账数值、
分日归属（历史账落到该行最后为真的那天）、台账幂等与增量补差、本地模型标记（`localModels` 端点登记、
远端模型不混入）、孪生行不撞键（base_url 尾斜杠差异各自足额入账）、会话卡片（阶段判定、项目归属、
token 与台账同源、结束撤卡）。夹具在临时目录、全程静默轮询，不碰真实 `state.db` 与 `data/`。

`node scripts/selfcheck-llama.js` —— llama.cpp 直连接入的 21 项断言：计时行还原公式
（无缓存 / 缓存复用 / 全缓存命中 / 缺 release 行，行样例取自真实日志）、夹具日志上的入账数值、
幂等（重复 harvest 不重复计）、增量（追加只补差额）、换代（截断重写换新台账键、旧账保留）、
忽略规则（`*.err.log` / 非 `server-*` / 空文件）、展示层净额（毛额扣 hermes 已入账、
偏大时钳 0 不出负、llamacpp 卡片与 byModel 口径）。夹具在临时目录，不碰真实 llama.cpp 日志目录与 `data/`。

`node scripts/selfcheck-dsh.js` —— DSH 活动级接入的 10 项断言：match 能同时命中 v2/v3 文件名
（v3 字面匹配漏检的回归）、多帧 zstd 帧走向器与朴素切片参考实现逐字节对拍、v3 提取器的
标题/模型/项目归属、旧格式兼容。只读真实会话文件，全程零写入。

`node scripts/selfcheck-away.js` —— 离线期间盘点的 13 项断言：byToolTotals 分工具累计
（llamacpp 净额扣 hermes 已入账、毛额桶缺模型明细时宁少不多）、awayDeltaOf 逐字段钳非负、
零差行跳过、无基线全额计、parseHeartbeat 对坏 JSON / 缺字段 / 未来时间戳的拒绝。
夹具日分桶塞进内存 warehouse，收尾从磁盘同步回来，不碰真实 `data/`。

## 数据文件

- `data/events.ndjson`：事件流水（每行一个 JSON），重启后自动载入最近 500 条。
- `data/stats-daily.json`：每日/每项目统计聚合，自动维护，可随手备份。
- `data/heartbeat.json`：离线盘点的心跳快照（最近一跳的全机分工具累计），自动维护。
- `data/hidden-projects.json`：被用户隐藏的项目列表（面板 ✕ / 恢复维护）。
- `data/user-projects.json`：用户手动新建/添加的项目路径（UI「＋ 新建」维护）。

## 已知边界

- token 统计是**日志尾部窗口采样的近似值**：只读日志尾部（claude/codex 256KB），
  台账保证只多记的量以后不会再记，累计值长期收敛。claude 的 usage 水位线落台账，
  重启后恢复旧会话也不会重复计数。zcode 的 token 不走日志采样，从 usage DB 精确对账（见开头说明）。
- 启动补扫把服务下线期间产生的 token 记到**重启当天**的账上，不回溯真实日期
  （workbuddy traces、Qoder 会话与 zcode 的 usage DB 例外：按记录时间戳落到真实日期）。
- 2026-09-17 之前入账的 token 没有分工具归属（当天修复的入账缺 tool 参数的 bug），
  分工具占比条从修复后开始累积；总量与逐日合计不受影响。
- dsh 只有**活动事件**（会话），日志里没有 token 用量（v2 单 JSON 与 v3 事件流都已逐一确认），不进 token 台账；
  v3 是"多帧 zstd"：每批事件一个独立帧，Node 的一次式/流式解压只吃第一帧，塔台按 RFC 8878 帧结构
  逐帧走块头解出全部事件，帧格式若再变化，该文件按"没动静"跳过，不影响其他工具。
  启动时只从接管那一刻开始记活动，存量日志不回填时间线。
- Qoder 的 token 是**上下文净增量**口径（见开头说明）：官方不报输入/输出分列，所以卡片上
  `出` 与 `缓存读` 恒为 0，不是"没消耗"而是"没上报"；成本一律看 `credits` 那行。
  子代理（Agent 工具）的流水是独立文件，会各自成一条会话并各自入账。
  全文件补账有 32MB 上限，超长的会话退回尾部窗口，累计值只会偏低不会重复。
- workbuddy 的 trace 无项目归属字段，归因靠 toolInput 文本里的路径嗅探，尽力而为；
  trace 里的 usage 是模型侧口径（prompt 含缓存读），与 codex 同口径，别和各家计费面板直接对数。
- 被监听目录消失（工具卸载、日志清理）不会让服务崩溃：watcher 报错被接住并放开该目录，
  目录回来后 30 秒内自动重新接管。
- dsh 会话是 zstd 压缩的单 JSON，解析需要 Node ≥ 22.15 / 23.8（`zlib.zstdDecompressSync`）；
  解析失败（写了一半、版本变化）静默跳过该次变更，不影响其他工具。
- Trae / CodeBuddy / Qoder IDE / Copilot CLI 没有本地可解析的用量记录（会话存 LevelDB/LocalStorage），
  无法统计；Claude Code 的会话目录首次运行后出现，服务会自动接管。
- "等你确认"的会话卡片最多保留 24 小时（与内存会话表的生命周期一致），超过后随补扫消失。
- zcode 的 model-io 日志会滚动截断、会话结束即删除——这正是 2026-09-24 前塔台只能记到官方
  数字一成的原因；现在 token 从 usage DB 对账后此问题不复存在。日志本身只用于会话卡片的
  标题/阶段：截断后请求体只携带增量消息（历史走缓存前缀），旧 prompt 不在文件里时
  会话标题会退化为文件名，该会话下一次真实输入后自动恢复。
- zcode 的折抵种子在首次 DB 轮询时一次性写入：日志时代已入账的旧账按会话折抵进 `zcode-db:*`
  台账键（有日记账的精确回放，2026-09-18 前的老条目按 DB 日分布比例摊派，日归属近似、总量精确）。
  DB 里查不到的 legacy 会话（DB 清理了旧行）搬进 `zcode-db:orphan:*` 键保全，总量不丢。
- zcode 只在"一次模型请求完成"时写日志，用户新输入到首个响应落地之间状态会短暂停留在上一轮的"等你确认"。
- 会话标题以"最新一轮用户输入"为准，task-notification、system-reminder 等注入内容会被剥掉。
- 会话日志的路径嗅探是尽力而为：没嗅出来就显示文件名，精确归因靠 hook 或把路径加进 `extraProjects`。
- 项目发现只扫 `projectRoots` 一层；嵌套更深的仓库加进 `extraProjects`。
- `git` 必须在系统 PATH 里（Git Bash 环境下默认可用）。
- 分模型入账从 2026-09-20 开始：之前的累计 token 只有工具归属，"今日/近 7 天"的模型明细从该日起才完整。
  zcode 例外：2026-09-24 接入 usage DB 后分模型明细覆盖全部历史（从 DB 的 `model_id` 直取）。
- Hermes 的历史补账把每个用量行落到该行**最后为真的那天**（`last_seen`）：一个跨多天的会话，
  它的存量账会集中在最后活动的那天，与 Codex 累计口径的既有近似一致；此后实时轮询的增量落当天。
- llama.cpp 直连的日归属是近似值：日志时间戳是开机 uptime 没有墙钟，存量日志首次入账落到该运行
  最后活动的那天，实时增量落读取当天；某天 hermes 的同模型入账若因补账晚到而大于当天毛额，
  直连净额按 0 计（只少记不多记，后续日子自然恢复）。llama-server 每次运行截断重写日志，
  **集成之前的直连历史无法回补**；某次运行若在两次轮询之间被整个覆盖（极少见），那次的量只少记不多记。
  走独立脚本、不落这个目录的向量/Embedding 模型不在记账范围。
- Hermes 接入依赖 Node ≥ 22.5 的 `node:sqlite`（只读连接轮询 WAL 库，不阻塞 Hermes 写入）；
  库文件缺失（卸载）只警告一次，恢复后自动重试，已入账的台账原样保留。
- `↑/↓` 未推送芯片要求当前分支设置了 upstream；detached HEAD 或无上游的仓库不显示。
- VS Code 按钮取决于服务启动时 PATH 里能否 `where code`；没装时按钮与服务端接口都不可用。

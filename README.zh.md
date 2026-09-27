# dsh-mcp-adapter

[English](README.md) | 简体中文

面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的省 token MCP 适配器——一个受 [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) 启发的 **prompt-side shim**（提示词侧垫片）。

**要求 dsh >= 0.1.7-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

## 问题

官方 `@deepseek-ai/dsh-mcp-client` 插件把发现的每个 MCP 工具都原生注册进工具表（`mcp__<server>__<tool>`），于是**每次请求都要为每个 MCP 工具的完整 JSON Schema 付费**——上游 README 原话：*"Data-dependent schema cost is paid on every request while the tools are registered."* 几个 server、几十个工具下来，就是每条消息烧掉数千 token，无论模型是否真的调用它们。

## 思路

本插件完全保留官方 `dsh-mcp-client` 作为连接层（transport、自动重连、`tools/list_changed` 重同步——全是上游现成的），只在提示词装配这一处介入：

- 每个匹配的 `mcp__*` 工具 schema 被**折叠出**装配后的 prompt（`system-prompt/assemble` waterfall）；
- 原位换上两个**恒定 meta-tool**，常驻 prompt 成本对 server/工具数量而言是 O(1)：
  - **`mcp_list`** — 紧凑目录（工具名 + 截断描述，不含 schema）；传 `tool` 按需展开单个工具的完整 schema，传 `server` 过滤，传 `query` 拿相关性精排的子集，传 `verbose` 全量内联；
  - **`mcp_call`** — 按 `{ tool, arguments }` 把调用分发到仍然注册着的定义上，运行上下文原样透传。

工具本身仍注册在 `ctx.tools` 里，所以 TUI 渲染、`tools.restrict()` 掩蔽照常工作——变的只是 prompt 载荷。折叠后恒定的工具列表也比上游"每次重同步就换代"的模式更利于 KV 前缀缓存。

一个管线细节：按子工具名（`mcp__server__tool`）匹配的 pre-execute / guard / post-execute 阶段不会在折叠调用上触发——注册表只会看到外层的 `mcp_call`。要管控 MCP 使用（审批、策略），请 guard **`mcp_call` 本身**。

图片结果保持原生行为：`mcp_call` 把 `output.render` 委托给被分发的子工具，并以同一个执行对象转发子工具的 `finalizeContent`——带图 MCP 结果仍会投影为持久附件引用，而不是把 base64 内联进上下文。

**故障放行（fail-open）：** 若两个 meta-tool 未成功注册（重名冲突、启动中断），本插件不动装配结果——退回官方全量直通，绝不会让 MCP 工具变得不可发现。

**Code Mode：** 在 `mode: 'code'` 下线上本来就折叠为 `run_code`，本插件天然 no-op。

**宿主资源工具（dsh ≥ 0.1.6）：** 宿主内置的 `@deepseek-ai/dsh-mcp-resources` 注册三个共享工具 —— `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`，均不带 `mcp__` 前缀。它们按设计不进折叠路径，原生呈现给模型；折叠与 keep 语义保持不变，`keep` 也只会命中匹配前缀的名字，本插件无需任何额外配置。

**加载位置：** 经宿主组合加载（即下方 `cordis.patch.yml` 的 `insert` 行）时全局生效——所有 agent 的装配都会被折叠；若经某个 agent 的 scoped context 加载，则只对该 agent 生效。

## 安装

保留（或新增）你的 `@deepseek-ai/dsh-mcp-client` 配置行，然后把本插件加在同处：

```yaml
- insert:
    - id: dsh-mcp-adapter
      name: '@aiwayds/dsh-mcp-adapter'
      config: {}
```

```
dsh plugin --profile <name> add @aiwayds/dsh-mcp-adapter
```

## 卸载

```
dsh plugin --profile <name> remove @aiwayds/dsh-mcp-adapter
```

宿主会自动完成清理：`dsh.profile.bundles` 里对应的条目被拼接移除，插件的 patch 层随之失效。

有一份状态被刻意**保留**：插件自己的门闩文件 `~/.dsh/storages/mcp-adapter/gate.json`（设置了 `DSH_HOME` 则以其为准）——stable server id（1..99）和 disabled 门闩。它按设计永不回收：重装本插件后，每个 server 仍沿用之前的 id。

连这份状态也想清掉的话，请自行删除 `storages/mcp-adapter/` 目录；重装时 id 会重新分配。

从 dsh 0.1.5 升级：旧 `settings.yaml` 里的 `mcp-adapter:` 小节（0.1.7 宿主首次启动时把该文件一次性导入并改名为 `settings.yaml.imported`，旧段名与本插件 entry id 不同名）会被**一次性自动承接**：下次插件启动时若尚无门闩文件，则从 `settings.yaml.imported`（兜底仍在的 `settings.yaml`）读取 stable id 与 disabled 门闩，消毒后直接写入 `gate.json`——无需再逐条 `/mcp disable <id>` 重新闩上。承接过程记录在 `<dsh home>/storages/mcp-adapter/legacy-import.json`（该 marker 存在即永不重跑；已有 gate.json 则完全不介入）。profile patch 里该 entry 的 `config:` 配置原样继承，不受影响。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `prefix` | `"mcp__"` | 要折叠的工具名前缀 |
| `keep` | `[]` | 保持原生进 prompt 的名字模式（`*` 通配）——对应 pi-mcp-adapter 的 direct 模式，适合高频、值得占一等座 schema 的工具 |
| `servers` | `[]` | server 白名单：非空时只有这些 server 的工具会被折叠 / 进目录 / 可分发（三处共用同一份名单） |
| `descriptionLimit` | `200` | `mcp_list` 目录里每条工具描述的最大字符数 |
| `storageDir` | `""` | 门闩存储目录覆盖；空 = `<dsh home>/storages/mcp-adapter`（插件启动时读一次，改后需重启插件生效） |
| `jevEnabled` | `false` | System One 总开关——**默认关闭**：false 表示任何环节都不发决策请求，而调用统计照常累积 |
| `jevBackend` | `"zen"` | 决策后端：`zen`（opencode-zen 免费档）/ `native`（typesafe 直连）/ `openrouter`；各自需要自己的 API key（`JEV_ZEN_API_KEY` / `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`，或 macOS 钥匙串） |
| `jevModel` | `""` | 钉死的模型 id；空 = 调用时解析后端自带默认（`jev-1.13-free` / `jev-1.13.0` / `typesafe/jev-1.13`）——升级是一次有意为之的动作 |
| `jevTimeoutMs` | `3000` | 单次请求超时（毫秒）；只试一次、不重试——下一次节奏就是重试 |
| `jevSecretFile` | `""` | 出站密钥闸的额外字面量密钥清单（`JEV_SECRET_FILE` 语义）；换路径即热更清单 |
| `jevLayaFallback` | `false` | **默认关闭**：每次决策请求同时并行打一发本地 laya；其答案只作对比记录，仅在主后端失败时接管 |
| `jevLayaUrl` | `"http://127.0.0.1:8000/v1/systemone"` | 该本地 laya-serve 端点 |

后七行即 System One 决策层（见下节），全部是可选开关——默认安装下插件不会发出任何一次对外决策请求。

以上字段全部声明为 **volatile**（dsh 0.1.7 settings 契约）：十二个键都会出现在插件设置页（entry `dsh-mcp-adapter`）中，在设置页修改**无需重启插件即可生效**——折叠边界、目录与分发在下一次使用时立即采用新值；`jev*` 开关同样每次使用时现读，在设置页打开 `jevEnabled` 后，下一次分发立即生效。（唯一例外是 `storageDir`：存储位置本身在插件启动时读一次，如其表行所述。）profile patch 里的 `config:` 写法照旧可用。

```yaml
config:
  keep:
    - mcp__fs__read_file
    - mcp__github__*
  servers:
    - fs
    - github
```

**信任边界：** 默认所有匹配 `prefix` 的工具都会被折叠——前缀只是命名约定而非安全边界，第三方插件恰好用 `mcp__*` 注册的工具同样会折叠。若只信任官方 client 的 server，请在 `servers` 里显式列出；其余保持原生（仍可直调，只是不走 meta-tool）。

## 自我进化（System One 决策层）

一个**默认关闭**的可选决策层：`jevEnabled: false` 时插件任何地方都不发对外决策请求，行为与接入前完全一致。打开后只发生三件事，且三件都是建议性的。

**调用统计（常开，永不走网络）。** 每一次走完的 `mcp_call` 分发（成功与失败都算）按工具计数（`calls`、`errors`、首次/最近使用时间），落进插件自有门闩目录里与 `gate.json` 并排的 `usage.json`。统计与 `jevEnabled` 无关——事后打开开关，此前攒下的计数直接复用。

**keep 建议（自我进化的部分）。** 每累计 20 次调用（越过 20、40、60……）触发一次后台批量提问：问决策后端，当前**处于折叠态**、且确实被调用过的工具里，哪些值得常驻每一条 prompt（省掉每次都要查目录、展开 schema 的成本）。触发它的那次分发早就返回了，这些活没人 await。答案写入 `suggestions.json`；这一轮失败则原样保留上一批。

**查看。** `/mcp suggest` 渲染当前这批建议——每行给出概率、档位、支撑它的调用证据，以及该行对应的 `keep` 片段——外加已记录的总量。视图自己会写明：`display only — nothing was written to keep, prefix, or the server gate.` 片段由你亲手粘进配置；**本插件永不修改你的配置**，任何一条决策路径都不会自行写入 `keep`、`prefix` 或门闩。

同一个后端，除了被计数器调用，也服务模型侧的两处检索：

- `mcp_list { "query": "<你想做什么>" }` — 是一个**子集**视图：先做一遍词法预筛（对工具名与描述，确定性、无网络），再对该批候选做可选重排。答案会说明总共命中多少个工具，并指回未过滤的完整目录；无参 `mcp_list` 依然是完整目录，而不带 query 的调用根本不会发起决策请求。
- `mcp_call` 打到未注册的工具名 — 报错保留原句，末尾追加 `Did you mean: "…"?` 建议：先按词法近似排序（编辑距离优先，其次共享的名字 token），可选再重排。末尾始终标注排序来源（`lexical` 或 `jev reranked`），没排过序的猜测不会被当成排过序的。

**故障放行（fail-open）：** 后端不可达、超时或给不出可用答案，与开关关闭不可区分——每条决策路径都退回它原本的词法行为；建议那一轮失败，代价仅是这一批没有更新。

**隐私：** 计数、建议与决策日志（`decisions.jsonl`）都不出本机——它们是门闩目录里的三个文件。打开 `jevEnabled` 后，工具名、其描述的前 200 字、调用计数以及模型自己的 query 文本**会**作为问题上下文发给决策后端；每个出站请求体都会先过内置密钥闸（JWT、各家 provider key、GitHub/Slack/AWS 令牌、PEM 块，外加你在 `jevSecretFile` 里列的字面量），命中即在出进程前中止这次调用。发往哪里由 `jevBackend` 决定：`zen`（opencode-zen 免费档，默认）、`native`（typesafe 直连）或 `openrouter`。本地 laya 陪跑（`jevLayaFallback`）默认关闭。

### 别把本地 laya 当后端——暂时不建议（实测针对 laya 0.3.20）

**`jevLayaFallback` 保持关闭。** 用真实 MCP 工具目录、经 `jevAskDual` 并行与免费档 `zen` 头对头，在本插件自己的三条缝上实测：

| 缝 | zen（免费档） | laya 0.3.20 | 纯词法 |
| --- | --- | --- | --- |
| keep 建议（12 工具批量 noul） | AUC **1.000**——高频 0.71 / 边界 0.48 / 该折叠 0.11 | AUC **0.333**，比随机还差：概率全挤在 51–55% | — |
| `mcp_list {query}` 排序（10 问） | **8/10** | 4/10——把 `read_file` 排到 SQL `query` 之下 | 6/10 |
| did-you-mean 重排（6 错拼） | 5/6 | 4/6 | 5/6 |
| 中文 query 语义兜底（5 问） | **5/5** | 1/5——不管问什么都锚在同一个工具上 | 0（词法零命中） |

laya 快约 8–10 倍（70 毫秒–1 秒 vs 0.6–6 秒），但判别力差得不是一点：它读不出 keep 建议**赖以成立**的调用频次信号——调用 412 次和调用 1 次的工具给回来的置信度一样高；而目录排序缝依赖的跨语言 query 匹配，是它彻底塌掉的地方。laya 自己的运行时也在警告内置 checkpoint 的置信度未校准。

所以陪跑只当降级模式的安全网：主路失败时 laya 的答案**降级**接管——只借相对排序，绝不拿它的绝对分数去撞校准过的档位，那一轮的 keep 建议直接跳过，而不是拿未校准的数字糊弄你。两边的判定行照旧都进 `decisions.jsonl`，等于这份对比免费持续跑着。

**何时再看：** 等 laya 出 typed-decisions checkpoint（或某个版本不再只"警告未校准"而是公开校准结果），并且上表被翻转时——届时先拿你自己的目录重测一遍再信。

## 备注

- `mcp_call` 只接受匹配 `prefix` 的工具（配置了 `servers` 时还须在白名单内）——它不可能被用来绕过其它工具自己的 pre-execute 管线。
- 已知边界（waterfall 次序）：若某 listener 注册**早于**本插件、并在自己的 `next()` 之后补插 `mcp__*` schema，该 schema 会逃过折叠——本插件折叠的是它运行时装配结果里的内容。当前上游不存在这样的 listener。
- 目录里的 server 名是启发式提取：前缀后第一段 `__` 分隔段（server 名规范为 `[A-Za-z0-9_-]{1,32}`，不会含字面 `__`，故不会错分组）。
- 与 [ben7am1n/dsh-mcp-proxy](https://github.com/ben7am1n/dsh-mcp-proxy) 可共存（它是 connection-side 代理、自带连接管理，工具名互不冲突）。该项目同样致谢 pi-mcp-adapter；本仓库是独立的 prompt-side 实现：复用官方 client 而不是重造连接层。
- 权衡（与 pi-mcp-adapter 相同）：首次调用多一次发现往返；模型展开过的 schema 会占据后续上下文。

## 命令

本插件在平台 `commands` 服务上注册一条斜杠命令——该依赖是软性的：宿主若没有命令服务，折叠与两个 meta-tool 照常工作（只记一条日志警告，代价是没有 `/mcp`）。`/mcp` 展示状态；v0.2.0 起它同时也是整个 MCP server 进/出适配器的唯一控制面：

| 形态 | 输出 |
|---|---|
| `/mcp` 或 `/mcp list` | 树形总览——每行 server 带 stable `[<id>]` 前缀；disabled 的标 `⏸ disabled` 且不列工具；尾部附折叠健康行 |
| `/mcp list <name>` | `<name>` 匹配某 server → 该 server 全部工具（disabled 的附加 `⏸` 说明行）；匹配完整工具名 → 完整描述 + 完整 input schema |
| `/mcp config` | 当前生效的 `prefix` / `keep` / `servers` / `descriptionLimit` 及各自命中清单，外加持久 enable/disable 台账、七个 `jev*` 设置与已记录的调用统计 |
| `/mcp suggest` | 当前这批 keep 建议：每行给出概率、档位、调用证据与对应的 `keep` 片段，外加已记录总量。只读：不向 `keep`、`prefix` 或门闩写任何东西 |
| `/mcp disable <id>` | 把一个 server 整体闩上：工具强制折叠出 prompt（keep 与 `servers` 豁免一并覆盖）、从 `mcp_list` 目录消失、`mcp_call` 拒绝并给 `/mcp enable <id>` 指引 |
| `/mcp enable <id>` | 用同一个 stable id 复原 |

其余形态一律回复用法说明。`/mcp` 观测到的每个 server 都会分到一个稳定数字 id（1..99，最小空闲优先），持久化到插件自己的门闩文件 `<dsh home>/storages/mcp-adapter/gate.json`（机器态——刻意用文件而非设置页字段）。id 跨重启、跨 re-sync 空窗保持不变，且永不回收——一个 id 永远指同一个 server；99 个用尽时由 `/mcp` 视图明确标注（`id space exhausted (99/99): N server(s) beyond the cap cannot be gated`，受影响的分组行会带标记）。

disable 是**门闩式开关，不是真断连**：官方 client 不提供断连 API，工具仍留在注册表里、连接照常运行——门闩只把它请出 prompt、目录与分发。三层门闩共用同一个判定函数，彼此之间以及与 `/mcp` 的展示永远不会口径不一。enable/disable 经该文件持久化（tmp+rename 原子写；文档损坏时启动告警一次并退化为全启，下一次分配写会自动修复）。若存储位置完全不可写，其余功能照常，只有 toggle 会回一条持久化报错。

一条真实边界：门闩生效在 prompt 侧（目录/分发层）；记得完整工具名的模型仍可能原生直调 `mcp__server__tool` 成功——需要硬性拦截时，请配合管线 guard 或 `tools.restrict()`。

状态是**二态语义**：server 出现在列表里 = 它的工具在本 scope 可见——不可见不代表未启用（可能正在重连退避）；官方 client 不暴露连接状态。健康行形如 `meta-tools: mcp_list/mcp_call live · folding ACTIVE — folded N, kept M · ~X chars of schema out of prompt`（meta-tools 存活且至少折叠一个工具时），否则降级为 fail-open（或无可折叠）提示。X 是被折叠 schema 的 JSON 字符数，刻意标注为字符而非 token。输出超过 400 行会被截断，并提示用 `/mcp list <server>` 收窄。

## 致谢

特别致敬 **[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)** 及其作者 [@nicobailon](https://github.com/nicobailon)：本插件的核心思想——把无界的 MCP 工具面折叠为恒定的 meta-tool、schema 按需展开，从而无论挂多少 server 常驻 prompt 成本都是 O(1)——完全来自该项目；正是它重新定义了 MCP 集成应有的代价。本仓库是这个理念在 DeepSeek Harness 上的移植，机制上刻意走了不同的路线（复用官方连接层的 prompt-side shim），但灵感与理念的功劳归于原作。如果你用的是 pi，请直接用原版。

同样值得提及：[ben7am1n/dsh-mcp-proxy](https://github.com/ben7am1n/dsh-mcp-proxy) 独立验证了 dsh 侧对这类方案的真实需求。

## 开发

```
npm install && npm run check && npm test
```

`@deepseek-ai/*` 类型由 `scripts/link-dsh-closure.mjs` 从全局 dsh 闭包软链解析（`precheck` 自动执行）——它们被刻意排除在 `package.json` 之外，以保证类型图中只存在一份 cordis 实例。完整设计依据与上游参考见 `DESIGN.md`。

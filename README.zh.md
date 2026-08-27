# dsh-mcp-adapter

[English](README.md) | 简体中文

面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的省 token MCP 适配器——一个受 [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) 启发的 **prompt-side shim**（提示词侧垫片）。

## 问题

官方 `@deepseek-ai/dsh-mcp-client` 插件把发现的每个 MCP 工具都原生注册进工具表（`mcp__<server>__<tool>`），于是**每次请求都要为每个 MCP 工具的完整 JSON Schema 付费**——上游 README 原话：*"Data-dependent schema cost is paid on every request while the tools are registered."* 几个 server、几十个工具下来，就是每条消息烧掉数千 token，无论模型是否真的调用它们。

## 思路

本插件完全保留官方 `dsh-mcp-client` 作为连接层（transport、自动重连、`tools/list_changed` 重同步——全是上游现成的），只在提示词装配这一处介入：

- 每个匹配的 `mcp__*` 工具 schema 被**折叠出**装配后的 prompt（`system-prompt/assemble` waterfall）；
- 原位换上两个**恒定 meta-tool**，常驻 prompt 成本对 server/工具数量而言是 O(1)：
  - **`mcp_list`** — 紧凑目录（工具名 + 截断描述，不含 schema）；传 `tool` 按需展开单个工具的完整 schema，传 `server` 过滤，传 `verbose` 全量内联；
  - **`mcp_call`** — 按 `{ tool, arguments }` 把调用分发到仍然注册着的定义上，运行上下文原样透传。

工具本身仍注册在 `ctx.tools` 里，所以 TUI 渲染、`tools.restrict()` 掩蔽照常工作——变的只是 prompt 载荷。折叠后恒定的工具列表也比上游"每次重同步就换代"的模式更利于 KV 前缀缓存。

一个管线细节：按子工具名（`mcp__server__tool`）匹配的 pre-execute / guard / post-execute 阶段不会在折叠调用上触发——注册表只会看到外层的 `mcp_call`。要管控 MCP 使用（审批、策略），请 guard **`mcp_call` 本身**。

图片结果保持原生行为：`mcp_call` 把 `output.render` 委托给被分发的子工具，并以同一个执行对象转发子工具的 `finalizeContent`——带图 MCP 结果仍会投影为持久附件引用，而不是把 base64 内联进上下文。

**故障放行（fail-open）：** 若两个 meta-tool 未成功注册（重名冲突、启动中断），本插件不动装配结果——退回官方全量直通，绝不会让 MCP 工具变得不可发现。

**Code Mode：** 在 `mode: 'code'` 下线上本来就折叠为 `run_code`，本插件天然 no-op。

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

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `prefix` | `"mcp__"` | 要折叠的工具名前缀 |
| `keep` | `[]` | 保持原生进 prompt 的名字模式（`*` 通配）——对应 pi-mcp-adapter 的 direct 模式，适合高频、值得占一等座 schema 的工具 |
| `servers` | `[]` | server 白名单：非空时只有这些 server 的工具会被折叠 / 进目录 / 可分发（三处共用同一份名单） |
| `descriptionLimit` | `200` | `mcp_list` 目录里每条工具描述的最大字符数 |

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

## 备注

- `mcp_call` 只接受匹配 `prefix` 的工具（配置了 `servers` 时还须在白名单内）——它不可能被用来绕过其它工具自己的 pre-execute 管线。
- 已知边界（waterfall 次序）：若某 listener 注册**早于**本插件、并在自己的 `next()` 之后补插 `mcp__*` schema，该 schema 会逃过折叠——本插件折叠的是它运行时装配结果里的内容。当前上游不存在这样的 listener。
- 目录里的 server 名是启发式提取：前缀后第一段 `__` 分隔段（server 名规范为 `[A-Za-z0-9_-]{1,32}`，不会含字面 `__`，故不会错分组）。
- 与 [ben7am1n/dsh-mcp-proxy](https://github.com/ben7am1n/dsh-mcp-proxy) 可共存（它是 connection-side 代理、自带连接管理，工具名互不冲突）。该项目同样致谢 pi-mcp-adapter；本仓库是独立的 prompt-side 实现：复用官方 client 而不是重造连接层。
- 权衡（与 pi-mcp-adapter 相同）：首次调用多一次发现往返；模型展开过的 schema 会占据后续上下文。

## 开发

```
npm install && npm run check && npm test
```

`@deepseek-ai/*` 类型由 `scripts/link-dsh-closure.mjs` 从全局 dsh 闭包软链解析（`precheck` 自动执行）——它们被刻意排除在 `package.json` 之外，以保证类型图中只存在一份 cordis 实例。完整设计依据与上游参考见 `DESIGN.md`。

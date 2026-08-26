# dsh-mcp-adapter 设计文档

> 状态：v0.1.0 设计定稿（2026-08-26）。实现须遵守本文；偏离须在 PR 说明理由。

## 1. 背景与定位

pi-mcp-adapter（nicobailon）的理念：MCP 工具的完整 JSON Schema 不该
**每条请求**都烧 token——无论挂多少 server，prompt 里的常驻工具定义
应该是 O(1) 的，schema 按需展开。

dsh 上游现状（已核实，`~/github/deepseek-harness`）：

- 官方 `@deepseek-ai/dsh-mcp-client` 是「全量发现 → 每工具完整 schema
  原样注册 → 每请求全量直通」。README 原文承认：
  "Data-dependent schema cost is paid on every request while the tools
  are registered"（`packages/mcp/mcp-client/README.md:91`）。
- 上游**没有**任何 MCP 按需加载/裁剪机制；per-tool visibility tiers
  在 code-mode 设计笔记里被明确标为 Deferred（公认未做的扩展点）。
- 但所需基建全部公开可用：
  - `system-prompt/assemble` waterfall（cordis Events 声明合并，
    `packages/core/system-prompt/src/index.ts:18-38`；派发点 :532-535），
    listener 返回值 authoritative，可整体改写 `assembly.tools`。
  - `ctx.tools.get(name, scope?)` / `ctx.tools.schemas(scope?)`
    （`packages/core/tools/src/index.ts:1204/:1234`）。

社区同类（差异化依据）：

- `ben7am1n/dsh-mcp-proxy`：**connection-side proxy** 路线——自带 MCP
  连接管理（懒连接、空闲断连、磁盘目录缓存），两个工具 `mcp_discover`
  / `mcp_call`。重实现，与官方 client 平行的第二套连接层。
- 本插件：**prompt-side shim** 路线——连接层完全复用官方
  dsh-mcp-client（transport、reconnect、list_changed re-sync、错误处理
  全部白嫖上游），只在水装配阶段把 schema 折叠掉。零 MCP SDK 依赖、
  代码量少一个数量级、与官方 client 演进解耦。

两者可共存：dsh-mcp-proxy 管它自己连的 server，本插件管官方 client
注册的 `mcp__*` 工具（工具名不冲突）。

## 2. 核心机制

```
官方 dsh-mcp-client          dsh-mcp-adapter（本插件）
├─ 连接 MCP server           ├─ ctx.on('system-prompt/assemble')
├─ syncTools(): 全量注册  →  │    next() 后改写 result.tools：
│   mcp__<srv>__<tool>       │    - 移除被折叠的 mcp__* schema
├─ reconnect / list_changed  │    - 保留 keep 名单与非 mcp 工具
└─ ctx.tools.register()      └─ 注册两个恒定 meta-tool：
      （照常注册，execute 闭包       mcp_list：目录/按需展开 schema
        保留在 registry 里供分发）    mcp_call：按名分发调用
```

- **省 token**：prompt 里 N 个 MCP 工具 schema → 2 个恒定 meta-tool
  schema。目录（name + 截断 description）只在模型调 `mcp_list` 时进
  上下文，完整 schema 只在模型点名 `tool` 或 `verbose` 时进。
- **KV cache 友好**：折叠后 tools 列表恒定（不随 re-sync 换代变化），
  比官方模式更 prefix-stable。
- **行为不丢失**：工具照常注册（TUI 展示、restrict、guard 不受影响），
  只是 schema 不再进 prompt。

## 3. Meta-tool 契约

### mcp_list

args：`{ tool?: string, server?: string, verbose?: boolean }`

- 无参：返回紧凑目录 `{ servers: [{ server, tools: [{ name, description }] }] }`
  ——name 为注册全名（`mcp__<server>__<tool>`），description 按
  `descriptionLimit`（默认 200）截断，**不含 schema**。
- `tool`（优先级最高）：返回 `{ tool: { name, description, parameters } }`
  完整 schema（按需展开）。
- `server`：按 server 过滤目录。server 名取
  `name.slice(prefix.length).split('__')[0]`（启发式：serverName 规范
  `[A-Za-z0-9_-]{1,32}`，双下划线分段——在 README 记录该启发式）。
- `verbose: true`：目录内联全部 schema（模型明确要求时才付这个 token）。
- 未知 `tool` / 空结果：返回结构化错误信息（不 throw）。

### mcp_call

args：`{ tool: string, arguments?: object }`

- 校验：`tool` 必须匹配 `prefix` **且**能被 `ctx.tools.get(tool)` 解析
  （restricted-away 的工具 get 不到，天然尊重白名单）。**绝不允许**
  通过 mcp_call 调非 mcp 工具——那会绕过子工具自己的 pre-execute 管线。
- 分发：`definition.execute(args.arguments ?? {}, exec)`，`exec` 透传
  meta-tool 自己的 ToolRunContext（signal/abort 语义正确传播）。
  参照 `packages/core/tools/src/index.ts:404-421`（ToolRunContext）与
  `packages/mcp/mcp-client/src/tools.ts:303-361`（官方 execute 闭包消费
  了 exec 的哪些字段——照它的实际消费面透传，别猜）。
- timeout：若 `definition.timeoutMs` 存在，在分发处 race 一个 timer
  （官方闭包内可能已自带 timeout——**实现前先读 tools.ts 确认**，避免
  双重 timeout；若官方已处理则不叠加）。
- 结果：原样返回子工具 execute 的 resolve 值；子工具 reject 则把
  message 包进结构化错误返回（不 throw，让模型可自我纠正）。

### 失败安全（fail-open）

折叠的前提是两个 meta-tool 已成功注册。若任一未注册（如名字冲突），
**不改写 assembly**，退回官方全量直通并 `ctx.logger.warn`——插件坏了
不能让 MCP 工具变得不可发现。

### 与 Code Mode 共存

`mode: 'code'` 下 wire 已折叠为 `run_code`（wireSchemas 过滤，
`packages/core/tools/src/index.ts:994-999`），assembly.tools 里没有
`mcp__*`，本插件自然 no-op。无需特殊处理，README 说明即可。

## 4. 配置（schemastery）

```ts
export interface AdapterConfig {
  /** tool-name prefix to fold */          prefix: string           // default 'mcp__'
  /** patterns kept native ("*" glob) */   keep: string[]           // default []
  /** catalog description truncation */    descriptionLimit: number // default 200
}
```

- config 风格照抄官方 mcp-client（`packages/mcp/mcp-client/src/index.ts`
  的 `z.object({...})` + default 写法，`import z from '@deepseek-ai/schemastery'`）。
- `keep` 匹配：`*` 通配（转成 `.*` 全匹配 regex，锚定首尾），无通配符
  即精确名。keep 里的工具保持原生注册+原生进 prompt（对应
  pi-mcp-adapter 的 direct 模式）。

## 5. 插件形状

- named exports：`export const name = 'mcp-adapter'`、
  `export const inject = ['tools']`、`export const Config = ...`、
  `export function apply(ctx, config)`（照抄官方 mcp-client 的命名空间
  插件形状，`packages/mcp/mcp-client/src/index.ts` 头部）。
- effect-scoped：`ctx.on(...)` 的 disposer 与 `ctx.tools.register(...)` 的
  disposer 都由 cordis scope 自动回收。
- **纯逻辑全部导出为纯函数/类**（同 dsh-ask-router 模式）：折叠判断、
  目录构建、keep 匹配、server 提取——单测直接 import `../lib/index.js`
  测，不 mock cordis。
- waterfall 订阅写法参照真实消费者
  `packages/preset/agent-presets/src/invariant.ts`（grep
  `system-prompt/assemble`）与事件声明处签名
  `(assembly, context, next) => Promise<PromptAssembly>`：
  **先 `await next()`，再改写 `result.tools`，再 return result**。
- 全局（非 scoped）注册 listener，即可收到所有 scope 的 assembly。

## 6. 铁律（违反=返工）

1. `@deepseek-ai/*` **一律不写进 package.json**（连 devDependencies 都
   不写）——由 `scripts/link-dsh-closure.mjs` 软链全局 dsh 闭包提供类型
   （这是 ask-router/官方踩坑定下的契约，见 link 脚本头部注释）。
2. 代码注释、commit message 用英文；文档可中文。
3. 测试用 `node --test`（`test/*.test.mjs`，import `../lib/index.js`），
   不引测试框架、不 mock 框架。
4. 上游仓库（deepseek-harness / dsh-ask-router）**只读**——只抄不改。

## 7. 验收

- `npm install && npm run check && npm test` 全绿。
- 单测至少覆盖：
  - 折叠：mcp__* 被折叠、keep 精确名/glob 命中不折叠、非 mcp 工具不动、
    meta-tool 未注册时 fail-open 不改写、assembly 其余字段
    （sections/contexts/variables）不动。
  - keep 匹配：`*` glob、精确名、不匹配。
  - 目录构建：分组、description 截断、server 过滤、tool 点名展开、
    verbose、未知 tool 报错。
  - mcp_call 校验：非 prefix 工具拒绝、get 不到拒绝、arguments 透传、
    子工具异常包装。
- README：机制说明、配置表、与官方 client/Code Mode/dsh-mcp-proxy 的
  共存关系、token 账（定性，不编数字）。

## 8. 关键上游参考（实现前必读）

| 读什么 | 位置（~/github/deepseek-harness/） |
|---|---|
| waterfall 事件声明与派发 | packages/core/system-prompt/src/index.ts:18-38, 480-540 |
| waterfall 订阅先例 | packages/preset/agent-presets/src/invariant.ts |
| ToolDefinition / ToolRunContext / get / schemas | packages/core/tools/src/index.ts:221-288, 395-425, 1195-1260 |
| 官方 MCP 工具定义（publicName 规范、execute 闭包、output.render） | packages/mcp/mcp-client/src/tools.ts:111-193, 244-361 |
| 插件入口 + config schema 风格 | packages/mcp/mcp-client/src/index.ts:1-160 |
| 模板仓库（scripts/tsconfig/test 风格） | ~/github/dsh-ask-router/ |

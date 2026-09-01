# dsh-mcp-adapter

English | [简体中文](README.zh.md)

Token-efficient MCP adapter for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — a **prompt-side shim** inspired by [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).

**Requires dsh >= 0.1.2-alpha.3** — the plugin targets the 0.1.2-alpha host line only; the rc line is no longer supported.

## The problem

The official `@deepseek-ai/dsh-mcp-client` plugin registers every discovered MCP tool natively (`mcp__<server>__<tool>`), so **every request pays the full JSON Schema of every MCP tool** — the upstream README states this outright: *"Data-dependent schema cost is paid on every request while the tools are registered."* With a handful of servers and dozens of tools, that is thousands of tokens burned per message, whether or not the model ever calls them.

## The approach

This plugin keeps the official `dsh-mcp-client` as the connection layer (transports, reconnect, `tools/list_changed` re-sync — all upstream) and intervenes only at prompt assembly:

- every `mcp__*` tool schema is **folded out** of the assembled prompt (`system-prompt/assemble` waterfall);
- two **constant meta-tools** take their place, so standing prompt cost is O(1) in the number of servers/tools:
  - **`mcp_list`** — compact catalog (tool names + truncated descriptions, no schemas); pass `tool` to expand one tool's full schema on demand, `server` to filter, `verbose` for everything;
  - **`mcp_call`** — dispatch `{ tool, arguments }` to the still-registered definition, passing the run context through.

Tools stay registered in `ctx.tools`, so TUI rendering and `tools.restrict()` masking keep working — only the prompt payload changes. A folded, constant tool list is also friendlier to KV-prefix caching than upstream's per-resync generation swap.

One pipeline nuance: pre-execute / guard / post-execute stages that match by the child tool's name (`mcp__server__tool`) never fire for folded calls — the registry only sees the outer `mcp_call`. To gate MCP usage (approvals, policy), guard **`mcp_call` itself**.

Image results keep their native behavior: `mcp_call` delegates `output.render` to the dispatched child and forwards the child's `finalizeContent` with the exact same run-execution object, so image-bearing MCP results still project to durable attachment references instead of inlining base64 into the context.

**Fail-open:** if the meta-tools are not registered (name collision, partial startup), the adapter leaves the assembly untouched — you fall back to official full passthrough, never to undiscoverable tools.

**Code Mode:** under `mode: 'code'` the wire already collapses to `run_code`; this plugin is a no-op there.

**Load position:** loaded through host composition (the `cordis.patch.yml` `insert` below) the adapter is global — every agent's assemblies are folded. Loaded through an agent-scoped context instead, it applies only to that agent.

## Setup

Keep (or add) your `@deepseek-ai/dsh-mcp-client` lines in `cordis.patch.yml`, then add this plugin next to them:

```yaml
- insert:
    - id: dsh-mcp-adapter
      name: '@aiwayds/dsh-mcp-adapter'
      config: {}
```

Install:

```
dsh plugin --profile <name> add @aiwayds/dsh-mcp-adapter
```

Or directly from git:

```
dsh plugin --profile <name> add github:fan56/dsh-mcp-adapter
```

## Config

| key | default | meaning |
|---|---|---|
| `prefix` | `"mcp__"` | tool-name prefix to fold |
| `keep` | `[]` | name patterns (`*` wildcard) kept native — pi-mcp-adapter's "direct mode", for high-frequency tools that deserve first-class schemas |
| `servers` | `[]` | server-name whitelist: when non-empty, only these servers' tools are folded / cataloged / dispatchable (all three consult the same list) |
| `descriptionLimit` | `200` | max chars per tool description in the `mcp_list` catalog |

```yaml
config:
  keep:
    - mcp__fs__read_file
    - mcp__github__*
  servers:
    - fs
    - github
```

**Trust boundary:** by default every `prefix`-matching tool is folded — the prefix is a naming convention, not a security boundary, so tools registered by third-party plugins that happen to use `mcp__*` names fold too. To trust only the official client's servers, list them explicitly in `servers`; everything else stays native (still callable directly, just outside the meta-tools).

## Notes

- `mcp_call` only accepts `prefix`-matching tools (and, when `servers` is set, whitelisted servers) — it can never be used to bypass another tool's own pre-execute pipeline.
- Known boundary (waterfall order): an assemble listener registered **before** this plugin that adds `mcp__*` schemas after its own `next()` would escape the fold — this plugin folds what the assembled prompt contains when its listener runs. No such listener exists upstream today.
- Server names in the catalog are derived heuristically as the first `__`-delimited segment after the prefix (server names are `[A-Za-z0-9_-]{1,32}`, so a literal `__` inside a server name would mis-group).
- Coexists with [ben7am1n/dsh-mcp-proxy](https://github.com/ben7am1n/dsh-mcp-proxy) (connection-side proxy with its own servers — different, non-colliding tool names). That project credits pi-mcp-adapter as prior art too; this repo is an independent prompt-side take that reuses the official client instead of re-implementing connections.
- Trade-offs (same as pi-mcp-adapter): one extra discovery round-trip before the first call, and expanded schemas still occupy context once the model pulls them in.

## Commands

The plugin registers one slash command on the platform `commands` service — consumed softly, so a host without that service still gets folding and both meta-tools (one log warning instead of `/mcp`). `/mcp` reports status, and since v0.2.0 it is also the control surface for taking a whole MCP server in or out of the adapter:

| Form | Output |
|---|---|
| `/mcp` or `/mcp list` | Tree overview — every server line carries its stable `[<id>]`; disabled ones show `⏸ disabled` and hide their tools; closed by a folding-health footer |
| `/mcp list <name>` | `<name>` matching a server → that server's full tool list (a disabled server adds a `⏸` note); matching a full tool name → full description + complete input schema |
| `/mcp config` | The effective `prefix` / `keep` / `servers` / `descriptionLimit`, each with its hitting tools, plus the persistent enable/disable inventory |
| `/mcp disable <id>` | Latch a whole server off: its tools force-fold out of every prompt — keep and `servers` exemptions included — it disappears from the `mcp_list` catalog, and `mcp_call` refuses it with an `/mcp enable <id>` hint |
| `/mcp enable <id>` | Restore it under the same stable id |

Any other form answers with usage. Every server observed by `/mcp` gets a stable numeric id (`1..99`, smallest free first), persisted in the dsh settings service under the `mcp-adapter:` section of your settings file (`~/.dsh/settings.yaml` on a stock install). Ids survive restarts and re-sync gaps and are never recycled — an id always names the same server; when all 99 are taken the `/mcp` views label it explicitly (`id space exhausted (99/99): N server(s) beyond the cap cannot be gated`, plus a marker on each affected group).

Disable is **gate-style, not a disconnect**: the official client exposes no disconnect API, so tools stay registered and connections keep running — gating only removes them from the prompt, the catalog, and dispatch. All three latches judge through one shared verdict, so they can never disagree with each other or with what `/mcp` displays. Enable/disable persist through the settings service; without one everything still works and only the toggles answer with an explanatory error.

One real boundary: that latch is prompt-side (catalog/dispatch); native direct calls to a remembered `mcp__server__tool` name may still execute — for hard enforcement pair with pipeline guards or `tools.restrict()`.

Status remains **two-state**: a server appears when its tools are visible in your scope — absence does not prove it is disabled (it may be reconnecting); the official client exposes no connection state. The footer reads `meta-tools: mcp_list/mcp_call live · folding ACTIVE — folded N, kept M · ~X chars of schema out of prompt` while the meta-tools are live and at least one tool folds, degrading to a fail-open (or nothing-to-fold) notice otherwise. X counts raw JSON-schema characters, deliberately not tokens. Output beyond 400 lines is truncated with a hint to narrow via `/mcp list <server>`.

## Acknowledgments

With full credit to **[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)** by [@nicobailon](https://github.com/nicobailon): the core idea behind this plugin — collapsing an unbounded MCP tool surface into constant meta-tools whose schemas expand on demand, so the standing prompt cost stays O(1) no matter how many servers you run — is entirely theirs, and it reframed what MCP integration should cost. This repository is our port of that idea to DeepSeek Harness; the prompt-side-shim mechanism differs (by design), but the inspiration and the concept belong to the original. If you are on pi, go use theirs.

Also inspired-by-adjacent: [ben7am1n/dsh-mcp-proxy](https://github.com/ben7am1n/dsh-mcp-proxy) independently validated the same demand for dsh.

## Development

```
npm install && npm run check && npm test
```

`@deepseek-ai/*` types resolve from the global dsh closure via `scripts/link-dsh-closure.mjs` (run automatically by `precheck`) — they are deliberately absent from `package.json` so a single cordis instance exists in the type graph. See `DESIGN.md` for the full design rationale and upstream references.

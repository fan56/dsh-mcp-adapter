# dsh-mcp-adapter

Token-efficient MCP adapter for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — a **prompt-side shim** inspired by [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).

## The problem

The official `@deepseek-ai/dsh-mcp-client` plugin registers every discovered MCP tool natively (`mcp__<server>__<tool>`), so **every request pays the full JSON Schema of every MCP tool** — the upstream README states this outright: *"Data-dependent schema cost is paid on every request while the tools are registered."* With a handful of servers and dozens of tools, that is thousands of tokens burned per message, whether or not the model ever calls them.

## The approach

This plugin keeps the official `dsh-mcp-client` as the connection layer (transports, reconnect, `tools/list_changed` re-sync — all upstream) and intervenes only at prompt assembly:

- every `mcp__*` tool schema is **folded out** of the assembled prompt (`system-prompt/assemble` waterfall);
- two **constant meta-tools** take their place, so standing prompt cost is O(1) in the number of servers/tools:
  - **`mcp_list`** — compact catalog (tool names + truncated descriptions, no schemas); pass `tool` to expand one tool's full schema on demand, `server` to filter, `verbose` for everything;
  - **`mcp_call`** — dispatch `{ tool, arguments }` to the still-registered definition, passing the run context through.

Tools stay registered in `ctx.tools`, so TUI rendering, `tools.restrict()` masking, and guards keep working — only the prompt payload changes. A folded, constant tool list is also friendlier to KV-prefix caching than upstream's per-resync generation swap.

**Fail-open:** if the meta-tools are not registered (name collision, partial startup), the adapter leaves the assembly untouched — you fall back to official full passthrough, never to undiscoverable tools.

**Code Mode:** under `mode: 'code'` the wire already collapses to `run_code`; this plugin is a no-op there.

## Setup

Keep (or add) your `@deepseek-ai/dsh-mcp-client` lines in `cordis.patch.yml`, then add this plugin next to them:

```yaml
- insert:
    - id: dsh-mcp-adapter
      name: '@aiwayds/dsh-mcp-adapter'
      config: {}
```

Install from git while unpublished:

```
dsh plugin --profile <name> add github:fan56/dsh-mcp-adapter
```

## Config

| key | default | meaning |
|---|---|---|
| `prefix` | `"mcp__"` | tool-name prefix to fold |
| `keep` | `[]` | name patterns (`*` wildcard) kept native — pi-mcp-adapter's "direct mode", for high-frequency tools that deserve first-class schemas |
| `descriptionLimit` | `200` | max chars per tool description in the `mcp_list` catalog |

```yaml
config:
  keep:
    - mcp__fs__read_file
    - mcp__github__*
```

## Notes

- `mcp_call` only accepts `prefix`-matching tools — it can never be used to bypass another tool's own pre-execute pipeline.
- Server names in the catalog are derived heuristically as the first `__`-delimited segment after the prefix (server names are `[A-Za-z0-9_-]{1,32}`, so a literal `__` inside a server name would mis-group).
- Coexists with [ben7am1n/dsh-mcp-proxy](https://github.com/ben7am1n/dsh-mcp-proxy) (connection-side proxy with its own servers — different, non-colliding tool names). That project credits pi-mcp-adapter as prior art too; this repo is an independent prompt-side take that reuses the official client instead of re-implementing connections.
- Trade-offs (same as pi-mcp-adapter): one extra discovery round-trip before the first call, and expanded schemas still occupy context once the model pulls them in.

## Development

```
npm install && npm run check && npm test
```

`@deepseek-ai/*` types resolve from the global dsh closure via `scripts/link-dsh-closure.mjs` (run automatically by `precheck`) — they are deliberately absent from `package.json` so a single cordis instance exists in the type graph. See `DESIGN.md` for the full design rationale and upstream references.

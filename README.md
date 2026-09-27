# dsh-mcp-adapter

English | [简体中文](README.zh.md)

Token-efficient MCP adapter for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — a **prompt-side shim** inspired by [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).

**Requires dsh >= 0.1.7-rc.1** — this plugin targets the dsh RC/stable line only (CI and releases resolve the newest of the `latest`/`next` dist-tags at runtime). **The alpha line is no longer supported.**

## The problem

The official `@deepseek-ai/dsh-mcp-client` plugin registers every discovered MCP tool natively (`mcp__<server>__<tool>`), so **every request pays the full JSON Schema of every MCP tool** — the upstream README states this outright: *"Data-dependent schema cost is paid on every request while the tools are registered."* With a handful of servers and dozens of tools, that is thousands of tokens burned per message, whether or not the model ever calls them.

## The approach

This plugin keeps the official `dsh-mcp-client` as the connection layer (transports, reconnect, `tools/list_changed` re-sync — all upstream) and intervenes only at prompt assembly:

- every `mcp__*` tool schema is **folded out** of the assembled prompt (`system-prompt/assemble` waterfall);
- two **constant meta-tools** take their place, so standing prompt cost is O(1) in the number of servers/tools:
  - **`mcp_list`** — compact catalog (tool names + truncated descriptions, no schemas); pass `tool` to expand one tool's full schema on demand, `server` to filter, `query` for a relevance-ranked shortlist, `verbose` for everything;
  - **`mcp_call`** — dispatch `{ tool, arguments }` to the still-registered definition, passing the run context through.

Tools stay registered in `ctx.tools`, so TUI rendering and `tools.restrict()` masking keep working — only the prompt payload changes. A folded, constant tool list is also friendlier to KV-prefix caching than upstream's per-resync generation swap.

One pipeline nuance: pre-execute / guard / post-execute stages that match by the child tool's name (`mcp__server__tool`) never fire for folded calls — the registry only sees the outer `mcp_call`. To gate MCP usage (approvals, policy), guard **`mcp_call` itself**.

Image results keep their native behavior: `mcp_call` delegates `output.render` to the dispatched child and forwards the child's `finalizeContent` with the exact same run-execution object, so image-bearing MCP results still project to durable attachment references instead of inlining base64 into the context.

**Fail-open:** if the meta-tools are not registered (name collision, partial startup), the adapter leaves the assembly untouched — you fall back to official full passthrough, never to undiscoverable tools.

**Code Mode:** under `mode: 'code'` the wire already collapses to `run_code`; this plugin is a no-op there.

**Host resource tools (dsh ≥ 0.1.6):** the host ships `@deepseek-ai/dsh-mcp-resources`, which registers three shared tools — `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` — without the `mcp__` prefix. By design they never enter the fold path and surface to the model natively; the fold/keep semantics are unchanged, and `keep` only ever promotes names that match the prefix, so nothing here is affected.

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

## Uninstall

```
dsh plugin --profile <name> remove @aiwayds/dsh-mcp-adapter
```

The host reconciles the profile automatically: the `dsh.profile.bundles` entry is spliced out and the package's patch layer drops.

One thing deliberately **stays**: the plugin's gate file at `~/.dsh/storages/mcp-adapter/gate.json` (`$DSH_HOME` honors an override) — the stable server ids (`1..99`) and the disabled gates. It is never pruned by design: if you reinstall the plugin, every server keeps the same id it had before.

To purge that state too, delete the `storages/mcp-adapter/` directory yourself; ids will be re-allocated from scratch on reinstall.

Upgrading from a dsh 0.1.5 install: the old `mcp-adapter:` section of `settings.yaml` (which the 0.1.7 host renames to `settings.yaml.imported` after its one-shot import, since the section name does not match this plugin's entry id) is **absorbed once automatically**: on the next plugin boot, if no gate file exists yet, the stable ids and the disabled set are read from `settings.yaml.imported` (fallback: the still-present `settings.yaml`), sanitized and written straight into `gate.json` — no `/mcp disable <id>` re-latching needed. The pass is recorded in `<dsh home>/storages/mcp-adapter/legacy-import.json` (a present marker means it never re-runs; an existing gate.json is left untouched). Your `config:` values in the profile patch carry over unchanged.

## Config

| key | default | meaning |
|---|---|---|
| `prefix` | `"mcp__"` | tool-name prefix to fold |
| `keep` | `[]` | name patterns (`*` wildcard) kept native — pi-mcp-adapter's "direct mode", for high-frequency tools that deserve first-class schemas |
| `servers` | `[]` | server-name whitelist: when non-empty, only these servers' tools are folded / cataloged / dispatchable (all three consult the same list) |
| `descriptionLimit` | `200` | max chars per tool description in the `mcp_list` catalog |
| `storageDir` | `""` | gate storage directory override; empty = `<dsh home>/storages/mcp-adapter` (read once at plugin start — moving it takes effect on restart) |
| `jevEnabled` | `false` | System One master switch — **default off**: false means zero decision calls anywhere, and the usage counters keep recording |
| `jevBackend` | `"zen"` | decision backend: `zen` (free opencode-zen tier) / `native` (typesafe first-party) / `openrouter`; each needs its own API key (`JEV_ZEN_API_KEY` / `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`, or the macOS keychain) |
| `jevModel` | `""` | pinned model id; empty = the backend's own default resolved at call time (`jev-1.13-free` / `jev-1.13.0` / `typesafe/jev-1.13`) — an upgrade is a deliberate act |
| `jevTimeoutMs` | `3000` | per-request timeout in ms; one attempt, no retry — the calling lane's next cadence is the retry |
| `jevSecretFile` | `""` | extra literal secrets for the outbound secret gate (`JEV_SECRET_FILE` semantics); swapping the path reloads the list |
| `jevLayaFallback` | `false` | **default off**: also call a local laya endpoint on every decision request; its answer is logged for comparison and takes over only when the primary backend fails |
| `jevLayaUrl` | `"http://127.0.0.1:8000/v1/systemone"` | that local laya-serve endpoint |

The last seven rows are the System One decision layer ([below](#self-evolution-system-one)); all of them are opt-in, and the default install makes no outbound decision call at all.

Every field is declared **volatile** (the dsh 0.1.7 settings contract): all twelve appear on the plugin's settings page under the `dsh-mcp-adapter` entry, and editing them there applies **without restarting the plugin** — the fold boundary, catalog and dispatch pick the new values up on their very next use, and the `jev*` switches are re-read the same way, so flipping `jevEnabled` in the settings page takes effect on the very next dispatch. (`storageDir` is the one exception: the storage location itself is read once at plugin start, as its row says.) The `config:` block in your profile patch keeps working exactly as before.

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

## Self-evolution (System One)

An optional decision layer, **off by default**: with `jevEnabled: false` the plugin makes no outbound decision call anywhere and behaves exactly as it did before. With it on, three things happen — and all three are advisory.

**Usage accounting (always on, never networked).** Every finished `mcp_call` dispatch, successes and failures alike, is counted per tool (`calls`, `errors`, first/last used) into `usage.json` in the plugin's own gate directory, right beside `gate.json`. This runs regardless of `jevEnabled`, so turning the switch on later reuses everything already counted.

**Keep suggestions (the self-evolving part).** Every 20 recorded calls — crossing 20, 40, 60 … — the plugin asks the decision backend, in **one batched request fired in the background**, which of the currently *folded* tools that were actually called earn a permanent place in every prompt instead of being looked up and expanded on every use. The dispatch that crossed the threshold returns long before any of this runs; nothing awaits it. The answer is written to `suggestions.json`; a failed round leaves the previous batch exactly as it was.

**Viewing them.** `/mcp suggest` renders the current batch — probability, band, the usage evidence behind it, and the `keep` fragment the row would translate to — plus the recorded totals. The view says so itself: `display only — nothing was written to keep, prefix, or the server gate.` You paste the fragment into your own config; **this plugin never edits your configuration**, and no decision path ever writes `keep`, `prefix` or the server gate on its own.

The same backend, asked by the model rather than by the counter, powers the two model-facing searches:

- `mcp_list { "query": "<what you want to do>" }` — a **subset** view: a lexical prefilter over tool names and descriptions first (deterministic, no network), then an optional rerank of that shortlist. The answer says how many tools matched in total and points back at the unfiltered catalog; a no-argument `mcp_list` call is still the full catalog, and a no-query call makes no decision call at all.
- `mcp_call` with an unregistered tool name — the error keeps its original sentence and gains a `Did you mean: "…"?` tail, ordered by a lexical near-miss pass (edit distance first, then shared name tokens) and optionally reranked. The tail always labels where its order came from (`lexical` or `jev reranked`), so an unranked guess never reads like a ranked one.

**Fail-open:** an unreachable, slow or unhelpful backend is indistinguishable from a disabled one — every decision path falls back to the lexical behavior it had before, and a failed suggestion round costs you that round's rows and nothing else.

**Privacy:** the counters, the suggestions and the decision log (`decisions.jsonl`) never leave the machine — they are three files in the gate directory. With `jevEnabled` on, tool names, the leading 200 chars of their descriptions, the usage counts and the model's own query text **do** go out to the decision backend as the question context; every outbound body is scanned by a built-in secret gate (JWT, provider keys, GitHub/Slack/AWS tokens, PEM blocks, plus whatever literals you list in `jevSecretFile`) and a hit aborts the call before anything leaves the process. `jevBackend` decides where: `zen` (the free opencode-zen tier, default), `native` (typesafe first-party) or `openrouter`. The local laya pace-maker (`jevLayaFallback`) is off by default.

### Not the local laya backend — not yet (measured against laya 0.3.20)

**Leave `jevLayaFallback` off.** Measured head-to-head against the free `zen` tier on this plugin's own three seams, with real MCP tool catalogs driven through `jevAskDual` in parallel:

| Seam | zen (free) | laya 0.3.20 | pure lexical |
| --- | --- | --- | --- |
| keep suggestions (12 tools, batched noul) | AUC **1.000** — hot 0.71 / borderline 0.48 / fold 0.11 | AUC **0.333**, worse than chance: every probability lands in 51–55% | — |
| `mcp_list {query}` ranking (10 queries) | **8/10** | 4/10 — ranks `read_file` below a SQL `query` | 6/10 |
| did-you-mean rerank (6 misspellings) | 5/6 | 4/6 | 5/6 |
| Chinese query, semantic fallback (5 queries) | **5/5** | 1/5 — anchors on one tool regardless of the query | 0 (no lexical match) |

laya answers roughly 8–10× faster (70 ms–1 s vs 0.6–6 s), but the discrimination is not close. It cannot read the call-frequency signal the keep suggestion is *about* — a tool called 412 times and one called once come back at the same confidence — and cross-language query matching, which the catalog seam leans on, is where it collapses outright. laya's own runtime warns that the bundled checkpoint's confidence values are uncalibrated.

So the pace-maker stays a degraded-mode safety net only: when the primary backend fails, laya's answer takes over **degraded** — relative order only, never absolute scores against the calibrated bands, and keep suggestions are skipped that round rather than shown with an uncalibrated number. Both sources' verdicts still land in `decisions.jsonl`, which makes the comparison free to run continuously.

**Revisit when** laya ships a typed-decisions checkpoint (or a version whose calibration is published instead of warned about) and this table inverts — then re-measure against your own catalogs before believing it.

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
| `/mcp config` | The effective `prefix` / `keep` / `servers` / `descriptionLimit`, each with its hitting tools, plus the persistent enable/disable inventory, the seven `jev*` settings and the recorded usage counters |
| `/mcp suggest` | The current keep-suggestion batch: per tool a probability, a band, the usage evidence and the exact `keep` fragment, plus the recorded totals. Read-only: it writes nothing to `keep`, `prefix` or the gate |
| `/mcp disable <id>` | Latch a whole server off: its tools force-fold out of every prompt — keep and `servers` exemptions included — it disappears from the `mcp_list` catalog, and `mcp_call` refuses it with an `/mcp enable <id>` hint |
| `/mcp enable <id>` | Restore it under the same stable id |

Any other form answers with usage. Every server observed by `/mcp` gets a stable numeric id (`1..99`, smallest free first), persisted in the plugin's own gate file at `<dsh home>/storages/mcp-adapter/gate.json` (machine state — deliberately a file, not a settings-page field). Ids survive restarts and re-sync gaps and are never recycled — an id always names the same server; when all 99 are taken the `/mcp` views label it explicitly (`id space exhausted (99/99): N server(s) beyond the cap cannot be gated`, plus a marker on each affected group).

Disable is **gate-style, not a disconnect**: the official client exposes no disconnect API, so tools stay registered and connections keep running — gating only removes them from the prompt, the catalog, and dispatch. All three latches judge through one shared verdict, so they can never disagree with each other or with what `/mcp` displays. Enable/disable persist through that file (atomic tmp+rename writes; a corrupt document warns once at startup and degrades to everything-enabled, and the next allocation write heals it). If the storage location cannot be written at all, everything still works and only the toggles answer with a persistence error.

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

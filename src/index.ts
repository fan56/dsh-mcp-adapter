/**
 * dsh-mcp-adapter — prompt-side MCP folding shim for dsh.
 *
 * The official `@deepseek-ai/dsh-mcp-client` registers every discovered MCP
 * tool natively (`mcp__<server>__<tool>`), so every assembled prompt carries
 * the full JSON Schema of every MCP tool. This plugin keeps that client as
 * the connection layer (transport, reconnect, `list_changed` re-sync — all
 * upstream) and intervenes only at prompt assembly:
 *
 * - every prefix-matching tool schema is folded out of the assembled prompt
 *   (`system-prompt/assemble` waterfall), so standing prompt cost is O(1) in
 *   the number of servers and tools, and the tool list stays KV-prefix
 *   stable across server re-syncs. The prefix is a naming convention, not a
 *   trust boundary — third-party tools that happen to use it fold too; set
 *   `servers` to restrict folding (and cataloging/dispatch) to named servers;
 * - two constant meta-tools replace them:
 *   - `mcp_list` — compact catalog grouped by server; `tool` expands one
 *     full schema on demand, `server` filters, `verbose` inlines everything;
 *   - `mcp_call` — dispatches `{ tool, arguments }` to the still-registered
 *     definition, forwarding the run context.
 *
 * Tools stay registered in `ctx.tools`, so TUI rendering and
 * `tools.restrict()` masking keep working — only the prompt payload changes.
 * Pipeline nuance: pre-execute/guard/post-execute stages that match by the
 * child tool's name never fire for folded calls (the registry only sees the
 * outer `mcp_call`) — gate MCP usage by guarding `mcp_call` itself.
 *
 * A read-only `/mcp` slash command (platform `commands` service) surfaces the
 * live state human-side: the server/tool tree, per-server/per-tool details,
 * the effective configuration, and whether folding is active, idle, or in
 * fail-open passthrough. The same command carries the one mutating surface:
 * `/mcp disable <id>` / `/mcp enable <id>` gate a whole server behind all
 * three latches at once — its tools force-fold out of every prompt (keep and
 * `servers` whitelist exemptions included), it disappears from the catalog,
 * and `mcp_call` refuses it with an enable hint. Each server gets a stable
 * numeric id (1..99, smallest free first) persisted in the dsh settings
 * service (`mcp-adapter` namespace), so ids survive restarts and re-syncs.
 *
 * Child-owned projections are preserved: `mcp_call` delegates its
 * `output.render` to the dispatched child and forwards the child's
 * `finalizeContent` with the exact same run-execution object, so
 * image-bearing MCP results still project to durable attachment references
 * instead of inlining base64 into the context.
 *
 * Fail-open: unless BOTH meta-tools resolve (in the assembling scope) to
 * exactly this plugin's definitions, assemblies pass through untouched — a
 * broken adapter must never make MCP tools undiscoverable. Under Code Mode
 * the wire already collapses to `run_code`, so this plugin is a natural no-op.
 *
 * All decision logic is exported as pure functions; the only Cordis calls
 * live in {@link apply}.
 *
 * @module @aiwayds/dsh-mcp-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
// alpha.3 split package: JsonValue no longer re-exports from the dsh-tools
// root (it lives in dsh-util-values now).
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
// Side-effect type imports: declaration-merge the `tools`, `commands` and
// `settings` services onto Context and the `system-prompt/assemble` waterfall
// onto Events.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-commands'
// Type-only import: loads dsh-settings' declaration merging (the `settings`
// service on Context) and the SettingsScope type. dsh-settings
// 0.1.2-alpha.3 removed the settingsNamespace() runtime helper this file
// used to call at module load; register() now brand-checks the plain
// literal below at the type level (SettingsNamespaceInput) and validates
// the same pattern at runtime via parseSettingsNamespace.
import type { SettingsScope } from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-adapter'

/**
 * Services required by this plugin — deliberately just `tools`. The platform
 * `commands` service is consumed SOFTLY at runtime ({@link apply} mounts it
 * via `ctx.inject`): listing it here would refuse to load the whole plugin on
 * hosts that do not compose commands, taking folding down with the command.
 */
export const inject = ['tools']

/** Registered slash-command name (read-only status surface). */
export const MCP_COMMAND_NAME = 'mcp'

/** Max rendered lines of any /mcp output before truncation kicks in. */
export const MCP_OUTPUT_LINE_LIMIT = 400

/**
 * Description cap for TREE views (`/mcp` overview and server listing): keep
 * each tool to one readable line. The configurable `descriptionLimit`
 * remains the ceiling for catalog-shaped data (`mcp_list`, `/mcp config`);
 * full multi-paragraph descriptions belong in `/mcp list <tool>` detail.
 */
export const TREE_DESCRIPTION_LIMIT = 100

/** Registered name of the catalog meta-tool. */
export const MCP_LIST_TOOL_NAME = 'mcp_list'

/** Registered name of the dispatch meta-tool. */
export const MCP_CALL_TOOL_NAME = 'mcp_call'

/** Default catalog description truncation. */
const DEFAULT_DESCRIPTION_LIMIT = 200

/** Default tool-name prefix to fold. */
const DEFAULT_PREFIX = 'mcp__'

/** Valid fold prefix: non-empty, tool-name characters only. */
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// ---- Server enable/disable (pure) ----

/** Upper bound of the stable per-server id space. */
export const MCP_SERVER_ID_LIMIT = 99

/**
 * dsh settings namespace persisting the stable ids and the disabled set.
 * Plain literal: dsh-settings 0.1.2-alpha.3 removed the runtime
 * settingsNamespace() helper this constant used to call (same adaptation as
 * dsh-model-sync / dsh-cron / dsh-vault).
 */
export const MCP_ADAPTER_SETTINGS_NAMESPACE = 'mcp-adapter'

/**
 * The persisted gate state (one settings section). `serverIds` maps every
 * OBSERVED server name to its stable id and is never pruned — enable/disable
 * never recycles an id, so an id always means the same server, even across
 * restarts and temporary re-sync gaps.
 */
export interface ServerIdRegistry {
  /** Observed server name -> stable id (1..99), assigned smallest-free-first. */
  serverIds: Record<string, number>
  /** Ids currently gated off; entries whose mapping exists nowhere are inert. */
  disabled: number[]
}

/**
 * Read-side snapshot of the registry the three latches consult. Structurally
 * a superset of {@link ServerIdRegistry}; everything (config objects included)
 * shaped like this qualifies, so production hands frozen `scope.get()` values
 * straight in.
 */
export interface ServerGateState {
  readonly serverIds: Readonly<Record<string, number>>
  readonly disabled: readonly number[]
}

/** Gate snapshot meaning "nothing observed, nothing disabled". */
export const EMPTY_SERVER_GATE: ServerGateState = { serverIds: {}, disabled: [] }

/** Schema of the persisted `mcp-adapter` settings section. */
export const SERVER_ID_REGISTRY_SCHEMA = z.object({
  serverIds: z.dict(z.number().step(1).min(1).max(MCP_SERVER_ID_LIMIT)).default({}),
  disabled: z.array(z.number().step(1).min(1).max(MCP_SERVER_ID_LIMIT)).default([]),
}) as unknown as z<ServerIdRegistry>

/** Whether one number is an allocatable server id. */
function isValidServerId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= MCP_SERVER_ID_LIMIT
}

/**
 * Coerce any resolved settings value into a trustworthy gate snapshot. The
 * schema already validates at resolve time, but every latch judges from THIS
 * function's output, so corrupt or hand-edited documents degrade to "some
 * entries ignored" instead of wedging folding or dispatch.
 */
export function normalizeServerGate(raw: unknown): ServerGateState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SERVER_GATE
  const rawIds = (raw as { serverIds?: unknown }).serverIds
  const rawDisabled = (raw as { disabled?: unknown }).disabled
  // One id must name exactly one server: on duplicate ids first mapping wins.
  const taken = new Set<number>()
  const serverIds: Record<string, number> = {}
  if (typeof rawIds === 'object' && rawIds !== null && !Array.isArray(rawIds)) {
    for (const [name, id] of Object.entries(rawIds as Record<string, unknown>)) {
      if (name !== '' && isValidServerId(id) && !taken.has(id)) {
        taken.add(id)
        serverIds[name] = id
      }
    }
  }
  const seen = new Set<number>()
  const disabled: number[] = []
  if (Array.isArray(rawDisabled)) {
    for (const entry of rawDisabled) {
      if (isValidServerId(entry) && !seen.has(entry)) {
        seen.add(entry)
        disabled.push(entry)
      }
    }
  }
  return { serverIds, disabled }
}

/**
 * THE shared disabled verdict — all three latches (waterfall fold, catalog,
 * mcp_call dispatch) and every /mcp renderer judge through this one function,
 * so the gating can never disagree with itself. An unmapped server (or an
 * absent snapshot, or the degenerate empty server segment) is ENABLED:
 * gating requires positive evidence, keeping fail-open direction.
 */
export function isServerDisabled(server: string, gate?: ServerGateState): boolean {
  if (gate === undefined || server === '') return false
  const id = gate.serverIds[server]
  return id !== undefined && gate.disabled.includes(id)
}

/** Outcome of {@link allocateMissingServerIds}. */
export interface ServerIdAllocation {
  /** Next registry: a fresh object; inputs are never mutated. */
  registry: ServerIdRegistry
  /** Servers left unassigned because the 1..99 space ran out. */
  unassigned: string[]
  /** Names that received a NEW id in this pass (empty in steady state). */
  added: string[]
}

/**
 * Assign the smallest free id (1..99) to every listed server not yet mapped.
 * Existing mappings are kept verbatim (id stability across restarts); the
 * allocation never mutates its input. Call this whenever /mcp observes the
 * live server set, then persist `{@link ServerIdAllocation.registry}` when
 * `added` is non-empty.
 */
export function allocateMissingServerIds(
  state: ServerGateState | undefined,
  servers: readonly string[],
): ServerIdAllocation {
  const source = normalizeServerGate(state)
  const serverIds: Record<string, number> = { ...source.serverIds }
  // Disabled ids stay burned even when their server vanished from the map
  // (hand-edited documents): a fresh assignment must never inherit a stale
  // disabled flag it did not ask for.
  const used = new Set<number>([...Object.values(serverIds), ...source.disabled])
  const added: string[] = []
  const unassigned: string[] = []
  for (const server of servers) {
    if (server === '' || serverIds[server] !== undefined) continue
    let id = 1
    while (used.has(id)) id += 1
    if (id > MCP_SERVER_ID_LIMIT) {
      unassigned.push(server)
      continue
    }
    used.add(id)
    serverIds[server] = id
    added.push(server)
  }
  return { registry: { serverIds, disabled: [...source.disabled] }, unassigned, added }
}

/** Reverse lookup: which server (if any) carries this id today. */
export function serverNameById(registry: ServerGateState | undefined, id: number): string | undefined {
  if (registry === undefined) return undefined
  for (const [name, mapped] of Object.entries(registry.serverIds)) {
    if (mapped === id) return name
  }
  return undefined
}

/** Outcome of {@link setServerDisabledState}. */
export interface ServerToggleOutcome {
  /** Next registry (fresh object); unchanged content when nothing applied. */
  registry: ServerIdRegistry
  /** Whether the disabled set actually moved. */
  changed: boolean
}

/**
 * Apply one enable/disable toggle for a MAPPED server onto a copy of the
 * registry. Unmapped servers are no-ops (`changed: false`). Enabling never
 * removes the id mapping — re-disabling later reuses the same number.
 */
export function setServerDisabledState(
  state: ServerGateState | undefined,
  server: string,
  disable: boolean,
): ServerToggleOutcome {
  const source = normalizeServerGate(state)
  const id = source.serverIds[server]
  const has = id !== undefined && source.disabled.includes(id)
  // Disable without a mapping (or already disabled) is inert; enable just
  // filters — both keep the id mapping untouched.
  const nextDisabled = disable
    ? id === undefined || has ? [...source.disabled] : [...source.disabled, id].sort((a, b) => a - b)
    : source.disabled.filter(entry => entry !== id)
  return {
    registry: { serverIds: { ...source.serverIds }, disabled: nextDisabled },
    changed: disable ? id !== undefined && !has : has,
  }
}

// ---- Config ----

/** Resolved adapter configuration. */
export interface AdapterConfig {
  /** Tool-name prefix to fold out of assembled prompts. */
  prefix: string
  /** Name patterns ("*" wildcard) kept native in the prompt. */
  keep: string[]
  /**
   * Server-name whitelist. Empty (default) folds every prefix-matching tool —
   * the prefix is then a naming convention, not a trust boundary. Non-empty
   * folds/catalogs/dispatches ONLY tools of the listed servers; fold, catalog
   * and dispatch all consult the same list.
   */
  servers: string[]
  /** Max chars per tool description in the mcp_list catalog. */
  descriptionLimit: number
}

export const Config = z.object({
  prefix: z.string().pattern(PREFIX_PATTERN).default(DEFAULT_PREFIX),
  keep: z.array(String).default([]),
  servers: z.array(String).default([]),
  descriptionLimit: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_DESCRIPTION_LIMIT),
}) as unknown as z<AdapterConfig>

// ---- Keep-pattern matching (pure) ----

/** Compiled keep patterns, keyed by source pattern. */
const keepPatternCache = new Map<string, RegExp>()

/**
 * Compile one keep pattern into an anchored RegExp: `*` matches any run,
 * every other character is literal.
 */
function keepPattern(pattern: string): RegExp {
  let compiled = keepPatternCache.get(pattern)
  if (compiled === undefined) {
    const source = pattern
      .split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    compiled = new RegExp(`^${source}$`)
    keepPatternCache.set(pattern, compiled)
  }
  return compiled
}

/**
 * Whether a tool name matches any keep pattern ("*" wildcard, anchored;
 * a pattern without wildcards is an exact name).
 * @param name - the registered tool name.
 * @param patterns - keep patterns from config.
 * @returns whether the tool stays native in the prompt.
 */
export function matchesKeep(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => keepPattern(pattern).test(name))
}

/**
 * Whether the server segment of one prefix-matching tool name passes the
 * optional servers whitelist. An empty list admits every server (the prefix
 * is a naming convention, not a trust boundary); a non-empty list admits
 * only the named servers.
 * @param name - the registered tool name.
 * @param prefix - the configured MCP prefix.
 * @param servers - server-name whitelist from config.
 * @returns whether the tool's server is admitted.
 */
export function isAllowedServer(name: string, prefix: string, servers: readonly string[]): boolean {
  if (servers.length === 0) return true
  return servers.includes(serverOfToolName(name, prefix))
}

/**
 * Whether one tool's schema should be folded out of the prompt: it must
 * carry the configured prefix, belong to a whitelisted server, not match the
 * keep list — and it must never be one of this plugin's own meta-tools,
 * whatever the prefix is configured to (folding them would make every folded
 * MCP tool undiscoverable).
 *
 * Gate override: when the tool's server is DISABLED
 * ({@link isServerDisabled}, shared with catalog/dispatch), its schema folds
 * OUT regardless of keep patterns or the servers whitelist — disablement is
 * strictly stronger than any config exemption.
 * @param name - the registered tool name.
 * @param prefix - tool-name prefix to fold.
 * @param keep - keep patterns from config.
 * @param servers - server-name whitelist from config (default: no filtering).
 * @param gate - live disabled-server snapshot (default/undefined: none).
 * @returns whether the schema leaves the prompt (the tool stays callable).
 */
export function shouldFold(
  name: string,
  prefix: string,
  keep: readonly string[],
  servers: readonly string[] = [],
  gate?: ServerGateState,
): boolean {
  if (name === MCP_LIST_TOOL_NAME || name === MCP_CALL_TOOL_NAME) return false
  if (prefix === '' || !name.startsWith(prefix)) return false
  if (isServerDisabled(serverOfToolName(name, prefix), gate)) return true
  return !matchesKeep(name, keep) && isAllowedServer(name, prefix, servers)
}

// ---- Assembly folding (pure) ----

/** Folding knobs resolved from config. */
export interface FoldOptions {
  /** Tool-name prefix to fold. */
  prefix: string
  /** Name patterns kept native. */
  keep: readonly string[]
  /** Server-name whitelist; empty or omitted admits every server. */
  servers?: readonly string[]
}

/**
 * Structural subset of `PromptAssembly` the folding operates on, so tests
 * can drive it without importing prompt-assembly types.
 */
export interface AssemblyWithTools {
  sections: unknown[]
  contexts: unknown[]
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}

/**
 * Rewrite one assembled prompt: drop the schemas of foldable tools, keep
 * everything else (sections, contexts, variables, non-MCP tools, meta-tools)
 * untouched.
 *
 * Fail-open contract: with `metaToolsLive` false the assembly object is
 * returned AS-IS (same reference) — folding is only safe while the model can
 * still discover MCP tools through the meta-tools.
 *
 * @param assembly - the post-waterfall assembly.
 * @param options - folding knobs.
 * @param metaToolsLive - whether both meta-tools currently resolve to this
 *   plugin's own definitions in the assembling scope.
 * @param gate - live disabled-server snapshot, fresh per assembly (default:
 *   none disabled).
 * @returns the folded assembly, or the input unchanged when nothing folds.
 */
export function foldPromptAssembly<T extends AssemblyWithTools>(
  assembly: T,
  options: FoldOptions,
  metaToolsLive: boolean,
  gate?: ServerGateState,
): T {
  if (!metaToolsLive) return assembly
  const servers = options.servers ?? []
  const tools = assembly.tools.filter(
    tool => !shouldFold(tool.name, options.prefix, options.keep, servers, gate),
  )
  if (tools.length === assembly.tools.length) return assembly
  return { ...assembly, tools }
}

// ---- Catalog (mcp_list, pure) ----

/** Options for the catalog builder. */
export interface McpListOptions {
  /** Tool-name prefix identifying MCP tools. */
  prefix: string
  /** Max chars per tool description in the catalog. */
  descriptionLimit: number
  /** Server-name whitelist; empty or omitted admits every server. */
  servers?: readonly string[]
  /**
   * Live gate reader (production: fresh `settingsScope.get()` snapshot per
   * execution). A callback, not a value: the factory is built once at apply
   * time and must observe later /mcp disable/enable writes.
   */
  getGate?: () => ServerGateState | undefined
}

/** Normalized `mcp_list` arguments. */
export interface McpListArgs {
  /** Expand this tool's full schema (highest priority when set). */
  tool?: string
  /** Filter the catalog to one server. */
  server?: string
  /** Inline every tool's schema in the catalog. */
  verbose?: boolean
}

/** One catalog entry; `parameters` is present only when expanded. */
export interface CatalogToolEntry {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** One server group in the compact catalog. */
export interface CatalogServerEntry {
  server: string
  tools: CatalogToolEntry[]
}

/** `mcp_list`'s canonical result: catalog, single expansion, or error. */
export type McpListResult =
  | { servers: CatalogServerEntry[] }
  | { tool: { name: string; description: string; parameters: Record<string, unknown> } }
  | { error: string }

/**
 * Narrow arbitrary model arguments to the `mcp_list` shape, dropping
 * unknown or mistyped keys instead of throwing (the model misbehaves).
 * @param args - raw model arguments.
 * @returns the normalized catalog query.
 */
export function normalizeMcpListArgs(args: unknown): McpListArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {}
  const raw = args as Record<string, unknown>
  return {
    ...typeof raw.tool === 'string' ? { tool: raw.tool } : {},
    ...typeof raw.server === 'string' ? { server: raw.server } : {},
    ...raw.verbose === true ? { verbose: true } : {},
  }
}

/**
 * Derive the server segment of a registered MCP tool name: the first
 * `__`-delimited segment after the prefix. Heuristic, not a parse: server
 * names are constrained to `[A-Za-z0-9_-]{1,32}` by the official client, so
 * a literal `__` inside a server name (impossible there) would mis-group.
 * @param name - the registered tool name.
 * @param prefix - the configured MCP prefix.
 * @returns the server segment ('' for degenerate names).
 */
export function serverOfToolName(name: string, prefix: string): string {
  return name.slice(prefix.length).split('__')[0]
}

/**
 * Truncate one description to the catalog limit, marking the cut with an
 * ellipsis character (so one char of headroom is reserved). A cut that would
 * land on the LOW half of a surrogate pair backs off one code unit so no
 * orphaned high surrogate is emitted. Whitespace runs (newlines, indents)
 * are collapsed to single spaces FIRST — MCP vendors routinely ship
 * multi-paragraph usage guides as descriptions and catalog lines must stay
 * single-line.
 * @param text - the full tool description.
 * @param limit - max chars in the catalog.
 * @returns the single-line truncated description.
 */
export function truncateDescription(text: string, limit: number): string {
  // Collapse whitespace runs FIRST: MCP vendors routinely ship multi-paragraph
  // usage guides as descriptions, and catalog lines must stay single-line.
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= limit) return flat
  let end = Math.max(0, limit - 1)
  // slice(0, end) excludes text[end]: when that first excluded code unit is
  // a low surrogate, the last included one is its now-orphaned high half.
  const cut = flat.charCodeAt(end)
  if (cut >= 0xDC00 && cut <= 0xDFFF && end > 0) end -= 1
  return `${flat.slice(0, end)}…`
}

/**
 * Build the `mcp_list` result over the currently visible schemas.
 *
 * Priority: `tool` (full single-tool expansion) > catalog (optionally
 * filtered by `server`, optionally `verbose`). Unknown or non-MCP `tool`,
 * and any query that selects nothing, return a structured error — never a
 * throw — so the model can correct itself.
 *
 * @param args - the normalized catalog query.
 * @param schemas - schemas visible to the calling agent.
 * @param options - catalog knobs.
 * @param gate - live disabled-server snapshot (default: none disabled).
 * @returns the canonical result value.
 */
export function buildMcpListResult(
  args: McpListArgs,
  schemas: readonly ToolSchema[],
  options: McpListOptions,
  gate?: ServerGateState,
): McpListResult {
  const { prefix, descriptionLimit } = options
  const servers = options.servers ?? []
  if (args.tool !== undefined) {
    // The meta-tools are visible schemas like any other and can match a
    // pathological prefix (e.g. "mcp_") — never expand them; they are this
    // adapter's own surface, not MCP tools.
    if (args.tool === MCP_LIST_TOOL_NAME || args.tool === MCP_CALL_TOOL_NAME) {
      return { error: `refusing to expand "${args.tool}": meta-tools are not expandable through ${MCP_LIST_TOOL_NAME}` }
    }
    if (!args.tool.startsWith(prefix)) {
      return { error: `"${args.tool}" is not an MCP tool (expected the "${prefix}" prefix) — call ${MCP_LIST_TOOL_NAME} without arguments for the catalog` }
    }
    if (!isAllowedServer(args.tool, prefix, servers)) {
      return { error: `"${args.tool}" belongs to server "${serverOfToolName(args.tool, prefix)}", which is not in the configured servers list` }
    }
    const gatedServer = serverOfToolName(args.tool, prefix)
    if (isServerDisabled(gatedServer, gate)) {
      const id = gate?.serverIds[gatedServer]
      return { error: `refusing to expand "${args.tool}": server "${gatedServer}" is disabled — it can be restored with "/mcp enable ${String(id)}"` }
    }
    const schema = schemas.find(candidate => candidate.name === args.tool)
    if (schema === undefined) {
      return { error: `unknown MCP tool "${args.tool}" — the server may have re-synced; call ${MCP_LIST_TOOL_NAME} to refresh` }
    }
    // On-demand expansion: the FULL description and schema, not truncated.
    return { tool: { name: schema.name, description: schema.description, parameters: schema.parameters } }
  }
  const serversOut: CatalogServerEntry[] = []
  // Servers that passed prefix/whitelist checks but were hidden by the gate.
  const gatedAway: string[] = []
  for (const schema of schemas) {
    // Never catalog the meta-tools themselves, even under a prefix that
    // matches their names.
    if (schema.name === MCP_LIST_TOOL_NAME || schema.name === MCP_CALL_TOOL_NAME) continue
    if (!schema.name.startsWith(prefix)) continue
    if (!isAllowedServer(schema.name, prefix, servers)) continue
    const server = serverOfToolName(schema.name, prefix)
    // Disabled servers vanish from the directory entirely; point-name
    // expansion above remains the structured way to learn why.
    if (isServerDisabled(server, gate)) {
      if (!gatedAway.includes(server)) gatedAway.push(server)
      continue
    }
    if (args.server !== undefined && server !== args.server) continue
    let group = serversOut.find(entry => entry.server === server)
    if (group === undefined) {
      group = { server, tools: [] }
      serversOut.push(group)
    }
    group.tools.push({
      name: schema.name,
      description: truncateDescription(schema.description, descriptionLimit),
      ...args.verbose === true ? { parameters: schema.parameters } : {},
    })
  }
  if (serversOut.length === 0) {
    if (args.server !== undefined && isServerDisabled(args.server, gate)) {
      const id = gate?.serverIds[args.server]
      return { error: `server "${args.server}" is disabled and hidden from the catalog — restore it with "/mcp enable ${String(id)}"` }
    }
    // An unfiltered catalog that found prefix tools but lost ALL of them to
    // the gate must not claim "nothing is registered" (same facts as the
    // filtered path above): name each hidden server with its restore hint.
    if (args.server === undefined && gatedAway.length > 0) {
      const named = gatedAway.map(name =>
        `"${name}" ("/mcp enable ${String(gate?.serverIds[name])}")`).join(', ')
      return { error: `every MCP tool under the "${prefix}" prefix belongs to a disabled server and is hidden from the catalog: ${named}` }
    }
    return args.server === undefined
      ? { error: `no MCP tools are registered under the "${prefix}" prefix` }
      : { error: `no MCP tools match server "${args.server}"` }
  }
  return { servers: serversOut }
}

// ---- Dispatch (mcp_call, pure) ----

/** Structural slice of a resolvable tool: what dispatch actually consumes. */
export interface DispatchableTool<E> {
  /** Cooperative timeout budget declared by the tool, if any. */
  readonly timeoutMs?: number
  /** The tool body dispatch invokes. */
  execute(args: unknown, exec: E): Promise<unknown>
}

/**
 * Dispatch one `mcp_call` to the resolved child tool.
 *
 * Validation: `tool` must be a non-empty string matching the configured
 * prefix, must not name a meta-tool, must belong to a whitelisted server
 * (when `servers` is non-empty), and must resolve through `resolve`
 * (scope-aware — a restricted-away tool does not resolve, so whitelists are
 * respected naturally). Non-MCP tools are REFUSED outright: dispatching them
 * here would bypass their own pre-execute pipeline (guards, approvals).
 *
 * Execution: `definition.execute(args.arguments ?? {}, exec)` with the
 * meta-tool's own run context passed through verbatim — the official MCP
 * executor consumes `exec.signal` (per-request abort) and `exec.agent`
 * (model-route resolution for image admission), both carried by that same
 * context object.
 *
 * Timeout: no timer is raced for the official mcp-client tools — their
 * executor already self-times every MCP request (`tools/call` is sent with
 * `timeout: toolCallTimeoutMs`, verified in the upstream bridge source), and
 * they never declare `timeoutMs`. Only a definition that DECLARED
 * `timeoutMs` gets a raced deadline, because calling `definition.execute()`
 * directly bypasses the registry's timeout policy wrapper.
 *
 * Errors never throw out of dispatch: a child rejection (or raced timeout)
 * is wrapped into a structured `{ error }` the model can correct and retry.
 *
 * @param args - raw model arguments (`{ tool, arguments? }`, validated here).
 * @param prefix - the configured MCP prefix.
 * @param resolve - scope-aware tool resolver (production: `ctx.tools.get`).
 * @param exec - the meta-tool's run context, forwarded to the child.
 * @param servers - server-name whitelist (default: no filtering).
 * @param gate - live disabled-server snapshot (default: none disabled). The
 *   disabled branch sits after the prefix/whitelist validation: a disabled
 *   server's tools are refused with an explicit `/mcp enable <id>` hint
 *   before the child is ever resolved.
 * @returns the child's resolved value verbatim, or a structured error.
 */
export async function dispatchMcpCall<E>(
  args: unknown,
  prefix: string,
  resolve: (name: string) => DispatchableTool<E> | undefined,
  exec: E,
  servers: readonly string[] = [],
  gate?: ServerGateState,
): Promise<unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { error: `${MCP_CALL_TOOL_NAME} expects an object { "tool": string, "arguments"?: object }` }
  }
  const raw = args as Record<string, unknown>
  const tool = raw.tool
  if (typeof tool !== 'string' || tool === '') {
    return { error: `${MCP_CALL_TOOL_NAME} requires a string "tool" — discover names with ${MCP_LIST_TOOL_NAME}` }
  }
  if (!tool.startsWith(prefix)) {
    return { error: `refusing to call "${tool}": ${MCP_CALL_TOOL_NAME} dispatches only tools named with the "${prefix}" prefix` }
  }
  if (tool === MCP_LIST_TOOL_NAME || tool === MCP_CALL_TOOL_NAME) {
    return { error: `refusing to call "${tool}": meta-tools are not dispatchable through ${MCP_CALL_TOOL_NAME}` }
  }
  if (!isAllowedServer(tool, prefix, servers)) {
    return { error: `refusing to call "${tool}": server "${serverOfToolName(tool, prefix)}" is not in the configured servers list` }
  }
  const gatedServer = serverOfToolName(tool, prefix)
  if (isServerDisabled(gatedServer, gate)) {
    const id = gate?.serverIds[gatedServer]
    return { error: `refusing to call "${tool}": server "${gatedServer}" is disabled — ask the operator to run "/mcp enable ${String(id)}" to restore it` }
  }
  const definition = resolve(tool)
  if (definition === undefined) {
    return { error: `tool "${tool}" is not registered or not visible in this scope — call ${MCP_LIST_TOOL_NAME} to see the catalog` }
  }
  try {
    // `?? {}` lets a missing/null arguments object reach the server, which
    // then produces its own "missing required param" error to learn from.
    const toolArgs = raw.arguments ?? {}
    if (definition.timeoutMs === undefined) {
      return await definition.execute(toolArgs, exec)
    }
    return await raceToolTimeout(definition, definition.timeoutMs, toolArgs, exec)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: `MCP tool "${tool}" failed: ${message}` }
  }
}

/** Race one declared-timeout tool body against its own budget. */
async function raceToolTimeout<E>(
  definition: DispatchableTool<E>,
  timeoutMs: number,
  args: unknown,
  exec: E,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      definition.execute(args, exec),
      new Promise<never>((_, reject) => {
        // Cooperative, like the registry's own timeout policy: the losing
        // promise keeps running (same-process code cannot be hard-killed),
        // the caller just stops waiting for it.
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---- /mcp command (pure rendering) ----

/** Knobs shared by every /mcp renderer — plain data, no Cordis. */
export interface McpCommandOptions {
  /** Tool-name prefix identifying MCP tools. */
  prefix: string
  /** Name patterns kept native in the prompt ("*" wildcard). */
  keep: readonly string[]
  /** Server-name whitelist; empty or omitted admits every server. */
  servers?: readonly string[]
  /** Max chars per tool description in rendered listings. */
  descriptionLimit: number
  /**
   * Live-resolved gate snapshot at invocation time (undefined = the settings
   * service is not composed, so ids/toggles are absent from all views and
   * everything renders enabled). A snapshot per invocation keeps these
   * renderers pure and never stale within one command execution.
   */
  gate?: ServerGateState
  /**
   * Live server names left WITHOUT a stable id because the 1..99 space was
   * full when they appeared (production:
   * {@link ServerIdAllocation.unassigned}). Views — not an erroring toggle —
   * surface that fact, since a server without an id cannot be targeted by
   * one in the first place.
   */
  unassignedServers?: readonly string[]
}

/** Usage text returned for unparseable /mcp invocations. */
export const MCP_COMMAND_USAGE = [
  'Usage: /mcp [list [server|tool] | config | disable <id> | enable <id>]',
  '',
  '/mcp               tree of MCP servers and tools, plus folding health',
  '/mcp list          same as /mcp',
  '/mcp list <name>   details for one server (its full tool list), or for one',
  '                   tool: full description + complete input schema (<name> is a',
  '                   server name or a full registered tool name)',
  '/mcp config        effective adapter configuration with per-pattern and',
  '                   per-server tool matches (read-only)',
  '/mcp disable <id>  fold one server\'s tools out of every prompt until it is',
  '                   enabled again (<id> is the stable number shown by "/mcp";',
  '                   keep and servers exemptions included)',
  '/mcp enable <id>   restore a disabled server under the same stable id',
].join('\n')

/** One parsed /mcp invocation. */
export type ParsedMcpCommandInput =
  | { form: 'overview' }
  | { form: 'detail'; name: string }
  | { form: 'config' }
  | { form: 'disable'; id: number }
  | { form: 'enable'; id: number }
  | { form: 'usage' }

/** Parse one positive integer token (`1`..); anything else is undefined. */
function parsePositiveInt(token: string): number | undefined {
  return /^[1-9][0-9]*$/.test(token) ? Number(token) : undefined
}

/**
 * Parse one /mcp raw input into its form. `''` and `'list'` are the tree
 * overview; `'list <name>'` is a server/tool detail; `'config'` shows the
 * effective configuration; `'disable <n>'` / `'enable <n>'` are whole-server
 * toggles (n is the stable id shown by `/mcp`, so a bare `0` or non-numeric
 * token is already usage). Everything else parses to the usage error.
 * @param rawInput - exact text following the command name.
 * @returns the normalized command form.
 */
export function parseMcpCommandInput(rawInput: string): ParsedMcpCommandInput {
  const parts = rawInput.trim().split(/\s+/)
  switch (parts[0]) {
    case '':
      return { form: 'overview' }
    case 'list':
      if (parts.length === 1) return { form: 'overview' }
      if (parts.length === 2) return { form: 'detail', name: parts[1] }
      return { form: 'usage' }
    case 'config':
      return parts.length === 1 ? { form: 'config' } : { form: 'usage' }
    case 'disable':
    case 'enable': {
      const id = parts.length === 2 ? parsePositiveInt(parts[1]) : undefined
      return id === undefined ? { form: 'usage' } : { form: parts[0] as 'disable' | 'enable', id }
    }
    default:
      return { form: 'usage' }
  }
}

/** The visible-schemas candidate set every /mcp view draws from: this view's
 * prefix-matching MCP tools — never the meta-tools themselves, and never
 * tools outside the servers whitelist (consistent with fold/catalog/dispatch).
 */
function mcpCommandCandidates(
  schemas: readonly ToolSchema[],
  options: Pick<McpCommandOptions, 'prefix' | 'servers'>,
): ToolSchema[] {
  const servers = options.servers ?? []
  return schemas.filter(schema =>
    schema.name !== MCP_LIST_TOOL_NAME
    && schema.name !== MCP_CALL_TOOL_NAME
    && schema.name.startsWith(options.prefix)
    && isAllowedServer(schema.name, options.prefix, servers),
  )
}

/**
 * Distinct server names among one view's candidates, in first-seen order —
 * the live set stable ids are allocated against.
 */
export function liveServerNames(
  schemas: readonly ToolSchema[],
  options: Pick<McpCommandOptions, 'prefix' | 'servers'>,
): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const schema of mcpCommandCandidates(schemas, options)) {
    const server = serverOfToolName(schema.name, options.prefix)
    if (server === '' || seen.has(server)) continue
    seen.add(server)
    names.push(server)
  }
  return names
}

/** Three-state folding health of the /mcp overview footer. */
export type McpFoldingHealth =
  | { state: 'folding'; folded: number; kept: number; schemaChars: number }
  | { state: 'fail-open' }
  | { state: 'idle'; matched: number }

/** Which tools count toward which health bucket. */
export interface McpHealthStats {
  /** Prefix-matching tools whose schema was folded out of the prompt. */
  folded: ToolSchema[]
  /**
   * Prefix-matching tools that stay native despite matching the prefix —
   * exempted either by a keep pattern or by the servers whitelist decision.
   */
  kept: ToolSchema[]
}

/**
 * Partition one scope's schemas into folded vs kept MCP tools and measure
 * how many schema characters leave the prompt. Mirrors {@link shouldFold}
 * exactly; the meta-tools themselves are never counted.
 *
 * Health semantics follow the waterfall: folding counts as ACTIVE only when
 * the meta-tools are live AND at least one tool actually folds. Live but
 * nothing to fold is the idle state; not-live is fail-open.
 *
 * @param schemas - schemas visible to the receiving agent.
 * @param options - adapter knobs (prefix/keep/servers) plus the live gate
 *   snapshot (`gate`) when the settings service is composed.
 * @param metaToolsLive - whether both meta-tools resolve to this plugin's
 *   definitions in the receiving agent's scope.
 * @returns the folding health plus the partition behind it.
 */
export function collectMcpHealth(
  schemas: readonly ToolSchema[],
  options: McpCommandOptions,
  metaToolsLive: boolean,
): { stats: McpHealthStats; health: McpFoldingHealth } {
  if (!metaToolsLive) return { stats: { folded: [], kept: [] }, health: { state: 'fail-open' } }
  const servers = options.servers ?? []
  const folded: ToolSchema[] = []
  const kept: ToolSchema[] = []
  let matched = 0
  for (const schema of schemas) {
    if (schema.name === MCP_LIST_TOOL_NAME || schema.name === MCP_CALL_TOOL_NAME) continue
    if (!schema.name.startsWith(options.prefix)) continue
    matched += 1
    if (shouldFold(schema.name, options.prefix, options.keep, servers, options.gate)) folded.push(schema)
    else kept.push(schema)
  }
  if (folded.length === 0) return { stats: { folded, kept }, health: { state: 'idle', matched } }
  // Schema weight removed from the standing prompt: JSON size of every folded
  // tool's parameters object. Chars, deliberately NOT tokens.
  const schemaChars = folded.reduce(
    (sum, schema) => sum + (schema.parameters === undefined ? 0 : JSON.stringify(schema.parameters).length),
    0,
  )
  return { stats: { folded, kept }, health: { state: 'folding', folded: folded.length, kept: kept.length, schemaChars } }
}

/**
 * Render the overview footer line for one health reading. Exactly one of:
 * `meta-tools: ... live · folding ACTIVE — folded N, kept M · ~X chars of
 * schema out of prompt`, the fail-open notice, or the nothing-to-fold notice.
 * @param health - the collected health reading.
 * @returns the single footer line.
 */
export function renderMcpHealthLine(health: McpFoldingHealth): string {
  switch (health.state) {
    case 'folding':
      return `meta-tools: ${MCP_LIST_TOOL_NAME}/${MCP_CALL_TOOL_NAME} live · folding ACTIVE`
        + ` — folded ${health.folded}, kept ${health.kept}`
          + ` · ~${health.schemaChars} chars of schema out of prompt`
    case 'fail-open':
      return 'folding INACTIVE (fail-open) — full schemas are passing through'
    case 'idle':
      return health.matched > 0
        ? `folding INACTIVE (nothing folded) — ${health.matched} matching tool(s) stay native via keep/servers exemptions`
        : `folding INACTIVE (nothing folded) — no MCP tools match the configured prefix`
  }
}

/** One server group in the /mcp views. */
export interface McpServerGroup {
  server: string
  schemas: ToolSchema[]
}

/**
 * Header line of one server group in the tree views. Without a gate snapshot
 * the line is the plain legacy form (`name (n)`); with one, every group is
 * prefixed by its stable id — `[1] fs (4)` — and a DISABLED group renders as
 * `[2] gh ⏸ disabled — hides 3 tool(s)` and lists no tools at all.
 */
export function renderServerGroupHeader(
  group: Pick<McpServerGroup, 'server' | 'schemas'>,
  gate?: ServerGateState,
): string {
  if (gate === undefined) return `${group.server} (${group.schemas.length})`
  const id = gate.serverIds[group.server]
  const label = `[${id === undefined ? '-' : String(id)}] ${group.server}`
  if (isServerDisabled(group.server, gate)) {
    return `${label} ⏸ disabled — hides ${group.schemas.length} tool(s)`
  }
  return `${label} (${group.schemas.length})`
}

/**
 * Group one scope's candidate schemas by server, first-seen order — the same
 * filtering contract as the `mcp_list` catalog loop.
 * @param schemas - schemas visible to the receiving agent.
 * @param options - adapter knobs (prefix/servers).
 * @returns server groups in first-seen order.
 */
export function groupSchemasByServer(
  schemas: readonly ToolSchema[],
  options: Pick<McpCommandOptions, 'prefix' | 'servers'>,
): McpServerGroup[] {
  const groups: McpServerGroup[] = []
  for (const schema of mcpCommandCandidates(schemas, options)) {
    const server = serverOfToolName(schema.name, options.prefix)
    let group = groups.find(entry => entry.server === server)
    if (group === undefined) {
      group = { server, schemas: [] }
      groups.push(group)
    }
    group.schemas.push(schema)
  }
  return groups
}

/**
 * Cap rendered /mcp output so a giant deployment cannot flood the transcript.
 * At most `limit` lines survive; the last becomes a truncation notice naming
 * the narrowing subcommand.
 * @param text - the rendered multi-line output.
 * @param limit - max output lines (default {@link MCP_OUTPUT_LINE_LIMIT}).
 * @returns the capped text (identical when already within the limit).
 */
export function capRenderedLines(text: string, limit: number = MCP_OUTPUT_LINE_LIMIT): string {
  const lines = text.split('\n')
  if (lines.length <= limit) return text
  const dropped = lines.length - limit + 1
  return `${lines.slice(0, limit - 1).join('\n')}\n… output truncated at ${limit} lines (${dropped} dropped) — narrow with "/mcp list <server>"`
}

/**
 * The one-line id-exhaustion notice for /mcp views. `undefined` while the
 * stable id space has room. This is where the 99-cap promise lands: a server
 * beyond the cap never gets an id, so no toggle could ever target it — the
 * views say so explicitly instead of pretending otherwise.
 * @param unassigned - live servers observed without an assignable id.
 * @returns the notice line, or nothing when the space is not exhausted.
 */
export function renderIdCapNotice(unassigned?: readonly string[]): string | undefined {
  if (unassigned === undefined || unassigned.length === 0) return undefined
  return `id space exhausted (${MCP_SERVER_ID_LIMIT}/${MCP_SERVER_ID_LIMIT}): `
    + `${unassigned.length} server(s) beyond the cap cannot be gated`
}

/**
 * Render the `/mcp` / `/mcp list` tree overview: one block per server with
 * each tool's name and truncated description (disabled servers show only a
 * `⏸ disabled` header line — their tools are hidden), closed by the
 * folding-health footer line. Servers beyond the id cap carry a marker on
 * their group header, and full exhaustion appends an explicit notice after
 * the footer. Output is line-capped defensively.
 * @param schemas - schemas visible to the receiving agent.
 * @param options - adapter knobs (prefix/keep/servers/descriptionLimit/gate/
 *   unassignedServers).
 * @param metaToolsLive - whether both meta-tools are live in that scope.
 * @returns the complete overview text.
 */
export function renderMcpOverview(
  schemas: readonly ToolSchema[],
  options: McpCommandOptions,
  metaToolsLive: boolean,
): string {
  const groups = groupSchemasByServer(schemas, options)
  const total = groups.reduce((sum, group) => sum + group.schemas.length, 0)
  const lines = [`MCP servers/tools — ${total} tool(s) across ${groups.length} server(s)`]
  for (const group of groups) {
    const header = renderServerGroupHeader(group, options.gate)
    lines.push('', options.unassignedServers?.includes(group.server)
      ? `${header} — beyond the id cap`
      : header)
    if (isServerDisabled(group.server, options.gate)) continue
    group.schemas.forEach((schema, index) => {
      const connector = index === group.schemas.length - 1 ? '└─' : '├─'
      const description = truncateDescription(schema.description, Math.min(options.descriptionLimit, TREE_DESCRIPTION_LIMIT))
      lines.push(`${connector} ${schema.name}${description === '' ? '' : ` — ${description}`}`)
    })
  }
  lines.push('', renderMcpHealthLine(collectMcpHealth(schemas, options, metaToolsLive).health))
  const idCapNotice = renderIdCapNotice(options.unassignedServers)
  if (idCapNotice !== undefined) lines.push(idCapNotice)
  return capRenderedLines(lines.join('\n'))
}

/** One resolved `/mcp list <name>` target. */
export type McpDetailTarget =
  | { kind: 'server'; server: string; schemas: ToolSchema[] }
  | { kind: 'tool'; schema: ToolSchema }

/**
 * Resolve `<name>` against one scope's candidates: a server segment first
 * (all of its tools), then an exact registered tool name.
 * @param name - server name or full registered tool name.
 * @param schemas - schemas visible to the receiving agent.
 * @param options - adapter knobs (prefix/servers).
 * @returns the resolved target, or undefined when nothing matches.
 */
export function resolveMcpDetailTarget(
  name: string,
  schemas: readonly ToolSchema[],
  options: Pick<McpCommandOptions, 'prefix' | 'servers'>,
): McpDetailTarget | undefined {
  const candidates = mcpCommandCandidates(schemas, options)
  const serverSchemas = candidates.filter(schema => serverOfToolName(schema.name, options.prefix) === name)
  if (serverSchemas.length > 0) return { kind: 'server', server: name, schemas: serverSchemas }
  const exact = candidates.find(schema => schema.name === name)
  return exact === undefined ? undefined : { kind: 'tool', schema: exact }
}

/** Outcome of rendering `/mcp list <name>`; `unknown` maps to an error result. */
export interface McpDetailView {
  outcome: 'server' | 'tool' | 'unknown'
  text: string
}

/**
 * Render `/mcp list <name>`: for a server, its full tool list (names +
 * truncated descriptions); for a single tool, the FULL untruncated
 * description plus the complete input schema. Unknown names produce a
 * descriptive miss rather than generic usage. Human inspection is never
 * gated, but a target belonging to a disabled server says so — with its
 * `/mcp enable <id>` hint.
 * @param name - the requested server or tool name.
 * @param schemas - schemas visible to the receiving agent.
 * @param options - adapter knobs (prefix/keep/servers/descriptionLimit/gate).
 * @returns the rendered view.
 */
export function renderMcpDetail(
  name: string,
  schemas: readonly ToolSchema[],
  options: McpCommandOptions,
): McpDetailView {
  const target = resolveMcpDetailTarget(name, schemas, options)
  if (target === undefined) {
    return {
      outcome: 'unknown',
      text: `no MCP server or tool matches "${name}" in this scope — run "/mcp" for the current tree`,
    }
  }
  if (target.kind === 'server') {
    const lines = [`server "${target.server}" — ${target.schemas.length} tool(s)`]
    if (isServerDisabled(target.server, options.gate)) {
      const id = options.gate?.serverIds[target.server]
      lines.push(`⏸ this server is disabled — its tools are folded out of every prompt; restore with "/mcp enable ${String(id)}"`)
    }
    target.schemas.forEach((schema, index) => {
      const connector = index === target.schemas.length - 1 ? '└─' : '├─'
      const description = truncateDescription(schema.description, Math.min(options.descriptionLimit, TREE_DESCRIPTION_LIMIT))
      lines.push(`${connector} ${schema.name}${description === '' ? '' : ` — ${description}`}`)
    })
    return { outcome: 'server', text: capRenderedLines(lines.join('\n')) }
  }
  const server = serverOfToolName(target.schema.name, options.prefix)
  const parameters = target.schema.parameters === undefined
    ? '(none)'
    : JSON.stringify(target.schema.parameters, null, 2)
  let text = `${target.schema.name} (server: ${server})\n\n${target.schema.description}\n\ninputSchema:\n${parameters}`
  if (isServerDisabled(server, options.gate)) {
    const id = options.gate?.serverIds[server]
    text += `\n\nnote: server "${server}" is disabled — restore it with "/mcp enable ${String(id)}"`
  }
  return { outcome: 'tool', text: capRenderedLines(text) }
}

/**
 * Render the effective configuration with each knob's hitting tools:
 * which names match the prefix, what each keep pattern holds back, and what
 * each whitelisted server contributes. Read-only inventory, no mutations.
 * Tools of disabled servers stay LISTED but carry a `⏸` marker — views
 * inform, they never hide.
 * @param schemas - schemas visible to the receiving agent.
 * @param options - adapter knobs (prefix/keep/servers/descriptionLimit/gate/
 *   unassignedServers).
 * @returns the rendered configuration view.
 */
export function renderMcpConfig(schemas: readonly ToolSchema[], options: McpCommandOptions): string {
  const candidates = mcpCommandCandidates(schemas, options)
  const servers = options.servers ?? []
  // Inventory completeness over gating: mark gate-held tools instead of
  // dropping them (the human inspection surface is never gated).
  const annotateDisabled = (name: string): string =>
    options.gate !== undefined && isServerDisabled(serverOfToolName(name, options.prefix), options.gate)
      ? `${name} ⏸`
      : name
  const lines = [
    `mcp-adapter configuration (read-only)`,
    '',
    `prefix            ${JSON.stringify(options.prefix)} — matches ${candidates.length} tool(s) in this scope`,
    `descriptionLimit  ${options.descriptionLimit}`,
    '',
    `keep patterns (kept native in the prompt): ${options.keep.length}`,
  ]
  if (options.keep.length === 0) {
    lines.push('  (empty — no tool is held back by name)')
  }
  for (const pattern of options.keep) {
    const hits = candidates.filter(schema => matchesKeep(schema.name, [pattern]))
    lines.push(
      `  - ${pattern}`,
      hits.length === 0 ? '      (no matching tools)' : `      matches: ${hits.map(schema => annotateDisabled(schema.name)).join(', ')}`,
    )
  }
  lines.push('', `servers whitelist (fold/catalog/dispatch boundary): ${servers.length}`)
  if (servers.length === 0) {
    lines.push('  (empty — no filtering; every prefix-matching server folds)')
  }
  for (const server of servers) {
    const hits = candidates.filter(schema => serverOfToolName(schema.name, options.prefix) === server)
    lines.push(
      `  - ${server}`,
      hits.length === 0 ? '      (no matching tools)' : `      tools: ${hits.map(schema => annotateDisabled(schema.name)).join(', ')}`,
    )
  }
  // Persistent gate inventory — only meaningful with a live settings-backed
  // snapshot, so absent snapshots keep the legacy output untouched.
  if (options.gate !== undefined) {
    const mapped = Object.entries(options.gate.serverIds).sort((left, right) => left[1] - right[1])
    lines.push('', 'persistent enable/disable (stable ids; survives restarts):')
    if (mapped.length === 0) {
      lines.push('  (no servers observed yet — ids appear the first time "/mcp" sees them)')
    }
    for (const [server, id] of mapped) {
      lines.push(isServerDisabled(server, options.gate)
        ? `  - [${id}] ${server} ⏸ disabled`
        : `  - [${id}] ${server}`)
    }
    const idCapNotice = renderIdCapNotice(options.unassignedServers)
    if (idCapNotice !== undefined) lines.push('', idCapNotice)
  }
  return capRenderedLines(lines.join('\n'))
}

/** Plain-data view one /mcp handler execution reads; production wiring fills
 * it from the receiving agent's scope before calling {@link executeMcpCommand}.
 */
export interface McpCommandView {
  /** Exact text following the command name. */
  rawInput: string
  /** Schemas visible to the receiving agent (`ctx.tools.schemas(scope)`). */
  schemas: readonly ToolSchema[]
  /** Effective adapter knobs plus the invocation-time gate snapshot (`gate`). */
  config: McpCommandOptions
  /** Whether both meta-tools resolve to this plugin's definitions there. */
  metaToolsLive: boolean
  /**
   * Gate snapshot resolved when the invocation started; `undefined` means the
   * dsh settings service is not composed in this process (stable ids and
   * toggles are unavailable; views degrade to enabled-everything).
   */
  gate?: ServerGateState
  /**
   * Persist one complete next registry (production: a wholesale `replace` of
   * the `mcp-adapter` settings section, mirroring agent-default-model's
   * save-selection precedent). Absent ⇒ /mcp disable/enable answers with an
   * explanatory error instead of silently dropping the intent.
   */
  writeGate?: (next: ServerIdRegistry) => Promise<void>
  /**
   * Cancellation signal owned by the dispatching UI request (production:
   * `invocation.signal`). Only the WAIT rides it: an aborted toggle answers
   * immediately that the outcome is unconfirmed while the write still
   * finishes in the background — same-process code cannot hard-kill it.
   */
  signal?: AbortSignal
}

/** CommandResult-compatible outcome (platform shape: success may omit text). */
export interface McpCommandOutcome {
  kind: 'success' | 'error'
  text: string
}

/**
 * Execute one /mcp invocation over plain data. Read forms stay side-effect-
 * free except for stable-id bookkeeping: any form that displays ids ensures
 * every newly observed server has one and persists fresh assignments through
 * `writeGate` (best-effort — a failed persistence still renders, ids merely
 * reallocate identically next time). The mutating forms validate their target
 * against the LIVE server set, then persist one combined write (allocations +
 * toggle); every failure surfaces as a structured `{ kind: 'error', text }`
 * outcome, never a throw.
 *
 * @param view - the invocation's resolved inputs.
 * @returns a platform-shaped command outcome.
 */
export async function executeMcpCommand(view: McpCommandView): Promise<McpCommandOutcome> {
  const parsed = parseMcpCommandInput(view.rawInput)
  const { config } = view

  // Toggle-free fast path: usage needs neither ids nor persistence.
  if (parsed.form === 'usage') return { kind: 'error', text: MCP_COMMAND_USAGE }

  // Stable-id observation point: whatever this invocation can see gets its
  // persistent id now (only when gating is actually wired). Failures keep the
  // local assignment for this render and simply re-run deterministically.
  // Servers that fit no free id travel with the view instead — the views
  // label the exhausted cap, since a toggle cannot target an idless server.
  let effectiveView: McpCommandView = view
  let registry: ServerIdRegistry | undefined
  if (view.gate !== undefined && view.writeGate !== undefined) {
    const allocation = allocateMissingServerIds(view.gate, liveServerNames(view.schemas, config))
    registry = allocation.registry
    if (allocation.added.length > 0) {
      try {
        // The allocation write races the invocation signal like a toggle
        // write: an aborted caller stops waiting while the background write
        // still lands (re-allocation is deterministic anyway).
        await raceWriteAck(view.writeGate(registry), view.signal)
      } catch {
        // Persistence failures must not block a status query.
      }
    }
    effectiveView = {
      ...view,
      config: { ...config, gate: registry, unassignedServers: allocation.unassigned },
    }
  }
  switch (parsed.form) {
    case 'overview':
      return { kind: 'success', text: renderMcpOverview(effectiveView.schemas, effectiveView.config, effectiveView.metaToolsLive) }
    case 'detail': {
      const rendered = renderMcpDetail(parsed.name, effectiveView.schemas, effectiveView.config)
      return { kind: rendered.outcome === 'unknown' ? 'error' : 'success', text: rendered.text }
    }
    case 'config':
      return { kind: 'success', text: renderMcpConfig(effectiveView.schemas, effectiveView.config) }
    case 'disable':
    case 'enable':
      return runServerToggle(parsed.form, parsed.id, registry, effectiveView)
  }
}

/** Sentinel returned by {@link raceWriteAck} when the caller's WAIT was cut
 * short by the invocation signal (the write itself keeps running). */
const WRITE_ABANDONED: unique symbol = Symbol('mcp-adapter.write-abandoned')

/**
 * Await one persistence write, giving up the wait as soon as `signal` aborts.
 * The losing write keeps running in the background — `Promise.race` only
 * cancels the waiting, never the work — and the raced promise is subscribed
 * either way, so a late background failure cannot surface as unhandled.
 */
async function raceWriteAck<T>(
  write: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof WRITE_ABANDONED> {
  if (signal === undefined) return write
  // An already-aborted caller must not see a raced write win the settlement
  // race merely by subscription order: report abandonment outright and keep
  // the background write's failure non-fatal.
  if (signal.aborted) {
    write.catch(() => {})
    return WRITE_ABANDONED
  }
  let onAbort: (() => void) | undefined
  const abandoned = new Promise<typeof WRITE_ABANDONED>(resolve => {
    if (signal.aborted) resolve(WRITE_ABANDONED)
    else {
      onAbort = () => resolve(WRITE_ABANDONED)
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([write, abandoned])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Execute one validated /mcp disable|enable against the ensured registry. */
async function runServerToggle(
  form: 'disable' | 'enable',
  id: number,
  registry: ServerIdRegistry | undefined,
  view: McpCommandView,
): Promise<McpCommandOutcome> {
  const wantDisable = form === 'disable'
  if (registry === undefined || view.writeGate === undefined) {
    return {
      kind: 'error',
      text: `"/mcp ${form}" needs the dsh settings service to persist server state, `
        + 'and it is not composed in this process',
    }
  }
  const liveServers = new Set(liveServerNames(view.schemas, view.config))
  const server = serverNameById(registry, id)
  if (server === undefined || !liveServers.has(server)) {
    const why = server === undefined
      ? `no live MCP server carries id ${id}`
      : `"${server}" carries id ${id} but has no visible tools in this scope right now`
    return { kind: 'error', text: `${why} — run "/mcp" for the assigned ids\n\n${MCP_COMMAND_USAGE}` }
  }
  const toggle = setServerDisabledState(registry, server, wantDisable)
  if (!toggle.changed) {
    return {
      kind: 'success',
      text: wantDisable
        ? `server "${server}" (id ${id}) is already disabled — nothing changed ("/mcp enable ${id}" restores it)`
        : `server "${server}" (id ${id}) is not disabled — nothing changed`,
    }
  }
  try {
    const settled = await raceWriteAck(view.writeGate(toggle.registry), view.signal)
    if (settled === WRITE_ABANDONED) {
      // The signal cut only the WAIT; the write keeps running to completion.
      return {
        kind: 'error',
        text: `"/mcp ${form} ${id}" — persist interrupted before confirming; rerun \`/mcp config\` to check the actual state`,
      }
    }
  } catch (error) {
    return {
      kind: 'error',
      text: `"/mcp ${form} ${id}" could not be persisted: ${error instanceof Error ? error.message : String(error)} — state unchanged`,
    }
  }
  return {
    kind: 'success',
    text: wantDisable
      ? `server "${server}" (id ${id}) disabled — its tools fold out of every prompt until "/mcp enable ${id}"`
      : `server "${server}" (id ${id}) enabled — back to normal folding/catalog/dispatch under the same id`,
  }
}



/**
 * Whether a value is this plugin's structured-error wrap (single `error`
 * string key) — rendered as plain text, never delegated to a child.
 */
function isStructuredError(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null
    && Object.keys(value).length === 1
    && typeof (value as { error?: unknown }).error === 'string'
}

/**
 * Render a canonical meta-tool value as model-facing text: structured
 * errors read best plain, everything else round-trips as pretty JSON.
 */
function renderValue(value: unknown): ContentBlock[] {
  if (isStructuredError(value)) {
    return [{ type: 'text', text: value.error }]
  }
  const text = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: text === undefined ? '(no JSON result)' : text }]
}

/** Parse the child tool name out of one mcp_call argument object. */
function childToolName(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const tool = (args as { tool?: unknown }).tool
  return typeof tool === 'string' && tool !== '' ? tool : undefined
}

/**
 * Extract the arguments payload mcp_call forwards (or would forward) to the
 * child — the exact `?? {}` fallback {@link dispatchMcpCall} applies.
 */
function childArguments(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {}
  return (args as { arguments?: unknown }).arguments ?? {}
}

/**
 * Render one mcp_call outcome by delegating to the dispatched child's own
 * `output.render`, so model-facing text is exactly what a native call of the
 * child would produce. Falls back to the generic JSON rendering whenever the
 * value is this plugin's structured-error wrap, the child cannot be resolved
 * from the arguments, or the child's render throws (the value's shape is the
 * child's contract, not this tool's).
 * @param metaArgs - the frozen mcp_call arguments (`{ tool, arguments? }`).
 * @param value - the dispatched child's resolved value (or an error wrap).
 * @param resolveChild - definition resolver (unscoped view is fine here —
 *   render is a pure display projection).
 * @returns the model-facing content blocks.
 */
export function renderDispatched(
  metaArgs: unknown,
  value: unknown,
  resolveChild: (name: string) => ToolDefinition | undefined,
): ContentBlock[] {
  if (isStructuredError(value)) return renderValue(value)
  const name = childToolName(metaArgs)
  if (name === undefined) return renderValue(value)
  const child = resolveChild(name)
  if (child === undefined) return renderValue(value)
  try {
    return child.output.render(childArguments(metaArgs), value as JsonValue)
  } catch {
    return renderValue(value)
  }
}

/**
 * Forward one successful mcp_call outcome to the dispatched child's own
 * `finalizeContent`, restoring child-owned rich projections (image
 * attachments).
 *
 * Why this is needed: the official mcp-client stages image projections in a
 * `WeakMap<ToolExecution, PreparedProjection>` filled by its executor
 * (`packages/mcp/mcp-client/src/tools.ts:255`, `:354-358`) and hands them
 * back from `finalizeContent` (`:262-270`) — but the registry invokes
 * `finalizeContent` only for the OUTER executed definition
 * (`packages/core/tools/src/index.ts:1649-1654`), which here is `mcp_call`.
 * Without forwarding, the child's projection never runs and image results
 * degrade to their base64-in-text fallback.
 *
 * Mechanics: the child is re-resolved from `metaArgs.tool`; a child-view
 * success result is synthesized with `content` computed by the child's own
 * `output.render` (the same fallback the registry would have produced for a
 * native call, so the child's value/fallback equality guards still pass);
 * and the child's `finalizeContent` is invoked with the EXACT `exec` object
 * dispatch forwarded to `child.execute` — same object identity, so the
 * child's WeakMap lookup hits.
 *
 * Failure paths never project: an `isError` result and this plugin's
 * structured-error wraps return `undefined` immediately; a child without
 * `finalizeContent`, an unresolvable child, or a throwing child callback
 * (the contract demands total callbacks) also degrade to `undefined`, which
 * preserves the registry-computed content.
 *
 * @param metaArgs - the frozen mcp_call arguments (`{ tool, arguments? }`).
 * @param result - the registry-normalized mcp_call outcome.
 * @param exec - the mcp_call execution object that was forwarded verbatim
 *   to the child body — the child's projection WeakMap key.
 * @param resolveChild - scope-aware definition resolver.
 * @returns replacement content from the child's finalizer, or `undefined`
 *   to preserve the registry-computed content.
 */
export function delegateFinalizeContent(
  metaArgs: unknown,
  result: Readonly<ToolExecutionResult>,
  exec: Readonly<ToolExecution>,
  resolveChild: (name: string) => ToolDefinition | undefined,
): ContentBlock[] | undefined {
  try {
    if (result.isError) return undefined
    if (isStructuredError(result.value)) return undefined
    const name = childToolName(metaArgs)
    if (name === undefined) return undefined
    const child = resolveChild(name)
    if (child === undefined || child.finalizeContent === undefined) return undefined
    // The registry renders result.content through mcp_call's output.render,
    // which delegates to this same child render — recompute it here so the
    // child sees the identical fallback a native call would have produced.
    const fallback = child.output.render(childArguments(metaArgs), result.value)
    return child.finalizeContent(exec, { isError: false, value: result.value, content: fallback })
  } catch {
    return undefined
  }
}

/**
 * Build the `mcp_list` meta-tool definition.
 * @param options - catalog knobs (prefix, description limit).
 * @param listSchemas - visible-schemas source (production: `ctx.tools.schemas`,
 *   called with the calling agent so restrictions are respected).
 * @returns the complete tool definition.
 */
export function createMcpListTool(
  options: McpListOptions,
  listSchemas: (scope?: ScopeKey) => readonly ToolSchema[],
): ToolDefinition {
  const { prefix } = options
  return {
    name: MCP_LIST_TOOL_NAME,
    description: [
      'Browse MCP tools registered by the built-in MCP client, without their schemas.',
      `With no arguments: a compact catalog grouped by server — full tool names (like "${prefix}<server>__<tool>") plus short descriptions.`,
      `Pass { "tool": "<full name>" } to expand that tool's complete input schema on demand.`,
      'Pass { "server": "<name>" } to filter the catalog to one server.',
      'Pass { "verbose": true } to inline every tool\'s full schema (expensive — request it only when you actually need many schemas).',
      `Workflow: call ${MCP_LIST_TOOL_NAME} to discover a tool and its schema, then invoke it with ${MCP_CALL_TOOL_NAME}.`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Full registered tool name whose schema to expand' },
        server: { type: 'string', description: 'Only list tools of this server' },
        verbose: { type: 'boolean', description: 'Inline every tool\'s full schema' },
      },
      additionalProperties: false,
    },
    output: {
      // Accepts every canonical result shape: { servers }, { tool }, { error }.
      schema: {
        type: 'object',
        properties: {
          servers: { type: 'array', items: {} },
          tool: {},
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => renderValue(value),
    },
    execute: (args: unknown, exec) => {
      const query = normalizeMcpListArgs(args)
      // The calling agent's view: restricted-away tools stay out of the catalog.
      const schemas = listSchemas(exec.agent)
      return Promise.resolve(buildMcpListResult(query, schemas, options, options.getGate?.()))
    },
  }
}

/**
 * Build the `mcp_call` meta-tool definition.
 * @param prefix - the configured MCP prefix (dispatch boundary).
 * @param resolve - scope-aware definition resolver (production:
 *   `ctx.tools.get`, called with the calling agent).
 * @param servers - server-name whitelist (default: no filtering).
 * @param getGate - live disabled-server reader (production: fresh
 *   `settingsScope.get()` snapshot per dispatch; default/omitted: nothing is
 *   disabled). Deliberately a callback — the definition object outlives any
 *   one settings snapshot and must observe later /mcp enable/disable writes.
 * @returns the complete tool definition.
 */
export function createMcpCallTool(
  prefix: string,
  resolve: (name: string, scope?: ScopeKey) => ToolDefinition | undefined,
  servers: readonly string[] = [],
  getGate?: () => ServerGateState | undefined,
): ToolDefinition {
  return {
    name: MCP_CALL_TOOL_NAME,
    description: [
      `Invoke one MCP tool by its full registered name (like "${prefix}<server>__<tool>").`,
      `First call ${MCP_LIST_TOOL_NAME} to discover tool names and expand the exact input schema,`,
      'then pass { "tool": "<full name>", "arguments": { ... } }.',
      `Only tools named with the "${prefix}" prefix are dispatchable — anything else is refused.`,
      'The result is the invoked tool\'s own return value, or a structured { "error": ... } you can correct and retry.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: `Full registered name (see ${MCP_LIST_TOOL_NAME})` },
        arguments: { type: 'object', description: 'Arguments matching the tool\'s expanded schema' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output: {
      // Permissive on purpose: the canonical value is the child tool's own
      // resolved value (or a structured { error }); its shape is the child's
      // contract, not this tool's. Rendering delegates to the dispatched
      // child's own output.render so text output matches a native call.
      schema: {},
      render: (args: unknown, value: unknown) =>
        renderDispatched(args, value, name => resolve(name)),
    },
    execute: (args: unknown, exec) =>
      dispatchMcpCall(args, prefix, name => resolve(name, exec.agent), exec, servers, getGate?.()),
    // Restore child-owned projections (image attachments): the registry
    // invokes THIS definition's finalizer, so it must forward to the child's
    // with the same exec object dispatch passed to child.execute.
    finalizeContent: (exec, result) =>
      delegateFinalizeContent(exec.arguments, result, exec, name => resolve(name, exec.agent)),
  }
}

// ---- Plugin apply (the only Cordis-touching code) ----

/**
 * Register the two meta-tools and install the assembly folding listener.
 *
 * Failure safety: if either meta-tool registration fails (name collision),
 * both registrations are rolled back, a warning is logged, and NO listener
 * is installed — the official full-schema passthrough stays intact.
 *
 * Server gating: when a dsh settings service is composed, the `mcp-adapter`
 * namespace is registered on it and every gate consumer reads FRESH resolved
 * values through small callbacks — the plugin keeps no in-memory copy that
 * could drift from settings. The read itself is defended too: if the
 * resolved-value lookup throws, consumers see an absent gate (everything
 * enabled) instead of the error, keeping the assemble waterfall alive.
 *
 * Commands: `/mcp` mounts through a runtime `ctx.inject(['commands'], ...)`
 * (same seam as settings), so hosts without the commands service keep this
 * plugin fully functional — one warning, no command. A registration name
 * conflict degrades to the same warning independently.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved adapter configuration.
 */
export function apply(ctx: Context, config: AdapterConfig): void {
  const foldOptions: FoldOptions = {
    prefix: config.prefix,
    keep: config.keep,
    servers: config.servers,
  }
  const listOptions: McpListOptions = {
    prefix: config.prefix,
    descriptionLimit: config.descriptionLimit,
    servers: config.servers,
  }

  // Optional settings consumption (the canonical inject-scoped pattern): the
  // registration rides its own child fiber, so disposing it removes exactly
  // the namespace. Late binding over `settingsScope` means the meta-tools,
  // waterfall, and command created below observe the mount whenever it lands.
  let settingsScope: SettingsScope<ServerIdRegistry> | undefined
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (sctx) => {
      settingsScope = sctx.settings.register(MCP_ADAPTER_SETTINGS_NAMESPACE, SERVER_ID_REGISTRY_SCHEMA)
      return () => { settingsScope = undefined }
    })
  }
  // One-shot latch: a persistently broken settings provider would otherwise
  // re-warn on EVERY assembled prompt (getGate runs per waterfall execution).
  let gateReadWarned = false
  // Fresh snapshot per read; normalize guards hand-edited documents. The
  // scope being absent is distinguishable from an empty section: undefined
  // propagates so toggle commands can name their missing dependency.
  const getGate = (): ServerGateState | undefined => {
    const scope = settingsScope
    if (scope === undefined) return undefined
    try {
      return normalizeServerGate(scope.get())
    } catch (error) {
      // Fail-open, hard requirement: a throwing read must never blow up the
      // system-prompt/assemble waterfall or a /mcp invocation. Gate-less
      // means every server counts as enabled — visibility only ever grows.
      if (!gateReadWarned) {
        gateReadWarned = true
        ctx.logger.warn(
          `mcp-adapter: reading the persisted enable/disable state failed `
          + `(${error instanceof Error ? error.message : String(error)}) `
          + '— treating every server as enabled',
        )
      }
      return undefined
    }
  }
  const writeGate = async (next: ServerIdRegistry): Promise<void> => {
    const scope = settingsScope
    if (scope === undefined) throw new Error('settings service went away before the write')
    // Wholesale replace (not update): we always hold the complete next
    // section, and replace cannot merge stale keys back under us.
    await scope.replace({ serverIds: { ...next.serverIds }, disabled: [...next.disabled] })
  }

  const listDefinition = createMcpListTool(
    { ...listOptions, getGate },
    scope => ctx.tools.schemas(scope),
  )
  const callDefinition = createMcpCallTool(
    config.prefix,
    (name, scope) => ctx.tools.get(name, scope),
    config.servers,
    getGate,
  )

  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.tools.register(listDefinition))
    disposers.push(ctx.tools.register(callDefinition))
  } catch (error) {
    for (const dispose of disposers) dispose()
    ctx.logger.warn(
      `mcp-adapter: meta-tool registration failed (${error instanceof Error ? error.message : String(error)}) `
      + '— keeping the official full-schema prompt passthrough',
    )
    return
  }
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'mcp-adapter.metaTools')

  // Registered on this plugin's (host-level) context, so the listener sees
  // every scope's assemblies — the same pattern as the upstream invariant
  // companion. Listener return values are authoritative: rewrite `tools`
  // AFTER `next()` so the fold observes the fully assembled state.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    // Fail-open per scope: fold only while BOTH meta-tools resolve (in the
    // assembling scope) to exactly this plugin's own definitions — a
    // missing, shadowed, or foreign `mcp_list`/`mcp_call` means passthrough.
    const metaToolsLive = ctx.tools.get(MCP_LIST_TOOL_NAME, context.scope) === listDefinition
      && ctx.tools.get(MCP_CALL_TOOL_NAME, context.scope) === callDefinition
    return foldPromptAssembly(assembled, foldOptions, metaToolsLive, getGate())
  })

  // Status + server toggles on the platform command service (visible in TUI
  // completion and web slash panels). The service is mounted SOFTLY: unlike
  // a static `inject` entry, an absent commands service only costs the
  // command — the meta-tools, waterfall, and gating load regardless.
  if (typeof ctx.inject !== 'function') {
    ctx.logger.warn(
      `mcp-adapter: context cannot inject services — "/${MCP_COMMAND_NAME}" is unavailable; `
      + 'folding and meta-tools keep working',
    )
  } else {
    let mounted = false
    // Deferred so a callback that fires synchronously (services already
    // present) does not trip over the not-yet-assigned handle.
    let mountCheck: ReturnType<typeof setTimeout> | undefined
    ctx.inject(['commands'], (ccmds) => {
      mounted = true
      if (mountCheck !== undefined) clearTimeout(mountCheck)
      try {
        const commandDisposer = ccmds.commands.register({
          name: MCP_COMMAND_NAME,
          description: 'Show MCP status; disable/enable MCP servers',
          input: { hint: '[list [server|tool] | config | disable <id> | enable <id>]' },
          handler: invocation => {
            // The receiving agent's restricted view; an absent agent degrades to
            // the global registry view (`schemas()` without scope).
            const scope = invocation.agent ?? undefined
            const schemas = ctx.tools.schemas(scope)
            const metaToolsLive = ctx.tools.get(MCP_LIST_TOOL_NAME, scope) === listDefinition
              && ctx.tools.get(MCP_CALL_TOOL_NAME, scope) === callDefinition
            // ONE snapshot per execution keeps config.gate and view.gate identical.
            const gate = getGate()
            return executeMcpCommand({
              rawInput: invocation.rawInput,
              schemas,
              config: {
                prefix: config.prefix,
                keep: config.keep,
                servers: config.servers,
                descriptionLimit: config.descriptionLimit,
                gate,
              },
              metaToolsLive,
              gate,
              signal: invocation.signal,
              writeGate,
            })
          },
        })
        // Disposing the injected fiber disposes exactly this registration;
        // if the service restarts, cordis re-runs this callback and a fresh
        // registration takes its place.
        return () => commandDisposer()
      } catch (error) {
        ccmds.logger.warn(
          `mcp-adapter: "/${MCP_COMMAND_NAME}" command registration failed `
          + `(${error instanceof Error ? error.message : String(error)}) — meta-tools keep working`,
        )
      }
    })
    // One heads-up for hosts that genuinely never compose the commands
    // service; cancelled by the mount above whenever it lands.
    mountCheck = setTimeout(() => {
      if (!mounted) {
        ctx.logger.warn(
          `mcp-adapter: no platform commands service — "/${MCP_COMMAND_NAME}" is unavailable; `
          + 'folding and meta-tools keep working',
        )
      }
    }, 0)
  }
}

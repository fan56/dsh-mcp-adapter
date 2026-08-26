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
import type { ToolDefinition, ToolExecution, ToolExecutionResult, JsonValue } from '@deepseek-ai/dsh-tools'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
// Side-effect type imports: declaration-merge the `tools` service onto
// Context and the `system-prompt/assemble` waterfall onto Events.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-adapter'

/** Services required by this plugin. */
export const inject = ['tools']

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
 * @param name - the registered tool name.
 * @param prefix - tool-name prefix to fold.
 * @param keep - keep patterns from config.
 * @param servers - server-name whitelist from config (default: no filtering).
 * @returns whether the schema leaves the prompt (the tool stays callable).
 */
export function shouldFold(
  name: string,
  prefix: string,
  keep: readonly string[],
  servers: readonly string[] = [],
): boolean {
  if (name === MCP_LIST_TOOL_NAME || name === MCP_CALL_TOOL_NAME) return false
  return prefix !== '' && name.startsWith(prefix) && !matchesKeep(name, keep)
    && isAllowedServer(name, prefix, servers)
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
 * @returns the folded assembly, or the input unchanged when nothing folds.
 */
export function foldPromptAssembly<T extends AssemblyWithTools>(
  assembly: T,
  options: FoldOptions,
  metaToolsLive: boolean,
): T {
  if (!metaToolsLive) return assembly
  const servers = options.servers ?? []
  const tools = assembly.tools.filter(
    tool => !shouldFold(tool.name, options.prefix, options.keep, servers),
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
 * orphaned high surrogate is emitted.
 * @param text - the full tool description.
 * @param limit - max chars in the catalog.
 * @returns the truncated description.
 */
export function truncateDescription(text: string, limit: number): string {
  if (text.length <= limit) return text
  let end = Math.max(0, limit - 1)
  // slice(0, end) excludes text[end]: when that first excluded code unit is
  // a low surrogate, the last included one is its now-orphaned high half.
  const cut = text.charCodeAt(end)
  if (cut >= 0xDC00 && cut <= 0xDFFF && end > 0) end -= 1
  return `${text.slice(0, end)}…`
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
 * @returns the canonical result value.
 */
export function buildMcpListResult(
  args: McpListArgs,
  schemas: readonly ToolSchema[],
  options: McpListOptions,
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
    const schema = schemas.find(candidate => candidate.name === args.tool)
    if (schema === undefined) {
      return { error: `unknown MCP tool "${args.tool}" — the server may have re-synced; call ${MCP_LIST_TOOL_NAME} to refresh` }
    }
    // On-demand expansion: the FULL description and schema, not truncated.
    return { tool: { name: schema.name, description: schema.description, parameters: schema.parameters } }
  }
  const serversOut: CatalogServerEntry[] = []
  for (const schema of schemas) {
    // Never catalog the meta-tools themselves, even under a prefix that
    // matches their names.
    if (schema.name === MCP_LIST_TOOL_NAME || schema.name === MCP_CALL_TOOL_NAME) continue
    if (!schema.name.startsWith(prefix)) continue
    if (!isAllowedServer(schema.name, prefix, servers)) continue
    const server = serverOfToolName(schema.name, prefix)
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
 * @returns the child's resolved value verbatim, or a structured error.
 */
export async function dispatchMcpCall<E>(
  args: unknown,
  prefix: string,
  resolve: (name: string) => DispatchableTool<E> | undefined,
  exec: E,
  servers: readonly string[] = [],
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

// ---- Meta-tool definitions (factories; Cordis-free) ----

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
      return Promise.resolve(buildMcpListResult(query, schemas, options))
    },
  }
}

/**
 * Build the `mcp_call` meta-tool definition.
 * @param prefix - the configured MCP prefix (dispatch boundary).
 * @param resolve - scope-aware definition resolver (production:
 *   `ctx.tools.get`, called with the calling agent).
 * @param servers - server-name whitelist (default: no filtering).
 * @returns the complete tool definition.
 */
export function createMcpCallTool(
  prefix: string,
  resolve: (name: string, scope?: ScopeKey) => ToolDefinition | undefined,
  servers: readonly string[] = [],
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
      dispatchMcpCall(args, prefix, name => resolve(name, exec.agent), exec, servers),
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

  const listDefinition = createMcpListTool(listOptions, scope => ctx.tools.schemas(scope))
  const callDefinition = createMcpCallTool(
    config.prefix,
    (name, scope) => ctx.tools.get(name, scope),
    config.servers,
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
    return foldPromptAssembly(assembled, foldOptions, metaToolsLive)
  })
}

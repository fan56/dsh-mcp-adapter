import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MCP_LIST_TOOL_NAME,
  MCP_CALL_TOOL_NAME,
  MCP_COMMAND_NAME,
  MCP_COMMAND_USAGE,
  MCP_OUTPUT_LINE_LIMIT,
  parseMcpCommandInput,
  collectMcpHealth,
  renderMcpHealthLine,
  groupSchemasByServer,
  capRenderedLines,
  renderMcpOverview,
  resolveMcpDetailTarget,
  renderMcpDetail,
  renderMcpConfig,
  executeMcpCommand,
  apply,
} from '../lib/index.js'

const OPTIONS = { prefix: 'mcp__', keep: [], servers: [], descriptionLimit: 200 }

function schema(name, description = '', parameters = { type: 'object', properties: {} }) {
  return { name, description, parameters }
}

function mcpSchemas() {
  return [
    schema('read', 'native tool'),
    schema('mcp__fs__read_file', 'Read a file from disk', {
      type: 'object',
      properties: { path: { type: 'string' } },
    }),
    schema('mcp__gh__create_issue', 'Create an issue on GitHub', {
      type: 'object',
      properties: { title: { type: 'string' } },
    }),
    schema('mcp__fs__write_file', 'Write a file to disk'),
  ]
}

function invocationLike(rawInput, agent = undefined) {
  return { commandId: 'cmd-1', agent, rawInput, attachments: [], signal: new AbortController().signal }
}

// ---- parseMcpCommandInput ----

test('parse: empty and bare-list inputs are the overview form', () => {
  assert.deepEqual(parseMcpCommandInput(''), { form: 'overview' })
  assert.deepEqual(parseMcpCommandInput('   '), { form: 'overview' })
  assert.deepEqual(parseMcpCommandInput('list'), { form: 'overview' })
})

test('parse: one argument after list is a server/tool detail, whitespace-collapsed', () => {
  assert.deepEqual(parseMcpCommandInput('list fs'), { form: 'detail', name: 'fs' })
  assert.deepEqual(parseMcpCommandInput('  list   mcp__fs__read_file  '), { form: 'detail', name: 'mcp__fs__read_file' })
})

test('parse: config is its own form', () => {
  assert.deepEqual(parseMcpCommandInput('config'), { form: 'config' })
})

test('parse: everything else is the usage form', () => {
  assert.deepEqual(parseMcpCommandInput('status'), { form: 'usage' })
  assert.deepEqual(parseMcpCommandInput('list fs extra'), { form: 'usage' })
  assert.deepEqual(parseMcpCommandInput('config now'), { form: 'usage' })
  assert.deepEqual(parseMcpCommandInput('help me'), { form: 'usage' })
})

// ---- collectMcpHealth ----

test('health: live with folds reports folded/kept counts and summed JSON char weight', () => {
  const bigParams = { type: 'object', properties: { a: { type: 'string' } } }
  const schemas = [
    schema('mcp__a__x', 'd1', bigParams),
    schema('mcp__b__y', 'd2'), // default {} properties params
    schema('mcp__keepme__z', 'd3'),
    schema('read', 'native'),
  ]
  const options = { ...OPTIONS, keep: ['mcp__keepme__z'] }
  const { stats, health } = collectMcpHealth(schemas, options, true)
  assert.equal(health.state, 'folding')
  assert.equal(health.folded, 2)
  assert.equal(health.kept, 1)
  // Exact JSON size of the folded parameters objects — chars, not tokens.
  const expectedChars = JSON.stringify(bigParams).length + JSON.stringify({ type: 'object', properties: {} }).length
  assert.equal(health.schemaChars, expectedChars)
  assert.deepEqual(stats.folded.map(tool => tool.name), ['mcp__a__x', 'mcp__b__y'])
})

test('health: servers-whitelist survivors count as kept alongside keep-pattern holds', () => {
  const options = { ...OPTIONS, servers: ['a'] }
  const { stats, health } = collectMcpHealth([schema('mcp__a__x'), schema('mcp__gh__y')], options, true)
  // a folds (whitelisted); gh stays native (outside the whitelist).
  assert.equal(health.state, 'folding')
  assert.equal(health.folded, 1)
  assert.equal(health.kept, 1)
  assert.deepEqual(stats.kept.map(tool => tool.name), ['mcp__gh__y'])
})

test('health: not-live meta-tools mean fail-open regardless of content', () => {
  const { health } = collectMcpHealth(mcpSchemas(), OPTIONS, false)
  assert.deepEqual(health, { state: 'fail-open' })
})

test('health: live but nothing matching is idle (zero-MCP-tools view)', () => {
  const none = collectMcpHealth([schema('read')], OPTIONS, true)
  assert.deepEqual(none.health, { state: 'idle', matched: 0 })
  // Matches exist but every one is held back by keep → still no fold.
  const allKept = collectMcpHealth(
    [schema('mcp__a__x', '', { type: 'object' })],
    { ...OPTIONS, keep: ['mcp__a__x'] },
    true,
  )
  assert.deepEqual(allKept.health, { state: 'idle', matched: 1 })
})

// ---- renderMcpHealthLine ----

test('health line: folding state renders the exact documented sentence', () => {
  const line = renderMcpHealthLine({ state: 'folding', folded: 12, kept: 3, schemaChars: 4567 })
  assert.match(line, /meta-tools: mcp_list\/mcp_call live/)
  assert.match(line, /folding ACTIVE — folded 12, kept 3/)
  assert.match(line, /~4567 chars of schema out of prompt/)
  // The unit is explicitly chars, never tokens.
  assert.doesNotMatch(line, /token/i)
})

test('health line: fail-open replaces the whole line; idle explains the emptiness', () => {
  assert.equal(
    renderMcpHealthLine({ state: 'fail-open' }),
    'folding INACTIVE (fail-open) — full schemas are passing through',
  )
  assert.match(renderMcpHealthLine({ state: 'idle', matched: 0 }), /no MCP tools match/)
  assert.match(renderMcpHealthLine({ state: 'idle', matched: 4 }), /4 matching tool\(s\) stay native/)
})

// ---- groupSchemasByServer ----

test('grouping: first-seen server order, candidates only, meta-tools excluded', () => {
  const groups = groupSchemasByServer(mcpSchemas(), OPTIONS)
  assert.deepEqual(groups.map(group => group.server), ['fs', 'gh'])
  assert.deepEqual(groups[0].schemas.map(tool => tool.name), ['mcp__fs__read_file', 'mcp__fs__write_file'])
  // A pathological prefix that matches the meta-tool names lists neither.
  const sick = groupSchemasByServer(
    [schema(MCP_LIST_TOOL_NAME), schema(MCP_CALL_TOOL_NAME), schema('mcp_ask_user')],
    { ...OPTIONS, prefix: 'mcp_' },
  )
  assert.deepEqual(sick.flatMap(group => group.schemas.map(tool => tool.name)), ['mcp_ask_user'])
})

// ---- capRenderedLines ----

test('line cap: within-limit text passes through byte-identical', () => {
  const text = ['a', 'b', 'c'].join('\n')
  assert.equal(capRenderedLines(text, 5), text)
  assert.equal(capRenderedLines(text), text)
})

test('line cap: over-limit text is cut with a narrowing hint at exactly the limit', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n')
  const capped = capRenderedLines(text, 5)
  const lines = capped.split('\n')
  assert.equal(lines.length, 5)
  assert.equal(lines[0], 'line-0')
  assert.equal(lines[3], 'line-3')
  assert.match(capped, /output truncated at 5 lines \(6 dropped\)/)
  assert.match(capped, /\/mcp list <server>/)
})

test('line cap: giant deployments hit the default 400-line ceiling end-to-end', () => {
  const many = []
  for (let server = 0; server < 40; server += 1) {
    for (let tool = 0; tool < 20; tool += 1) many.push(schema(`mcp__srv${server}__tool${tool}`, 'desc'))
  }
  const overview = renderMcpOverview(many, OPTIONS, true)
  const lines = overview.split('\n')
  assert.ok(lines.length > 400 - 50, 'fixture should clearly exceed the cap')
  assert.ok(lines.length <= MCP_OUTPUT_LINE_LIMIT, `capped output must stay within ${MCP_OUTPUT_LINE_LIMIT}`)
  assert.match(overview, /\/mcp list <server>/)
})

// ---- renderMcpOverview ----

test('overview: tree blocks per server with truncated descriptions and the health footer', () => {
  const long = 'z'.repeat(300)
  const schemas = [schema('mcp__fs__read_file', 'Read a file from disk'), schema('mcp__gh__big', long)]
  const text = renderMcpOverview(schemas, { ...OPTIONS, descriptionLimit: 30 }, true)
  assert.match(text, /^MCP servers\/tools — 2 tool\(s\) across 2 server\(s\)$/m)
  assert.match(text, /^└─ mcp__fs__read_file — Read a file from disk$/m)
  assert.match(text, /^fs \(1\)$/m)
  assert.match(text, /^gh \(1\)$/m)
  // Descriptions truncate to the configured listing limit.
  const ghLine = text.split('\n').find(line => line.includes('mcp__gh__big'))
  const descriptionPart = ghLine.slice(ghLine.indexOf('— ') + 2)
  assert.equal(descriptionPart.length, 30)
  assert.ok(descriptionPart.endsWith('…'))
  assert.match(text, /folding ACTIVE — folded 2, kept 0/)
})

test('overview: healthy-empty and fail-open views still render their tree frame', () => {
  const idle = renderMcpOverview([schema('read')], OPTIONS, true)
  assert.match(idle, /0 tool\(s\) across 0 server\(s\)/)
  assert.match(idle, /no MCP tools match/)
  const open = renderMcpOverview(mcpSchemas(), OPTIONS, false)
  assert.match(open, /^fs \(2\)$/m)
  assert.match(open, /folding INACTIVE \(fail-open\) — full schemas are passing through/)
})

// ---- detail target resolution ----

test('detail: server segment wins first, then exact tool name', () => {
  const asServer = resolveMcpDetailTarget('fs', mcpSchemas(), OPTIONS)
  assert.equal(asServer.kind, 'server')
  assert.deepEqual(asServer.schemas.map(tool => tool.name), ['mcp__fs__read_file', 'mcp__fs__write_file'])
  const asTool = resolveMcpDetailTarget('mcp__gh__create_issue', mcpSchemas(), OPTIONS)
  assert.equal(asTool.kind, 'tool')
  assert.equal(asTool.schema.name, 'mcp__gh__create_issue')
  assert.equal(resolveMcpDetailTarget('nope', mcpSchemas(), OPTIONS), undefined)
})

test('detail: whitelisted-away servers and meta-tool names resolve to nothing', () => {
  const options = { ...OPTIONS, servers: ['fs'] }
  assert.equal(resolveMcpDetailTarget('gh', mcpSchemas(), options), undefined)
  assert.equal(resolveMcpDetailTarget(MCP_LIST_TOOL_NAME, mcpSchemas(), OPTIONS), undefined)
  assert.equal(resolveMcpDetailTarget(MCP_CALL_TOOL_NAME, mcpSchemas(), OPTIONS), undefined)
})

// ---- renderMcpDetail ----

test('detail: a server renders its full tool list with truncated descriptions', () => {
  const view = renderMcpDetail('fs', mcpSchemas(), { ...OPTIONS, descriptionLimit: 12 })
  assert.equal(view.outcome, 'server')
  assert.match(view.text, /^server "fs" — 2 tool\(s\)$/m)
  assert.match(view.text, /└─ mcp__fs__write_file — Write a fil…/)
  // No schemas leak into the server listing.
  assert.doesNotMatch(view.text, /inputSchema/)
})

test('detail: a tool renders the FULL description plus its complete input schema', () => {
  const long = 'w'.repeat(500)
  const schemas = [schema('mcp__s__t', long, { type: 'object', properties: { q: { type: 'number' } } })]
  const view = renderMcpDetail('mcp__s__t', schemas, { ...OPTIONS, descriptionLimit: 10 })
  assert.equal(view.outcome, 'tool')
  assert.match(view.text, /^mcp__s__t \(server: s\)$/m)
  assert.match(view.text, new RegExp(long)) // untruncated
  assert.match(view.text, /inputSchema:\s*\{\s*"type": "object",\s*"properties": \{\s*"q": \{/m)
})

test('detail: an unknown name produces a descriptive miss, pointing back to /mcp', () => {
  const view = renderMcpDetail('ghost', [], OPTIONS)
  assert.equal(view.outcome, 'unknown')
  assert.match(view.text, /no MCP server or tool matches "ghost"/)
  assert.match(view.text, /\/mcp/)
})

// ---- renderMcpConfig ----

test('config: shows each knob verbatim with its hitting tools (read-only)', () => {
  const options = {
    prefix: 'mcp__',
    keep: ['mcp__fs__read_file', 'mcp__github__*'],
    servers: ['fs'],
    descriptionLimit: 42,
  }
  const schemas = [
    schema('mcp__fs__read_file', 'd'),
    schema('mcp__fs__write_file', 'd'),
    schema('mcp__other__tool', 'd'),
  ]
  const text = renderMcpConfig(schemas, options)
  // Candidates respect the servers whitelist, so mcp__other__tool does not
  // count toward the prefix matches (consistent with fold/catalog/dispatch).
  assert.match(text, /prefix\s+"mcp__" — matches 2 tool\(s\) in this scope/)
  assert.match(text, /descriptionLimit\s+42/)
  assert.match(text, /- mcp__fs__read_file\n\s+matches: mcp__fs__read_file/)
  assert.match(text, /- mcp__github__\*\n\s+\(no matching tools\)/)
  assert.match(text, /- fs\n\s+tools: mcp__fs__read_file, mcp__fs__write_file/)
})

test('config: empty keep and empty servers explain their no-filter meaning', () => {
  const text = renderMcpConfig(mcpSchemas(), OPTIONS)
  assert.match(text, /\(empty — no tool is held back by name\)/)
  assert.match(text, /\(empty — no filtering; every prefix-matching server folds\)/)
})

// ---- executeMcpCommand ----

function runExecute(rawInput, overrides = {}) {
  return executeMcpCommand({
    rawInput,
    schemas: mcpSchemas(),
    config: OPTIONS,
    metaToolsLive: true,
    ...overrides,
  })
}

test('execute: overview is a success carrying the tree and the health line', () => {
  for (const rawInput of ['', 'list']) {
    const outcome = runExecute(rawInput)
    assert.equal(outcome.kind, 'success')
    assert.match(outcome.text, /MCP servers\/tools/)
    assert.match(outcome.text, /folding ACTIVE/)
  }
})

test('execute: detail hits are successes, misses are errors referencing the miss', () => {
  assert.equal(runExecute('list fs').kind, 'success')
  const miss = runExecute('list ghost')
  assert.equal(miss.kind, 'error')
  assert.match(miss.text, /no MCP server or tool matches "ghost"/)
})

test('execute: config succeeds and bad forms return the verbatim usage text', () => {
  assert.equal(runExecute('config').kind, 'success')
  const usage = runExecute('make it fold harder')
  assert.deepEqual(usage, { kind: 'error', text: MCP_COMMAND_USAGE })
})

test('execute: a fail-open view renders successfully with the INACTIVE notice', () => {
  const failOpen = runExecute('', { metaToolsLive: false })
  assert.equal(failOpen.kind, 'success')
  assert.match(failOpen.text, /folding INACTIVE \(fail-open\) — full schemas are passing through/)
})

// ---- apply() command wiring ----

/**
 * Standalone ctx stub mirroring mcp-adapter.test.mjs's fakeCtx plus the
 * `commands` service, with scope recording and a live-mask hook so the
 * fail-open branch of the command handler can be exercised.
 */
function stubCtx() {
  const state = { registered: new Map(), commands: new Map(), effects: [], warnings: [], schemaScopes: [], maskedMeta: false }
  const ctx = {
    tools: {
      register(definition) {
        if (state.registered.has(definition.name)) throw new Error(`name conflict on ${definition.name}`)
        state.registered.set(definition.name, definition)
        return () => state.registered.delete(definition.name)
      },
      get(name) {
        if (state.maskedMeta && (name === MCP_LIST_TOOL_NAME || name === MCP_CALL_TOOL_NAME)) return undefined
        return state.registered.get(name)
      },
      schemas(scope) {
        state.schemaScopes.push(scope)
        return [...state.registered.values()].map(
          ({ name, description, parameters }) => ({ name, description, parameters }),
        )
      },
    },
    commands: {
      register(definition) {
        if (state.commands.has(definition.name)) throw new Error(`name conflict on /${definition.name}`)
        state.commands.set(definition.name, definition)
        return () => state.commands.delete(definition.name)
      },
    },
    on(event, listener) {
      state.listeners = state.listeners ?? []
      state.listeners.push({ event, listener })
      return () => {}
    },
    effect(execute, label) {
      const disposer = execute()
      state.effects.push({ disposer, label })
      return disposer
    },
    logger: { warn(message) { state.warnings.push(message) } },
  }
  return { ctx, state }
}

test('apply(): registers the read-only /mcp command with the declared contract', () => {
  const { ctx, state } = stubCtx()
  apply(ctx, { ...OPTIONS })
  const definition = state.commands.get('mcp')
  assert.notEqual(definition, undefined)
  assert.equal(definition.name, 'mcp')
  assert.equal(definition.description, 'Show MCP server/tool status (read-only)')
  assert.deepEqual(definition.input, { hint: '[list [server|tool] | config]' })
})

test('apply(): the handler answers from the invoking agent\'s scope, live-aware', async () => {
  const { ctx, state } = stubCtx()
  apply(ctx, { ...OPTIONS })
  state.registered.set('mcp__fs__read_file', schema('mcp__fs__read_file', 'Read files'))
  const definition = state.commands.get(MCP_COMMAND_NAME)
  const agent = { id: 'agent-7' }
  const outcome = await definition.handler(invocationLike('', agent))
  // Every query consulted the receiving agent as the tools scope.
  assert.equal(state.schemaScopes.length, 1)
  assert.strictEqual(state.schemaScopes[0], agent)
  assert.equal(outcome.kind, 'success')
  assert.match(outcome.text, /mcp__fs__read_file/)
  assert.match(outcome.text, /folding ACTIVE — folded 1, kept 0/)
  // Shadowed meta-tools degrade the same line to fail-open passthrough.
  state.maskedMeta = true
  const degraded = await definition.handler(invocationLike('', agent))
  assert.equal(state.schemaScopes.length, 2)
  assert.match(degraded.text, /folding INACTIVE \(fail-open\)/)
})

test('apply(): a /mcp name collision degrades gracefully without touching the meta-tools', () => {
  const { ctx, state } = stubCtx()
  state.commands.set(MCP_COMMAND_NAME, {})
  apply(ctx, { ...OPTIONS })
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /"\/mcp" command registration failed/)
  assert.match(state.warnings[0], /name conflict on \/mcp/)
  // Both meta-tools and the assembly listener are unaffected.
  assert.deepEqual([...state.registered.keys()].sort(), [MCP_CALL_TOOL_NAME, MCP_LIST_TOOL_NAME])
  assert.equal(state.listeners.length, 1)
})

test('apply(): command teardown disposes exactly the command registration', () => {
  const { ctx, state } = stubCtx()
  apply(ctx, { ...OPTIONS })
  const commandEffect = state.effects.find(effect => effect.label === 'mcp-adapter.command')
  assert.notEqual(commandEffect, undefined)
  assert.equal(state.commands.has(MCP_COMMAND_NAME), true)
  commandEffect.disposer()
  assert.equal(state.commands.has(MCP_COMMAND_NAME), false)
})

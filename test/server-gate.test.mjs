import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MCP_LIST_TOOL_NAME,
  MCP_CALL_TOOL_NAME,
  MCP_COMMAND_USAGE,
  MCP_SERVER_ID_LIMIT,
  MCP_ADAPTER_SETTINGS_NAMESPACE,
  SERVER_ID_REGISTRY_SCHEMA,
  parseMcpCommandInput,
  normalizeServerGate,
  isServerDisabled,
  allocateMissingServerIds,
  setServerDisabledState,
  serverNameById,
  liveServerNames,
  shouldFold,
  foldPromptAssembly,
  buildMcpListResult,
  dispatchMcpCall,
  createMcpListTool,
  createMcpCallTool,
  renderMcpOverview,
  renderMcpConfig,
  renderMcpDetail,
  renderServerGroupHeader,
  executeMcpCommand,
  apply,
} from '../lib/index.js'

const OPTIONS = { prefix: 'mcp__', keep: [], servers: [], descriptionLimit: 200 }

function schema(name, description = '', parameters = { type: 'object', properties: {} }) {
  return { name, description, parameters }
}

function schemasFor() {
  return [
    schema('read', 'native tool'),
    schema('mcp__fs__read_file', 'Read a file'),
    schema('mcp__fs__write_file', 'Write a file'),
    schema('mcp__gh__create_issue', 'Create an issue'),
  ]
}

function invocationLike(rawInput, agent = undefined) {
  return { commandId: 'cmd-1', agent, rawInput, attachments: [], signal: new AbortController().signal }
}

/** Tool fixture that both lists in schemas() views and executes when dispatched. */
function liveTool(name, description, value) {
  return {
    ...schema(name, description),
    async execute(args) { return value === undefined ? { ok: true, args } : structuredClone(value) },
  }
}

// ---- normalizeServerGate / isServerDisabled ----

test('normalize: junk resolves to the empty gate; valid entries survive; ids are sanitized', () => {
  assert.deepEqual(normalizeServerGate(undefined), { serverIds: {}, disabled: [] })
  assert.deepEqual(normalizeServerGate('nope'), { serverIds: {}, disabled: [] })
  const gate = normalizeServerGate({
    serverIds: { fs: 1, gh: 2.5, ghost: 0, over: 100, empty: -3 },
    disabled: [2, 2, 0, 42, 7.7, 101],
    extra: true,
  })
  assert.deepEqual(gate.serverIds, { fs: 1 })
  assert.deepEqual(gate.disabled, [2, 42], 'deduped, range-filtered, order kept')
})

test('normalize: two names mapping one id keep the first mapping only', () => {
  const gate = normalizeServerGate({ serverIds: { first: 3, second: 3 }, disabled: [] })
  assert.equal(gate.serverIds.first, 3)
  assert.equal(gate.serverIds.second, undefined)
})

test('the persisted registry schema fills defaults for a missing section', () => {
  assert.deepEqual(SERVER_ID_REGISTRY_SCHEMA({}), { serverIds: {}, disabled: [] })
})

test('isServerDisabled: positive evidence required; unmapped/absent/empty-server mean enabled', () => {
  const gate = { serverIds: { fs: 1 }, disabled: [1] }
  assert.equal(isServerDisabled('fs', gate), true)
  assert.equal(isServerDisabled('gh', gate), false, 'unmapped servers stay enabled')
  assert.equal(isServerDisabled('fs', undefined), false, 'absent snapshot means enabled')
  assert.equal(isServerDisabled('', gate), false, 'degenerate segment never gates')
  // An id in disabled without any mapping is inert.
  assert.equal(isServerDisabled('gh', { serverIds: { fs: 1 }, disabled: [9] }), false)
})

// ---- allocation (first-seen smallest free id; stable reuse) ----

test('allocation: first sighting assigns smallest free ids starting at 1', () => {
  const { registry, unassigned, added } = allocateMissingServerIds(EMPTY(), ['gh', 'fs'])
  assert.deepEqual(registry.serverIds, { gh: 1, fs: 2 })
  assert.deepEqual(registry.disabled, [])
  assert.deepEqual(unassigned, [])
  assert.deepEqual(added.sort(), ['fs', 'gh'])
})

test('allocation: existing mappings and gaps are honored (minimum FREE id)', () => {
  const start = { serverIds: { fs: 1, gh: 3 }, disabled: [] }
  const { registry } = allocateMissingServerIds(start, ['db'])
  assert.equal(registry.serverIds.db, 2, 'fills the hole left of the highest id')
  const full = allocateMissingServerIds({ serverIds: { fs: 1 }, disabled: [] }, ['fs'])
  assert.deepEqual(full.added, [], 'already-mapped servers are untouched')
  assert.equal(full.registry.serverIds.fs, 1)
})

test('allocation: a full 99-id space reports exactly the unassignable names', () => {
  const serverIds = {}
  for (let id = 1; id <= MCP_SERVER_ID_LIMIT; id += 1) serverIds[`s${id}`] = id
  const { unassigned, added } = allocateMissingServerIds({ serverIds, disabled: [] }, ['s1', 'fresh'])
  assert.deepEqual(unassigned, ['fresh'])
  assert.deepEqual(added, [])
})

test('toggle: disable->enable->disable reuses the same id (enable never recycles)', () => {
  const base = { serverIds: { fs: 1, gh: 2 }, disabled: [] }
  let state = base
  state = setServerDisabledState(state, 'gh', true).registry
  assert.deepEqual(state.disabled, [2])
  assert.deepEqual(state.serverIds, { fs: 1, gh: 2 })
  state = setServerDisabledState(state, 'gh', false).registry
  assert.deepEqual(state.disabled, [], 'enable keeps the mapping for a later identical disable')
  state = setServerDisabledState(state, 'gh', true).registry
  assert.deepEqual(state.disabled, [2])
  // changed flags tell idempotent repeats apart from real moves.
  assert.equal(setServerDisabledState(base, 'gh', true).changed, true)
  assert.equal(setServerDisabledState(state, 'gh', true).changed, false)
  assert.equal(setServerDisabledState(state, 'ghost', true).changed, false)
})

test('serverNameById reverses the map; liveServerNames dedups candidates in order', () => {
  const registry = { serverIds: { fs: 1, gh: 2 }, disabled: [] }
  assert.equal(serverNameById(registry, 2), 'gh')
  assert.equal(serverNameById(registry, 9), undefined)
  assert.deepEqual(liveServerNames(schemasFor(), OPTIONS), ['fs', 'gh'])
  assert.deepEqual(liveServerNames([schema(MCP_LIST_TOOL_NAME), schema('mcp__a__t')], OPTIONS), ['a'],
    'meta-tools never become live servers')
})

function EMPTY() {
  return { serverIds: {}, disabled: [] }
}

// ---- latch 1: forced fold overrides keep and servers ----

test('fold: a disabled server folds even against keep patterns; enabled servers keep their exemptions', () => {
  const gate = { serverIds: { fs: 1, gh: 2 }, disabled: [1] }
  const options = {
    prefix: 'mcp__',
    keep: ['mcp__fs__*'],       // would normally hold fs native
    servers: ['fs', 'gh'],
  }
  const build = () => ({ sections: [], contexts: [], variables: {}, tools: [
    schema('mcp__fs__read_file'),
    schema('mcp__gh__create_issue'),
  ] })
  // Without the gate the keep exemption holds fs native; gh folds normally.
  const ungated = foldPromptAssembly(build(), options, true)
  assert.deepEqual(ungated.tools.map(tool => tool.name), ['mcp__fs__read_file'])
  // With the gate, disablement overrides that exemption for ALL of fs's tools.
  const gated = foldPromptAssembly(build(), options, true, gate)
  assert.deepEqual(gated.tools.map(tool => tool.name), [],
    'disabled fs folds despite keep; enabled gh folds as usual')
  assert.equal(shouldFold('mcp__fs__read_file', 'mcp__', options.keep, options.servers, gate), true)
  assert.equal(shouldFold('mcp__gh__create_issue', 'mcp__', options.keep, options.servers, gate), true)
  // Enabling restores the exemptions immediately.
  const enabledGate = { ...gate, disabled: [] }
  assert.equal(shouldFold('mcp__fs__read_file', 'mcp__', options.keep, options.servers, enabledGate), false)
})

test('allocation never hands out an orphan-disabled id (hand-edited documents)', () => {
  // id 1 sits in disabled but maps to nothing.
  const { registry } = allocateMissingServerIds({ serverIds: {}, disabled: [1] }, ['fs'])
  assert.equal(registry.serverIds.fs, 2, 'the burned id stays burned')
})

test('health parity: disabled tools count as folded in the overview footer', () => {
  const gate = { serverIds: { fs: 1, gh: 2 }, disabled: [1] }
  const text = renderMcpOverview(schemasFor(), { ...OPTIONS, gate }, true)
  // fs's 2 tools fold by force, gh's tool folds normally -> 3 folded, 0 kept.
  assert.match(text, /folding ACTIVE — folded 3, kept 0/)
})

// ---- latch 2: catalog hiding + structured expansion error with enable hint ----

test('catalog: disabled servers vanish from the directory; expansion says why with "/mcp enable"', () => {
  const gate = { serverIds: { fs: 1, gh: 2 }, disabled: [1] }
  const options = OPTIONS
  const catalog = buildMcpListResult({}, schemasFor(), options, gate)
  assert.deepEqual(catalog.servers.map(group => group.server), ['gh'])
  const expansion = buildMcpListResult({ tool: 'mcp__fs__read_file' }, schemasFor(), options, gate)
  assert.match(expansion.error, /refusing to expand "mcp__fs__read_file"/)
  assert.match(expansion.error, /server "fs" is disabled/)
  assert.match(expansion.error, /\/mcp enable 1/)
  // Filtering straight at a disabled server also answers with the hint.
  const filtered = buildMcpListResult({ server: 'fs' }, schemasFor(), options, gate)
  assert.match(filtered.error, /server "fs" is disabled and hidden/)
  assert.match(filtered.error, /\/mcp enable 1/)
})

// ---- latch 3: dispatch refusal after prefix validation, with guidance ----

test('dispatch: prefix refusals fire before the disabled branch; disabled tools get the enable hint', async () => {
  const gate = { serverIds: { fs: 1 }, disabled: [1] }
  let resolved = 0
  const resolve = () => { resolved += 1; return { async execute() { return {} } } }
  // A non-prefix name still produces the PREFIX error, not the gate error.
  const foreign = await dispatchMcpCall({ tool: 'read' }, 'mcp__', resolve, {}, [], gate)
  assert.match(foreign.error, /prefix/)
  // Whitelist-out stays primary when both apply (config boundary first).
  const whitelistedAway = await dispatchMcpCall({ tool: 'mcp__fs__t' }, 'mcp__', resolve, {}, ['other'], gate)
  assert.match(whitelistedAway.error, /servers list/)
  // The gated refusal itself carries the operator-facing command.
  const refused = await dispatchMcpCall({ tool: 'mcp__fs__read_file' }, 'mcp__', resolve, {}, [], gate)
  assert.match(refused.error, /refusing to call "mcp__fs__read_file"/)
  assert.match(refused.error, /server "fs" is disabled/)
  assert.match(refused.error, /\/mcp enable 1/)
  assert.equal(resolved, 0, 'the child is never resolved while gated')
  // Enabled again -> normal dispatch.
  const ok = await dispatchMcpCall({ tool: 'mcp__fs__read_file' }, 'mcp__', resolve, {}, [],
    { serverIds: { fs: 1 }, disabled: [] })
  assert.equal(resolved, 1)
  assert.deepEqual(ok, {})
})

// ---- factories read the gate through their callbacks per execution ----

test('factories: mcp_list/mcp_call observe the LIVE callback value on every execution', async () => {
  let gate = { serverIds: { gh: 2 }, disabled: [] }
  const ghOnly = [schema('mcp__gh__x', 'the only server')]
  const list = createMcpListTool({ prefix: 'mcp__', descriptionLimit: 200, getGate: () => gate }, () => ghOnly)
  const call = createMcpCallTool('mcp__', () => ({ async execute() { return { ok: true } } }), [], () => gate)

  const openCatalog = await list.execute({}, {})
  assert.deepEqual(openCatalog.servers.map(group => group.server), ['gh'])
  const dispatched = await call.execute({ tool: 'mcp__gh__x' }, {})
  assert.deepEqual(dispatched, { ok: true })

  gate = { serverIds: { gh: 2 }, disabled: [2] }
  const closedCatalog = await list.execute({}, {})
  assert.deepEqual(closedCatalog, { error: 'no MCP tools are registered under the "mcp__" prefix' })
  const refused = await call.execute({ tool: 'mcp__gh__x' }, {})
  assert.match(refused.error, /\/mcp enable 2/)
})

// ---- /mcp command surface ----

test('parse: disable/enable take one positive integer; anything else is usage', () => {
  assert.deepEqual(parseMcpCommandInput('disable 3'), { form: 'disable', id: 3 })
  assert.deepEqual(parseMcpCommandInput('  enable   12 '), { form: 'enable', id: 12 })
  for (const bad of ['disable', 'enable', 'disable x', 'disable 0', 'disable -1', 'enable 1 2', 'disable']) {
    assert.deepEqual(parseMcpCommandInput(bad), { form: 'usage' }, JSON.stringify(bad))
  }
})

test('tree: every server line gains its stable [id] prefix; disabled groups hide tools', () => {
  const gate = { serverIds: { fs: 4, gh: 9 }, disabled: [4] }
  const text = renderMcpOverview(schemasFor(), { ...OPTIONS, gate }, true)
  assert.match(text, /^\[9\] gh \(1\)$/m)
  assert.match(text, /^\[4\] fs ⏸ disabled — hides 2 tool\(s\)$/m)
  assert.doesNotMatch(text, /├─ mcp__fs__read_file/, 'disabled groups list no tools')
  assert.match(text, /└─ mcp__gh__create_issue/)
})

test('header renderer: legacy shape without a gate, [-] fallback when unassigned', () => {
  const group = { server: 'fs', schemas: [{}, {}] }
  assert.equal(renderServerGroupHeader(group, undefined), 'fs (2)', 'unchanged without gating')
  assert.equal(renderServerGroupHeader(group, EMPTY()), '[-] fs (2)')
  assert.equal(renderServerGroupHeader(group, { serverIds: { fs: 7 }, disabled: [7] }),
    '[7] fs ⏸ disabled — hides 2 tool(s)')
})

test('config view: appends the persistent enable/disable inventory', () => {
  const gate = { serverIds: { gh: 2, fs: 1 }, disabled: [2] }
  const text = renderMcpConfig(schemasFor(), { ...OPTIONS, gate })
  assert.match(text, /persistent enable\/disable \(stable ids; survives restarts\):/)
  const lines = text.split('\n')
  const fsLine = lines.findIndex(line => line.includes('[1] fs'))
  const ghLine = lines.findIndex(line => line.includes('[2] gh'))
  assert.ok(fsLine !== -1 && ghLine !== -1)
  assert.match(lines[ghLine], /⏸ disabled/)
  assert.ok(fsLine < ghLine, 'ids render sorted ascending')
  // Empty observations explain themselves.
  const fresh = renderMcpConfig(schemasFor(), { ...OPTIONS, gate: EMPTY() })
  assert.match(fresh, /\(no servers observed yet/)
})

test('detail view: disabled targets carry the restore hint but stay inspectable', () => {
  const gate = { serverIds: { fs: 1 }, disabled: [1] }
  const serverView = renderMcpDetail('fs', schemasFor(), { ...OPTIONS, gate })
  assert.equal(serverView.outcome, 'server')
  assert.match(serverView.text, /this server is disabled/)
  assert.match(serverView.text, /\/mcp enable 1/)
  assert.match(serverView.text, /mcp__fs__write_file/, 'human inspection is not gated')
  const toolView = renderMcpDetail('mcp__fs__read_file', schemasFor(), { ...OPTIONS, gate })
  assert.equal(toolView.outcome, 'tool')
  assert.match(toolView.text, /note: server "fs" is disabled/)
})

// ---- executeMcpCommand persistence flows (plain-data writeGate) ----

test('command flow: first sighting persists allocations through writeGate, once', async () => {
  let stored = { serverIds: {}, disabled: [] }
  const writes = []
  const view = (rawInput) => ({
    rawInput,
    schemas: schemasFor(),
    config: { ...OPTIONS, gate: stored },
    metaToolsLive: true,
    gate: stored,
    writeGate: async (next) => {
      writes.push(structuredClone(next))
      stored = structuredClone(next)
    },
  })
  const outcome = await executeMcpCommand(view(''))
  assert.equal(outcome.kind, 'success')
  assert.match(outcome.text, /\[1\] fs \(2\)/)
  assert.match(outcome.text, /\[2\] gh \(1\)/)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], { serverIds: { fs: 1, gh: 2 }, disabled: [] })
  // Steady state: nothing new to assign -> zero further writes.
  const steady = await executeMcpCommand(view('config'))
  assert.equal(steady.kind, 'success')
  assert.match(steady.text, /- \[1\] fs/)
  assert.equal(writes.length, 1, 'no duplicate persistence')
})

test('command flow: disable/enable persist toggles; targets must be live assigned ids', async () => {
  // A live store closure: each write becomes the next read, like settings do.
  let stored = { serverIds: { fs: 1, gh: 2 }, disabled: [] }
  const writes = []
  const view = (rawInput) => ({
    rawInput,
    schemas: schemasFor(),
    config: { ...OPTIONS, gate: stored },
    metaToolsLive: true,
    gate: stored,
    writeGate: async (next) => {
      writes.push(structuredClone(next))
      stored = structuredClone(next)
    },
  })

  const off = await executeMcpCommand(view('disable 2'))
  assert.equal(off.kind, 'success')
  assert.match(off.text, /server "gh" \(id 2\) disabled/)
  assert.match(off.text, /\/mcp enable 2/)
  assert.deepEqual(writes.at(-1).disabled, [2])
  assert.deepEqual(writes.at(-1).serverIds, { fs: 1, gh: 2 }, 'ids persist untouched')

  // Idempotent repeat against the persisted state: no second write.
  const again = await executeMcpCommand(view('disable 2'))
  assert.equal(again.kind, 'success')
  assert.match(again.text, /already disabled/)
  assert.equal(writes.length, 1)

  // Enable path restores; repeat explains there was nothing to do.
  const on = await executeMcpCommand(view('enable 2'))
  assert.equal(on.kind, 'success')
  assert.match(on.text, /enabled — back to normal folding/)
  assert.deepEqual(writes.at(-1).disabled, [])
  const idleEnable = await executeMcpCommand(view('enable 2'))
  assert.match(idleEnable.text, /not disabled/)
  assert.equal(writes.length, 2)
})

test('command flow: unknown or not-live ids answer error + usage; exhaustion names the limit', async () => {
  const noop = async () => {}
  const neverAssigned = await executeMcpCommand({
    rawInput: 'disable 42',
    schemas: schemasFor(),
    config: { ...OPTIONS, gate: EMPTY() },
    metaToolsLive: true,
    gate: EMPTY(),
    writeGate: noop,
  })
  assert.equal(neverAssigned.kind, 'error')
  assert.match(neverAssigned.text, /no live MCP server carries id 42/)
  assert.ok(neverAssigned.text.includes(MCP_COMMAND_USAGE), 'error+usage per contract')

  const outOfRange = await executeMcpCommand({
    rawInput: `enable ${MCP_SERVER_ID_LIMIT + 500}`,
    schemas: schemasFor(),
    config: { ...OPTIONS, gate: EMPTY() },
    metaToolsLive: true,
    gate: EMPTY(),
    writeGate: noop,
  })
  assert.equal(outOfRange.kind, 'error')

  // A mapped id whose server currently has no visible tools refuses too.
  const partialSchemas = [schema('mcp__gh__create_issue')]
  const staleTarget = await executeMcpCommand({
    rawInput: 'disable 1',
    schemas: partialSchemas,
    config: { ...OPTIONS, gate: { serverIds: { fs: 1, gh: 2 }, disabled: [] } },
    metaToolsLive: true,
    gate: { serverIds: { fs: 1, gh: 2 }, disabled: [] },
    writeGate: noop,
  })
  assert.equal(staleTarget.kind, 'error')
  assert.match(staleTarget.text, /has no visible tools in this scope right now/)

  // A brand-new server in a FULL id space surfaces the exhaustion clearly.
  const serverIds = {}
  for (let id = 1; id <= MCP_SERVER_ID_LIMIT; id += 1) serverIds[`s${id}`] = id
  const exhausted = await executeMcpCommand({
    rawInput: '',
    schemas: [...schemasFor(), schema(`mcp__overflow__t`)],
    config: { ...OPTIONS, gate: { serverIds, disabled: [] } },
    metaToolsLive: true,
    gate: { serverIds, disabled: [] },
    writeGate: noop,
  })
  assert.equal(exhausted.kind, 'success', 'status queries still render around the failure')
})

test('command flow: absent settings service and failed persistence surface as errors', async () => {
  const missing = await executeMcpCommand({
    rawInput: 'disable 1',
    schemas: schemasFor(),
    config: OPTIONS,
    metaToolsLive: true,
    gate: undefined,
    writeGate: undefined,
  })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /settings service/)

  const boom = new Error('disk on fire')
  const failing = await executeMcpCommand({
    rawInput: 'disable 1',
    schemas: schemasFor(),
    config: { ...OPTIONS, gate: { serverIds: { fs: 1 }, disabled: [] } },
    metaToolsLive: true,
    gate: { serverIds: { fs: 1 }, disabled: [] },
    writeGate: async () => { throw boom },
  })
  assert.equal(failing.kind, 'error')
  assert.match(failing.text, /could not be persisted/)
  assert.match(failing.text, /disk on fire/)
  assert.match(failing.text, /state unchanged/)
})

// ---- apply() wiring with a mocked settings registration ----

/**
 * Settings seam stub: register(ns, schema) layers defaults like production;
 * replace records each section so tests can watch the exact write payload.
 */
function settingsHost(store) {
  return {
    register(ns, schemaFn) {
      const entry = store.sections[ns] ?? (store.sections[ns] = { resolved: schemaFn({}), user: undefined })
      if (entry.resolved === undefined) entry.resolved = schemaFn({})
      return {
        get: () => entry.resolved,
        replace: async (section) => {
          entry.user = section
          entry.resolved = schemaFn(section)
          store.writes.push(structuredClone(section))
        },
      }
    },
  }
}

function stubCtx({ mountSettings = true } = {}) {
  const store = { sections: {}, writes: [] }
  const state = {
    registered: new Map(), commands: new Map(), effects: [], warnings: [],
    listeners: [], injections: [], store,
  }
  const ctx = {
    tools: {
      register(definition) {
        state.registered.set(definition.name, definition)
        return () => state.registered.delete(definition.name)
      },
      get(name) { return state.registered.get(name) },
      schemas(scope) {
        state.lastSchemaScope = scope
        return [...state.registered.values()].map(
          ({ name, description, parameters }) => ({ name, description, parameters }),
        )
      },
    },
    commands: {
      register(definition) { state.commands.set(definition.name, definition); return () => state.commands.delete(definition.name) },
    },
    inject(services, callback) {
      state.injections.push([...services])
      let disposer
      if (mountSettings && services.includes('settings')) disposer = callback({ settings: settingsHost(store) })
      return () => { if (disposer !== undefined) disposer() }
    },
    on(event, listener) { state.listeners.push({ event, listener }); return () => {} },
    effect(execute, label) { const disposer = execute(); state.effects.push({ disposer, label }); return disposer },
    logger: { warn(message) { state.warnings.push(message) } },
  }
  return { ctx, state }
}

const BASE_CONFIG = { prefix: 'mcp__', keep: [], servers: [], descriptionLimit: 200 }

test('apply(): settings namespace registered under "mcp-adapter"; ids assigned and persisted on first /mcp', async () => {
  const { ctx, state } = stubCtx()
  apply(ctx, BASE_CONFIG)
  assert.deepEqual(state.injections[0], ['settings'])
  const namespaceEntry = state.store.sections[MCP_ADAPTER_SETTINGS_NAMESPACE]
  assert.deepEqual(namespaceEntry.resolved, { serverIds: {}, disabled: [] })

  state.registered.set('mcp__fs__read_file', schema('mcp__fs__read_file', 'Read files'))
  state.registered.set('mcp__fs__write_file', schema('mcp__fs__write_file', 'Write files'))
  const handler = state.commands.get('mcp').handler
  const outcome = await handler(invocationLike(''))
  assert.equal(outcome.kind, 'success')
  assert.match(outcome.text, /^\[1\] fs \(2\)$/m)
  assert.equal(state.store.writes.length, 1)
  assert.deepEqual(state.store.writes[0], { serverIds: { fs: 1 }, disabled: [] })
})

test('apply(): /mcp disable drives all three latches end-to-end through one settings document', async () => {
  const { ctx, state } = stubCtx()
  apply(ctx, BASE_CONFIG)
  state.registered.set('mcp__fs__read_file', liveTool('mcp__fs__read_file', 'Read files'))
  state.registered.set('mcp__gh__create_issue', liveTool('mcp__gh__create_issue', 'Issues'))
  const handler = state.commands.get('mcp').handler
  await handler(invocationLike(''))

  const off = await handler(invocationLike('disable 1'))
  assert.equal(off.kind, 'success')
  assert.match(off.text, /server "fs" \(id 1\) disabled/)
  assert.match(off.text, /\/mcp enable 1/)
  const section = state.store.sections[MCP_ADAPTER_SETTINGS_NAMESPACE]
  assert.deepEqual(section.user.disabled, [1])
  assert.deepEqual(section.resolved.disabled, [1])

  // Latch 1: the waterfall now force-folds fs even though nothing else would.
  const listener = state.listeners.find(entry => entry.event === 'system-prompt/assemble').listener
  const assembly = {
    sections: [], contexts: [], variables: {},
    tools: [schema('read'), schema('mcp__fs__read_file')],
  }
  const folded = await listener(assembly, { scope: undefined }, () => Promise.resolve(assembly))
  assert.deepEqual(folded.tools.map(tool => tool.name), ['read'])

  // Latch 2: mcp_list hides fs but keeps gh.
  const catalog = await state.registered.get(MCP_LIST_TOOL_NAME).execute({}, { agent: undefined })
  assert.deepEqual(catalog.servers.map(group => group.server), ['gh'])

  // Latch 3: mcp_call refuses with the restore hint.
  const refused = await state.registered.get(MCP_CALL_TOOL_NAME).execute({ tool: 'mcp__fs__read_file' }, { agent: undefined })
  assert.match(refused.error, /server "fs" is disabled/)
  assert.match(refused.error, /\/mcp enable 1/)

  // Overview reflects the state; footer counts the forced fold plus gh's
  // ordinary one.
  const tree = await handler(invocationLike('list'))
  assert.match(tree.text, /^\[1\] fs ⏸ disabled — hides 1 tool\(s\)$/m)
  assert.doesNotMatch(tree.text, /mcp__fs__read_file — Read files/)
  assert.match(tree.text, /folding ACTIVE — folded 2, kept 0/)

  // Enable flips everything back through the same persistent doc.
  const onOutcome = await handler(invocationLike('enable 1'))
  assert.equal(onOutcome.kind, 'success')
  const restored = await state.registered.get(MCP_CALL_TOOL_NAME).execute({ tool: 'mcp__fs__read_file' }, { agent: undefined })
  assert.deepEqual(restored, { ok: true, args: {} }, 'dispatch reaches the child again after enable')
  assert.deepEqual(state.store.sections[MCP_ADAPTER_SETTINGS_NAMESPACE].user.disabled, [])
  // Same stable id survives the whole cycle.
  const finalTree = await handler(invocationLike(''))
  assert.match(finalTree.text, /^\[1\] fs \(1\)$/m)
})

test('apply(): hand-edited gate sections degrade instead of wedging the latches', async () => {
  const { ctx, state } = stubCtx()
  apply(ctx, BASE_CONFIG)
  // Simulate a corrupt stored section resolved by the provider: an
  // out-of-range id and a disabled flag mapping to nothing.
  state.store.sections[MCP_ADAPTER_SETTINGS_NAMESPACE].resolved = { serverIds: { fs: 999 }, disabled: [1] }
  state.registered.set('mcp__fs__read_file', schema('mcp__fs__read_file'))
  const handler = state.commands.get('mcp').handler
  // id 999 sanitizes away; the burned orphan id 1 is skipped, so fs lands on 2.
  const outcome = await handler(invocationLike(''))
  assert.equal(outcome.kind, 'success')
  assert.match(outcome.text, /^\[2\] fs \(1\)$/m)
  assert.doesNotMatch(outcome.text, /⏸/)
})

test('apply(): without a settings service the command explains it and folding continues', async () => {
  const { ctx, state } = stubCtx({ mountSettings: false })
  apply(ctx, BASE_CONFIG)
  state.registered.set('mcp__fs__read_file', schema('mcp__fs__read_file'))
  const handler = state.commands.get('mcp').handler

  // Reads still work, ids simply never appear (legacy header shape).
  const overview = await handler(invocationLike(''))
  assert.equal(overview.kind, 'success')
  assert.match(overview.text, /^fs \(1\)$/m)

  // Toggles refuse loudly.
  const denied = await handler(invocationLike('disable 1'))
  assert.equal(denied.kind, 'error')
  assert.match(denied.text, /settings service/)

  // Folding + dispatch continue ungated (everything enabled).
  const catalog = await state.registered.get(MCP_LIST_TOOL_NAME).execute({}, { agent: undefined })
  assert.deepEqual(catalog.servers.map(group => group.server), ['fs'])
  const assembly = { sections: [], contexts: [], variables: {}, tools: [schema('read'), schema('mcp__fs__read_file')] }
  const listener = state.listeners.find(entry => entry.event === 'system-prompt/assemble').listener
  const folded = await listener(assembly, { scope: undefined }, () => Promise.resolve(assembly))
  assert.deepEqual(folded.tools.map(tool => tool.name), ['read'],
    'no gate snapshot keeps the fold semantics identical to v0.1')
})

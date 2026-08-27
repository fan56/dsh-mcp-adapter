import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MCP_LIST_TOOL_NAME,
  MCP_CALL_TOOL_NAME,
  matchesKeep,
  shouldFold,
  foldPromptAssembly,
  normalizeMcpListArgs,
  serverOfToolName,
  isAllowedServer,
  truncateDescription,
  buildMcpListResult,
  dispatchMcpCall,
  createMcpListTool,
  createMcpCallTool,
  apply,
} from '../lib/index.js'

const FOLD = { prefix: 'mcp__', keep: [] }

function schema(name, description = '', parameters = { type: 'object', properties: {} }) {
  return { name, description, parameters }
}

function assembly(tools, extra = {}) {
  return {
    sections: [{ name: 'identity', text: 'You are dsh.' }],
    contexts: [{ name: 'cwd', text: '/tmp' }],
    tools,
    variables: { provider: 'deepseek', model: 'x' },
    ...extra,
  }
}

function execLike(overrides = {}) {
  return { signal: new AbortController().signal, agent: undefined, ...overrides }
}

// ---- folding ----

test('folding: mcp__* schemas leave the prompt, everything else stays', () => {
  const input = assembly([
    schema('read'),
    schema(MCP_LIST_TOOL_NAME),
    schema(MCP_CALL_TOOL_NAME),
    schema('mcp__fs__read_file'),
    schema('mcp__github__create_issue'),
  ])
  const result = foldPromptAssembly(input, FOLD, true)
  assert.deepEqual(result.tools.map(tool => tool.name), ['read', MCP_LIST_TOOL_NAME, MCP_CALL_TOOL_NAME])
})

test('folding: keep patterns (exact name and glob) survive the fold', () => {
  const input = assembly([
    schema('mcp__fs__read_file'),
    schema('mcp__fs__write_file'),
    schema('mcp__github__create_issue'),
  ])
  const options = { prefix: 'mcp__', keep: ['mcp__fs__read_file', 'mcp__github__*'] }
  const result = foldPromptAssembly(input, options, true)
  assert.deepEqual(result.tools.map(tool => tool.name), ['mcp__fs__read_file', 'mcp__github__create_issue'])
})

test('folding: non-MCP tools untouched, and the meta-tools are never folded even under a matching prefix', () => {
  // A pathological prefix that WOULD match the meta-tool names.
  const options = { prefix: 'mcp_', keep: [] }
  const input = assembly([schema('read'), schema('mcp_ask_user'), schema('mcp_list'), schema('mcp_call')])
  const result = foldPromptAssembly(input, options, true)
  assert.deepEqual(result.tools.map(tool => tool.name), ['read', 'mcp_list', 'mcp_call'])
  // Sanity of the pathological setup: an ordinary mcp_ tool does fold.
  assert.equal(shouldFold('mcp_ask_user', 'mcp_', []), true)
})

test('folding: fail-open — meta-tools not live returns the assembly unchanged (same reference)', () => {
  const input = assembly([schema('mcp__fs__read_file'), schema('read')])
  const result = foldPromptAssembly(input, FOLD, false)
  assert.strictEqual(result, input)
})

test('folding: sections/contexts/variables pass through untouched', () => {
  const input = assembly([schema('read'), schema('mcp__fs__read_file')])
  const result = foldPromptAssembly(input, FOLD, true)
  assert.strictEqual(result.sections, input.sections)
  assert.strictEqual(result.contexts, input.contexts)
  assert.strictEqual(result.variables, input.variables)
  assert.deepEqual(result.variables, { provider: 'deepseek', model: 'x' })
})

test('folding: nothing to fold returns the assembly unchanged (Code Mode shape)', () => {
  const input = assembly([schema('run_code')])
  const result = foldPromptAssembly(input, FOLD, true)
  assert.strictEqual(result, input)
})

// ---- keep matching ----

test('keep matching: "*" wildcard globs across segments', () => {
  assert.equal(matchesKeep('mcp__github__create_issue', ['mcp__github__*']), true)
  assert.equal(matchesKeep('mcp__fs__read_file', ['mcp__*__read*']), true)
  assert.equal(matchesKeep('mcp__fs__write_file', ['mcp__*__read*']), false)
})

test('keep matching: a pattern without wildcards is an exact name', () => {
  assert.equal(matchesKeep('mcp__fs__read_file', ['mcp__fs__read_file']), true)
  assert.equal(matchesKeep('mcp__fs__read_file2', ['mcp__fs__read_file']), false)
})

test('keep matching: non-matching names and regex metacharacters stay literal', () => {
  assert.equal(matchesKeep('read', ['mcp__*']), false)
  assert.equal(matchesKeep('read', []), false)
  // A dot in the pattern is literal, not "any character".
  assert.equal(matchesKeep('mcp__axb', ['mcp__a.b']), false)
  assert.equal(matchesKeep('mcp__a.b', ['mcp__a.b']), true)
})

// ---- catalog (mcp_list) ----

function catalogSchemas() {
  return [
    schema('read', 'native tool', { type: 'object' }),
    schema('mcp__fs__read_file', 'Read a file from disk', { type: 'object', properties: { path: { type: 'string' } } }),
    schema('mcp__gh__create_issue', 'Create an issue', { type: 'object', properties: { title: { type: 'string' } } }),
    schema('mcp__fs__write_file', 'Write a file to disk', { type: 'object', properties: { path: { type: 'string' } } }),
  ]
}

test('catalog: groups prefix tools by server in first-seen order, excludes non-MCP tools', () => {
  const result = buildMcpListResult({}, catalogSchemas(), { prefix: 'mcp__', descriptionLimit: 200 })
  assert.deepEqual(result, {
    servers: [
      {
        server: 'fs',
        tools: [
          { name: 'mcp__fs__read_file', description: 'Read a file from disk' },
          { name: 'mcp__fs__write_file', description: 'Write a file to disk' },
        ],
      },
      { server: 'gh', tools: [{ name: 'mcp__gh__create_issue', description: 'Create an issue' }] },
    ],
  })
})

test('catalog: descriptions truncate to the limit with an ellipsis marker', () => {
  const long = 'x'.repeat(250)
  assert.equal(truncateDescription(long, 200).length, 200)
  assert.ok(truncateDescription(long, 200).endsWith('…'))
  assert.equal(truncateDescription('short', 200), 'short')
  const result = buildMcpListResult({}, [schema('mcp__s__t', long)], { prefix: 'mcp__', descriptionLimit: 20 })
  assert.equal(result.servers[0].tools[0].description.length, 20)
})

test('catalog: truncation never splits a surrogate pair', () => {
  const emoji = '😀' // U+1F600, one high+low surrogate pair
  // The cut at limit-1 would land on the pair's low surrogate: back off one.
  assert.equal(truncateDescription(`ab${emoji}cd`, 4), 'ab…')
  assert.equal(truncateDescription(`${emoji}abcd`, 2), '…')
  // A cut that does not split a pair is unchanged.
  assert.equal(truncateDescription(`${emoji}abcd`, 5), `${emoji}ab…`)
  // Whole description fits: untouched.
  assert.equal(truncateDescription(emoji, 2), emoji)
  // No truncated result ever ends on an orphaned high surrogate.
  for (const text of [`${'x'.repeat(199)}${emoji}`, `x${emoji}${'y'.repeat(50)}`, emoji.repeat(3)]) {
    for (const limit of [3, 5, 200]) {
      const cut = truncateDescription(text, limit)
      assert.ok(!/[\uD800-\uDBFF]$/.test(cut), `orphan surrogate in ${JSON.stringify(cut)}`)
    }
  }
})

test('catalog: server filter selects one group; unknown server is a structured error', () => {
  const options = { prefix: 'mcp__', descriptionLimit: 200 }
  const filtered = buildMcpListResult({ server: 'gh' }, catalogSchemas(), options)
  assert.deepEqual(filtered.servers.map(group => group.server), ['gh'])
  const missing = buildMcpListResult({ server: 'nope' }, catalogSchemas(), options)
  assert.match(missing.error, /no MCP tools match server "nope"/)
})

test('catalog: naming one tool expands its full untruncated schema', () => {
  const long = 'y'.repeat(500)
  const schemas = [schema('mcp__s__t', long, { type: 'object', properties: { a: { type: 'number' } } })]
  const result = buildMcpListResult({ tool: 'mcp__s__t' }, schemas, { prefix: 'mcp__', descriptionLimit: 10 })
  assert.deepEqual(result, {
    tool: { name: 'mcp__s__t', description: long, parameters: { type: 'object', properties: { a: { type: 'number' } } } },
  })
})

test('catalog: verbose inlines every schema into the catalog', () => {
  const result = buildMcpListResult({ verbose: true }, [schema('mcp__s__t', 'd', { type: 'object' })], { prefix: 'mcp__', descriptionLimit: 200 })
  assert.deepEqual(result.servers[0].tools[0], { name: 'mcp__s__t', description: 'd', parameters: { type: 'object' } })
})

test('catalog: unknown or non-MCP tool names return structured errors, never throw', () => {
  const options = { prefix: 'mcp__', descriptionLimit: 200 }
  const unknown = buildMcpListResult({ tool: 'mcp__nope__x' }, catalogSchemas(), options)
  assert.match(unknown.error, /unknown MCP tool "mcp__nope__x"/)
  const foreign = buildMcpListResult({ tool: 'read' }, catalogSchemas(), options)
  assert.match(foreign.error, /not an MCP tool/)
  const empty = buildMcpListResult({}, [schema('read')], options)
  assert.match(empty.error, /no MCP tools are registered/)
})

test('catalog: a pathological prefix never lists or expands the meta-tools themselves', () => {
  // 'mcp_' matches the meta-tool names; both must stay out of every path.
  const options = { prefix: 'mcp_', descriptionLimit: 200 }
  const schemas = [
    schema(MCP_LIST_TOOL_NAME, 'catalog meta-tool'),
    schema(MCP_CALL_TOOL_NAME, 'dispatch meta-tool'),
    schema('mcp_ask_user', 'some other prefixed tool'),
  ]
  const result = buildMcpListResult({}, schemas, options)
  assert.deepEqual(result.servers.flatMap(group => group.tools.map(tool => tool.name)), ['mcp_ask_user'])
  // Point-name expansion is refused in the same style as dispatch refusals.
  assert.match(buildMcpListResult({ tool: MCP_LIST_TOOL_NAME }, schemas, options).error, /refusing to expand "mcp_list"/)
  assert.match(buildMcpListResult({ tool: MCP_CALL_TOOL_NAME }, schemas, options).error, /refusing to expand "mcp_call"/)
})

test('catalog: server names come from the first __ segment after the prefix', () => {
  assert.equal(serverOfToolName('mcp__fs__read_file', 'mcp__'), 'fs')
  assert.equal(serverOfToolName('mcp__a__b__c', 'mcp__'), 'a')
  // Degenerate shapes degrade predictably: no separator → whole rest, and a
  // name not longer than the prefix → empty segment.
  assert.equal(serverOfToolName('mcp__single', 'mcp__'), 'single')
  assert.equal(serverOfToolName('other', 'mcp__'), '')
})

test('catalog: the optional servers whitelist admits only named servers', () => {
  const servers = ['fs', 'gh']
  assert.equal(isAllowedServer('mcp__fs__t', 'mcp__', servers), true)
  assert.equal(isAllowedServer('mcp__other__t', 'mcp__', servers), false)
  // Empty whitelist = no filtering: the prefix alone decides.
  assert.equal(isAllowedServer('mcp__other__t', 'mcp__', []), true)
})

test('catalog: model arguments are normalized defensively', () => {
  assert.deepEqual(normalizeMcpListArgs({ tool: 'mcp__s__t', server: 's', verbose: true, junk: 1 }),
    { tool: 'mcp__s__t', server: 's', verbose: true })
  assert.deepEqual(normalizeMcpListArgs(null), {})
  assert.deepEqual(normalizeMcpListArgs([1, 2]), {})
  assert.deepEqual(normalizeMcpListArgs({ tool: 42, verbose: 'yes' }), {})
})

// ---- dispatch (mcp_call) ----

function fakeTool(behavior = {}) {
  const calls = []
  const tool = {
    calls,
    timeoutMs: behavior.timeoutMs,
    async execute(args, exec) {
      calls.push({ args, exec })
      if (behavior.fail) throw new Error(behavior.fail)
      return behavior.value !== undefined ? behavior.value : { ok: true, args }
    },
  }
  return tool
}

test('mcp_call: non-prefix tool names are refused without resolving', async () => {
  let resolved = 0
  const resolve = (name) => { resolved += 1; return undefined }
  const result = await dispatchMcpCall({ tool: 'read', arguments: {} }, 'mcp__', resolve, execLike())
  assert.match(result.error, /refusing to call "read"/)
  assert.equal(resolved, 0)
})

test('mcp_call: unresolvable tools (unknown or restricted away) are a structured error', async () => {
  const result = await dispatchMcpCall({ tool: 'mcp__fs__nope' }, 'mcp__', () => undefined, execLike())
  assert.match(result.error, /not registered or not visible/)
})

test('mcp_call: arguments pass through verbatim; missing arguments become {}', async () => {
  const tool = fakeTool()
  const first = await dispatchMcpCall({ tool: 'mcp__fs__t', arguments: { path: '/x', n: 3 } }, 'mcp__', () => tool, execLike())
  assert.deepEqual(first.args, { path: '/x', n: 3 })
  const second = await dispatchMcpCall({ tool: 'mcp__fs__t' }, 'mcp__', () => tool, execLike())
  assert.deepEqual(second.args, {})
})

test('mcp_call: non-object arguments reach the child verbatim (the child coerces)', async () => {
  // A misbehaving model can send a bare string; the official executor
  // coerces at the child boundary, so dispatch must not coerce first.
  const tool = fakeTool()
  const str = await dispatchMcpCall({ tool: 'mcp__fs__t', arguments: 'oops' }, 'mcp__', () => tool, execLike())
  assert.equal(str.args, 'oops')
  // Null is nullish: the `?? {}` fallback applies, like a missing key.
  const nul = await dispatchMcpCall({ tool: 'mcp__fs__t', arguments: null }, 'mcp__', () => tool, execLike())
  assert.deepEqual(nul.args, {})
})

test('mcp_call: exec is forwarded as-is (same reference) to the child body', async () => {
  const tool = fakeTool()
  const exec = execLike({ agent: { id: 'agent-1' } })
  await dispatchMcpCall({ tool: 'mcp__fs__t' }, 'mcp__', () => tool, exec)
  assert.strictEqual(tool.calls[0].exec, exec)
})

test('mcp_call: a child rejection is wrapped into a structured error, not rethrown', async () => {
  const tool = fakeTool({ fail: 'boom' })
  const result = await dispatchMcpCall({ tool: 'mcp__fs__t' }, 'mcp__', () => tool, execLike())
  assert.match(result.error, /MCP tool "mcp__fs__t" failed: boom/)
})

test('mcp_call: bad argument shapes are structured errors', async () => {
  const notObject = await dispatchMcpCall('read', 'mcp__', () => undefined, execLike())
  assert.match(notObject.error, /expects an object/)
  const noTool = await dispatchMcpCall({ arguments: {} }, 'mcp__', () => undefined, execLike())
  assert.match(noTool.error, /requires a string "tool"/)
})

test('mcp_call: meta-tools are never dispatchable, even under a matching prefix', async () => {
  const result = await dispatchMcpCall({ tool: 'mcp_list' }, 'mcp_', () => ({ async execute() { throw new Error('must not run') } }), execLike())
  assert.match(result.error, /meta-tools are not dispatchable/)
})

test('mcp_call: a declared timeoutMs races a deadline; undeclared tools are not raced', async () => {
  const slow = {
    timeoutMs: 10,
    execute: () => new Promise(() => {}),
  }
  const timedOut = await dispatchMcpCall({ tool: 'mcp__fs__t' }, 'mcp__', () => slow, execLike())
  assert.match(timedOut.error, /timed out after 10ms/)
  // Without a declared timeoutMs the (never-settling) body would hang — so
  // prove the no-race branch with a normally resolving tool instead.
  const fast = fakeTool({ value: { content: [] } })
  const value = await dispatchMcpCall({ tool: 'mcp__fs__t' }, 'mcp__', () => fast, execLike())
  assert.deepEqual(value, { content: [] })
})

// ---- servers whitelist (fold / catalog / dispatch consistency) ----

test('servers whitelist: fold, catalog, and dispatch apply one server set consistently', async () => {
  const servers = ['fs']
  // Fold: the whitelisted server folds; the non-whitelisted one stays native
  // (still registered, still directly callable — just not this adapter's business).
  const input = assembly([schema('read'), schema('mcp__fs__t'), schema('mcp__gh__t')])
  const folded = foldPromptAssembly(input, { prefix: 'mcp__', keep: [], servers }, true)
  assert.deepEqual(folded.tools.map(tool => tool.name), ['read', 'mcp__gh__t'])
  // Catalog: only whitelisted tools are listed; expanding others is refused.
  const options = { prefix: 'mcp__', descriptionLimit: 200, servers }
  assert.deepEqual(buildMcpListResult({}, catalogSchemas(), options).servers.map(group => group.server), ['fs'])
  assert.match(
    buildMcpListResult({ tool: 'mcp__gh__create_issue' }, catalogSchemas(), options).error,
    /not in the configured servers list/,
  )
  // Dispatch: refused before the definition is even resolved.
  let resolved = 0
  const refused = await dispatchMcpCall({ tool: 'mcp__gh__t' }, 'mcp__', () => { resolved += 1; return fakeTool() }, execLike(), servers)
  assert.match(refused.error, /refusing to call "mcp__gh__t"/)
  assert.equal(resolved, 0)
  // A whitelisted server still dispatches.
  const ok = await dispatchMcpCall({ tool: 'mcp__fs__t' }, 'mcp__', () => fakeTool(), execLike(), servers)
  assert.deepEqual(ok, { ok: true, args: {} })
  // An empty whitelist keeps the prefix-only behavior everywhere.
  const all = foldPromptAssembly(assembly([schema('mcp__fs__t'), schema('mcp__gh__t')]), { prefix: 'mcp__', keep: [], servers: [] }, true)
  assert.deepEqual(all.tools.map(tool => tool.name), [])
})

// ---- meta-tool factories ----

test('mcp_list tool: execute builds the catalog from the calling agent\'s visible schemas', async () => {
  const scopes = []
  const tool = createMcpListTool(
    { prefix: 'mcp__', descriptionLimit: 200 },
    (scope) => { scopes.push(scope); return catalogSchemas() },
  )
  const agent = { id: 'agent-1' }
  const value = await tool.execute({}, execLike({ agent }))
  assert.deepEqual(scopes, [agent])
  assert.deepEqual(value.servers.map(group => group.server), ['fs', 'gh'])
  // render projects structured values to a text block
  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('mcp__fs__read_file'))
})

test('mcp_call tool: execute resolves the definition in the calling agent\'s scope', async () => {
  const child = fakeTool({ value: { content: [{ type: 'text', text: 'hi' }] } })
  const seen = []
  const tool = createMcpCallTool('mcp__', (name, scope) => { seen.push([name, scope]); return child })
  const agent = { id: 'agent-2' }
  const value = await tool.execute({ tool: 'mcp__fs__t', arguments: { a: 1 } }, execLike({ agent }))
  assert.deepEqual(seen, [['mcp__fs__t', agent]])
  assert.deepEqual(value, { content: [{ type: 'text', text: 'hi' }] })
  // Errors render as plain text for self-correction.
  const failed = fakeTool({ fail: 'nope' })
  const failing = createMcpCallTool('mcp__', () => failed)
  const errorValue = await failing.execute({ tool: 'mcp__fs__t' }, execLike())
  const rendered = failing.output.render({}, errorValue)
  assert.equal(rendered[0].text, errorValue.error)
})

test('meta-tool names and parameters follow the declared contract', () => {
  const list = createMcpListTool({ prefix: 'mcp__', descriptionLimit: 200 }, () => [])
  const call = createMcpCallTool('mcp__', () => undefined)
  assert.equal(list.name, MCP_LIST_TOOL_NAME)
  assert.equal(call.name, MCP_CALL_TOOL_NAME)
  assert.deepEqual(call.parameters.required, ['tool'])
  assert.ok(list.description.includes('mcp_call'))
  assert.ok(call.description.includes('mcp_list'))
})

// ---- child projection delegation (finalizeContent / render) ----

/**
 * Fake child mirroring the official mcp-client projection pattern: execute
 * stages a rich image projection keyed by the exact exec object (upstream
 * uses a WeakMap); finalizeContent hands it back only for a success result
 * that still deep-equals the staged value AND whose content deep-equals the
 * child's own output.render fallback.
 */
function projectionChild(value) {
  const executeCalls = []
  const finalizeCalls = []
  const staged = new Map()
  const projected = [{ type: 'image', attachment: { id: 'att-1' } }]
  const child = {
    executeCalls,
    finalizeCalls,
    projected,
    output: {
      render(_args, v) {
        return [{ type: 'text', text: `native-render:${JSON.stringify(v)}` }]
      },
    },
    async execute(args, exec) {
      executeCalls.push({ args, exec })
      staged.set(exec, projected)
      return value
    },
    finalizeContent(exec, result) {
      finalizeCalls.push({ exec, result })
      const content = staged.get(exec)
      if (content === undefined) return undefined
      if (result.isError) return undefined
      if (JSON.stringify(result.value) !== JSON.stringify(value)) return undefined
      if (JSON.stringify(result.content) !== JSON.stringify(child.output.render(undefined, value))) return undefined
      return content
    },
  }
  return child
}

test('mcp_call: finalizeContent forwards to the dispatched child and restores its projection', async () => {
  const value = {
    content: [
      { type: 'text', text: 'plotted' },
      { type: 'image', mimeType: 'image/png', data: 'aGk=' },
    ],
  }
  const child = projectionChild(value)
  const call = createMcpCallTool('mcp__', () => child)
  const exec = execLike({ arguments: { tool: 'mcp__chart__render', arguments: { kind: 'bar' } } })
  // The registry pipeline shape: execute → output.render → finalizeContent.
  const dispatched = await call.execute(exec.arguments, exec)
  assert.deepEqual(dispatched, value)
  const content = call.output.render(exec.arguments, dispatched)
  // Render is delegated to the child, so text matches a native call.
  assert.equal(content[0].type, 'text')
  assert.ok(content[0].text.startsWith('native-render:'))
  const projected = call.finalizeContent(exec, { isError: false, value: dispatched, content })
  assert.deepEqual(projected, [{ type: 'image', attachment: { id: 'att-1' } }])
  // The child was consulted with the SAME exec object dispatch forwarded —
  // that object identity is the WeakMap key that makes the staged
  // projection recoverable at all.
  assert.strictEqual(child.executeCalls[0].exec, exec)
  assert.strictEqual(child.finalizeCalls[0].exec, exec)
  assert.equal(child.finalizeCalls[0].result.isError, false)
  assert.deepEqual(child.finalizeCalls[0].result.value, value)
  // The synthesized child-view content equals the render fallback the child
  // itself expects (what the registry would have computed for a native call).
  assert.deepEqual(child.finalizeCalls[0].result.content, content)
})

test('mcp_call: finalizeContent never forwards failures, error wraps, or finalizer-less children', async () => {
  const value = { content: [{ type: 'text', text: 'ok' }] }
  const child = projectionChild(value)
  const call = createMcpCallTool('mcp__', () => child)
  const exec = execLike({ arguments: { tool: 'mcp__s__t' } })
  await call.execute(exec.arguments, exec)
  const before = child.finalizeCalls.length
  // Pipeline failure (isError): the registry-computed content is preserved.
  assert.equal(
    call.finalizeContent(exec, { isError: true, error: { message: 'blocked' }, content: [] }),
    undefined,
  )
  // Dispatch-level failure wrap ({ error } value, not the child's): skipped.
  assert.equal(
    call.finalizeContent(exec, {
      isError: false,
      value: { error: 'MCP tool "mcp__s__t" failed: boom' },
      content: [{ type: 'text', text: 'MCP tool "mcp__s__t" failed: boom' }],
    }),
    undefined,
  )
  assert.equal(child.finalizeCalls.length, before) // the child was not consulted
  // A child without finalizeContent degrades to undefined.
  const plain = fakeTool({ value })
  const plainCall = createMcpCallTool('mcp__', () => plain)
  const plainExec = execLike({ arguments: { tool: 'mcp__s__t' } })
  const plainValue = await plainCall.execute(plainExec.arguments, plainExec)
  assert.equal(plainCall.finalizeContent(plainExec, { isError: false, value: plainValue, content: [] }), undefined)
  // An unresolvable child (unregistered mid-flight) degrades too.
  const gone = createMcpCallTool('mcp__', () => undefined)
  assert.equal(gone.finalizeContent(exec, { isError: false, value, content: [] }), undefined)
  // A throwing child finalizer must not break the outer materialization.
  const hostile = {
    output: { render: () => [{ type: 'text', text: 'x' }] },
    finalizeContent() { throw new Error('hostile finalizer') },
  }
  const hostileCall = createMcpCallTool('mcp__', () => hostile)
  assert.equal(hostileCall.finalizeContent(exec, { isError: false, value, content: [] }), undefined)
})

test('mcp_call: output.render delegates to the child render; error wraps and misses stay plain', () => {
  const value = { content: [{ type: 'text', text: 'hi' }] }
  const child = projectionChild(value)
  const call = createMcpCallTool('mcp__', name => name === 'mcp__s__t' ? child : undefined)
  const args = { tool: 'mcp__s__t', arguments: { a: 1 } }
  // Delegated: exactly the child's own projection of the value.
  assert.deepEqual(call.output.render(args, value), child.output.render(undefined, value))
  // A dispatch error wrap renders as its plain text, never delegated.
  assert.deepEqual(call.output.render(args, { error: 'nope' }), [{ type: 'text', text: 'nope' }])
  // Child unresolvable from the arguments → pretty-JSON fallback.
  const gone = createMcpCallTool('mcp__', () => undefined)
  assert.deepEqual(gone.output.render(args, value), [{ type: 'text', text: JSON.stringify(value, null, 2) }])
  // Child render throwing → pretty-JSON fallback, not a pipeline failure.
  const hostile = { output: { render() { throw new Error('bad render') } } }
  const hostileCall = createMcpCallTool('mcp__', () => hostile)
  assert.deepEqual(hostileCall.output.render(args, value), [{ type: 'text', text: JSON.stringify(value, null, 2) }])
})

// ---- apply() smoke (hand-written ctx stub, no mock framework) ----

const BASE_CONFIG = { prefix: 'mcp__', keep: [], servers: [], descriptionLimit: 200 }

function fakeCtx({ failOn } = {}) {
  const state = {
    registered: new Map(), listeners: [], effects: [], warnings: [],
    commands: new Map(), injections: [],
  }
  const ctx = {
    tools: {
      register(definition) {
        if (definition.name === failOn) throw new Error(`name conflict on ${definition.name}`)
        state.registered.set(definition.name, definition)
        return () => state.registered.delete(definition.name)
      },
      get(name) { return state.registered.get(name) },
      schemas() {
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
    // No settings service composed here: apply's optional gating wiring
    // degrades to "everything enabled" and records the request.
    inject(services, callback) {
      state.injections.push([...services])
      return () => {}
    },
    on(event, listener) {
      state.listeners.push({ event, listener })
      return () => { state.listeners = state.listeners.filter(entry => entry.listener !== listener) }
    },
    // Mirrors cordis semantics: the callback runs at registration time and
    // its return value is the scope disposer.
    effect(execute, label) {
      const disposer = execute()
      state.effects.push({ disposer, label })
      return disposer
    },
    logger: { warn(message) { state.warnings.push(message) } },
  }
  return { ctx, state }
}

test('apply(): registers both meta-tools and folds assemblies through the installed listener', async () => {
  const { ctx, state } = fakeCtx()
  apply(ctx, BASE_CONFIG)
  assert.deepEqual([...state.registered.keys()].sort(), [MCP_CALL_TOOL_NAME, MCP_LIST_TOOL_NAME])
  const entries = state.listeners.filter(entry => entry.event === 'system-prompt/assemble')
  assert.equal(entries.length, 1)
  // A folded MCP tool exists in the registry; the assembly carries its schema.
  state.registered.set('mcp__fs__read_file', schema('mcp__fs__read_file'))
  const input = assembly([
    schema('read'),
    schema('mcp__fs__read_file'),
    schema(MCP_LIST_TOOL_NAME),
    schema(MCP_CALL_TOOL_NAME),
  ])
  const folded = await entries[0].listener(input, { scope: 'agent-1' }, () => Promise.resolve(input))
  assert.deepEqual(folded.tools.map(tool => tool.name), ['read', MCP_LIST_TOOL_NAME, MCP_CALL_TOOL_NAME])
  // Effect-scoped teardown unregisters exactly the meta-tools.
  const metaToolsEffect = state.effects.find(effect => effect.label === 'mcp-adapter.metaTools')
  assert.notEqual(metaToolsEffect, undefined)
  metaToolsEffect.disposer()
  assert.deepEqual([...state.registered.keys()], ['mcp__fs__read_file'])
})

test('apply(): meta-tool registration failure rolls back, warns, and installs no listener', () => {
  const { ctx, state } = fakeCtx({ failOn: MCP_CALL_TOOL_NAME })
  apply(ctx, BASE_CONFIG)
  // The successfully registered mcp_list was rolled back; nothing remains.
  assert.equal(state.registered.size, 0)
  assert.equal(state.listeners.length, 0)
  assert.equal(state.effects.length, 0)
  // One warning explains the fail-open degradation.
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /meta-tool registration failed/)
  assert.match(state.warnings[0], /name conflict on mcp_call/)
})

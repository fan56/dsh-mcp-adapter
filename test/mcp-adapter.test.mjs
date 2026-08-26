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
  truncateDescription,
  buildMcpListResult,
  dispatchMcpCall,
  createMcpListTool,
  createMcpCallTool,
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

test('catalog: server names come from the first __ segment after the prefix', () => {
  assert.equal(serverOfToolName('mcp__fs__read_file', 'mcp__'), 'fs')
  assert.equal(serverOfToolName('mcp__a__b__c', 'mcp__'), 'a')
  // Degenerate shapes degrade predictably: no separator → whole rest, and a
  // name not longer than the prefix → empty segment.
  assert.equal(serverOfToolName('mcp__single', 'mcp__'), 'single')
  assert.equal(serverOfToolName('other', 'mcp__'), '')
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

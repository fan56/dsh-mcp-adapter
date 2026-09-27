// Seam C (mcp_call's unknown-tool branch): did-you-mean.
//
// The contract this file protects: the pre-seam error sentence must survive
// byte for byte, and every jev outcome — declined, throwing, unusable — must
// land on the lexical order rather than on an exception. The suggestion is an
// addition to a message the model was already going to read, never a
// replacement of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchMcpCall,
  didYouMeanPool,
  createMcpCallTool,
  MCP_CALL_TOOL_NAME,
  MCP_LIST_TOOL_NAME,
  DID_YOU_MEAN_POOL_LIMIT,
} from '../lib/index.js'
import { didYouMeanCandidates, didYouMeanMessage, editDistanceWithin, DID_YOU_MEAN_MAX_DISTANCE } from '../lib/rank.js'

const BASE_ERROR = tool => `tool "${tool}" is not registered or not visible in this scope — call ${MCP_LIST_TOOL_NAME} to see the catalog`

function schema(name, description = '') {
  return { name, description, parameters: { type: 'object', properties: {} } }
}

function execLike(agent) {
  return { agent, signal: new AbortController().signal }
}

const POOL = [
  { name: 'mcp__gh__create_issue', description: 'Create an issue on GitHub' },
  { name: 'mcp__gh__close_issue', description: 'Close an issue' },
  { name: 'mcp__gh__list_issues', description: 'List issues' },
  { name: 'mcp__fs__read_file', description: 'Read a file' },
  { name: 'mcp__fs__write_file', description: 'Write a file' },
]

// ---- the lexical prefilter (pure) ----

test('seam C: edit distance is bounded and case-insensitive', () => {
  assert.equal(editDistanceWithin('mcp__fs__read_file', 'mcp__fs__read_file', 3), 0)
  assert.equal(editDistanceWithin('mcp__fs__read_fil', 'mcp__fs__read_file', 3), 1)
  assert.equal(editDistanceWithin('mcp__gh__create_issue', 'MCP__GH__CREATE_ISSUE', 3), 0)
  assert.equal(editDistanceWithin('abc', 'xyz', 3), 3)
  assert.equal(editDistanceWithin('abc', 'wxyz', 3), undefined, 'beyond the bound reports "no"')
  assert.equal(editDistanceWithin('a', 'abcdefgh', 3), undefined, 'the length pre-check short-circuits')
  assert.equal(editDistanceWithin('kitten', 'sitting', 2), undefined)
})

test('seam C: near-misses are edit hits first, token hits second', () => {
  const found = didYouMeanCandidates('mcp__fs__read_fil', POOL.map(entry => entry.name), 10, ['mcp'])
  assert.equal(found[0].name, 'mcp__fs__read_file')
  assert.equal(found[0].tier, 'edit')
  assert.equal(found[0].distance, 1)
  // The fs sibling shares the server segment; the gh tools share nothing once
  // the fold prefix stops counting as evidence.
  assert.deepEqual(found.slice(1).map(entry => entry.name), ['mcp__fs__write_file'])
  assert.equal(found[1].tier, 'token')
  assert.ok(found.every(entry => entry.name !== 'mcp__fs__read_fil'), 'the name itself is never suggested')
})

test('seam C: the fold prefix is not evidence of a near-miss', () => {
  const names = POOL.map(entry => entry.name)
  // Without the ignore list, "shares mcp" makes every tool a candidate — the
  // set fills the display cap with noise.
  assert.equal(didYouMeanCandidates('mcp__zz__unrelated', names).length, 3)
  assert.deepEqual(didYouMeanCandidates('mcp__zz__unrelated', names, 10, ['mcp']), [])
  // The server segment IS evidence: fs is kept.
  assert.deepEqual(
    didYouMeanCandidates('mcp__fs__unrelated', names, 10, ['mcp']).map(entry => entry.name),
    ['mcp__fs__read_file', 'mcp__fs__write_file'],
  )
})

test('seam C: a typo of the tool segment beats a mere token sibling', () => {
  const pool = ['mcp__gh__list_prs', 'mcp__gh__list_issues', 'mcp__gh__create_issue']
  const found = didYouMeanCandidates('mcp__gh__list_issue', pool, 3)
  assert.deepEqual(found.map(entry => entry.name), ['mcp__gh__list_issues', 'mcp__gh__list_prs', 'mcp__gh__create_issue'])
})

test('seam C: no near-miss yields no candidates, and the default limit is three', () => {
  assert.deepEqual(didYouMeanCandidates('mcp__zz__unrelated_name', POOL.map(e => e.name), 10, ['mcp']), [])
  const found = didYouMeanCandidates('mcp__fs__read_fil', POOL.map(e => e.name), 10, ['mcp'])
  assert.equal(found.length, 2)
  assert.equal(didYouMeanCandidates('mcp__fs__read_fil', POOL.map(e => e.name), 1, ['mcp']).length, 1, 'the limit trims, it does not filter')
  assert.equal(DID_YOU_MEAN_MAX_DISTANCE, 3)
  assert.equal(DID_YOU_MEAN_POOL_LIMIT, 40, 'the cold pool ceiling matches the jev batch ceiling')
})

test('seam C: the message states its own provenance, and nothing when empty', () => {
  assert.equal(didYouMeanMessage([], 'lexical'), '')
  assert.equal(
    didYouMeanMessage(['mcp__fs__read_file', 'mcp__fs__readdir'], 'lexical'),
    ' Did you mean: "mcp__fs__read_file", "mcp__fs__readdir"? (lexical)',
  )
  assert.match(didYouMeanMessage(['a'], 'jev'), /\(jev reranked\)$/)
})

// ---- the dispatch branch ----

test('seam C: without the seam the error is the pre-seam sentence, byte for byte', async () => {
  const value = await dispatchMcpCall({ tool: 'mcp__fs__read_fil' }, 'mcp__', () => undefined, execLike())
  assert.deepEqual(value, { error: BASE_ERROR('mcp__fs__read_fil') })
})

test('seam C: an empty pool leaves the message exactly as it was', async () => {
  const hook = { candidates: () => [] }
  const value = await dispatchMcpCall({ tool: 'mcp__fs__read_fil' }, 'mcp__', () => undefined, execLike(), [], undefined, hook)
  assert.deepEqual(value, { error: BASE_ERROR('mcp__fs__read_fil') })
})

test('seam C: a pool with no near-miss leaves the message exactly as it was', async () => {
  const hook = { candidates: () => POOL }
  const value = await dispatchMcpCall({ tool: 'mcp__zz__unrelated_name' }, 'mcp__', () => undefined, execLike(), [], undefined, hook)
  assert.deepEqual(value, { error: BASE_ERROR('mcp__zz__unrelated_name') })
})

test('seam C: the lexical fallback names the near-misses and says so', async () => {
  const hook = { candidates: () => POOL }
  const value = await dispatchMcpCall({ tool: 'mcp__fs__read_fil' }, 'mcp__', () => undefined, execLike(), [], undefined, hook)
  assert.ok(value.error.startsWith(BASE_ERROR('mcp__fs__read_fil')), 'the pre-seam sentence is still the prefix')
  assert.match(value.error, / Did you mean: "mcp__fs__read_file", "mcp__fs__write_file"\? \(lexical\)$/)
})

test('seam C: a reranker that reorders wins, and the message says it was jev', async () => {
  const asked = []
  const hook = {
    candidates: () => POOL,
    rerank: async (tool, candidates) => {
      asked.push({ tool, names: candidates.map(entry => entry.name) })
      return ['mcp__fs__write_file', 'mcp__fs__read_file']
    },
  }
  const value = await dispatchMcpCall({ tool: 'mcp__fs__read_fil' }, 'mcp__', () => undefined, execLike(), [], undefined, hook)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].tool, 'mcp__fs__read_fil')
  assert.equal(asked[0].names.length, 2, 'the reranker sees the whole lexical pool, not the three shown')
  assert.ok(value.error.endsWith('(jev reranked)'))
  assert.ok(value.error.indexOf('mcp__fs__write_file') < value.error.indexOf('mcp__fs__read_file'), 'jev\'s pick leads')
  assert.ok(value.error.startsWith(BASE_ERROR('mcp__fs__read_fil')))
})

test('seam C: a reranker that declines, returns junk, or throws keeps the lexical answer', async () => {
  const decliners = [
    async () => undefined,
    async () => [],
    async () => ['not_a_tool_at_all'],
    async () => { throw new Error('jev exploded') },
  ]
  for (const rerank of decliners) {
    const hook = { candidates: () => POOL, rerank }
    const value = await dispatchMcpCall({ tool: 'mcp__fs__read_fil' }, 'mcp__', () => undefined, execLike(), [], undefined, hook)
    assert.ok(value.error.endsWith('(lexical)'), 'the lexical order and its label stand')
    assert.ok(value.error.includes('"mcp__fs__read_file"'))
  }
})

test('seam C: a single near-miss is not worth a rerank, but is still shown', async () => {
  let rerankCalls = 0
  const hook = {
    candidates: () => [{ name: 'mcp__fs__read_file', description: 'Read a file' }],
    rerank: async () => { rerankCalls += 1; return undefined },
  }
  const value = await dispatchMcpCall({ tool: 'mcp__fs__read_fil' }, 'mcp__', () => undefined, execLike(), [], undefined, hook)
  assert.equal(rerankCalls, 0, 'one candidate cannot be reordered')
  assert.ok(value.error.endsWith('"mcp__fs__read_file"? (lexical)'))
})

test('seam C: a throwing pool is contained like any other seam failure', async () => {
  const hook = { candidates: () => { throw new Error('registry exploded') } }
  const value = await dispatchMcpCall({ tool: 'mcp__fs__read_fil' }, 'mcp__', () => undefined, execLike(), [], undefined, hook)
  assert.deepEqual(value, { error: BASE_ERROR('mcp__fs__read_fil') })
})

test('seam C: the seam never touches a successful dispatch', async () => {
  let calls = 0
  const child = { timeoutMs: undefined, async execute() { calls += 1; return { ok: true } } }
  let poolCalls = 0
  const hook = { candidates: () => { poolCalls += 1; return POOL } }
  const value = await dispatchMcpCall({ tool: 'mcp__fs__read_file' }, 'mcp__', name => (name === 'mcp__fs__read_file' ? child : undefined), execLike(), [], undefined, hook)
  assert.deepEqual(value, { ok: true })
  assert.equal(calls, 1)
  assert.equal(poolCalls, 0, 'the pool is only read on the unknown-tool branch')
})

// ---- the pool builder (pure) ----

test('seam C: the pool is this scope\'s dispatchable prefix tools', () => {
  const schemas = [schema('read'), schema(MCP_LIST_TOOL_NAME), schema(MCP_CALL_TOOL_NAME), ...POOL.map(p => schema(p.name, p.description))]
  assert.deepEqual(
    didYouMeanPool(schemas, { prefix: 'mcp__', servers: [] }).map(entry => entry.name),
    POOL.map(entry => entry.name),
    'meta-tools and native tools are not dispatchable, so they are not suggested',
  )
  assert.deepEqual(
    didYouMeanPool(schemas, { prefix: 'mcp__', servers: ['gh'] }).map(entry => entry.name),
    ['mcp__gh__create_issue', 'mcp__gh__close_issue', 'mcp__gh__list_issues'],
  )
  // A disabled server's tools cannot be dispatched, so naming one would be
  // advice the model cannot take.
  const off = didYouMeanPool(schemas, { prefix: 'mcp__', servers: [] }, { serverIds: { fs: 1, gh: 2 }, disabled: [1] })
  assert.deepEqual(off.map(entry => entry.name), POOL.filter(p => !p.name.startsWith('mcp__fs__')).map(p => p.name))
  assert.equal(didYouMeanPool(schemas, { prefix: 'mcp__', servers: [] })[0].description, 'Create an issue on GitHub', 'the pool carries the blurb a reranker needs')
})

// ---- the tool wiring ----

test('seam C: the tool binds the pool to the calling agent\'s scope', async () => {
  const seen = []
  const tool = createMcpCallTool(
    'mcp__',
    (name, scope) => { seen.push([name, scope]); return name === 'mcp__fs__read_file' ? { execute: async () => ({ ok: true }) } : undefined },
    [],
    undefined,
    {
      didYouMean: scope => { seen.push(['pool', scope]); return POOL },
      didYouMeanRank: async (scope, toolName) => { seen.push(['rank', scope, toolName]); return undefined },
    },
  )
  const agent = { id: 'agent-1' }
  const value = await tool.execute({ tool: 'mcp__fs__read_fil' }, execLike(agent))
  assert.ok(value.error.includes('Did you mean'))
  assert.ok(value.error.endsWith('(lexical)'), 'no reranker opinion, lexical label')
  assert.deepEqual(seen, [['mcp__fs__read_fil', agent], ['pool', agent], ['rank', agent, 'mcp__fs__read_fil']])
})

test('seam C: an unknown tool still renders as plain text for self-correction', async () => {
  const tool = createMcpCallTool('mcp__', () => undefined, [], undefined, { didYouMean: () => POOL })
  const value = await tool.execute({ tool: 'mcp__fs__read_fil' }, execLike())
  const rendered = tool.output.render({ tool: 'mcp__fs__read_fil' }, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].text, value.error)
  assert.equal(tool.name, MCP_CALL_TOOL_NAME)
})

test('seam C: every refusal BEFORE the unknown branch stays suggestion-free', async () => {
  const cases = [
    [{ tool: 'read' }, 'mcp_', 'dispatches only tools named with the "mcp_" prefix'],
    [{ tool: MCP_CALL_TOOL_NAME }, 'mcp_', 'meta-tools are not dispatchable'],
    [{ tool: 'mcp__zz__t' }, 'mcp__', 'is not in the configured servers list'],
  ]
  for (const [args, prefix, fragment] of cases) {
    const hook = { candidates: () => POOL }
    const value = await dispatchMcpCall(args, prefix, () => undefined, execLike(), ['gh'], undefined, hook)
    assert.ok(value.error.includes(fragment), value.error)
    assert.ok(!value.error.includes('Did you mean'), 'only the unknown-tool branch offers near-misses')
  }
  const gated = await dispatchMcpCall(
    { tool: 'mcp__fs__read_fil' }, 'mcp__', () => undefined, execLike(), [], { serverIds: { fs: 1 }, disabled: [1] }, { candidates: () => POOL },
  )
  assert.match(gated.error, /server "fs" is disabled/)
  assert.ok(!gated.error.includes('Did you mean'), 'a disabled server explains itself instead')
})

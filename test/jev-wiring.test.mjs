// Configuration + apply() wiring for the three seams: the seven jev settings
// in the schema, the /mcp config view, the two ranking seams end to end
// through the real meta-tools, and the guarantees the whole feature rests on
// (red line ① no remote call on a hot path, red line ③ no write to keep/gate).
//
// Hermetic: globalThis.fetch is stubbed per test, every document lives in a
// scratch gate dir, and ambient key env vars are deleted up front.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const k of ['TYPESAFE_API_KEY', 'JEV_ZEN_API_KEY', 'OPENROUTER_API_KEY', 'JEV_KEYCHAIN']) delete process.env[k]

const {
  apply,
  Config,
  renderMcpConfig,
  executeMcpCommand,
  MCP_LIST_TOOL_NAME,
  MCP_CALL_TOOL_NAME,
  GATE_FILE_NAME,
} = await import('../lib/index.js')
const { JEV_CONFIG_KEYS } = await import('../lib/jev/config.js')
const { rankListQuery, rankDidYouMean, orderFromChoice, noulProbability } = await import('../lib/jev/seams.js')
const { createDecisionLog } = await import('../lib/jev/log.js')
const { DEFAULT_LAYA_URL } = await import('../lib/jev/dual.js')
const { suggestionsFile, usageFile } = await import('../lib/usage.js')

const TMP = mkdtempSync(join(tmpdir(), 'mcp-adapter-jev-wiring-'))
process.env.DSH_HOME = TMP

const ZEN_KEY = 'test-zen-key-0123456789abcdef'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** One test: a scratch gate dir, an injected key, a stubbed backend. */
function withBackend(t, respond) {
  const dir = mkdtempSync(join(TMP, 'gate-'))
  const log = createDecisionLog(dir)
  const prevKey = process.env.JEV_ZEN_API_KEY
  process.env.JEV_ZEN_API_KEY = ZEN_KEY
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), body })
    return respond(body, String(url))
  }
  t.after(() => {
    globalThis.fetch = prevFetch
    if (prevKey === undefined) delete process.env.JEV_ZEN_API_KEY
    else process.env.JEV_ZEN_API_KEY = prevKey
  })
  return {
    dir,
    calls,
    rows: () => {
      try {
        return readFileSync(log.file(), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
      } catch {
        return []
      }
    },
    env: (enabled = true) => ({
      enabled: () => enabled,
      config: () => ({
        jevBackend: 'zen',
        jevModel: '',
        jevTimeoutMs: 5000,
        jevSecretFile: '',
        jevLayaFallback: false,
        jevLayaUrl: DEFAULT_LAYA_URL,
      }),
      log: () => log,
    }),
  }
}

async function waitFor(predicate, { timeout = 5000, interval = 10 } = {}) {
  const started = Date.now()
  for (;;) {
    let value
    try {
      value = await predicate()
    } catch {
      value = undefined
    }
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('timed out waiting for a background seam')
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

function schema(name, description = '') {
  return { name, description, parameters: { type: 'object', properties: {} } }
}

function stubCtx() {
  const state = { registered: new Map(), commands: new Map(), warnings: [] }
  const ctx = {
    tools: {
      register(definition) {
        state.registered.set(definition.name, definition)
        return () => state.registered.delete(definition.name)
      },
      get(name) { return state.registered.get(name) },
      schemas() {
        return [...state.registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
      },
    },
    commands: {
      register(definition) { state.commands.set(definition.name, definition); return () => {} },
    },
    inject(services, callback) {
      callback({ commands: ctx.commands, logger: ctx.logger })
      return () => {}
    },
    on() { return () => {} },
    effect(execute) { execute(); return () => {} },
    logger: { warn(message) { state.warnings.push(message) }, info() {} },
  }
  return { ctx, state }
}

let seq = 0
function liveConfig(initial = {}) {
  const dir = join(TMP, `wiring-${seq += 1}`)
  const base = Config({ storageDir: dir, ...initial })
  const values = {}
  const config = {}
  for (const key of Object.keys(base)) {
    values[key] = base[key].get()
    config[key] = { get: () => values[key] }
  }
  return { config, values, dir, set: (key, value) => { values[key] = value } }
}

function liveTool(name, description = 'a tool') {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    output: { render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() { return { ok: true } },
  }
}

function invocationLike(rawInput, agent) {
  return { rawInput, agent, signal: new AbortController().signal }
}

/** decisions.jsonl of a gate dir — where the PLUGIN's log actually lands. */
function gateRows(dir) {
  try {
    return readFileSync(join(dir, 'decisions.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
  } catch {
    return []
  }
}

/** Rank answer: probabilities for every option of the choice question. */
function choiceAnswer(order) {
  const probabilities = {}
  order.forEach((name, index) => { probabilities[name] = 1 - index * 0.1 })
  return body => json({ answers: { r1: { choice: order[0], probabilities } } })
}

// ---- the settings schema ----

test('config: the seven jev keys are part of the adapter settings schema, off by default', () => {
  const config = Config({})
  for (const key of JEV_CONFIG_KEYS) {
    assert.equal(typeof config[key].get, 'function', `${key} is a live volatile ref`)
  }
  assert.equal(config.jevEnabled.get(), false, 'a fresh install asks nothing')
  assert.equal(config.jevBackend.get(), 'zen')
  assert.equal(config.jevModel.get(), '')
  assert.equal(config.jevTimeoutMs.get(), 3000)
  assert.equal(config.jevSecretFile.get(), '')
  assert.equal(config.jevLayaFallback.get(), false)
  assert.equal(config.jevLayaUrl.get(), 'http://127.0.0.1:8000/v1/systemone')
  // The pre-existing knobs are untouched by the spread.
  assert.equal(config.prefix.get(), 'mcp__')
  assert.deepEqual(config.keep.get(), [])
  assert.equal(config.descriptionLimit.get(), 200)
})

test('config: the adapter config view lists all seven keys plus the recorded usage', () => {
  const options = {
    prefix: 'mcp__',
    keep: [],
    descriptionLimit: 200,
    jev: {
      jevEnabled: true,
      jevBackend: 'native',
      jevModel: '',
      jevTimeoutMs: 1500,
      jevSecretFile: '',
      jevLayaFallback: true,
      jevLayaUrl: '',
    },
    usage: { totalCalls: 42, toolCount: 3 },
  }
  const text = renderMcpConfig([schema('mcp__fs__read_file', 'Read files')], options)
  assert.match(text, /System One decision support/)
  for (const key of JEV_CONFIG_KEYS) assert.ok(text.includes(key), `the view names ${key}`)
  assert.match(text, /jevEnabled {8}true/)
  assert.match(text, /jevModel {10}\(backend default\)/)
  assert.match(text, /jevLayaUrl {8}\(default\)/)
  assert.match(text, /recorded usage {4}42 call\(s\) across 3 tool\(s\)/)
  assert.match(text, /"\/mcp suggest"/, 'the view points at the surface that shows the suggestions')
})

test('config: without jev wired the config view is byte-identical to the pre-jev one', () => {
  const schemas = [schema('mcp__fs__read_file', 'Read files')]
  const base = { prefix: 'mcp__', keep: [], servers: [], descriptionLimit: 200 }
  assert.equal(renderMcpConfig(schemas, base), renderMcpConfig(schemas, { ...base, jev: undefined, usage: undefined }))
  assert.doesNotMatch(renderMcpConfig(schemas, base), /jev/i)
})

// ---- the ranking seams in isolation ----

test('seam B/C: a choice answer becomes a full permutation, a bare choice a prefix', () => {
  const candidates = [{ name: 'a', description: '' }, { name: 'b', description: '' }, { name: 'c', description: '' }]
  assert.deepEqual(orderFromChoice(candidates, { probabilities: { a: 0.1, b: 0.9, c: 0.5 } }), ['b', 'c', 'a'])
  assert.deepEqual(orderFromChoice(candidates, { choice: 'c' }), ['c', 'a', 'b'])
  assert.equal(orderFromChoice(candidates, { choice: 'not_a_candidate' }), undefined, 'an unusable answer is no opinion')
  assert.equal(orderFromChoice(candidates, { probabilities: { zzz: 0.9 } }), undefined, 'a map of unknowns is no opinion')
  assert.equal(orderFromChoice(candidates, null), undefined)
  assert.equal(orderFromChoice(candidates, { probabilities: { a: 'high' } }), undefined)
  // Partial maps keep the lexical order for unscored options.
  assert.deepEqual(orderFromChoice(candidates, { probabilities: { c: 0.9 } }), ['c', 'a', 'b'])
})

test('seam B: rankListQuery asks one batched choice question and returns the order', async (t) => {
  const backend = withBackend(t, choiceAnswer(['mcp__gh__create_issue', 'mcp__gh__list_issues', 'mcp__gh__close_issue']))
  const candidates = [
    { name: 'mcp__gh__close_issue', description: 'Close an issue' },
    { name: 'mcp__gh__create_issue', description: 'Create an issue' },
    { name: 'mcp__gh__list_issues', description: 'List issues' },
  ]
  const order = await rankListQuery('issue', candidates, backend.env())
  assert.deepEqual(order, ['mcp__gh__create_issue', 'mcp__gh__list_issues', 'mcp__gh__close_issue'])
  assert.equal(backend.calls.length, 1)
  const body = backend.calls[0].body
  assert.equal(body.questions.r1.type, 'choice')
  assert.match(body.questions.r1.instructions, /issue/, 'the query is in the instructions')
  assert.match(body.state, /候选工具数：3/)
  assert.equal(body.questions.r1.criteria['mcp__gh__close_issue'], 'mcp__gh__close_issue: Close an issue')
  const rows = backend.rows()
  assert.equal(rows.find(row => row.questionId === undefined).lane, 'list-rank')
  const verdicts = rows.filter(row => row.questionId !== undefined)
  assert.equal(verdicts.length, 3, 'one verdict row per scored candidate')
  assert.deepEqual(verdicts.map(row => row.ref).sort(), [
    'tool:mcp__gh__close_issue',
    'tool:mcp__gh__create_issue',
    'tool:mcp__gh__list_issues',
  ])
  assert.equal(verdicts[0].qtype, 'choice')
  assert.equal(verdicts[0].band, 'record', 'a relative order claims no adopt/veto band')
  assert.equal(verdicts[0].agree, 'n/a')
  assert.equal(verdicts.find(row => row.ref === 'tool:mcp__gh__create_issue').probability > 0.5, true)
})

test('seam B: a single candidate is not worth a remote call', async (t) => {
  const backend = withBackend(t, choiceAnswer(['a']))
  assert.equal(await rankListQuery('x', [{ name: 'a', description: '' }], backend.env()), undefined)
  assert.equal(await rankDidYouMean('b', [{ name: 'b', description: '' }], backend.env()), undefined)
  assert.equal(backend.calls.length, 0)
})

test('seam C: rankDidYouMean names the mistyped tool in the question and returns the order', async (t) => {
  const backend = withBackend(t, choiceAnswer(['mcp__fs__write_file', 'mcp__fs__read_file']))
  const order = await rankDidYouMean('mcp__fs__read_fil', [
    { name: 'mcp__fs__read_file', description: 'Read a file' },
    { name: 'mcp__fs__write_file', description: 'Write a file' },
  ], backend.env())
  assert.deepEqual(order, ['mcp__fs__write_file', 'mcp__fs__read_file'])
  const body = backend.calls[0].body
  assert.match(body.questions.r1.instructions, /mcp__fs__read_fil/)
  assert.match(body.state, /未注册的工具名：mcp__fs__read_fil/)
  assert.equal(backend.rows().find(row => row.questionId === undefined).lane, 'didyoumean')
})

test('seam B/C: disabled, failed, and unusable answers all degrade to "no opinion"', async (t) => {
  const ok = withBackend(t, choiceAnswer(['a', 'b']))
  const candidates = [{ name: 'a', description: '' }, { name: 'b', description: '' }]
  assert.equal(await rankListQuery('x', candidates, ok.env(false)), undefined)
  assert.equal(ok.calls.length, 0, 'the switch short-circuits before any request')

  const broken = withBackend(t, () => new Response('nope', { status: 500 }))
  assert.equal(await rankListQuery('x', candidates, broken.env()), undefined)
  assert.equal(broken.rows()[0].outcome, 'http_5xx')
  assert.equal(broken.rows()[0].fallback, true)

  const garbage = withBackend(t, () => json({ answers: { r1: { nothing_useful: true } } }))
  assert.equal(await rankDidYouMean('q', candidates, garbage.env()), undefined)

  const halfAnswered = withBackend(t, () => json({ answers: { other: { choice: 'a' } } }))
  assert.equal(await rankListQuery('x', candidates, halfAnswered.env()), undefined)
})

test('seam B/C: a degraded laya answer is usable for a RANK (relative use only)', async (t) => {
  const backend = withBackend(t, (body, url) => {
    if (url.includes('127.0.0.1:8000')) {
      return json({ answers: { r1: { probabilities: { a: 0.9, b: 0.1 } } } })
    }
    return new Response('primary down', { status: 502 })
  })
  const prevKey = process.env.JEV_ZEN_API_KEY
  process.env.JEV_ZEN_API_KEY = ZEN_KEY
  const log = createDecisionLog(backend.dir)
  t.after(() => {
    if (prevKey === undefined) delete process.env.JEV_ZEN_API_KEY
    else process.env.JEV_ZEN_API_KEY = prevKey
  })
  const order = await rankListQuery('x', [{ name: 'a', description: '' }, { name: 'b', description: '' }], {
    enabled: () => true,
    config: () => ({ jevBackend: 'zen', jevModel: '', jevTimeoutMs: 5000, jevSecretFile: '', jevLayaFallback: true, jevLayaUrl: DEFAULT_LAYA_URL }),
    log: () => log,
  })
  assert.deepEqual(order, ['a', 'b'], 'the pace-maker may answer a relative ranking')
  const verdicts = backend.rows().filter(row => row.questionId !== undefined)
  assert.equal(verdicts.find(row => row.backend === 'laya').degraded, true, 'and it is marked degraded')
})

test('seam C: noulProbability only accepts a finite 0..1 number', () => {
  assert.equal(noulProbability({ noul: 0.5 }), 0.5)
  for (const answer of [{ noul: 1.2 }, { noul: -0.1 }, { noul: 'high' }, { noul: Number.NaN }, {}, null, 'x', 5]) {
    assert.equal(noulProbability(answer), undefined)
  }
})

// ---- the seams through the real meta-tools ----

test('apply(): mcp_list {query} is reranked by jev end to end', async (t) => {
  const backend = withBackend(t, choiceAnswer(['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues']))
  const { ctx } = stubCtx()
  const { config, dir } = liveConfig({ jevEnabled: true })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__gh__create_issue', 'Create an issue on GitHub'))
  ctx.tools.register(liveTool('mcp__gh__close_issue', 'Close an issue on GitHub'))
  ctx.tools.register(liveTool('mcp__gh__list_issues', 'List issues in a repository'))
  const list = ctx.tools.get(MCP_LIST_TOOL_NAME)

  const value = await list.execute({ query: 'issue' }, { agent: undefined })
  assert.equal(value.ranked, true)
  assert.equal(value.total, 3)
  assert.deepEqual(value.servers[0].tools.map(tool => tool.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
  assert.equal(backend.calls.length, 1)
  assert.equal(backend.calls[0].body.questions.r1.type, 'choice')
  // Telemetry lands in the plugin's own gate directory, beside gate.json.
  await waitFor(() => gateRows(dir).length > 0 ? true : undefined)
  const rows = gateRows(dir)
  assert.equal(rows.find(row => row.questionId === undefined).lane, 'list-rank')
  assert.equal(existsSync(join(dir, 'decisions.jsonl')), true)
  // Red line ③: a catalog read writes no gate state.
  assert.equal(existsSync(join(dir, GATE_FILE_NAME)), false, 'no toggle, no gate.json write')
})

test('apply(): a jev failure in mcp_list degrades to the lexical order', async (t) => {
  const backend = withBackend(t, () => new Response('down', { status: 503 }))
  const { ctx } = stubCtx()
  const { config, dir } = liveConfig({ jevEnabled: true })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__gh__create_issue', 'Create an issue on GitHub'))
  ctx.tools.register(liveTool('mcp__gh__list_issues', 'List issues in a repository'))
  const list = ctx.tools.get(MCP_LIST_TOOL_NAME)
  const value = await list.execute({ query: 'issue' }, { agent: undefined })
  assert.equal(value.ranked, true, 'the answer is still a ranked shortlist')
  assert.deepEqual(value.servers[0].tools.map(tool => tool.name), ['mcp__gh__create_issue', 'mcp__gh__list_issues'])
  assert.equal(backend.calls.length, 1, 'it tried, and the failure is telemetry')
  await waitFor(() => gateRows(dir).length > 0 ? true : undefined)
  assert.equal(gateRows(dir)[0].outcome, 'http_5xx', 'the failed call is the health metric')
  assert.equal(gateRows(dir)[0].fallback, true)
})

test('apply(): the unknown-tool branch is reranked by jev end to end', async (t) => {
  const backend = withBackend(t, choiceAnswer(['mcp__fs__write_file', 'mcp__fs__read_file']))
  const { ctx } = stubCtx()
  const { config, dir } = liveConfig({ jevEnabled: true })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read a file'))
  ctx.tools.register(liveTool('mcp__fs__write_file', 'Write a file'))
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)
  const value = await call.execute({ tool: 'mcp__fs__read_fil' }, { agent: undefined })
  assert.ok(value.error.startsWith('tool "mcp__fs__read_fil" is not registered'))
  assert.ok(value.error.endsWith('(jev reranked)'))
  assert.ok(value.error.indexOf('mcp__fs__write_file') < value.error.indexOf('"mcp__fs__read_file"'))
  await waitFor(() => gateRows(dir).length > 0 ? true : undefined)
  assert.equal(gateRows(dir).find(row => row.questionId === undefined).lane, 'didyoumean')
})

test('apply(): jevEnabled off keeps the query path and the near-miss path fully local', async (t) => {
  const backend = withBackend(t, choiceAnswer(['mcp__fs__write_file']))
  const { ctx } = stubCtx()
  const { config } = liveConfig({ jevEnabled: false })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read a file'))
  ctx.tools.register(liveTool('mcp__fs__write_file', 'Write a file'))
  const list = ctx.tools.get(MCP_LIST_TOOL_NAME)
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)
  const exec = { agent: undefined }
  const ranked = await list.execute({ query: 'file' }, exec)
  assert.equal(ranked.ranked, true, 'the feature works without jev — lexically')
  const failed = await call.execute({ tool: 'mcp__fs__read_fil' }, exec)
  assert.ok(failed.error.endsWith('(lexical)'), 'the lexical answer is labeled as such')
  assert.equal(backend.calls.length, 0)
})

// ---- the /mcp suggest surface, through the registered command ----

test('apply(): /mcp suggest reads the gate dir document and renders it', async (t) => {
  const backend = withBackend(t, () => json({ answers: { c1: { noul: 0.93 } } }))
  const { ctx, state } = stubCtx()
  const { config, dir } = liveConfig({ jevEnabled: true })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read a file from disk'))
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)
  for (let i = 0; i < 20; i += 1) await call.execute({ tool: 'mcp__fs__read_file' }, { agent: undefined })
  await waitFor(() => existsSync(suggestionsFile(dir)) ? true : undefined)

  const handler = state.commands.get('mcp').handler
  const outcome = await handler(invocationLike('suggest'))
  assert.equal(outcome.kind, 'success')
  assert.match(outcome.text, /mcp__fs__read_file/)
  assert.match(outcome.text, /p=0\.93 \(adopt\)/)
  assert.match(outcome.text, /keep: \["mcp__fs__read_file"\]/)
  assert.match(outcome.text, /20 call\(s\) across 1 tool\(s\)/)
  assert.equal(existsSync(usageFile(dir)), true, 'usage was recorded on the way')
  // Reading a suggestion wrote nothing to the gate (red line ③).
  assert.equal(existsSync(join(dir, GATE_FILE_NAME)), true, '/mcp suggest still allocates stable ids like every read form')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, GATE_FILE_NAME), 'utf8')), { serverIds: { fs: 1 }, disabled: [] })
})

test('apply(): /mcp suggest with no batch explains itself instead of failing', async (t) => {
  withBackend(t, () => json({ answers: {} }))
  const { ctx, state } = stubCtx()
  const { config } = liveConfig({ jevEnabled: true })
  apply(ctx, config)
  const handler = state.commands.get('mcp').handler
  const outcome = await handler(invocationLike('suggest'))
  assert.equal(outcome.kind, 'success', 'an empty batch is a normal state, not an error')
  assert.match(outcome.text, /no suggestions yet — 0 call\(s\) recorded, threshold is 20/)
})

test('executeMcpCommand: the suggest form needs no gate store and mutates nothing', async () => {
  const outcome = await executeMcpCommand({
    rawInput: 'suggest',
    schemas: [schema('mcp__fs__read_file', 'Read files')],
    config: { prefix: 'mcp__', keep: [], descriptionLimit: 200 },
    metaToolsLive: true,
  })
  assert.equal(outcome.kind, 'success')
  assert.match(outcome.text, /no suggestions yet — 0 call\(s\) recorded/)
  assert.match(outcome.text, /decision support is OFF/, 'a caller that wires no jev options sees the honest default')
})

test('apply(): the usage document survives a restart and the batch keeps counting up', async (t) => {
  withBackend(t, () => json({ answers: { c1: { noul: 0.7 } } }))
  const { ctx } = stubCtx()
  const { config, dir } = liveConfig({ jevEnabled: true })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read a file'))
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)
  for (let i = 0; i < 20; i += 1) await call.execute({ tool: 'mcp__fs__read_file' }, { agent: undefined })
  await waitFor(async () => {
    const doc = JSON.parse(readFileSync(usageFile(dir), 'utf8'))
    return doc.tools['mcp__fs__read_file'].calls === 20 ? doc : undefined
  })
  // A second mount over the same directory keeps the counters.
  const second = stubCtx()
  apply(second.ctx, liveConfig({ storageDir: dir, jevEnabled: true }).config)
  second.ctx.tools.register(liveTool('mcp__fs__read_file', 'Read a file'))
  const again = second.ctx.tools.get(MCP_CALL_TOOL_NAME)
  for (let i = 0; i < 5; i += 1) await again.execute({ tool: 'mcp__fs__read_file' }, { agent: undefined })
  await waitFor(async () => {
    const doc = JSON.parse(readFileSync(usageFile(dir), 'utf8'))
    return doc.tools['mcp__fs__read_file'].calls === 25 ? doc : undefined
  })
  rmSync(dir, { recursive: true, force: true })
})

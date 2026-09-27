// Seam A end to end (src/usage.ts + src/jev/seams.ts + apply()): the keep
// suggestion batch that makes the plugin self-evolving.
//
// Hermetic, same three-piece set as jev-client.test.mjs: globalThis.fetch is
// stubbed, the decisions.jsonl sink and the usage/suggestion documents live in
// a scratch temp dir, and ambient key env vars are deleted so no assertion can
// depend on — or leak — a developer's key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const k of ['TYPESAFE_API_KEY', 'JEV_ZEN_API_KEY', 'OPENROUTER_API_KEY', 'JEV_KEYCHAIN']) delete process.env[k]

const { createDecisionLog } = await import('../lib/jev/log.js')
const { askKeepSuggestions } = await import('../lib/jev/seams.js')
const { DEFAULT_LAYA_URL } = await import('../lib/jev/dual.js')
const { SUGGEST_ADOPT, SUGGEST_FALLBACK } = await import('../lib/jev/thresholds.js')
const { suggestionsFile, usageFile } = await import('../lib/usage.js')
const {
  apply,
  Config,
  executeMcpCommand,
  renderMcpSuggest,
  parseMcpCommandInput,
  MCP_LIST_TOOL_NAME,
  MCP_CALL_TOOL_NAME,
} = await import('../lib/index.js')

const TMP = mkdtempSync(join(tmpdir(), 'mcp-adapter-suggest-'))
process.env.DSH_HOME = TMP

const ZEN_KEY = 'test-zen-key-0123456789abcdef'

/** One scratch dir per test, with the jev env injected and fetch stubbed. */
function withJev(t, { laya = false, respond } = {}) {
  const dir = mkdtempSync(join(TMP, 'case-'))
  const log = createDecisionLog(dir)
  const prevKey = process.env.JEV_ZEN_API_KEY
  process.env.JEV_ZEN_API_KEY = ZEN_KEY
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), body })
    const isLaya = String(url).includes('127.0.0.1:8000')
    if (respond !== undefined) return respond({ body, isLaya, calls })
    const answers = {}
    for (const id of Object.keys(body.questions)) {
      answers[id] = { noul: isLaya ? 0.2 : (respond === undefined ? 0.75 : 0.75) }
    }
    return json({ answers, usage: { input_tokens: 120, output_tokens: 12 } })
  }
  t.after(() => {
    globalThis.fetch = prevFetch
    if (prevKey === undefined) delete process.env.JEV_ZEN_API_KEY
    else process.env.JEV_ZEN_API_KEY = prevKey
    rmSync(dir, { recursive: true, force: true })
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
        jevLayaFallback: laya,
        jevLayaUrl: DEFAULT_LAYA_URL,
      }),
      log: () => log,
    }),
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** noul answers keyed by question id. */
function noulByTool(tools) {
  return ({ body }) => {
    const answers = {}
    for (const id of Object.keys(body.questions)) answers[id] = { noul: tools[id] ?? 0.5 }
    return json({ answers })
  }
}

async function waitFor(predicate, { timeout = 5000, interval = 10 } = {}) {
  const started = Date.now()
  for (;;) {
    // A predicate that throws (a document that has not landed yet) is simply
    // "not yet" — background seams write files asynchronously.
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

function candidate(tool, calls, errors = 0) {
  return { tool, calls, errors, lastUsedAt: '2026-09-27T08:00:00.000Z', description: `What ${tool} does` }
}

// ---- the seam itself ----

test('seam A: one batched noul request per run, rows sorted by probability', async (t) => {
  const jev = withJev(t, { respond: noulByTool({ c1: 0.2, c2: 0.91, c3: 0.6 }) })
  const records = await askKeepSuggestions(
    [candidate('mcp__a__one', 9), candidate('mcp__b__two', 30), candidate('mcp__c__three', 4)],
    jev.env(),
  )
  assert.equal(jev.calls.length, 1, 'one HTTP call for the whole batch')
  assert.equal(jev.calls[0].url, 'https://opencode.ai/zen/v1/systemone')
  const body = jev.calls[0].body
  assert.deepEqual(Object.keys(body.questions), ['c1', 'c2', 'c3'], 'one question per candidate, in order')
  assert.equal(body.questions.c1.type, 'noul')
  assert.ok(body.questions.c1.criteria.true.includes('mcp__a__one'))
  assert.ok(body.questions.c1.criteria.false.startsWith('不值得常驻'), 'two-sided criteria (calibration contract)')
  assert.ok(body.state.includes('mcp__b__two: 30 call(s)'), 'the state carries the usage evidence')
  assert.ok(body.state.includes('What mcp__a__one does'), 'the state carries the description blurb')

  assert.deepEqual(records.map(r => r.tool), ['mcp__b__two', 'mcp__c__three', 'mcp__a__one'])
  assert.equal(records[0].probability, 0.91)
  assert.equal(records[0].band, 'adopt')
  assert.equal(records[1].band, 'adopt', `${SUGGEST_ADOPT} is inclusive`)
  assert.equal(records[2].probability, 0.2)
  assert.equal(records[2].band, 'record')
  assert.equal(records[0].basis, '30 call(s), 0 error(s), last used 2026-09-27')
  assert.match(records[0]._at, /^\d{4}-\d{2}-\d{2}T/)

  const rows = jev.rows()
  const call = rows.find(row => row.lane === 'usage-suggest' && row.questionId === undefined)
  assert.equal(call.outcome, 'ok')
  assert.equal(call.questionCount, 3)
  const verdicts = rows.filter(row => row.questionId !== undefined)
  assert.equal(verdicts.length, 3)
  assert.equal(verdicts[0].ref, 'tool:mcp__a__one')
  assert.equal(verdicts[0].band, 'record')
})

test('seam A: the bands follow the suggest thresholds, including the veto floor', async (t) => {
  const jev = withJev(t, { respond: noulByTool({ c1: SUGGEST_ADOPT, c2: SUGGEST_ADOPT - 0.01, c3: SUGGEST_FALLBACK, c4: SUGGEST_FALLBACK - 0.01 }) })
  const records = await askKeepSuggestions(
    [candidate('mcp__a__one', 1), candidate('mcp__b__two', 1), candidate('mcp__c__three', 1), candidate('mcp__d__four', 1)],
    jev.env(),
  )
  assert.deepEqual(records.map(r => r.band), ['adopt', 'record', 'record', 'fallback'])
})

test('seam A: disabled means no call at all and no rows', async (t) => {
  const jev = withJev(t)
  const records = await askKeepSuggestions([candidate('mcp__a__one', 3)], jev.env(false))
  assert.equal(records, null)
  assert.equal(jev.calls.length, 0, 'the master switch short-circuits before any request')
  assert.deepEqual(jev.rows(), [], 'not even a call-layer row: nothing was attempted')
})

test('seam A: an empty candidate set never reaches the backend', async (t) => {
  const jev = withJev(t)
  assert.equal(await askKeepSuggestions([], jev.env()), null)
  assert.equal(jev.calls.length, 0)
})

test('seam A: a backend failure returns null and logs the failed call row', async (t) => {
  const jev = withJev(t, { respond: () => new Response('backend exploded', { status: 503 }) })
  const records = await askKeepSuggestions([candidate('mcp__a__one', 3)], jev.env())
  assert.equal(records, null, 'this round produced nothing — the previous batch stays')
  const rows = jev.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].outcome, 'http_5xx')
  assert.equal(rows[0].fallback, true, 'the fail-open rate is the health metric')
  assert.equal(rows.filter(row => row.questionId !== undefined).length, 0, 'no fabricated verdicts')
})

test('seam A: a timeout degrades to null, never a throw', async (t) => {
  const jev = withJev(t, {
    respond: ({ body }) => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('too late')), 50)
    }),
  })
  assert.equal(await askKeepSuggestions([candidate('mcp__a__one', 3)], jev.env()), null)
})

test('seam A: unusable answers produce no rows rather than fabricated ones', async (t) => {
  const jev = withJev(t, {
    respond: ({ body }) => json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: 'high' }])) }),
  })
  assert.equal(await askKeepSuggestions([candidate('mcp__a__one', 3)], jev.env()), null)
  assert.equal(jev.rows().filter(row => row.questionId !== undefined).length, 0)
})

test('seam A: the batch is capped at 40 questions', async (t) => {
  const jev = withJev(t, { respond: noulByTool({}) })
  const many = Array.from({ length: 80 }, (_unused, i) => candidate(`mcp__s__t${i}`, i + 1))
  const records = await askKeepSuggestions(many, jev.env())
  assert.equal(Object.keys(jev.calls[0].body.questions).length, 40)
  assert.equal(records.length, 40)
})

test('seam A: the laya pace-maker is logged for comparison but does not drive the rows', async (t) => {
  const jev = withJev(t, {
    laya: true,
    respond: ({ body, isLaya }) => {
      const answers = {}
      for (const id of Object.keys(body.questions)) answers[id] = { noul: isLaya ? 0.05 : 0.88 }
      return json({ answers })
    },
  })
  const records = await askKeepSuggestions([candidate('mcp__a__one', 5)], jev.env())
  assert.equal(jev.calls.length, 2, 'both backends were asked')
  assert.deepEqual(
    jev.calls.map(entry => entry.url).sort(),
    ['http://127.0.0.1:8000/v1/systemone', 'https://opencode.ai/zen/v1/systemone'],
    'the pace-maker fires in parallel with the primary (issue order is not the contract)',
  )
  assert.equal(jev.calls.find(entry => entry.url === DEFAULT_LAYA_URL).body.model, 'laya-rl-agent')
  assert.equal(records.length, 1)
  assert.equal(records[0].probability, 0.88, 'the healthy primary drives; laya only compares')
  const verdicts = jev.rows().filter(row => row.questionId !== undefined)
  assert.deepEqual(verdicts.map(row => row.backend).sort(), ['laya', 'primary'])
  assert.ok(verdicts.every(row => row.degraded === false), 'a healthy primary means no degraded row')
})

test('seam A: a primary failure hands the batch to laya, which produces NO suggestion rows', async (t) => {
  const jev = withJev(t, {
    laya: true,
    respond: ({ body, isLaya }) => {
      if (!isLaya) return new Response('primary down', { status: 502 })
      const answers = {}
      for (const id of Object.keys(body.questions)) answers[id] = { noul: 0.71 }
      return json({ answers })
    },
  })
  const records = await askKeepSuggestions([candidate('mcp__a__one', 5)], jev.env())
  // dual.ts: a laya takeover is for RELATIVE ranking only. A suggestion row is
  // an absolute number + a band + an actionable "keep it resident" line that
  // a human reads, and laya's 0.71 is not calibrated against these thresholds
  // — so a degraded round produces nothing and the previous batch stands.
  assert.equal(records, null, "a degraded round must not write laya's absolute score into suggestions.json")
  const verdicts = jev.rows().filter(row => row.questionId !== undefined)
  assert.equal(verdicts.length, 1, 'the bench keeps the round — telemetry is not a suggestion')
  assert.equal(verdicts[0].backend, 'laya')
  assert.equal(verdicts[0].degraded, true)
  assert.equal(verdicts[0].probability, 0.71, 'the raw score is still recorded for the laya-vs-jev comparison')
  assert.equal(verdicts[0].band, 'record', 'an uncalibrated score never takes a suggest band')
})

test('seam A: only a primary probability takes a suggest band; the pace-maker stays bench-only', async (t) => {
  const jev = withJev(t, {
    laya: true,
    respond: ({ body, isLaya }) => {
      const answers = {}
      // laya's 0.05 would read as a hard `fallback` veto on the suggest scale;
      // that is exactly the uncalibrated number that must never ship.
      for (const id of Object.keys(body.questions)) answers[id] = { noul: isLaya ? 0.05 : 0.9 }
      return json({ answers })
    },
  })
  const records = await askKeepSuggestions([candidate('mcp__a__one', 5)], jev.env())
  assert.equal(records.length, 1)
  assert.equal(records[0].probability, 0.9)
  assert.equal(records[0].band, 'adopt')
  const bands = Object.fromEntries(
    jev.rows().filter(row => row.questionId !== undefined).map(row => [row.backend, row.band]),
  )
  assert.deepEqual(bands, { primary: 'adopt', laya: 'record' })
})

// ---- /mcp suggest rendering (pure) ----

test('/mcp suggest: explains the "off" state with the usage it has collected', () => {
  const text = renderMcpSuggest([], { jev: { jevEnabled: false }, usage: { totalCalls: 42, toolCount: 3 } })
  assert.match(text, /decision support is OFF/)
  assert.match(text, /no suggestions yet — 42 call\(s\) recorded, threshold is 20/)
  assert.match(text, /usage: 42 call\(s\) across 3 tool\(s\)/)
})

test('/mcp suggest: the enabled-but-empty state names the cadence', () => {
  const text = renderMcpSuggest([], { jev: { jevEnabled: true }, usage: { totalCalls: 12, toolCount: 1 } })
  assert.match(text, /no suggestions yet — 12 call\(s\) recorded, threshold is 20/)
  assert.match(text, /a batch runs every 20 calls/)
  assert.doesNotMatch(text, /decision support is OFF/)
})

test('/mcp suggest: rows render probability, band, evidence and the keep fragment', () => {
  const text = renderMcpSuggest(
    [
      { tool: 'mcp__fs__read_file', probability: 0.12, band: 'record', basis: '4 call(s), 0 error(s), last used 2026-09-26', _at: '2026-09-27T10:00:00.000Z' },
      { tool: 'mcp__gh__create_issue', probability: 0.82, band: 'adopt', basis: '24 call(s), 1 error(s), last used 2026-09-27', _at: '2026-09-27T10:00:00.000Z' },
    ],
    { jev: { jevEnabled: true }, usage: { totalCalls: 40, toolCount: 2 } },
  )
  assert.ok(text.indexOf('mcp__gh__create_issue') < text.indexOf('mcp__fs__read_file'), 'most confident first')
  assert.match(text, /p=0\.82 \(adopt\) — 24 call\(s\), 1 error\(s\), last used 2026-09-27/)
  assert.match(text, /to keep it resident: keep: \["mcp__gh__create_issue"\]/)
  assert.match(text, /nothing was written to keep, prefix, or the server gate/)
  assert.match(text, /2026-09-27T10:00:00\.000Z/, 'the batch timestamp is shown')
})

test('/mcp suggest: the parse form exists and takes no argument', () => {
  assert.deepEqual(parseMcpCommandInput('suggest'), { form: 'suggest' })
  assert.equal(parseMcpCommandInput('suggest now').form, 'usage')
})

test('/mcp suggest: the command renders the document it is handed', async () => {
  const outcome = await executeMcpCommand({
    rawInput: 'suggest',
    schemas: [],
    config: { prefix: 'mcp__', keep: [], descriptionLimit: 200, jev: { jevEnabled: true }, usage: { totalCalls: 40, toolCount: 1 } },
    metaToolsLive: true,
    suggestions: [{ tool: 'mcp__gh__create_issue', probability: 0.9, band: 'adopt', basis: '24 call(s)', _at: 't' }],
  })
  assert.equal(outcome.kind, 'success')
  assert.match(outcome.text, /mcp__gh__create_issue/)
  assert.match(outcome.text, /p=0\.90 \(adopt\)/)
})

// ---- the lazy trigger, end to end through apply() ----

/** Stub ctx carrying just enough of the registry + command service. */
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

/** Live volatile refs, so a test can flip a setting the way cordis would. */
let gateSeq = 0
function liveConfig(initial = {}) {
  const dir = join(TMP, `gate-${gateSeq += 1}`)
  const base = Config({ storageDir: dir, ...initial })
  const values = {}
  const config = {}
  for (const key of Object.keys(base)) {
    values[key] = base[key].get()
    config[key] = { get: () => values[key] }
  }
  return { config, values, dir, set: (key, value) => { values[key] = value } }
}

/** A registered child tool that always succeeds. */
function liveTool(name, description = 'a tool') {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    output: { render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() { return { ok: true } },
  }
}

async function dispatch(definition, tool, exec = { agent: undefined }) {
  return definition.execute({ tool }, exec)
}

test('apply(): the 20th dispatch fires one background batch, the 19th does not', async (t) => {
  const jev = withJev(t, { respond: noulByTool({}) })
  const { ctx } = stubCtx()
  const { config, dir } = liveConfig({ jevEnabled: true })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__gh__create_issue', 'Create an issue'))
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)

  for (let i = 0; i < 19; i += 1) await dispatch(call, 'mcp__gh__create_issue')
  assert.equal(jev.calls.length, 0, '19 calls: usage is recorded, nothing is asked remotely')
  const recorded = await waitFor(async () => {
    const doc = JSON.parse(readFileSync(usageFile(dir), 'utf8'))
    return doc.tools['mcp__gh__create_issue'].calls === 19 ? doc : undefined
  })
  assert.equal(recorded.tools['mcp__gh__create_issue'].errors, 0)

  await dispatch(call, 'mcp__gh__create_issue')
  await waitFor(() => jev.calls.length > 0 ? true : undefined)
  await waitFor(() => existsSync(suggestionsFile(dir)) ? true : undefined)
  const written = JSON.parse(readFileSync(suggestionsFile(dir), 'utf8'))
  assert.equal(written.length, 1)
  assert.equal(written[0].tool, 'mcp__gh__create_issue')
  assert.equal(written[0].band, 'record', '0.75 sits in the record band')
  assert.match(written[0].basis, /^20 call\(s\)/)
  // The dispatch itself never waited for any of it.
  assert.ok(jev.calls.every(entry => entry.body.questions !== undefined))
})

test('apply(): a disabled jev records usage and asks nothing, until a later crossing', async (t) => {
  const jev = withJev(t, { respond: noulByTool({}) })
  const { ctx } = stubCtx()
  const { config, dir, set } = liveConfig({ jevEnabled: false })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read files'))
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)
  for (let i = 0; i < 20; i += 1) await dispatch(call, 'mcp__fs__read_file')
  await waitFor(() => existsSync(usageFile(dir)) ? true : undefined)
  assert.equal(jev.calls.length, 0, 'the switch is read per dispatch, not at mount time')
  assert.equal(existsSync(suggestionsFile(dir)), false)

  // Hot-reload: turning it on mid-stream needs the NEXT crossing.
  set('jevEnabled', true)
  for (let i = 0; i < 19; i += 1) await dispatch(call, 'mcp__fs__read_file')
  assert.equal(jev.calls.length, 0)
  await dispatch(call, 'mcp__fs__read_file')
  await waitFor(() => jev.calls.length > 0 ? true : undefined)
  await waitFor(() => existsSync(suggestionsFile(dir)) ? true : undefined)
  const written = JSON.parse(readFileSync(suggestionsFile(dir), 'utf8'))
  assert.equal(written[0].tool, 'mcp__fs__read_file')
  assert.match(written[0].basis, /^40 call\(s\)/, 'the batch saw the accumulated usage, not the last dispatch')
})

test('apply(): a failed batch leaves the previous document alone and keeps counting', async (t) => {
  const jev = withJev(t, { respond: noulByTool({ c1: 0.9 }) })
  const { ctx, state } = stubCtx()
  const { config, dir } = liveConfig({ jevEnabled: true })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read files'))
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)
  for (let i = 0; i < 20; i += 1) await dispatch(call, 'mcp__fs__read_file')
  await waitFor(() => jev.calls.length > 0 ? true : undefined)
  await waitFor(() => existsSync(suggestionsFile(dir)) ? true : undefined)
  const first = readFileSync(suggestionsFile(dir), 'utf8')
  assert.equal(JSON.parse(first)[0].probability, 0.9)

  // The next crossing runs against a backend that is down. The decision log
  // lives beside gate.json, i.e. in the gate dir the plugin was given.
  const gateRows = () => {
    try {
      return readFileSync(join(dir, 'decisions.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
    } catch {
      return []
    }
  }
  const healthy = globalThis.fetch
  globalThis.fetch = async () => new Response('down', { status: 500 })
  try {
    for (let i = 0; i < 20; i += 1) await dispatch(call, 'mcp__fs__read_file')
    await waitFor(() => gateRows().some(row => row.outcome === 'http_5xx') ? true : undefined)
  } finally {
    globalThis.fetch = healthy
  }
  assert.equal(readFileSync(suggestionsFile(dir), 'utf8'), first, 'the last good batch survives a failed one')
  await waitFor(async () => {
    const doc = JSON.parse(readFileSync(usageFile(dir), 'utf8'))
    return doc.tools['mcp__fs__read_file'].calls === 40 ? doc : undefined
  })
  assert.equal(
    state.warnings.filter(w => /keep-suggestion/.test(w)).length,
    0,
    'a failed CALL is telemetry, not a storage failure',
  )
})

test('apply(): a degraded (laya) batch keeps the previous document and releases the latch', async (t) => {
  // primary healthy -> primary down (laya takes over) -> primary healthy again
  let mode = 'healthy'
  const jev = withJev(t, {
    laya: true,
    respond: ({ body, isLaya }) => {
      if (isLaya) return json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: 0.99 }])) })
      if (mode === 'degraded') return new Response('primary down', { status: 502 })
      const noul = mode === 'recovered' ? 0.95 : 0.9
      return json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul }])) })
    },
  })
  const { ctx } = stubCtx()
  const { config, dir } = liveConfig({ jevEnabled: true, jevLayaFallback: true })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read files'))
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)
  const suggestions = () => JSON.parse(readFileSync(suggestionsFile(dir), 'utf8'))
  const layaCalls = () => jev.calls.filter(entry => entry.url === DEFAULT_LAYA_URL).length
  // The seam's OWN log (apply() builds it in the gate dir it was handed).
  const gateRows = () => {
    try {
      return readFileSync(join(dir, 'decisions.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
    } catch {
      return []
    }
  }

  for (let i = 0; i < 20; i += 1) await dispatch(call, 'mcp__fs__read_file')
  await waitFor(() => existsSync(suggestionsFile(dir)) ? true : undefined)
  assert.equal(suggestions()[0].probability, 0.9)

  // Primary down, pace-maker up: the round degrades, and laya's confident 0.99
  // must NOT reach the document a human reads in /mcp suggest. Waiting on the
  // degraded verdict row waits for the ROUND, not just for its HTTP call — a
  // crossing that lands while the previous batch is in flight is dropped by
  // design, which would test the guard instead of the latch.
  mode = 'degraded'
  for (let i = 0; i < 20; i += 1) await dispatch(call, 'mcp__fs__read_file')
  await waitFor(() => gateRows().some(row => row.backend === 'laya' && row.degraded === true) ? true : undefined)
  assert.equal(suggestions()[0].probability, 0.9, "the last PRIMARY batch survives the degraded one")

  // The background latch is released even though the round produced nothing:
  // a wedged suggestInFlight would swallow every later 20-call crossing.
  mode = 'recovered'
  for (let i = 0; i < 20; i += 1) await dispatch(call, 'mcp__fs__read_file')
  await waitFor(() => suggestions()[0].probability === 0.95 ? true : undefined)
  assert.equal(layaCalls(), 3, 'the third crossing really ran a third batch (one pace-maker call each)')
})

test('apply(): the hot paths make zero jev calls even with jev fully enabled', async (t) => {
  const jev = withJev(t, { respond: noulByTool({}) })
  const { ctx } = stubCtx()
  const { config } = liveConfig({ jevEnabled: true, jevBackend: 'zen' })
  apply(ctx, config)
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read files'))
  const call = ctx.tools.get(MCP_CALL_TOOL_NAME)
  const list = ctx.tools.get(MCP_LIST_TOOL_NAME)
  const exec = { agent: undefined }

  for (let i = 0; i < 18; i += 1) await dispatch(call, 'mcp__fs__read_file', exec)
  await list.execute({}, exec)
  await list.execute({ server: 'fs' }, exec)
  await list.execute({ verbose: true }, exec)
  await list.execute({ tool: 'mcp__fs__read_file' }, exec)
  // A failed dispatch is a cold branch, but with a SINGLE near-miss there is
  // nothing to rank — 19 calls total, still below the batch cadence.
  const failed = await dispatch(call, 'mcp__fs__read_fil', exec)
  assert.match(failed.error, /Did you mean/)
  assert.equal(jev.calls.length, 0, 'folding, catalog, expansion, success and a one-candidate unknown-tool all stayed local')
})

test('apply(): a corrupt usage document degrades to zero statistics with one warning', async (t) => {
  const jev = withJev(t)
  const dir = mkdtempSync(join(TMP, 'corrupt-'))
  writeFileSync(usageFile(dir), 'not json', 'utf8')
  const { ctx, state } = stubCtx()
  const { config } = liveConfig({ storageDir: dir })
  apply(ctx, config)
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /usage statistics/)
  // And the plugin keeps working.
  ctx.tools.register(liveTool('mcp__fs__read_file', 'Read files'))
  const value = await dispatch(ctx.tools.get(MCP_CALL_TOOL_NAME), 'mcp__fs__read_file')
  assert.deepEqual(value, { ok: true })
  assert.equal(jev.calls.length, 0)
})

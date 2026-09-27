// jevAsk client tests — ported from dsh-topics-memory test/jev-client.test.mjs.
// Hermetic: globalThis.fetch is stubbed, no network, and the decisions.jsonl
// sink is a temp dir handed to createDecisionLog (nothing ever touches a real
// dsh home or gate dir). Ambient key env vars are deleted explicitly (dsh
// scrubs KEY|PASSWORD|SECRET|TOKEN variables from profiles, but a local dev
// shell may still carry them — no assertion may depend on or leak an ambient
// key).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const k of ['TYPESAFE_API_KEY', 'JEV_ZEN_API_KEY', 'OPENROUTER_API_KEY', 'JEV_KEYCHAIN']) delete process.env[k]
const tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-adapter-jev-client-'))

const { createDecisionLog } = await import('../lib/jev/log.js')
const { jevAsk, parseKeychainSpec, keychainLookup, resolveApiKey, normalizeQuestions, KEYCHAIN_TIMEOUT_MS } = await import('../lib/jev/client.js')
const { BACKENDS, resolveBackend } = await import('../lib/jev/backends.js')

/** One injected log per test file: every call-layer row lands here. */
const LOG = createDecisionLog(tmpRoot)

const ZEN_KEY = 'test-zen-key-0123456789abcdef'
const decisionsPath = LOG.file()

function lastDecisionRow() {
  const lines = readFileSync(decisionsPath, 'utf8').split('\n').filter((l) => l.trim() !== '')
  return JSON.parse(lines[lines.length - 1])
}

/** Stub global fetch; handler(calls, init) -> Response | Promise<Response>. */
function stubFetch(handler) {
  const calls = []
  const stub = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(calls, init)
  }
  const prev = globalThis.fetch
  globalThis.fetch = stub
  return {
    calls,
    restore: () => {
      globalThis.fetch = prev
    },
  }
}

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const BASE_CONFIG = { jevBackend: 'zen', jevModel: '', jevTimeoutMs: 5000, jevSecretFile: '' }
const BASE_QUESTIONS = { c1: { type: 'noul', instructions: 'helps answer the query' } }

function zenConfig(overrides = {}) {
  process.env.JEV_ZEN_API_KEY = ZEN_KEY
  return { ...BASE_CONFIG, ...overrides }
}

test('client: zen wire shape — endpoint, auth, batched body, default model, auto two-sided criteria', async () => {
  const s = stubFetch(() => jsonResponse({ model: 'jev-1.13-free', answers: { c1: { noul: 0.7 } }, usage: { input_tokens: 2417, output_tokens: 108 } }))
  try {
    const r = await jevAsk({
      state: '用户问题原文',
      questions: BASE_QUESTIONS,
      config: zenConfig(),
      log: LOG,
      lane: 'usage-suggest',
    })
    assert.equal(r.ok, true)
    assert.equal(r.answers.c1.noul, 0.7)
    assert.deepEqual(r.usage, { input_tokens: 2417, output_tokens: 108 })
    assert.ok(r.latencyMs >= 0)

    assert.equal(s.calls.length, 1)
    const { url, init } = s.calls[0]
    assert.equal(url, 'https://opencode.ai/zen/v1/systemone')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['content-type'], 'application/json')
    assert.equal(init.headers.authorization, `Bearer ${ZEN_KEY}`)
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'jev-1.13-free') // '' sentinel → backend default
    assert.equal(body.state, '用户问题原文')
    assert.equal(body.questions.c1.type, 'noul')
    assert.equal(body.questions.c1.instructions, 'helps answer the query')
    assert.deepEqual(body.questions.c1.criteria, { true: 'helps answer the query', false: 'NOT: helps answer the query' })

    // call-layer telemetry row (§6.2) with every field
    const row = lastDecisionRow()
    assert.deepEqual(
      Object.keys(row).sort(),
      ['at', 'backend', 'fallback', 'lane', 'latencyMs', 'model', 'outcome', 'questionCount', 'stateChars', 'usage'],
    )
    assert.equal(row.lane, 'usage-suggest')
    assert.equal(row.backend, 'zen')
    assert.equal(row.model, 'jev-1.13-free')
    assert.equal(row.questionCount, 1)
    assert.equal(row.stateChars, 6)
    assert.equal(row.outcome, 'ok')
    assert.equal(row.fallback, false)
    assert.deepEqual(row.usage, { input_tokens: 2417, output_tokens: 108 })
  } finally {
    s.restore()
    delete process.env.JEV_ZEN_API_KEY
  }
})

test('client: explicit jevModel wins over the backend default', async () => {
  const s = stubFetch(() => jsonResponse({ answers: { c1: { noul: 0.5 } } }))
  try {
    await jevAsk({ state: 's', questions: BASE_QUESTIONS, config: zenConfig({ jevModel: 'jev-1.13.0' }), log: LOG, lane: 'list-rank' })
    assert.equal(JSON.parse(s.calls[0].init.body).model, 'jev-1.13.0')
  } finally {
    s.restore()
    delete process.env.JEV_ZEN_API_KEY
  }
})

test('client: native backend — typesafe endpoint, jev-1.13.0 default, TYPESAFE_API_KEY', async () => {
  process.env.TYPESAFE_API_KEY = 'test-native-key'
  const s = stubFetch(() => jsonResponse({ answers: { c1: { noul: 0.4 } } }))
  try {
    const r = await jevAsk({ state: 's', questions: BASE_QUESTIONS, config: { ...BASE_CONFIG, jevBackend: 'native' }, log: LOG, lane: 'didyoumean' })
    assert.equal(r.ok, true)
    assert.equal(s.calls[0].url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(JSON.parse(s.calls[0].init.body).model, 'jev-1.13.0')
    assert.equal(s.calls[0].init.headers.authorization, 'Bearer test-native-key')
  } finally {
    s.restore()
    delete process.env.TYPESAFE_API_KEY
  }
})

test('client: openrouter decisions protocol — string levels pass, structured levels refused locally', async () => {
  process.env.OPENROUTER_API_KEY = 'test-or-key'
  const s = stubFetch(() => jsonResponse({ answers: { q1: { score: 3 } } }))
  try {
    const r = await jevAsk({
      state: 's',
      questions: { q1: { type: 'score', instructions: 'rate it', criteria: ['low', 'mid', 'high'] } },
      config: { ...BASE_CONFIG, jevBackend: 'openrouter' },
      log: LOG,
      lane: 'list-rank',
    })
    assert.equal(r.ok, true)
    assert.equal(s.calls[0].url, 'https://openrouter.ai/api/alpha/decisions')
    const body = JSON.parse(s.calls[0].init.body)
    assert.equal(body.model, 'typesafe/jev-1.13')
    assert.deepEqual(body.questions.q1.criteria, ['low', 'mid', 'high'])

    // structured level objects are a systemone-only affordance
    const bad = await jevAsk({
      state: 's',
      questions: { q1: { type: 'score', instructions: 'rate it', criteria: [{ desc: 'low' }, 'high'] } },
      config: { ...BASE_CONFIG, jevBackend: 'openrouter' },
      log: LOG,
      lane: 'list-rank',
    })
    assert.equal(bad.ok, false)
    assert.equal(bad.outcome, 'invalid_request')
    assert.equal(s.calls.length, 1, 'refusal must not send anything')
  } finally {
    s.restore()
    delete process.env.OPENROUTER_API_KEY
  }
})

test('client: systemone tolerates structured score levels (protocol affordance)', async () => {
  const s = stubFetch(() => jsonResponse({ answers: { q1: { score: 2 } } }))
  try {
    const r = await jevAsk({
      state: 's',
      questions: { q1: { type: 'score', instructions: 'rate it', criteria: [{ desc: 'low' }, 'high'] } },
      config: zenConfig(),
      log: LOG,
      lane: 'usage-suggest',
    })
    assert.equal(r.ok, true)
    assert.deepEqual(JSON.parse(s.calls[0].init.body).questions.q1.criteria, [{ desc: 'low' }, 'high'])
  } finally {
    s.restore()
    delete process.env.JEV_ZEN_API_KEY
  }
})

test('client: openrouter refuses one-sided noul criteria before sending', async () => {
  process.env.OPENROUTER_API_KEY = 'test-or-key'
  const s = stubFetch(() => jsonResponse({ answers: {} }))
  try {
    const r = await jevAsk({
      state: 's',
      questions: { c1: { type: 'noul', instructions: 'x', criteria: { true: 'x' } } },
      config: { ...BASE_CONFIG, jevBackend: 'openrouter' },
      log: LOG,
      lane: 'didyoumean',
    })
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'invalid_request')
    assert.match(r.message, /two-sided/)
    assert.equal(s.calls.length, 0)
    assert.equal(lastDecisionRow().outcome, 'invalid_request')
  } finally {
    s.restore()
    delete process.env.OPENROUTER_API_KEY
  }
})

test('client: secret gate blocks builtin-pattern state, nothing sent', async () => {
  const s = stubFetch(() => jsonResponse({ answers: { c1: { noul: 0.9 } } }))
  try {
    const r = await jevAsk({
      state: 'the user pasted sk-ant-api03-abcdefghijklmnopqrst into chat',
      questions: BASE_QUESTIONS,
      config: zenConfig(),
      log: LOG,
      lane: 'usage-suggest',
      fallback: true,
    })
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'secret_gate_blocked')
    assert.match(r.message, /anthropic-key/)
    assert.match(r.message, /NOTHING was sent/)
    assert.ok(!r.message.includes('sk-ant-api03'))
    assert.equal(s.calls.length, 0)
    const row = lastDecisionRow()
    assert.equal(row.outcome, 'secret_gate_blocked')
    assert.equal(row.fallback, true)
    assert.equal(row.usage, null)
  } finally {
    s.restore()
    delete process.env.JEV_ZEN_API_KEY
  }
})

test('client: secret gate covers the model field and the external list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-adapter-jev-client-'))
  try {
    const secretFile = join(dir, 'secrets')
    writeFileSync(secretFile, 'corp-internal-token-777\n', 'utf8')
    const s = stubFetch(() => jsonResponse({ answers: { c1: { noul: 0.9 } } }))
    try {
      // external list entry in the state
      let r = await jevAsk({
        state: 'leak of corp-internal-token-777',
        questions: BASE_QUESTIONS,
        config: zenConfig({ jevSecretFile: secretFile }),
        log: LOG,
        lane: 'usage-suggest',
      })
      assert.equal(r.outcome, 'secret_gate_blocked')
      assert.match(r.message, /external\(/)
      assert.equal(s.calls.length, 0)

      // a secret smuggled in via the model id hits the same gate (the WHOLE
      // serialized body is scanned, model included)
      r = await jevAsk({
        state: 'clean',
        questions: BASE_QUESTIONS,
        config: zenConfig({ jevModel: `evil-${'corp-internal-token-777'}`, jevSecretFile: secretFile }),
        log: LOG,
        lane: 'usage-suggest',
      })
      assert.equal(r.outcome, 'secret_gate_blocked')

      // same file, clean state → passes
      r = await jevAsk({
        state: 'clean',
        questions: BASE_QUESTIONS,
        config: zenConfig({ jevSecretFile: secretFile }),
        log: LOG,
        lane: 'usage-suggest',
      })
      assert.equal(r.ok, true)
    } finally {
      s.restore()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.JEV_ZEN_API_KEY
  }
})

test('client: missing key → missing_key without any request (native probes nothing)', async () => {
  delete process.env.TYPESAFE_API_KEY
  delete process.env.JEV_KEYCHAIN
  const s = stubFetch(() => jsonResponse({ answers: {} }))
  try {
    const r = await jevAsk({ state: 's', questions: BASE_QUESTIONS, config: { ...BASE_CONFIG, jevBackend: 'native' }, log: LOG, lane: 'didyoumean' })
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'missing_key')
    assert.match(r.message, /TYPESAFE_API_KEY/)
    assert.equal(s.calls.length, 0)
  } finally {
    s.restore()
  }
})

test('client: timeout — stub honors the abort signal, maps to timeout, no retry', async () => {
  // AbortSignal.timeout's timer is UNREF'd: with a never-settling stub the
  // only pending work is that unref'd timer, so the event loop can drain
  // before the abort fires and node:test cancels the remaining file (seen on
  // node 22 CI). Keep the loop ref'd until the abort actually lands.
  const keepAlive = setInterval(() => {}, 5)
  const s = stubFetch((_calls, init) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted due to timeout')
        err.name = 'TimeoutError'
        reject(err)
      })
      // never resolves on its own — no retry may fire either
    })
  })
  try {
    const r = await jevAsk({ state: 's', questions: BASE_QUESTIONS, config: zenConfig({ jevTimeoutMs: 30 }), log: LOG, lane: 'list-rank' })
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'timeout')
    assert.equal(s.calls.length, 1, 'NO retry — one attempt only')
    assert.equal(lastDecisionRow().outcome, 'timeout')
  } finally {
    clearInterval(keepAlive)
    s.restore()
    delete process.env.JEV_ZEN_API_KEY
  }
})

test('client: fetch rejection (non-timeout) maps to network', async () => {
  const s = stubFetch(() => {
    throw new TypeError('fetch failed: ECONNREFUSED')
  })
  try {
    const r = await jevAsk({ state: 's', questions: BASE_QUESTIONS, config: zenConfig({ jevTimeoutMs: 500 }), log: LOG, lane: 'didyoumean' })
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'network')
    assert.match(r.message, /ECONNREFUSED/)
  } finally {
    s.restore()
    delete process.env.JEV_ZEN_API_KEY
  }
})

test('client: http status mapping — 4xx vs 5xx, body truncated into the message', async () => {
  for (const [status, expected] of [[400, 'http_4xx'], [401, 'http_4xx'], [500, 'http_5xx'], [503, 'http_5xx']]) {
    const longBody = JSON.stringify({ error: 'e'.repeat(1000) })
    const s = stubFetch(() => jsonResponse(longBody, status))
    try {
      const r = await jevAsk({ state: 's', questions: BASE_QUESTIONS, config: zenConfig(), log: LOG, lane: 'usage-suggest' })
      assert.equal(r.ok, false)
      assert.equal(r.outcome, expected, `status ${status} → ${expected}`)
      assert.match(r.message, new RegExp(String(status)))
      assert.ok(r.message.length < 400, 'error body must be truncated (≤300 chars + prefix)')
      assert.ok(r.message.includes('eeee'))
    } finally {
      s.restore()
    }
  }
  delete process.env.JEV_ZEN_API_KEY
})

test('client: non-JSON 200 body → bad_json', async () => {
  const s = stubFetch(() => jsonResponse('<html>gateway error</html>'))
  try {
    const r = await jevAsk({ state: 's', questions: BASE_QUESTIONS, config: zenConfig(), log: LOG, lane: 'usage-suggest' })
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'bad_json')
    assert.match(r.message, /non-JSON/)
  } finally {
    s.restore()
    delete process.env.JEV_ZEN_API_KEY
  }
})

test('client: answers shape — missing answers object or question id → bad_json', async () => {
  for (const body of [{ model: 'jev-1.13-free' }, { answers: {} }, { answers: { c2: { noul: 0.5 } } }]) {
    const s = stubFetch(() => jsonResponse(body))
    try {
      const r = await jevAsk({
        state: 's',
        questions: { c1: { type: 'noul', instructions: 'i1' }, c2: { type: 'noul', instructions: 'i2' } },
        config: zenConfig(),
        log: LOG,
        lane: 'list-rank',
      })
      assert.equal(r.ok, false, `expected bad_json for ${JSON.stringify(body)}`)
      assert.equal(r.outcome, 'bad_json')
    } finally {
      s.restore()
    }
  }
  delete process.env.JEV_ZEN_API_KEY
})

test('client: batch of 6 rides ONE request (batch protocol, no per-question calls)', async () => {
  const s = stubFetch(() => jsonResponse({ answers: Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => [id, { noul: 0.5 }])) }))
  try {
    const questions = Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => [id, { type: 'noul', instructions: `cand ${id}` }]))
    const r = await jevAsk({ state: 's', questions, config: zenConfig(), log: LOG, lane: 'usage-suggest' })
    assert.equal(r.ok, true)
    assert.equal(Object.keys(r.answers).length, 6)
    assert.equal(s.calls.length, 1)
    assert.equal(Object.keys(JSON.parse(s.calls[0].init.body).questions).length, 6)
  } finally {
    s.restore()
    delete process.env.JEV_ZEN_API_KEY
  }
})

// ---- key resolution units (injected runner — never touches the real keychain) ----

test('keychain: spec parsing', () => {
  assert.deepEqual(parseKeychainSpec('svc'), { service: 'svc' })
  assert.deepEqual(parseKeychainSpec('svc:acct'), { service: 'svc', account: 'acct' })
  assert.deepEqual(parseKeychainSpec('svc:acct:extra'), { service: 'svc', account: 'acct:extra' })
})

test('keychain: lookup returns trimmed secret, null on failure', async () => {
  const okRunner = async () => ({ stdout: '  secret-123  \n' })
  assert.equal(await keychainLookup({ service: 's' }, okRunner), 'secret-123')
  const failRunner = async () => {
    throw new Error('SecKeychainSearchCopyFromAttributes: The specified item could not be found')
  }
  assert.equal(await keychainLookup({ service: 's', account: 'a' }, failRunner), null)
})

test('keychain: env var wins over the keychain', async () => {
  const seen = []
  const spy = async (spec) => {
    seen.push(spec)
    return 'keychain-key'
  }
  process.env.JEV_ZEN_API_KEY = 'env-key'
  assert.equal(await resolveApiKey(BACKENDS.zen, spy), 'env-key')
  assert.deepEqual(seen, [])
  delete process.env.JEV_ZEN_API_KEY
})

test('keychain: zen falls back to its DEFAULT service; native/openrouter need explicit JEV_KEYCHAIN', async () => {
  const seen = []
  const spy = async (spec) => {
    seen.push(spec)
    return 'kc-key'
  }
  // zen: default service probed when no env key and no JEV_KEYCHAIN
  assert.equal(await resolveApiKey(BACKENDS.zen, spy), 'kc-key')
  assert.deepEqual(seen, [{ service: 'opencode-zen-inference' }])
  // native: no probe at all
  seen.length = 0
  assert.equal(await resolveApiKey(BACKENDS.native, spy), '')
  assert.deepEqual(seen, [])
  // explicit JEV_KEYCHAIN opts any backend in, service[:account] honored
  process.env.JEV_KEYCHAIN = 'my-svc:my-acct'
  assert.equal(await resolveApiKey(BACKENDS.native, spy), 'kc-key')
  assert.deepEqual(seen, [{ service: 'my-svc', account: 'my-acct' }])
  delete process.env.JEV_KEYCHAIN
})

test('keychain: empty env value counts as absent', async () => {
  process.env.TYPESAFE_API_KEY = ''
  const seen = []
  assert.equal(await resolveApiKey(BACKENDS.native, async (spec) => (seen.push(spec), null)), '')
  assert.deepEqual(seen, [])
  delete process.env.TYPESAFE_API_KEY
})

// A backend of this test's own, so the process-wide memo (see below) can never
// answer a real backend's entry — the memo is keyed by backend name + spec.
const MEMO_BACKEND = { name: 'memo-probe', keyEnv: 'MEMO_PROBE_KEY', keychainService: 'memo-probe-service', keychainByDefault: true }
delete process.env.MEMO_PROBE_KEY

test('keychain: a hanging lookup is bounded — null at the deadline, never a throw', async () => {
  // A locked keychain makes `security` block until a UI unlock nobody may ever
  // see; resolveApiKey is awaited BEFORE the fetch, so an unbounded lookup
  // parks the seam outside its own timeout budget.
  const hanging = () => new Promise(() => {})
  const started = Date.now()
  assert.equal(await keychainLookup({ service: 's' }, hanging, 60), null, 'a timeout is a MISSING KEY, not a throw')
  assert.ok(Date.now() - started < 2000, 'the caller is released at the deadline, not at the child\'s leisure')
  // …and it reads as "no key" all the way up the stack, which is the value
  // jevAsk refuses with the structured `missing_key` (asserted above).
  assert.equal(await resolveApiKey(MEMO_BACKEND, spec => keychainLookup(spec, hanging, 60)), '')
  // A runner that throws SYNCHRONOUSLY is contained too (the pre-deadline
  // contract): a lookup failure never escapes into the seam.
  assert.equal(await keychainLookup({ service: 's' }, () => { throw new Error('no such binary: security') }, 60), null)
})

test('keychain: the default budget is 3s and is the one enforced', { timeout: 20_000 }, async () => {
  // The production path passes no budget: prove the 3s default is what a
  // stuck `security` actually meets, and that a nonsense budget falls back to
  // it instead of disabling the bound (removing either fails here rather than
  // hanging the suite forever).
  const hanging = () => new Promise(() => {})
  const started = Date.now()
  const [byDefault, byInvalid] = await Promise.all([
    keychainLookup({ service: 's' }, hanging),
    keychainLookup({ service: 's' }, hanging, 0),
  ])
  const elapsed = Date.now() - started
  assert.equal(KEYCHAIN_TIMEOUT_MS, 3000, 'the budget is outside every jevTimeoutMs on purpose')
  assert.deepEqual([byDefault, byInvalid], [null, null])
  assert.ok(elapsed >= KEYCHAIN_TIMEOUT_MS - 100, `waited out the budget (${elapsed}ms)`)
  assert.ok(elapsed < 10_000, 'and not forever')
})

test('keychain: the resolved key is memoized per backend — two calls, one spawn', async () => {
  const seen = []
  const lookup = async (spec) => { seen.push(spec); return 'memoized-key' }
  assert.equal(await resolveApiKey(MEMO_BACKEND, lookup), 'memoized-key')
  assert.equal(await resolveApiKey(MEMO_BACKEND, lookup), 'memoized-key')
  assert.equal(await resolveApiKey(MEMO_BACKEND, lookup), 'memoized-key')
  assert.deepEqual(seen, [{ service: 'memo-probe-service' }], '`security` is spawned once, not once per seam call')
  // The env path is read on EVERY call and never memoized, so a settings-page
  // key change takes effect on the next request.
  process.env.MEMO_PROBE_KEY = 'env-key'
  assert.equal(await resolveApiKey(MEMO_BACKEND, lookup), 'env-key')
  assert.equal(seen.length, 1, 'the env key short-circuits the keychain entirely')
  delete process.env.MEMO_PROBE_KEY
  // Repointing JEV_KEYCHAIN is a different spec, so it cannot be answered out
  // of the memo entry written for another service.
  process.env.JEV_KEYCHAIN = 'other-svc:other-acct'
  assert.equal(await resolveApiKey(MEMO_BACKEND, lookup), 'memoized-key')
  assert.deepEqual(seen[1], { service: 'other-svc', account: 'other-acct' })
  delete process.env.JEV_KEYCHAIN
})

test('keychain: a MISS is never memoized — unlocking the keychain takes effect', async () => {
  // Caching a miss would weld a locked keychain shut for the whole process:
  // the first `security` call of every seam would fail, and so would every
  // later one, even after the user unlocks.
  const LOCKED = { name: 'locked-probe', keyEnv: 'LOCKED_PROBE_KEY', keychainService: 'locked-probe-service', keychainByDefault: true }
  delete process.env.LOCKED_PROBE_KEY
  let locked = true
  let spawns = 0
  const lookup = async () => { spawns += 1; return locked ? null : 'unlocked-key' }
  assert.equal(await resolveApiKey(LOCKED, lookup), '')
  assert.equal(await resolveApiKey(LOCKED, lookup), '', 'still locked: re-probed, still no key')
  assert.equal(spawns, 2, 'a miss is not a cached answer')
  locked = false
  assert.equal(await resolveApiKey(LOCKED, lookup), 'unlocked-key')
  assert.equal(spawns, 3)
  await resolveApiKey(LOCKED, lookup)
  assert.equal(spawns, 3, 'the success IS cached')
})

// ---- normalization + backend table units ----

test('normalize: rejects empty questions, unknown types, missing instructions', () => {
  assert.equal(normalizeQuestions({}, 'systemone').ok, false)
  assert.equal(normalizeQuestions({ c1: { type: 'noul', instructions: '' } }, 'systemone').ok, false)
  assert.equal(normalizeQuestions({ c1: { type: 'rank', instructions: 'x' } }, 'systemone').ok, false)
})

test('backends: table matches the design §3.1 pins', () => {
  assert.deepEqual(resolveBackend('zen'), BACKENDS.zen)
  assert.equal(BACKENDS.zen.endpoint, 'https://opencode.ai/zen/v1/systemone')
  assert.equal(BACKENDS.zen.defaultModel, 'jev-1.13-free')
  assert.equal(BACKENDS.zen.keyEnv, 'JEV_ZEN_API_KEY')
  assert.equal(BACKENDS.zen.keychainService, 'opencode-zen-inference')
  assert.equal(BACKENDS.zen.keychainByDefault, true)
  assert.equal(BACKENDS.native.endpoint, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(BACKENDS.native.defaultModel, 'jev-1.13.0')
  assert.equal(BACKENDS.native.keyEnv, 'TYPESAFE_API_KEY')
  assert.equal(BACKENDS.native.keychainByDefault, false)
  assert.equal(BACKENDS.openrouter.endpoint, 'https://openrouter.ai/api/alpha/decisions')
  assert.equal(BACKENDS.openrouter.family, 'decisions')
  assert.equal(BACKENDS.openrouter.defaultModel, 'typesafe/jev-1.13')
  assert.equal(BACKENDS.openrouter.keyEnv, 'OPENROUTER_API_KEY')
  assert.equal(BACKENDS.openrouter.keychainByDefault, false)
  // unknown/absent name lands on the config default
  assert.equal(resolveBackend(undefined), BACKENDS.zen)
  assert.equal(resolveBackend('bogus'), BACKENDS.zen)
})

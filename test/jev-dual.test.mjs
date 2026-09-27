// jev dual-run pace-maker (design §3.4) — ported from dsh-topics-memory
// test/jev-dual.test.mjs. The topics version drove the wrapper through its
// slow lane (business seam); here the wrapper itself is the unit under test —
// this stage ships the decision ground floor, not the seams — so the four
// contract cases are asserted directly on jevAskDual.
//
// Hermetic: fetch is stubbed per-URL (opencode.ai = primary, 127.0.0.1:8000 =
// laya), the decisions.jsonl sink is a temp dir handed to createDecisionLog,
// keys are env-injected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createDecisionLog } = await import('../lib/jev/log.js')
const { jevAskDual, DEFAULT_LAYA_URL } = await import('../lib/jev/dual.js')

const QUESTIONS = { c1: { type: 'noul', instructions: 'rank this candidate' } }

/** Dual-routed fetch stub: the URL decides the backend. */
function dualFetchStub({ primaryFail = null, layaFail = null }) {
  const calls = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const isLaya = u.includes('127.0.0.1:8000')
    calls.push({ url: u, backend: isLaya ? 'laya' : 'primary', body: JSON.parse(init.body) })
    if (isLaya && layaFail === 'refused') throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8000')
    if (isLaya && layaFail === 'timeout') {
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted due to timeout')
          e.name = 'TimeoutError'
          rej(e)
        })
      })
    }
    if (!isLaya && primaryFail !== null) {
      if (primaryFail === 'timeout') {
        return new Promise((_res, rej) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted due to timeout')
            e.name = 'TimeoutError'
            rej(e)
          })
        })
      }
      return new Response('backend exploded', { status: primaryFail })
    }
    return new Response(
      JSON.stringify({ answers: { c1: { noul: isLaya ? 0.62 : 0.91 } }, usage: { input_tokens: 111, output_tokens: 22 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { calls, restore: () => (globalThis.fetch = prev) }
}

/** One scratch log dir + stubbed fetch per test; keys env-injected. */
function withDual(t, { jevLayaFallback, primaryFail = null, layaFail = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-adapter-jev-dual-'))
  const log = createDecisionLog(dir)
  const prevKey = process.env.JEV_ZEN_API_KEY
  process.env.JEV_ZEN_API_KEY = 'test-zen-key'
  const stub = dualFetchStub({ primaryFail, layaFail })
  // AbortSignal.timeout's timer is UNREF'd: a never-settling stub leaves the
  // event loop with nothing ref'd, so node:test could cancel the file before
  // the abort lands. Keep the loop ref'd for the whole test.
  const keepAlive = setInterval(() => {}, 5)
  t.after(() => {
    clearInterval(keepAlive)
    stub.restore()
    if (prevKey === undefined) delete process.env.JEV_ZEN_API_KEY
    else process.env.JEV_ZEN_API_KEY = prevKey
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    calls: stub.calls,
    rows: () => {
      try {
        return readFileSync(log.file(), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
    args: {
      state: 'mcp tool selection state',
      questions: QUESTIONS,
      log,
      lane: 'usage-suggest',
      fallback: true,
      config: {
        jevBackend: 'zen',
        jevModel: '',
        jevTimeoutMs: primaryFail === 'timeout' ? 30 : 5000,
        jevSecretFile: '',
        jevLayaFallback,
        jevLayaUrl: DEFAULT_LAYA_URL,
      },
    },
  }
}

test('dual off (default): zero laya requests — behavior identical to pre-dual', async (t) => {
  const d = withDual(t, { jevLayaFallback: false })
  const r = await jevAskDual(d.args)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'primary')
  assert.equal(r.layaResult, null, 'the pace-maker never ran')
  assert.equal(r.answers.c1.noul, 0.91, 'the primary answer drove the decision')
  assert.equal(d.calls.filter((c) => c.backend === 'laya').length, 0, 'no pace-maker request')
  assert.ok(d.calls.every((c) => c.body.model === 'jev-1.13-free'))
  const rows = d.rows()
  assert.equal(rows.length, 1, 'exactly one call-layer row')
  assert.equal(rows.some((row) => row.backend === 'laya'), false, 'no laya call rows')
  assert.equal(rows[0].outcome, 'ok')
})

test('dual on, primary ok: primary drives, laya logged as a comparison row', async (t) => {
  const d = withDual(t, { jevLayaFallback: true })
  const r = await jevAskDual(d.args)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'primary', 'primary drives whenever it is ok')
  assert.equal(r.answers.c1.noul, 0.91, 'laya\'s answer is NOT what drives the seam')
  assert.ok(r.layaResult?.ok === true, 'the pace-maker result is handed back for comparison')

  const layaCalls = d.calls.filter((c) => c.backend === 'laya')
  assert.equal(layaCalls.length, 1, 'pace-maker fired once, in parallel')
  assert.equal(layaCalls[0].url, DEFAULT_LAYA_URL)
  assert.equal(layaCalls[0].body.model, 'laya-rl-agent')

  const rows = d.rows()
  assert.equal(rows.length, 2, 'both sides land a call-layer row')
  const backends = rows.map((row) => row.backend).sort()
  assert.deepEqual(backends, ['laya', 'zen'])
  assert.ok(rows.every((row) => row.outcome === 'ok'))
  assert.ok(rows.every((row) => row.fallback === true))
})

test('dual on, primary timeout → laya degraded takeover', async (t) => {
  const d = withDual(t, { jevLayaFallback: true, primaryFail: 'timeout' })
  const r = await jevAskDual(d.args)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'laya', 'degraded takeover: the seam may only use RELATIVE ordering')
  assert.equal(r.answers.c1.noul, 0.62, 'laya\'s answers are what the seam sees')
  assert.equal(r.layaResult?.ok, true)

  const rows = d.rows()
  const byBackend = (b) => rows.filter((row) => row.backend === b)
  assert.equal(byBackend('laya').length, 1)
  assert.equal(byBackend('laya')[0].outcome, 'ok')
  assert.equal(byBackend('zen').length, 1)
  assert.equal(byBackend('zen')[0].outcome, 'timeout', 'the primary failure is still logged (fallback rate is the health metric)')
})

test('dual on, primary AND laya fail → fail-open structured failure, nothing thrown', async (t) => {
  const d = withDual(t, { jevLayaFallback: true, primaryFail: 503, layaFail: 'refused' })
  const r = await jevAskDual(d.args)
  assert.equal(r.ok, false, 'the seam sees a structured failure it can swallow — never a throw')
  assert.equal(r.outcome, 'http_5xx', 'the primary failure is the reported one')
  assert.equal(r.source, 'primary')
  assert.equal(r.layaResult?.ok, false)
  assert.equal(r.layaResult?.outcome, 'network', 'the laya refusal is still recorded')

  const rows = d.rows()
  assert.equal(rows.length, 2, 'both failures are logged')
  assert.ok(rows.some((row) => row.backend === 'laya' && row.outcome === 'network'))
  assert.ok(rows.some((row) => row.backend === 'zen' && row.outcome === 'http_5xx'))
})

test('dual on, laya down (refused) → primary-only, zero behavior change', async (t) => {
  const d = withDual(t, { jevLayaFallback: true, layaFail: 'refused' })
  const r = await jevAskDual(d.args)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'primary')
  assert.equal(r.answers.c1.noul, 0.91)
  assert.equal(d.calls.filter((c) => c.backend === 'laya').length, 1, 'pace-maker attempted')
  const rows = d.rows()
  assert.equal(rows.filter((row) => row.backend === 'laya')[0].outcome, 'network', 'the refused connection is logged')
})

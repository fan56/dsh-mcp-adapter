// decisions.jsonl telemetry tests — ported from dsh-topics-memory
// test/jev-log.test.mjs. The destination is INJECTED (createDecisionLog over
// a fresh temp dir per test) instead of an env-resolved bundle root; every
// other mechanism (queued appends, 512KB compaction keeping the most recent
// quarter, digest, field whitelist, swallowed write failures) is unchanged.
// No network, no key material.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createDecisionLog, digestFor, decisionsFile } = await import('../lib/jev/log.js')
const { band, SUGGEST_ADOPT, SUGGEST_FALLBACK, MERGE_PAIR_ADOPT, MERGE_PAIR_FALLBACK } = await import('../lib/jev/thresholds.js')

/** A fresh temp log dir per test — the queue is per-log, never shared. */
function freshLog() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-adapter-jev-log-'))
  const log = createDecisionLog(dir)
  return { dir, log, file: decisionsFile(dir), done: () => rmSync(dir, { recursive: true, force: true }) }
}

function callRec(overrides = {}) {
  return {
    at: '2026-09-25T00:00:00.000Z',
    lane: 'usage-suggest',
    backend: 'zen',
    model: 'jev-1.13-free',
    questionCount: 6,
    stateChars: 1843,
    latencyMs: 448,
    usage: { input_tokens: 2417, output_tokens: 108 },
    outcome: 'ok',
    fallback: false,
    ...overrides,
  }
}

function verdictRec(overrides = {}) {
  return {
    at: '2026-09-25T00:00:00.000Z',
    lane: 'didyoumean',
    questionId: 'c3',
    qtype: 'noul',
    ref: 'tool:github',
    digest: digestFor('state', 'c3', 'instr'),
    probability: 0.62,
    band: 'record',
    agree: 'hit',
    ...overrides,
  }
}

function readRows(file) {
  const raw = readFileSync(file, 'utf8')
  return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}

test('log: call row lands at <logDir>/decisions.jsonl with the exact §6.2 field whitelist', async () => {
  const t = freshLog()
  try {
    await t.log.logCall(callRec())
    const rows = readRows(t.file)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.deepEqual(
      Object.keys(row).sort(),
      ['at', 'backend', 'fallback', 'lane', 'latencyMs', 'model', 'outcome', 'questionCount', 'stateChars', 'usage'],
    )
    assert.equal(row.lane, 'usage-suggest')
    assert.deepEqual(row.usage, { input_tokens: 2417, output_tokens: 108 })
    assert.equal(row.fallback, false)
  } finally {
    t.done()
  }
})

test('log: the three adapter lanes are the lane vocabulary', async () => {
  const t = freshLog()
  try {
    for (const lane of ['usage-suggest', 'list-rank', 'didyoumean']) {
      await t.log.logCall(callRec({ lane }))
    }
    assert.deepEqual(readRows(t.file).map((r) => r.lane), ['usage-suggest', 'list-rank', 'didyoumean'])
  } finally {
    t.done()
  }
})

test('log: extra fields on caller objects are dropped (redaction whitelist — no state text can leak)', async () => {
  const t = freshLog()
  try {
    const leaky = { ...callRec(), stateText: 'SHOULD-NOT-LEAK', conclusion: 'SHOULD-NOT-LEAK-EITHER' }
    await t.log.logCall(leaky)
    const raw = readFileSync(t.file, 'utf8')
    assert.ok(!raw.includes('SHOULD-NOT-LEAK'))
    const leakyVerdict = { ...verdictRec(), stateText: 'LEAK-ME-NOT' }
    await t.log.logVerdicts([leakyVerdict])
    const raw2 = readFileSync(t.file, 'utf8')
    assert.ok(!raw2.includes('LEAK-ME-NOT'))
  } finally {
    t.done()
  }
})

test('log: verdict rows carry the §6.2 verdict-layer fields (backend/degraded included); empty batch writes nothing', async () => {
  const t = freshLog()
  try {
    await t.log.logVerdicts([])
    assert.equal(existsSync(t.file), false, 'empty batch must not create the file')
  } finally {
    t.done()
  }

  const t2 = freshLog()
  try {
    await t2.log.logVerdicts([
      verdictRec(),
      verdictRec({ questionId: 'c4', probability: 0.05, band: 'fallback', agree: 'wouldBlock', ref: 'server:linear', backend: 'laya', degraded: true }),
    ])
    const rows = readRows(t2.file)
    assert.equal(rows.length, 2)
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ['agree', 'at', 'backend', 'band', 'degraded', 'digest', 'lane', 'probability', 'qtype', 'questionId', 'ref'],
    )
    assert.equal(rows[0].backend, 'primary', 'absent backend defaults to primary')
    assert.equal(rows[0].degraded, false)
    assert.equal(rows[1].agree, 'wouldBlock')
    assert.equal(rows[1].ref, 'server:linear')
    assert.equal(rows[1].backend, 'laya')
    assert.equal(rows[1].degraded, true)
  } finally {
    t2.done()
  }
})

test('log: digest is h1: + 16 hex, stable, and differs per state/question/instructions', () => {
  const d = digestFor('state text', 'c1', 'instructions')
  assert.match(d, /^h1:[0-9a-f]{16}$/)
  assert.equal(d, digestFor('state text', 'c1', 'instructions'))
  assert.notEqual(d, digestFor('other state', 'c1', 'instructions'))
  assert.notEqual(d, digestFor('state text', 'c2', 'instructions'))
  assert.notEqual(d, digestFor('state text', 'c1', 'other instructions'))
})

test('log: thresholds are the ported placeholders and band() respects the boundaries', () => {
  // PLACEHOLDER numbers (see src/jev/thresholds.ts): they MUST be re-swept
  // against this plugin's own protocol before any seam acts on a band. This
  // test pins the CURRENT values so a future calibration is a visible change.
  assert.equal(SUGGEST_ADOPT, 0.6)
  assert.equal(SUGGEST_FALLBACK, 0.1)
  assert.equal(MERGE_PAIR_ADOPT, 0.5)
  assert.equal(MERGE_PAIR_FALLBACK, 0.15)

  assert.equal(band(0.6, 'suggest'), 'adopt')
  assert.equal(band(0.599, 'suggest'), 'record')
  assert.equal(band(0.1, 'suggest'), 'record')
  assert.equal(band(0.099, 'suggest'), 'fallback')
  assert.equal(band(0.95, 'suggest'), 'adopt')

  assert.equal(band(0.5, 'mergePair'), 'adopt')
  assert.equal(band(0.499, 'mergePair'), 'record')
  assert.equal(band(0.15, 'mergePair'), 'record')
  assert.equal(band(0.149, 'mergePair'), 'fallback')
})

test('log: 512KB rotation keeps the most recent quarter', async () => {
  const t = freshLog()
  try {
    // pre-fill ~700 lines × ~1KB ≈ 700KB (> 512KB cap)
    const big = JSON.stringify({ pad: 'x'.repeat(1000), n: 0 })
    const lines = []
    for (let i = 0; i < 700; i++) lines.push(big.replace('"n":0', `"n":${i}`))
    writeFileSync(t.file, lines.map((l) => `${l}\n`).join(''), 'utf8')

    await t.log.logCall(callRec({ outcome: 'timeout', fallback: true }))
    const rows = readRows(t.file)
    assert.ok(rows.length < 200, `compacted to ~quarter, got ${rows.length}`)
    assert.ok(rows.length > 100, `recent quarter preserved, got ${rows.length}`)
    // the new record survived at the tail
    assert.equal(rows[rows.length - 1].outcome, 'timeout')
    assert.equal(rows[rows.length - 1].fallback, true)
  } finally {
    t.done()
  }
})

test('log: under the cap nothing is rewritten', async () => {
  const t = freshLog()
  try {
    await t.log.logCall(callRec())
    const before = readFileSync(t.file, 'utf8')
    await t.log.logVerdicts([verdictRec()])
    const after = readFileSync(t.file, 'utf8')
    assert.ok(after.startsWith(before))
  } finally {
    t.done()
  }
})

test('log: concurrent appends from one handle stay line-atomic (the append queue)', async () => {
  const t = freshLog()
  try {
    await Promise.all(Array.from({ length: 40 }, (_, i) => t.log.logCall(callRec({ latencyMs: i }))))
    const rows = readRows(t.file)
    assert.equal(rows.length, 40, 'no interleaved/torn line')
    assert.deepEqual(rows.map((r) => r.latencyMs), Array.from({ length: 40 }, (_, i) => i))
  } finally {
    t.done()
  }
})

test('log: write failures are swallowed — logCall never rejects (fail-open extends to stats)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-adapter-jev-log-'))
  try {
    // the log dir points at a regular FILE → mkdir under it fails
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'I am a file', 'utf8')
    const log = createDecisionLog(blocker)
    await assert.doesNotReject(log.logCall(callRec()))
    await assert.doesNotReject(log.logVerdicts([verdictRec()]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

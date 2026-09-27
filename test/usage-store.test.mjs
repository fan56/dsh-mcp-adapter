// Seam A data layer (src/usage.ts) — the pure halves plus the file-backed
// store. No framework, no cordis: everything here is called directly against
// lib/usage.js, and the store runs against a scratch temp dir so no real dsh
// home is ever touched.
//
// The store's contract under test: memory updates are synchronous (a caller
// can threshold on the total it just produced), the document lands atomically,
// and a corrupt document costs statistics, never correctness.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  USAGE_FILE_NAME,
  SUGGESTIONS_FILE_NAME,
  EMPTY_USAGE,
  normalizeUsage,
  recordUsageCall,
  usageTotalCalls,
  usageToolCount,
  shouldRunSuggestBatch,
  createUsageStore,
  usageSuggestCandidates,
  suggestionBasis,
  keepSuggestionFragment,
  normalizeSuggestions,
  writeSuggestions,
  readSuggestions,
  usageFile,
  suggestionsFile,
  SUGGEST_DESCRIPTION_CHARS,
} = await import('../lib/usage.js')

function freshDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-adapter-usage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function readDoc(dir) {
  return JSON.parse(readFileSync(usageFile(dir), 'utf8'))
}

// ---- normalizeUsage (pure) ----

test('usage: normalizeUsage keeps a well-formed document verbatim', () => {
  const raw = {
    tools: {
      'mcp__fs__read_file': { calls: 12, errors: 2, firstUsedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-27T00:00:00.000Z' },
    },
  }
  assert.deepEqual(normalizeUsage(raw), raw)
})

test('usage: normalizeUsage degrades corrupt entries instead of failing', () => {
  const normalized = normalizeUsage({
    tools: {
      ok: { calls: 3, errors: 1, firstUsedAt: 'a', lastUsedAt: 'b' },
      negative: { calls: -5, errors: -1 },
      fractional: { calls: 2.9, errors: 0.5 },
      absurd: { calls: 9, errors: 99 },
      stringy: { calls: '3', errors: null },
      notAnObject: 42,
      '': { calls: 1 },
    },
  })
  assert.equal(normalized.tools.ok.calls, 3)
  assert.equal(normalized.tools.negative.calls, 0, 'a negative counter is zero, not a credit')
  assert.equal(normalized.tools.fractional.calls, 2, 'counters floor to integers')
  assert.equal(normalized.tools.absurd.errors, 9, 'errors can never exceed calls')
  assert.equal(normalized.tools.stringy.calls, 0, 'a stringly-typed counter is not trusted')
  assert.equal('notAnObject' in normalized.tools, false)
  assert.equal('' in normalized.tools, false, 'the empty name is not a tool')
  assert.equal(normalized.tools.negative.firstUsedAt, '', 'a missing timestamp is empty, never "now"')
})

test('usage: normalizeUsage survives any non-document at all', () => {
  for (const raw of [undefined, null, 42, 'text', [], { tools: [] }, { tools: null }]) {
    assert.deepEqual(normalizeUsage(raw), EMPTY_USAGE, `raw: ${JSON.stringify(raw)}`)
  }
})

// ---- recordUsageCall (pure) ----

test('usage: recordUsageCall counts calls and errors, and never mutates its input', () => {
  const first = recordUsageCall(EMPTY_USAGE, 'mcp__fs__read_file', false, '2026-09-01T00:00:00.000Z')
  assert.equal(first.tools['mcp__fs__read_file'].calls, 1)
  assert.equal(first.tools['mcp__fs__read_file'].errors, 0)
  assert.equal(first.tools['mcp__fs__read_file'].firstUsedAt, '2026-09-01T00:00:00.000Z')

  const second = recordUsageCall(first, 'mcp__fs__read_file', true, '2026-09-27T10:00:00.000Z')
  const stats = second.tools['mcp__fs__read_file']
  assert.equal(stats.calls, 2)
  assert.equal(stats.errors, 1)
  assert.equal(stats.firstUsedAt, '2026-09-01T00:00:00.000Z', 'firstUsedAt is the FIRST call, not the latest')
  assert.equal(stats.lastUsedAt, '2026-09-27T10:00:00.000Z')
  // The input document is untouched — snapshots handed to readers stay valid.
  assert.equal(first.tools['mcp__fs__read_file'].calls, 1)
  assert.deepEqual(EMPTY_USAGE, { tools: {} })
})

test('usage: recordUsageCall ignores an unnamed tool', () => {
  assert.equal(recordUsageCall(EMPTY_USAGE, '', true), EMPTY_USAGE)
})

test('usage: totals sum calls and count only tools that were used', () => {
  let doc = EMPTY_USAGE
  for (let i = 0; i < 3; i += 1) doc = recordUsageCall(doc, 'mcp__fs__read_file', i === 0)
  doc = recordUsageCall(doc, 'mcp__gh__create_issue', false)
  assert.equal(usageTotalCalls(doc), 4)
  assert.equal(usageToolCount(doc), 2)
  // A hand-written entry with zero calls exists but has no usage.
  const withZero = { tools: { ...doc.tools, idle: { calls: 0, errors: 0, firstUsedAt: '', lastUsedAt: '' } } }
  assert.equal(usageTotalCalls(withZero), 4)
  assert.equal(usageToolCount(withZero), 2, 'idle tools are not counted as used')
})

// ---- shouldRunSuggestBatch (pure) ----

test('usage: the batch threshold fires exactly on each multiple of 20', () => {
  const firing = []
  for (let total = 1; total <= 45; total += 1) if (shouldRunSuggestBatch(total)) firing.push(total)
  assert.deepEqual(firing, [20, 40], 'one batch per crossing, never on the call in between')
  assert.equal(shouldRunSuggestBatch(0), false, 'zero calls are not a crossing')
  assert.equal(shouldRunSuggestBatch(-1), false)
})

test('usage: the batch threshold is a pure function of the cadence', () => {
  const firing = []
  for (let total = 1; total <= 10; total += 1) if (shouldRunSuggestBatch(total, 5)) firing.push(total)
  assert.deepEqual(firing, [5, 10])
  assert.equal(shouldRunSuggestBatch(20, 0), false, 'a degenerate cadence never fires')
})

// ---- createUsageStore (file-backed) ----

test('usage store: records land in usage.json atomically and reload on restart', async (t) => {
  const dir = freshDir(t)
  const store = createUsageStore(dir, () => { throw new Error('must not warn') })
  store.record('mcp__fs__read_file', false)
  store.record('mcp__fs__read_file', true)
  store.record('mcp__gh__create_issue', false)
  assert.equal(store.total(), 3, 'the mirror updates synchronously')
  await store.flush()

  const doc = readDoc(dir)
  assert.equal(doc.tools['mcp__fs__read_file'].calls, 2)
  assert.equal(doc.tools['mcp__fs__read_file'].errors, 1)
  assert.equal(doc.tools['mcp__gh__create_issue'].calls, 1)
  assert.deepEqual(
    readdirSync(dir).filter(name => name.includes('.tmp')),
    [],
    'no tmp file survives an atomic write',
  )

  // A restart reads the document back — the counters are durable, not
  // per-session.
  const reopened = createUsageStore(dir, () => {})
  assert.equal(reopened.total(), 3)
  reopened.record('mcp__gh__create_issue', true)
  assert.equal(reopened.get().tools['mcp__gh__create_issue'].errors, 1)
})

test('usage store: a corrupt document warns once and degrades to zero statistics', async (t) => {
  const dir = freshDir(t)
  writeFileSync(usageFile(dir), '{ this is not json', 'utf8')
  const warnings = []
  const store = createUsageStore(dir, message => warnings.push(message))
  assert.equal(warnings.length, 1, 'exactly one boot warning')
  assert.match(warnings[0], /usage statistics/)
  assert.match(warnings[0], /starting from zero statistics/)
  assert.deepEqual(store.get(), EMPTY_USAGE)

  // Behavior is otherwise identical: recording keeps working and heals the file.
  store.record('mcp__fs__read_file', false)
  assert.equal(store.total(), 1)
  await store.flush()
  assert.equal(readDoc(dir).tools['mcp__fs__read_file'].calls, 1)
})

test('usage store: a missing document is the silent fresh-install state', (t) => {
  const dir = freshDir(t)
  const warnings = []
  const store = createUsageStore(dir, message => warnings.push(message))
  assert.deepEqual(warnings, [], 'a fresh install says nothing')
  assert.equal(store.total(), 0)
})

test('usage store: an unwritable directory keeps counting in memory and warns once', async (t) => {
  const dir = freshDir(t)
  // A FILE where the directory should be: every mkdir/write below fails.
  const blocked = join(dir, 'blocked')
  writeFileSync(blocked, 'not a directory', 'utf8')
  const warnings = []
  const store = createUsageStore(blocked, message => warnings.push(message))
  for (let i = 0; i < 5; i += 1) store.record('mcp__fs__read_file', false)
  assert.equal(store.total(), 5, 'the mirror is the source of truth')
  await store.flush()
  assert.equal(warnings.length, 1, 'one warning, not one per record')
  assert.match(warnings[0], /could not be written/)
})

test('usage store: bursts coalesce into a settled write, never a lost tail', async (t) => {
  const dir = freshDir(t)
  const store = createUsageStore(dir, () => {})
  for (let i = 0; i < 50; i += 1) store.record('mcp__fs__read_file', i % 3 === 0)
  await store.flush()
  assert.equal(readDoc(dir).tools['mcp__fs__read_file'].calls, 50, 'every record is durable once flushed')
  assert.equal(readdirSync(dir).filter(name => name.includes('.tmp')).length, 0)
})

test('usage store: flush on an idle store resolves immediately', async (t) => {
  const dir = freshDir(t)
  const store = createUsageStore(dir, () => {})
  await store.flush()
  assert.deepEqual(readdirSync(dir), [], 'no file is created by an idle store')
})

// ---- usageSuggestCandidates (pure) ----

test('usage: suggestion candidates are the FOLDED tools that were actually used', () => {
  const schemas = [
    { name: 'mcp__fs__read_file', description: 'Read a file' },
    { name: 'mcp__fs__write_file', description: 'Write a file' },
    { name: 'mcp__gh__create_issue', description: 'Create an issue' },
    { name: 'read', description: 'native tool' },
  ]
  const folded = new Set(['mcp__fs__read_file', 'mcp__fs__write_file', 'mcp__gh__create_issue'])
  const doc = {
    tools: {
      mcp__fs__read_file: { calls: 5, errors: 0, firstUsedAt: 'a', lastUsedAt: '2026-09-27T09:00:00.000Z' },
      // Used, but it is kept native — it is not folded, so it is not a
      // candidate for "should this become resident?" (it already is).
      mcp__fs__write_file: { calls: 9, errors: 1, firstUsedAt: 'a', lastUsedAt: 'b' },
      mcp__gh__create_issue: { calls: 1, errors: 0, firstUsedAt: 'a', lastUsedAt: 'c' },
      // Folded but never called: no usage evidence, no candidate.
      mcp__fs__list_dir: { calls: 0, errors: 0, firstUsedAt: '', lastUsedAt: '' },
    },
  }
  const keptNative = new Set(['mcp__fs__write_file'])
  const candidates = usageSuggestCandidates(
    doc,
    schemas,
    name => folded.has(name) && !keptNative.has(name),
  )
  assert.deepEqual(candidates.map(c => c.tool), ['mcp__fs__read_file', 'mcp__gh__create_issue'])
  assert.equal(candidates[0].calls, 5)
  assert.equal(candidates[0].description, 'Read a file', 'the description travels with the candidate')
  assert.equal(candidates[0].lastUsedAt, '2026-09-27T09:00:00.000Z')
})

test('usage: suggestion candidates are capped and descriptions truncated', () => {
  const schemas = Array.from({ length: 60 }, (_unused, index) => ({
    name: `mcp__s__t${index}`,
    description: 'x'.repeat(500),
  }))
  const doc = { tools: Object.fromEntries(schemas.map((schema, index) => [schema.name, { calls: 100 - index, errors: 0, firstUsedAt: 'a', lastUsedAt: 'b' }])) }
  const candidates = usageSuggestCandidates(doc, schemas, () => true)
  assert.equal(candidates.length, 40, 'the batch cap is the jev question cap')
  assert.equal(candidates[0].tool, 'mcp__s__t0', 'most used first')
  assert.equal(candidates[0].description.length, SUGGEST_DESCRIPTION_CHARS)
  assert.equal(usageSuggestCandidates(doc, schemas, () => true, 3).length, 3)
})

test('usage: an unknown tool in the mirror still yields a candidate without a description', () => {
  const doc = { tools: { mcp__gone__t: { calls: 3, errors: 0, firstUsedAt: 'a', lastUsedAt: 'b' } } }
  const candidates = usageSuggestCandidates(doc, [], () => true)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].description, '', 'a re-synced-away tool has no blurb, not a crash')
})

test('usage: the basis line and the keep fragment are what the operator reads', () => {
  assert.equal(
    suggestionBasis({ calls: 24, errors: 1, lastUsedAt: '2026-09-27T10:11:12.000Z' }),
    '24 call(s), 1 error(s), last used 2026-09-27',
  )
  assert.equal(suggestionBasis({ calls: 2, errors: 0, lastUsedAt: '' }), '2 call(s), 0 error(s), last used unknown')
  assert.equal(keepSuggestionFragment('mcp__github__create_issue'), 'keep: ["mcp__github__create_issue"]')
})

// ---- the suggestion document ----

test('suggestions: write/read roundtrip is atomic and replaces the batch', async (t) => {
  const dir = freshDir(t)
  const batch = [
    { tool: 'mcp__gh__create_issue', probability: 0.82, band: 'adopt', basis: '24 call(s), 1 error(s), last used 2026-09-27', _at: '2026-09-27T10:00:00.000Z' },
    { tool: 'mcp__fs__read_file', probability: 0.12, band: 'record', basis: '4 call(s), 0 error(s), last used 2026-09-26', _at: '2026-09-27T10:00:00.000Z' },
  ]
  await writeSuggestions(dir, batch)
  assert.deepEqual(await readSuggestions(dir), batch)
  assert.equal(JSON.parse(readFileSync(suggestionsFile(dir), 'utf8')).length, 2)
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp')), [])

  // A new batch REPLACES the old one — suggestions are a snapshot, not a log.
  await writeSuggestions(dir, [batch[0]])
  assert.deepEqual((await readSuggestions(dir)).map(row => row.tool), ['mcp__gh__create_issue'])
})

test('suggestions: an empty batch is a real, renderable state', async (t) => {
  const dir = freshDir(t)
  await writeSuggestions(dir, [])
  assert.deepEqual(await readSuggestions(dir), [])
})

test('suggestions: a missing or corrupt document reads as "none", never throws', async (t) => {
  const dir = freshDir(t)
  assert.deepEqual(await readSuggestions(dir), [], 'missing file is silent')
  const warnings = []
  writeFileSync(suggestionsFile(dir), 'not json at all', 'utf8')
  assert.deepEqual(await readSuggestions(dir, message => warnings.push(message)), [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /keep suggestions/)
})

test('suggestions: rows without a name or a usable probability are dropped, not faked', async (t) => {
  const dir = freshDir(t)
  await writeSuggestions(dir, [
    { tool: 'mcp__fs__read_file', probability: 0.7, band: 'adopt', basis: 'b', _at: 't' },
    { tool: '', probability: 0.9, band: 'adopt', basis: 'b', _at: 't' },
    { tool: 'mcp__a__t', probability: 'high', band: 'adopt', basis: 'b', _at: 't' },
    { tool: 'mcp__b__t', probability: 1.4, band: 'adopt', basis: 'b', _at: 't' },
    { tool: 'mcp__c__t', probability: 0.3, band: 'not-a-band', basis: 7, _at: 9 },
    'not an object',
  ])
  const rows = await readSuggestions(dir)
  assert.deepEqual(rows.map(row => row.tool), ['mcp__fs__read_file', 'mcp__c__t'])
  assert.equal(rows[1].band, 'record', 'an unknown band degrades to the neutral one')
  assert.equal(rows[1].basis, '')
  assert.equal(rows[1]._at, '')
})

test('suggestions: normalizeSuggestions tolerates any document shape', () => {
  for (const raw of [undefined, null, {}, 'text', 42]) assert.deepEqual(normalizeSuggestions(raw), [])
  assert.equal(USAGE_FILE_NAME, 'usage.json')
  assert.equal(SUGGESTIONS_FILE_NAME, 'suggestions.json')
  assert.equal(usageFile('/gate'), '/gate/usage.json')
  assert.equal(suggestionsFile('/gate'), '/gate/suggestions.json')
})

test('usage store: writes create the gate directory when it does not exist yet', async (t) => {
  const dir = join(freshDir(t), 'nested', 'gate')
  assert.equal(existsSyncSafe(dir), false)
  const store = createUsageStore(dir, () => {})
  store.record('mcp__fs__read_file', false)
  await store.flush()
  assert.equal(readDoc(dir).tools['mcp__fs__read_file'].calls, 1)
  assert.equal(mkdirSafe(dir), true)
})

function existsSyncSafe(dir) {
  try {
    readdirSync(dir)
    return true
  } catch {
    return false
  }
}

function mkdirSafe(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

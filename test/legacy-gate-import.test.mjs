// One-time legacy gate absorption (0.1.5 → 0.1.7): the host's one-shot
// settings.yaml import keys sections by "section name = entry id", so the old
// machine-state `mcp-adapter:` section (serverIds/disabled) was silently
// dropped. createFileGateStore absorbs it once on a fresh gate. Parser tests
// are pure string-in/string-out; absorption tests run against a scratch dsh
// home (the gate.json document and the marker file are the observable
// contract).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GATE_FILE_NAME,
  MCP_ADAPTER_STORAGE_DIRNAME,
  LEGACY_GATE_SECTION,
  LEGACY_IMPORT_MARKER,
  LEGACY_SETTINGS_FILES,
  createFileGateStore,
  legacyGateCandidate,
  legacyGateSection,
  normalizeServerGate,
} from '../lib/index.js'

/** Fresh scratch gate dir per test — gate files must never leak across tests. */
function freshDir() {
  return mkdtempSync(join(tmpdir(), 'mcp-adapter-absorb-gate-'))
}

/** Fresh scratch dsh home per test — legacy documents and markers live here. */
function freshHome() {
  return mkdtempSync(join(tmpdir(), 'mcp-adapter-absorb-home-'))
}

/** The marker path for one home. */
function markerFile(home) {
  return join(home, 'storages', MCP_ADAPTER_STORAGE_DIRNAME, LEGACY_IMPORT_MARKER)
}

/** A store over `dir` with absorption pointed at `home`. */
function absorbingStore(dir, home, { info, warn } = {}) {
  const lines = []
  return {
    store: createFileGateStore(dir, message => (warn ?? lines).push(message), {
      info: message => (info ?? lines).push(message),
      home,
    }),
    lines,
  }
}

// ---- Parser (pure) -----------------------------------------------------------

test('parse: block-style section — serverIds map and disabled sequence', () => {
  const doc = [
    'ui-theme:',
    '  preference: light',
    'mcp-adapter:',
    '  serverIds:',
    '    fs: 1',
    '    gh: 2',
    '  disabled:',
    '    - 2',
    'other:',
    '  key: value',
  ].join('\n')
  assert.deepEqual(legacyGateSection(doc), { serverIds: { fs: 1, gh: 2 }, disabled: [2] })
})

test('parse: single-line quoted flow JSON values (the folded-safe writer shape)', () => {
  const doc = [
    'mcp-adapter:',
    `  serverIds: '{"fs": 1, "gh": 2}'`,
    `  disabled: '[2]'`,
  ].join('\n')
  assert.deepEqual(legacyGateSection(doc), { serverIds: '{"fs": 1, "gh": 2}', disabled: '[2]' })
  assert.deepEqual(normalizeServerGate(legacyGateCandidate(legacyGateSection(doc))), {
    serverIds: { fs: 1, gh: 2 },
    disabled: [2],
  })
})

test('parse: unquoted flow JSON and mixed shapes decode through the candidate', () => {
  const doc = [
    'mcp-adapter:',
    '  disabled: [1, 2]',
    '  serverIds:',
    '    fs: 1',
  ].join('\n')
  const section = legacyGateSection(doc)
  assert.deepEqual(section.disabled, '[1, 2]')
  assert.deepEqual(section.serverIds, { fs: 1 })
  const gate = normalizeServerGate(legacyGateCandidate(section))
  assert.deepEqual(gate, { serverIds: { fs: 1 }, disabled: [1, 2] })
})

test('parse: malformed flow JSON degrades to an absent key, never a half-read value', () => {
  const section = { serverIds: '{"fs": ', disabled: '[not json' }
  const candidate = legacyGateCandidate(section)
  assert.equal(candidate.serverIds, undefined)
  assert.equal(candidate.disabled, undefined)
  assert.deepEqual(normalizeServerGate(candidate), { serverIds: {}, disabled: [] })
})

test('parse: folded scalars, unknown keys, comments and blanks are skipped', () => {
  const doc = [
    'mcp-adapter:',
    '  # a comment',
    '  serverIds:',
    '',
    "    fs: 1  # inline comment",
    '  futureKey: whatever',
    '  disabled:',
    '    - 3',
    'next-section:',
    '  serverIds:',
    '    late: 9',
  ].join('\n')
  assert.deepEqual(legacyGateSection(doc), { serverIds: { fs: 1 }, disabled: [3] })
})

test('parse: absent section and non-block header both yield undefined', () => {
  assert.equal(legacyGateSection('other:\n  key: 1\n'), undefined)
  assert.equal(legacyGateSection('mcp-adapter: []\n'), undefined, 'inline header value = not a block map')
})

test('contract: document priority order, section name and marker name are stable', () => {
  assert.deepEqual([...LEGACY_SETTINGS_FILES], ['settings.yaml.imported', 'settings.yaml'])
  assert.equal(LEGACY_GATE_SECTION, 'mcp-adapter')
  assert.equal(LEGACY_IMPORT_MARKER, 'legacy-import.json')
  assert.ok(markerFile('/h/.dsh').endsWith(join('storages', MCP_ADAPTER_STORAGE_DIRNAME, 'legacy-import.json')))
})

// ---- Absorption (scratch home + gate dir) -------------------------------------

const BLOCK_DOC = [
  'mcp-adapter:',
  '  serverIds:',
  '    fs: 1',
  '    gh: 2',
  '  disabled:',
  '    - 2',
  '',
].join('\n')

test('absorption: fresh gate + legacy section → gate.json lands, mirror serves it, info line + imported marker', async () => {
  const dir = freshDir()
  const home = freshHome()
  try {
    writeFileSync(join(home, 'settings.yaml.imported'), BLOCK_DOC, 'utf8')
    const { store, lines } = absorbingStore(dir, home)
    assert.deepEqual(store.get(), { serverIds: { fs: 1, gh: 2 }, disabled: [2] })
    // The document landed atomically and exactly as a store.write would have.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, GATE_FILE_NAME), 'utf8')), { serverIds: { fs: 1, gh: 2 }, disabled: [2] })
    // One summary line.
    const summary = lines.find(l => String(l).includes('legacy settings import'))
    assert.ok(summary, 'a summary line is logged')
    assert.match(String(summary), /serverIds=2, disabled=1/)
    // The audit marker.
    const marker = JSON.parse(readFileSync(markerFile(home), 'utf8'))
    assert.equal(marker.outcome, 'imported')
    assert.equal(marker.serverIds, 2)
    assert.equal(marker.disabled, 1)
    assert.equal(typeof marker.at, 'string')
    assert.ok(marker.source.endsWith('settings.yaml.imported'))
    // A later toggle writes on top of the absorbed registry (ids preserved).
    await store.write({ serverIds: { fs: 1, gh: 2 }, disabled: [] })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, GATE_FILE_NAME), 'utf8')).disabled, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('absorption: an existing gate.json wins — no absorption, no marker, boot quiet', () => {
  const dir = freshDir()
  const home = freshHome()
  try {
    writeFileSync(join(dir, GATE_FILE_NAME), JSON.stringify({ serverIds: { live: 1 }, disabled: [] }), 'utf8')
    writeFileSync(join(home, 'settings.yaml.imported'), BLOCK_DOC, 'utf8')
    const warnings = []
    const { store, lines } = absorbingStore(dir, home, { warn: warnings })
    assert.deepEqual(store.get(), { serverIds: { live: 1 }, disabled: [] })
    assert.equal(existsSync(markerFile(home)), false, 'a live gate document makes the migration moot')
    assert.equal(lines.length, 0, 'existing users boot exactly as quiet as before')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('absorption: a present marker short-circuits everything (idempotent, no resurrection)', () => {
  const dir = freshDir()
  const home = freshHome()
  try {
    mkdirHome(home)
    writeFileSync(markerFile(home), '{"at":"2026-09-25T00:00:00.000Z","outcome":"no-op"}\n', 'utf8')
    writeFileSync(join(home, 'settings.yaml.imported'), BLOCK_DOC, 'utf8')
    const { store } = absorbingStore(dir, home)
    assert.deepEqual(store.get(), { serverIds: {}, disabled: [] })
    assert.equal(existsSync(join(dir, GATE_FILE_NAME)), false, 'absorbed values never resurrect')
    assert.equal(readFileSync(markerFile(home), 'utf8').includes('2026-09-25T00:00:00.000Z'), true, 'marker untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('absorption: junk ids are cleaned by the normalizer; nothing surviving → no gate.json, marker no-op', () => {
  const dir = freshDir()
  const home = freshHome()
  try {
    writeFileSync(join(home, 'settings.yaml.imported'), [
      'mcp-adapter:',
      '  serverIds:',
      '    fs: 999',
      '    gh: 0',
      '  disabled:',
      '    - 500',
      '',
    ].join('\n'), 'utf8')
    const { store } = absorbingStore(dir, home)
    assert.deepEqual(store.get(), { serverIds: {}, disabled: [] }, '999/0/500 sanitized away')
    assert.equal(existsSync(join(dir, GATE_FILE_NAME)), false, 'nothing absorbable → no gate file')
    assert.equal(JSON.parse(readFileSync(markerFile(home), 'utf8')).outcome, 'no-op')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('absorption: no legacy document at all → marker no-legacy, no gate.json', () => {
  const dir = freshDir()
  const home = freshHome()
  try {
    const { store } = absorbingStore(dir, home)
    assert.deepEqual(store.get(), { serverIds: {}, disabled: [] })
    assert.equal(existsSync(join(dir, GATE_FILE_NAME)), false)
    assert.equal(JSON.parse(readFileSync(markerFile(home), 'utf8')).outcome, 'no-legacy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('absorption: legacy document without our section → marker no-section', () => {
  const dir = freshDir()
  const home = freshHome()
  try {
    writeFileSync(join(home, 'settings.yaml.imported'), 'ui-theme:\n  preference: light\n', 'utf8')
    absorbingStore(dir, home)
    assert.equal(JSON.parse(readFileSync(markerFile(home), 'utf8')).outcome, 'no-section')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('absorption: settings.yaml.imported wins over settings.yaml', () => {
  const dir = freshDir()
  const home = freshHome()
  try {
    writeFileSync(join(home, 'settings.yaml.imported'), BLOCK_DOC, 'utf8')
    writeFileSync(join(home, 'settings.yaml'), 'mcp-adapter:\n  serverIds:\n    wrong: 9\n', 'utf8')
    const { store } = absorbingStore(dir, home)
    assert.deepEqual(store.get().serverIds, { fs: 1, gh: 2 })
    assert.ok(JSON.parse(readFileSync(markerFile(home), 'utf8')).source.endsWith('settings.yaml.imported'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('absorption: a store built without a home stays inert (bare-harness isolation)', () => {
  const dir = freshDir()
  try {
    // No `home` option: no legacy document is ever read, no marker written,
    // and the zero state is exactly as before this feature existed.
    const warnings = []
    const store = createFileGateStore(dir, message => warnings.push(message))
    assert.deepEqual(store.get(), { serverIds: {}, disabled: [] })
    assert.equal(warnings.length, 0, 'fresh installs boot quiet')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Create the storages/mcp-adapter skeleton under one scratch home. */
function mkdirHome(home) {
  mkdirSync(join(home, 'storages', MCP_ADAPTER_STORAGE_DIRNAME), { recursive: true })
}

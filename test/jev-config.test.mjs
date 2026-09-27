// The seven jev config keys — ported from dsh-topics-memory
// test/jev-config.test.mjs, retargeted at this plugin's schemastery schema
// (src/jev/config.ts). The topics version asserted the topics command surface
// (CONFIG_KEYS / displayKey / parseConfigValue); that surface does not exist
// in the adapter — the keys land in the host `Config` schema next stage, so
// what is pinned here is the SCHEMA: defaults, accepted values, rejections.
//
// NOTE: nothing reads these keys yet (src/index.ts is untouched this stage),
// so this file is the only place they are exercised.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'
import { JevConfig, JEV_CONFIG_FIELDS, JEV_CONFIG_KEYS } from '../lib/jev/config.js'

// Schemastery resolves volatile fields into live {get()} refs on real hosts;
// bare harnesses may hand back plain values — accept both.
function read(ref) {
  return typeof ref?.get === 'function' ? ref.get() : ref
}

test('config: the seven keys are exactly the ones the design asks for', () => {
  assert.deepEqual([...JEV_CONFIG_KEYS], [
    'jevEnabled',
    'jevBackend',
    'jevModel',
    'jevTimeoutMs',
    'jevSecretFile',
    'jevLayaFallback',
    'jevLayaUrl',
  ])
  assert.deepEqual(Object.keys(JEV_CONFIG_FIELDS), [...JEV_CONFIG_KEYS], 'field record and key list must not drift')
})

test('config: jev* defaults (default-off, zen, model sentinel, 3s timeout, no secret file, laya off)', () => {
  const resolved = JevConfig({})
  assert.equal(read(resolved.jevEnabled), false)
  assert.equal(read(resolved.jevBackend), 'zen')
  assert.equal(read(resolved.jevModel), '') // '' = resolve per backend at call time
  assert.equal(read(resolved.jevTimeoutMs), 3000)
  assert.equal(read(resolved.jevSecretFile), '')
  assert.equal(read(resolved.jevLayaFallback), false)
  assert.equal(read(resolved.jevLayaUrl), 'http://127.0.0.1:8000/v1/systemone')
})

test('config: jev* keys accept explicit values', () => {
  const resolved = JevConfig({
    jevEnabled: true,
    jevBackend: 'native',
    jevModel: 'jev-1.13.0',
    jevTimeoutMs: 8000,
    jevSecretFile: '/tmp/secrets',
    jevLayaFallback: true,
    jevLayaUrl: 'http://127.0.0.1:9999/v1/systemone',
  })
  assert.equal(read(resolved.jevEnabled), true)
  assert.equal(read(resolved.jevBackend), 'native')
  assert.equal(read(resolved.jevModel), 'jev-1.13.0')
  assert.equal(read(resolved.jevTimeoutMs), 8000)
  assert.equal(read(resolved.jevSecretFile), '/tmp/secrets')
  assert.equal(read(resolved.jevLayaFallback), true)
  assert.equal(read(resolved.jevLayaUrl), 'http://127.0.0.1:9999/v1/systemone')
})

test('config: jevBackend enum is zen | native | openrouter', () => {
  for (const backend of ['zen', 'native', 'openrouter']) {
    assert.equal(read(JevConfig({ jevBackend: backend }).jevBackend), backend)
  }
  assert.throws(() => JevConfig({ jevBackend: 'auto' }), /expected "zen" \| "native" \| "openrouter"/)
})

test('config: jevTimeoutMs is a positive integer', () => {
  assert.equal(read(JevConfig({ jevTimeoutMs: 1 }).jevTimeoutMs), 1)
  assert.equal(read(JevConfig({ jevTimeoutMs: 30000 }).jevTimeoutMs), 30000)
  assert.throws(() => JevConfig({ jevTimeoutMs: 0 }), /expected number >= 1/)
  assert.throws(() => JevConfig({ jevTimeoutMs: -3 }), /expected number >= 1/)
  assert.throws(() => JevConfig({ jevTimeoutMs: 1.5 }), /expected number multiple of 1/)
  assert.throws(() => JevConfig({ jevTimeoutMs: 'abc' }))
})

test('config: jevModel / jevSecretFile pass raw strings (empty sentinel allowed)', () => {
  assert.equal(read(JevConfig({ jevModel: 'jev-1.13.0' }).jevModel), 'jev-1.13.0')
  assert.equal(read(JevConfig({ jevModel: '' }).jevModel), '')
  assert.equal(read(JevConfig({ jevSecretFile: '/Users/x/.config/jev-secrets' }).jevSecretFile), '/Users/x/.config/jev-secrets')
  assert.equal(read(JevConfig({ jevSecretFile: '' }).jevSecretFile), '')
})

test('config: JEV_CONFIG_FIELDS spreads into a host object schema (next-stage wiring form)', () => {
  // The wiring this stage does NOT do: `z.object({ ...JEV_CONFIG_FIELDS, … })`
  // inside src/index.ts. Prove the record is spreadable and keeps defaults +
  // validations, so the next stage is a one-line change.
  const HostLike = z.object({ storageDir: z.string().default('').volatile(), ...JEV_CONFIG_FIELDS })
  const resolved = HostLike({})
  assert.equal(read(resolved.storageDir), '')
  assert.equal(read(resolved.jevEnabled), false)
  assert.equal(read(resolved.jevBackend), 'zen')
  assert.equal(read(resolved.jevTimeoutMs), 3000)
  assert.throws(() => HostLike({ jevBackend: 'auto' }), /expected "zen" \| "native" \| "openrouter"/)
})

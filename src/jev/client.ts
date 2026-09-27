/**
 * System One decision client — direct HTTP with zero dependencies beyond
 * node:child_process and the global fetch (design 2026-09-25 §3; ADR
 * proposal: direct HTTP over MCP). Ported from dsh-topics-memory
 * `src/jev/client.ts`; the ONE structural change is the telemetry sink: the
 * decisions.jsonl log is injected (see ./log.ts) instead of resolved from a
 * paths module at call time.
 *
 * Semantics (§1/§3.2):
 *  - one AbortSignal.timeout per request, NO retry — the calling lane's next
 *    cadence is the natural retry (fail-open hard-coded, red line ②);
 *  - every failure returns as a structured {ok:false} result, never a throw;
 *  - the COMPLETE serialized body is gate-scanned before anything leaves the
 *    process (red line ③, design §3.3).
 *
 * @module jev/client
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveBackend } from './backends.ts'
import type { JevFamily } from './backends.ts'
import { currentSecrets, scanForSecrets } from './gate.ts'
import type { GateLogger } from './gate.ts'
import type { DecisionLog, JevLane, JevOutcome, JevUsage } from './log.ts'

export type JevQuestionType = 'noul' | 'choice' | 'score'

export interface JevQuestion {
  type: JevQuestionType
  /** The plugin ALWAYS sends instructions (systemone requires them). */
  instructions: string
  criteria?: unknown
}

/** The config slice jevAsk needs (pass straight from the volatile refs). */
export interface JevAskConfig {
  jevBackend: string
  jevModel: string
  jevTimeoutMs: number
  jevSecretFile: string
}

export interface JevAskArgs {
  state: string
  questions: Record<string, JevQuestion>
  config: JevAskConfig
  /** Seam identity for the decisions.jsonl call-layer row (§6.2) — required
   *  so telemetry cannot be silently skipped. */
  lane: JevLane
  /** decisions.jsonl sink (build it once with createDecisionLog). Required,
   *  not optional: the call-layer row must exist on EVERY path, failures
   *  included — the fallback rate is the health metric. */
  log: DecisionLog
  /** Whether the caller falls back to the legacy path on failure (§6.2
   *  `fallback` — the fail-open health metric). */
  fallback?: boolean
  /** Host logger (optional, warn-only, best-effort). */
  logger?: GateLogger
  /** Dual-run pace-maker hook (jev/dual.ts): target this endpoint/model with
   *  no auth header and tag the call-layer row backend='laya'. Never set by
   *  user config — internal to the dual wrapper. */
  overrides?: { endpoint: string; model: string }
}

export type JevAnswer = Record<string, unknown>

export type JevAskOk = {
  ok: true
  answers: Record<string, JevAnswer>
  usage: JevUsage | null
  latencyMs: number
}

export type JevAskFailure = {
  ok: false
  outcome: Exclude<JevOutcome, 'ok'>
  message: string
  latencyMs: number
}

export type JevAskResult = JevAskOk | JevAskFailure

/** Guard for non-positive/absent values from bare harnesses. */
const DEFAULT_TIMEOUT_MS = 3000

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// API key resolution: backend env var first, then the macOS keychain via
// `security find-generic-password`. Only zen falls back to its default
// keychain service; native/openrouter need an explicit
// JEV_KEYCHAIN='<service>[:<account>]' (dsh-jev-mcp server.mjs parity).
// ---------------------------------------------------------------------------

export interface KeychainSpec {
  service: string
  account?: string
}

/** 'svc' -> {service:'svc'}; 'svc:acct' -> {service:'svc', account:'acct'} */
export function parseKeychainSpec(spec: string): KeychainSpec {
  const i = spec.indexOf(':')
  if (i === -1) return { service: spec }
  return { service: spec.slice(0, i), account: spec.slice(i + 1) }
}

export type KeychainRunner = (file: string, args: string[]) => Promise<{ stdout: string }>

const execFileAsync = promisify(execFile)

/**
 * Budget for one `security find-generic-password` call. This lookup is awaited
 * BEFORE the fetch, so it sits OUTSIDE the caller's jevTimeoutMs — and a
 * locked keychain makes `security` block indefinitely (it waits for a UI
 * unlock the user may never see), which parked the model-path seams outright
 * and, on the background seam, held `suggestInFlight` true forever so every
 * later 20-call crossing was silently swallowed. 3s is generous for a local
 * `security` on a loaded machine and short enough that a locked keychain costs
 * one batch, not the feature.
 *
 * A timeout is a MISSING KEY: it returns the same structured `missing_key`
 * refusal as "no key at all" (fail-open, red line ②) and never throws. That is
 * the same semantics the lookup already had for "entry not found" — the key
 * is simply not available, and the lane's own fallback is the answer.
 */
export const KEYCHAIN_TIMEOUT_MS = 3000

/** Default runner: `security find-generic-password … -w`; errors (missing
 *  entry, no binary on non-macOS, access denied) surface as rejections. The
 *  exec-level `timeout` SIGTERMs the child, so nothing is left running after
 *  the seam has moved on. */
const securityRunner: KeychainRunner = async (file, args) => {
  return (await execFileAsync(file, args, { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS })) as { stdout: string }
}

/** Runs `security find-generic-password -w`; null on any failure (silent).
 *
 *  The seam that must not block is THIS one, so the deadline is enforced here
 *  rather than trusted to the transport: a runner that ignores its own bound
 *  (a future transport, a child that traps SIGTERM) still returns null.
 *  @param spec - keychain service[:account] to read.
 *  @param runner - injectable transport (tests never touch the real keychain).
 *  @param timeoutMs - deadline for one lookup; a non-positive/absent value
 *  falls back to {@link KEYCHAIN_TIMEOUT_MS} rather than disabling the bound.
 */
export async function keychainLookup(
  spec: KeychainSpec,
  runner: KeychainRunner = securityRunner,
  timeoutMs: number = KEYCHAIN_TIMEOUT_MS,
): Promise<string | null> {
  const args = ['find-generic-password', '-s', spec.service]
  if (spec.account !== undefined) args.push('-a', spec.account)
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : KEYCHAIN_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The loser's rejection is absorbed HERE: once the deadline wins, a late
    // rejection must not surface as an unhandled rejection. The call itself
    // stays inside the try, so a runner that throws SYNCHRONOUSLY is a lookup
    // failure like any other rather than an escaping exception.
    const attempt = runner('security', [...args, '-w']).then(result => ({ result }), () => undefined)
    const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), budget) })
    const winner = await Promise.race([attempt, deadline])
    return winner?.result.stdout.trim() || null
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Resolved-key memo, per process. `security` is a fork+exec per seam call:
 * with zen the default backend (keychainByDefault) and no JEV_ZEN_API_KEY set,
 * EVERY batch spawned one, so a locked keychain spawned a process per call
 * too. Only a SUCCESSFUL keychain answer is memoized — a miss must stay a
 * miss that is re-probed, so unlocking the keychain needs no restart. The
 * trade-off this buys is that a key ROTATED in the keychain is picked up on
 * the next dsh start, not sooner; the env path (the documented fix for a
 * rotated key) is read on every call and is never memoized.
 */
const apiKeyMemo = new Map<string, string>()

/** Resolve the API key for a backend: env var wins, then the keychain spec
 *  (explicit JEV_KEYCHAIN, or the backend default for zen only), memoized per
 *  backend name + resolved spec — JEV_KEYCHAIN is volatile, so repointing it
 *  must not be answered out of another service's memo entry. */
export async function resolveApiKey(
  backend: { name: string; keyEnv: string; keychainService: string; keychainByDefault: boolean },
  lookup: (spec: KeychainSpec) => Promise<string | null> = keychainLookup,
): Promise<string> {
  const envKey = process.env[backend.keyEnv] ?? ''
  if (envKey !== '') return envKey
  const explicit = process.env.JEV_KEYCHAIN?.trim() ?? ''
  const spec: KeychainSpec | null =
    explicit !== '' ? parseKeychainSpec(explicit) : backend.keychainByDefault ? { service: backend.keychainService } : null
  if (spec === null) return ''
  const memoKey = `${backend.name} ${spec.service} ${spec.account ?? ''}`
  const memoized = apiKeyMemo.get(memoKey)
  if (memoized !== undefined) return memoized
  const key = (await lookup(spec)) ?? ''
  if (key !== '') apiKeyMemo.set(memoKey, key)
  return key
}

// ---------------------------------------------------------------------------
// Question normalization onto the active wire protocol (design §3.1). The
// plugin ALWAYS sends two-sided noul criteria and string score levels, so
// both families accept every request: absent noul criteria are auto-generated
// two-sided from the instructions (single-sided instructions measurably
// degrade calibration), and anything that can NOT be sent to the active
// family is refused LOCALLY before anything leaves the process.
// ---------------------------------------------------------------------------

type WireQuestions = Record<string, Record<string, unknown>>

interface NormalizeOk {
  ok: true
  questions: WireQuestions
}
interface NormalizeRefusal {
  ok: false
  message: string
}

function where(id: string): string {
  return `questions['${id}']`
}

export function normalizeQuestions(questions: Record<string, JevQuestion>, family: JevFamily): NormalizeOk | NormalizeRefusal {
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    return { ok: false, message: "'questions' must be a non-empty object mapping question id -> {type, instructions, criteria?}." }
  }
  const systemone = family === 'systemone'
  const out: WireQuestions = {}
  for (const [id, q] of Object.entries(questions)) {
    if (!isPlainObject(q)) return { ok: false, message: `${where(id)} must be an object.` }
    if (q.type !== 'noul' && q.type !== 'choice' && q.type !== 'score') {
      return { ok: false, message: `${where(id)}.type must be 'noul' | 'choice' | 'score'.` }
    }
    if (typeof q.instructions !== 'string' || q.instructions === '') {
      return { ok: false, message: `${where(id)}.instructions must be a non-empty string (the plugin always sends instructions).` }
    }
    const wire: Record<string, unknown> = { type: q.type, instructions: q.instructions }
    if (q.type === 'noul') {
      if (q.criteria === undefined) {
        wire.criteria = { true: q.instructions, false: `NOT: ${q.instructions}` }
      } else if (isPlainObject(q.criteria) && q.criteria.true !== undefined && q.criteria.false !== undefined) {
        if (!systemone && (typeof q.criteria.true !== 'string' || typeof q.criteria.false !== 'string')) {
          return { ok: false, message: `${where(id)}: noul criteria must be the two-sided {true: string, false: string} on the decisions protocol.` }
        }
        wire.criteria = q.criteria
      } else {
        return { ok: false, message: `${where(id)}: noul criteria, when given, must be the two-sided {true: ..., false: ...}.` }
      }
    } else if (q.type === 'choice') {
      if (!isPlainObject(q.criteria)) {
        return { ok: false, message: `${where(id)}: choice criteria must be an OBJECT mapping option -> description.` }
      }
      wire.criteria = q.criteria
    } else {
      // score: 2-10 ordered levels; strings everywhere (plugin convention);
      // the systemone protocol additionally tolerates structured levels.
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
        return { ok: false, message: `${where(id)}: score criteria must be an ARRAY of 2-10 level descriptions.` }
      }
      const stringLevels = q.criteria.every((l) => typeof l === 'string' && l.length > 0)
      if (!stringLevels && !systemone) {
        return { ok: false, message: `${where(id)}: score levels must be non-empty strings on the decisions protocol.` }
      }
      wire.criteria = q.criteria
    }
    out[id] = wire
  }
  return { ok: true, questions: out }
}

// ---------------------------------------------------------------------------

/** Ask the System One decision model. One request for the whole batch;
 *  resolves to a structured failure (never throws) so the calling lane can
 *  fail open. Writes the decisions.jsonl call-layer row on EVERY path. */
export async function jevAsk(args: JevAskArgs): Promise<JevAskResult> {
  // Pace-maker override: a synthetic laya backend (no key — the auth header
  // carries a placeholder the local server ignores; the secret gate and the
  // call-layer row still run, tagged backend='laya').
  const backend = args.overrides
    ? ({
        name: 'laya',
        family: 'systemone',
        endpoint: args.overrides.endpoint,
        defaultModel: args.overrides.model,
        keyEnv: '',
        keychainService: '',
        keychainByDefault: false,
      } as unknown as ReturnType<typeof resolveBackend>)
    : resolveBackend(args.config.jevBackend)
  // '' is the sentinel; undefined (bare harnesses) resolves to the default too
  const model = args.overrides ? args.overrides.model : args.config.jevModel ? args.config.jevModel : backend.defaultModel
  const fallback = args.fallback === true // absent => false: the column is call-time-invariant (fail-open = outcome !== ok)
  const state = typeof args.state === 'string' ? args.state : ''
  const started = Date.now()

  async function emit(outcome: Exclude<JevOutcome, 'ok'> | 'ok', usage: JevUsage | null): Promise<void> {
    await args.log.logCall({
      at: new Date().toISOString(),
      lane: args.lane,
      backend: backend.name,
      model,
      questionCount: isPlainObject(args.questions) ? Object.keys(args.questions).length : 0,
      stateChars: state.length,
      latencyMs: Date.now() - started,
      usage,
      outcome,
      fallback,
    })
  }

  const refuse = async (outcome: Exclude<JevOutcome, 'ok'>, message: string): Promise<JevAskFailure> => {
    await emit(outcome, null)
    return { ok: false, outcome, message, latencyMs: Date.now() - started }
  }

  // 1. Local protocol check — nothing about the request has left the process.
  const normalized = normalizeQuestions(args.questions, backend.family)
  if (!normalized.ok) return refuse('invalid_request', normalized.message)
  const wireQuestions = normalized.questions

  // 2. Secret gate over the COMPLETE outbound body — the exact string below
  //    is what goes on the wire, so the gate sees byte-identical traffic.
  //    A hit sends NOTHING.
  const secretFile = args.config.jevSecretFile ?? ''
  const wire = JSON.stringify({ model, state, questions: wireQuestions })
  const hit = scanForSecrets(wire, currentSecrets(secretFile, args.logger), secretFile)
  if (hit !== null) {
    return refuse(
      'secret_gate_blocked',
      `outbound payload matched secret pattern '${hit.pattern}' at offset ${hit.offset}; NOTHING was sent. Remove the secret from the request body (model/state/questions).`,
    )
  }

  // 3. API key — absent key fails before any network activity. The laya
  //    pace-maker skips resolution entirely (local, no auth).
  const key = args.overrides ? 'laya-local' : await resolveApiKey(backend)
  if (key === '') {
    const hint =
      backend.keychainByDefault
        ? ` (set ${backend.keyEnv}, or store the key in the macOS keychain service '${backend.keychainService}')`
        : ` (set ${backend.keyEnv}, or JEV_KEYCHAIN='<service>[:<account>]' for a macOS keychain lookup)`
    return refuse('missing_key', `no API key for the active backend '${backend.name}'${hint}.`)
  }

  // 4. One request, one timeout, NO retry.
  const timeoutMs = Number(args.config.jevTimeoutMs) > 0 ? Number(args.config.jevTimeoutMs) : DEFAULT_TIMEOUT_MS
  let res: Response
  try {
    res = await fetch(backend.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: wire,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const outcome: Exclude<JevOutcome, 'ok'> =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network'
    return refuse(outcome, `${outcome} error: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    const outcome: Exclude<JevOutcome, 'ok'> = res.status >= 500 ? 'http_5xx' : 'http_4xx'
    return refuse(outcome, `${backend.name} responded ${res.status}: ${text}`)
  }

  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    return refuse('bad_json', `${backend.name} returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 5. Response shape: answers must be an object covering every question id
  //    (a half-answered batch is a bad response, not a partial success).
  if (!isPlainObject(json)) {
    return refuse('bad_json', `${backend.name} returned no answers object.`)
  }
  const answers = json.answers
  if (!isPlainObject(answers)) {
    return refuse('bad_json', `${backend.name} returned no answers object.`)
  }
  const missing = Object.keys(wireQuestions).filter((id) => answers[id] === undefined)
  if (missing.length > 0) {
    return refuse('bad_json', `${backend.name} returned no answer for question id(s): ${missing.join(', ')}.`)
  }

  const usage = isPlainObject(json.usage) ? (json.usage as unknown as JevUsage) : null
  await emit('ok', usage)
  return { ok: true, answers: answers as Record<string, JevAnswer>, usage, latencyMs: Date.now() - started }
}

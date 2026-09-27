/**
 * decisions.jsonl — System One usage/optimization telemetry (design
 * 2026-09-25 §6), always on while jevEnabled is on. Ported from
 * dsh-topics-memory `src/jev/log.ts` with ONE structural change: the
 * destination directory is no longer resolved from an env/paths module
 * inside the log, it is INJECTED by the caller
 * ({@link createDecisionLog}). Everything else is carried over unchanged:
 * 512KB auto-compaction keeping the most recent quarter, line JSON, and
 * write failures swallowed silently — fail-open extends to the stats itself.
 *
 * The caller owns the directory; the plugin's own gate directory
 * (`<dsh home>/storages/mcp-adapter`, see resolveGateDir in ../index.ts) is
 * the intended one, so decisions.jsonl lands beside gate.json. Nothing here
 * reads the dsh home, which keeps the module testable against a temp dir.
 *
 * REDACTION INVARIANT (§6.1): metadata and probabilities only — reference
 * hash/question type/score/latency/token count. NEVER the state text or
 * conclusion bodies. Writers copy an explicit field whitelist, so extra
 * fields on caller objects cannot leak into the file.
 *
 * @module jev/log
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { JevBand } from './thresholds.ts'

/** This plugin's three jev seams. A row must be attributable to exactly one
 *  of them — the seam identity is what makes the usage/calibration analysis
 *  separable per seam. */
export type JevLane = 'usage-suggest' | 'list-rank' | 'didyoumean'

export type JevOutcome =
  | 'ok'
  | 'timeout'
  | 'network'
  | 'http_4xx'
  | 'http_5xx'
  | 'bad_json'
  | 'secret_gate_blocked'
  | 'missing_key'
  /** Local pre-flight refusal (e.g. questions violate the decisions/openrouter
   *  wire contract) — nothing was sent. Reserved outcome beyond §6.2's v1 list. */
  | 'invalid_request'

export interface JevUsage {
  input_tokens: number
  output_tokens: number
}

/** Call layer (§6.2): one row per HTTP call, failures included — the
 *  fallback rate is the health metric, so failed calls must be counted. */
export interface JevCallRecord {
  at: string
  lane: JevLane
  backend: string
  model: string
  questionCount: number
  stateChars: number
  latencyMs: number
  usage: JevUsage | null
  outcome: JevOutcome
  fallback: boolean
}

/** Verdict layer (§6.2): one row per question, batch requests expanded. */
export interface JevVerdictRecord {
  at: string
  lane: JevLane
  questionId: string
  qtype: 'noul' | 'choice' | 'score'
  /** Candidate reference without content: `tool:xxx` | `server:name`. */
  ref: string
  /** §6.2 digest — stable key for the repeat-decision-rate analysis. */
  digest: string
  probability: number
  band: JevBand
  agree: 'hit' | 'nearFloor' | 'gate-blocked' | 'wouldBlock' | 'n/a'
  /** Which backend produced this verdict: 'primary' (default — the configured
   *  backend) or 'laya' (the local pace-maker). Design §3.4. */
  backend?: string
  /** True when this row's source DROVE the decision because the primary
   *  backend was unavailable (degraded mode). Comparison rows from the
   *  pace-maker are degraded=false; laya rows are excluded from ECE either
   *  way (uncalibrated probabilities). */
  degraded?: boolean
}

const COMPACT_LIMIT = 512 * 1024 // ~512KB cap, same as the ilog sidecars

/** The log file for one directory. The directory is created lazily on the
 *  first append — `createDecisionLog` itself touches nothing on disk. */
export function decisionsFile(logDir: string): string {
  return join(logDir, 'decisions.jsonl')
}

/** Digest field separator — a NUL byte, spelled this way so the source file
 *  itself stays plain text (a raw NUL would make the file binary). */
const NUL_SEP = String.fromCharCode(0)

/** digest(state, questionId, instructions): `h1:` + first 16 hex of
 *  sha256(state + NUL + questionId + NUL + instructions) — the key the
 *  repeat-decision-rate analysis joins on. */
export function digestFor(state: string, questionId: string, instructions: string): string {
  const h = createHash('sha256')
  h.update(state)
  h.update(NUL_SEP)
  h.update(questionId)
  h.update(NUL_SEP)
  h.update(instructions)
  return `h1:${h.digest('hex').slice(0, 16)}`
}

/** One injected log handle. jevAsk takes this as a required argument so the
 *  "row on EVERY path" invariant cannot be skipped by a caller. */
export interface DecisionLog {
  /** Absolute path this log appends to. */
  file(): string
  /** Call-layer row (field whitelist enforced). */
  logCall(rec: JevCallRecord): Promise<void>
  /** Verdict-layer rows (batch expanded by the caller). */
  logVerdicts(recs: readonly JevVerdictRecord[]): Promise<void>
}

/**
 * Build a decisions.jsonl log over one directory. Cheap and side-effect
 * free: build it once (apply time), keep the handle, pass it to jevAsk.
 */
export function createDecisionLog(logDir: string): DecisionLog {
  const file = decisionsFile(logDir)

  // Serialized like the store's write queue: single-record appends are
  // line-atomic anyway, but the compaction rewrite must not interleave with
  // an append. Per-log, so two logs never block each other.
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op, op)
    queue = run.catch(() => undefined)
    return run
  }

  /** All write failures die HERE — never upstream. */
  async function appendJsonl(lines: readonly string[]): Promise<void> {
    await enqueue(async () => {
      try {
        await mkdir(logDir, { recursive: true })
        await appendFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8')
        await compactIfNeeded(file)
      } catch {
        // fail-open: a broken stats sink must never break the feature (§6.1)
      }
    })
  }

  // ~512KB cap; keep the most recent quarter when exceeded (headroom for
  // the next window).
  async function compactIfNeeded(target: string): Promise<void> {
    let raw: string
    try {
      raw = await readFile(target, 'utf8')
    } catch {
      return
    }
    if (raw.length <= COMPACT_LIMIT) return
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    const keep = lines.slice(-Math.max(1, Math.floor(lines.length / 4)))
    const tmp = `${target}.tmp-${randomUUID()}`
    try {
      await writeFile(tmp, keep.map((l) => `${l}\n`).join(''), 'utf8')
      await rename(tmp, target)
    } catch {
      // swallow — the next append retries the compaction
    }
  }

  /** Call-layer row. Field whitelist enforced here: anything extra on the
   *  caller's object is dropped, so no state/conclusion text can sneak in. */
  async function logCall(rec: JevCallRecord): Promise<void> {
    await appendJsonl([
      JSON.stringify({
        at: rec.at,
        lane: rec.lane,
        backend: rec.backend,
        model: rec.model,
        questionCount: rec.questionCount,
        stateChars: rec.stateChars,
        latencyMs: rec.latencyMs,
        usage:
          rec.usage === null
            ? null
            : { input_tokens: rec.usage.input_tokens, output_tokens: rec.usage.output_tokens },
        outcome: rec.outcome,
        fallback: rec.fallback,
      }),
    ])
  }

  /** Verdict-layer rows (batch expanded by the caller). */
  async function logVerdicts(recs: readonly JevVerdictRecord[]): Promise<void> {
    if (recs.length === 0) return
    await appendJsonl(
      recs.map((rec) =>
        JSON.stringify({
          at: rec.at,
          lane: rec.lane,
          questionId: rec.questionId,
          qtype: rec.qtype,
          ref: rec.ref,
          digest: rec.digest,
          probability: rec.probability,
          band: rec.band,
          agree: rec.agree,
          backend: rec.backend ?? 'primary',
          degraded: rec.degraded === true,
        }),
      ),
    )
  }

  return { file: () => file, logCall, logVerdicts }
}

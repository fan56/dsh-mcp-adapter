/**
 * Per-tool usage statistics and the keep-suggestion document (seam A — the
 * self-evolution core).
 *
 * WHAT THIS MODULE OWNS: the durable facts only.
 *  - `usage.json` — `{ tools: { <name>: { calls, errors, firstUsedAt,
 *    lastUsedAt } } }`, one document in the plugin's own gate directory
 *    (beside gate.json / decisions.jsonl / suggestions.json);
 *  - `suggestions.json` — the last jev keep-suggestion batch.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN: any jev call. The batch that fills
 * suggestions.json lives in `jev/seams.ts`; this module only knows the shape
 * of its result (so the command surface can render it without importing the
 * client). Keeping the decision out of here is what makes the record path
 * synchronous and remote-free: `record()` updates memory and schedules a
 * write, and returns. Red line ① (no jev on the hot path) holds structurally
 * because this file cannot call out at all.
 *
 * FAIL-OPEN (red line ②): a corrupt or unreadable document is warned about
 * once and degrades to zero statistics — never to a crash and never to a
 * wedged dispatch. Suggestions that cannot be read degrade to "no
 * suggestions yet", which is exactly what an empty file means.
 *
 * @module usage
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RANK_CANDIDATE_LIMIT } from './rank.ts'
import type { JevBand } from './jev/thresholds.ts'

/** The usage document file name inside the plugin's gate directory. */
export const USAGE_FILE_NAME = 'usage.json'

/** The keep-suggestion document file name inside the plugin's gate directory. */
export const SUGGESTIONS_FILE_NAME = 'suggestions.json'

/** Absolute usage.json path for one gate directory. */
export function usageFile(dir: string): string {
  return join(dir, USAGE_FILE_NAME)
}

/** Absolute suggestions.json path for one gate directory. */
export function suggestionsFile(dir: string): string {
  return join(dir, SUGGESTIONS_FILE_NAME)
}

/**
 * Recorded counters for one tool. Timestamps are ISO strings (`''` when the
 * document was hand-written without them) so the document stays
 * human-readable and diffable.
 */
export interface ToolUsageStats {
  /** Dispatches through mcp_call, successes AND failures. */
  calls: number
  /** How many of those dispatches came back as this plugin's `{ error }` wrap. */
  errors: number
  /** ISO time of the first recorded call; `''` when unknown. */
  firstUsedAt: string
  /** ISO time of the most recent recorded call; `''` when unknown. */
  lastUsedAt: string
}

/** The whole usage document. */
export interface UsageDocument {
  tools: Record<string, ToolUsageStats>
}

/** Fresh-install zero state. */
export const EMPTY_USAGE: UsageDocument = { tools: {} }

/** The warning seam (production: `ctx.logger.warn`; tests: a collector). */
export type UsageWarn = (message: string) => void

/** Coerce one counter to a non-negative integer; anything else is zero. */
function counter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/** Keep only string timestamps (hand-edited documents can hold anything). */
function timestamp(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Sanitize any parsed usage document. Entry-by-entry: a corrupt counter
 * becomes zero, a corrupt timestamp becomes `''`, and a non-object document
 * becomes the empty one. Hand-edited or half-written files therefore cost
 * precision, never correctness.
 *
 * @param raw - the parsed JSON (or anything at all).
 * @returns a fresh document; the input is never retained.
 */
export function normalizeUsage(raw: unknown): UsageDocument {
  if (typeof raw !== 'object' || raw === null) return { tools: {} }
  const rawTools = (raw as { tools?: unknown }).tools
  if (typeof rawTools !== 'object' || rawTools === null || Array.isArray(rawTools)) return { tools: {} }
  const tools: Record<string, ToolUsageStats> = {}
  for (const [name, value] of Object.entries(rawTools as Record<string, unknown>)) {
    if (name === '' || typeof value !== 'object' || value === null) continue
    const entry = value as Partial<Record<keyof ToolUsageStats, unknown>>
    const stats: ToolUsageStats = {
      calls: counter(entry.calls),
      errors: Math.min(counter(entry.errors), counter(entry.calls)),
      firstUsedAt: timestamp(entry.firstUsedAt),
      lastUsedAt: timestamp(entry.lastUsedAt),
    }
    tools[name] = stats
  }
  return { tools }
}

/**
 * Fold one dispatch into a document and return the NEXT document (pure — the
 * input object and its stats are never mutated, so a caller holding a snapshot
 * keeps it). `firstUsedAt` is stamped on the tool's first call only, so it
 * stays a true "when did this tool start being used" answer.
 *
 * @param doc - the current document.
 * @param tool - the dispatched tool name.
 * @param failed - whether the dispatch came back as a structured error.
 * @param now - ISO timestamp to stamp (default: now).
 * @returns the next document.
 */
export function recordUsageCall(
  doc: UsageDocument,
  tool: string,
  failed: boolean,
  now: string = new Date().toISOString(),
): UsageDocument {
  if (tool === '') return doc
  const previous = doc.tools[tool]
  const tools = { ...doc.tools }
  tools[tool] = {
    calls: (previous?.calls ?? 0) + 1,
    errors: (previous?.errors ?? 0) + (failed ? 1 : 0),
    firstUsedAt: previous?.firstUsedAt !== undefined && previous.firstUsedAt !== ''
      ? previous.firstUsedAt
      : (previous === undefined ? now : previous.firstUsedAt),
    lastUsedAt: now,
  }
  return { tools }
}

/** Total dispatches recorded across every tool. */
export function usageTotalCalls(doc: UsageDocument): number {
  let total = 0
  for (const stats of Object.values(doc.tools)) total += stats.calls
  return total
}

/** Number of tools carrying at least one recorded call. */
export function usageToolCount(doc: UsageDocument): number {
  let total = 0
  for (const stats of Object.values(doc.tools)) if (stats.calls > 0) total += 1
  return total
}

/**
 * How many total calls pass before a suggestion batch may fire.
 * Deliberately coarse: the batch is a remote round trip whose answers are
 * about prompt economics, not correctness, so it runs on a slow cadence
 * instead of per call.
 */
export const SUGGEST_BATCH_EVERY = 20

/**
 * Whether crossing into `totalCalls` opens a new suggestion batch. True only
 * on the call that MAKES a multiple (20, 40, …), so N calls trigger exactly
 * floor(N/20) batches and never more — the threshold predicate is a pure
 * function precisely so the hot path can ask it without any jev work.
 *
 * @param totalCalls - total calls AFTER the just-recorded one.
 * @param every - batch cadence (default {@link SUGGEST_BATCH_EVERY}).
 * @returns whether a batch should be started.
 */
export function shouldRunSuggestBatch(totalCalls: number, every: number = SUGGEST_BATCH_EVERY): boolean {
  // `totalCalls < every` also rules out zero/negative totals, which would
  // otherwise look like a crossing (0 is a multiple of every).
  if (every < 1 || totalCalls < every) return false
  return Math.floor(totalCalls / every) > Math.floor((totalCalls - 1) / every)
}

/**
 * The live usage handle. Reads are served from the in-memory mirror and NEVER
 * touch the disk; `record` updates the mirror synchronously (so a caller can
 * threshold on the total it just produced) and schedules an atomic write.
 *
 * WRITE POLICY — write-through with coalescing: the first record starts a
 * write; records arriving while one is in flight are folded into ONE follow-up
 * write carrying the newest state. So the document on disk is at most one
 * write cycle behind the mirror, and a crash can lose only the records counted
 * during that single in-flight write (milliseconds, one tmp+rename pair) — not
 * an unbounded tail. `flush()` awaits the queue for shutdown/tests.
 */
export interface UsageStore {
  /** Current mirror (corrupt input already sanitized away). */
  get(): UsageDocument
  /** Total calls in the mirror. */
  total(): number
  /** Count one dispatch; returns the new total. Never throws. */
  record(tool: string, failed: boolean): number
  /** Await the pending write(s), if any. */
  flush(): Promise<void>
}

/**
 * Build the usage store over one gate directory. The initial read is
 * synchronous (boot-time, once, mirroring the gate store); writes land
 * atomically (tmp file + rename) so a crash mid-write can never leave a torn
 * document.
 *
 * @param dir - the plugin's gate directory (`resolveGateDir(...)`).
 * @param warn - warning seam for a corrupt document / failed write.
 * @returns the store handle.
 */
export function createUsageStore(dir: string, warn: UsageWarn): UsageStore {
  const file = usageFile(dir)
  let mirror = loadInitialUsage(file, warn)
  let writing: Promise<void> | null = null
  let dirty = false
  let writeWarned = false

  async function writeNow(): Promise<void> {
    try {
      await mkdir(dir, { recursive: true })
      const payload = JSON.stringify({ tools: { ...mirror.tools } }, null, 2) + '\n'
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, file)
    } catch (error) {
      // One warning per process, not per call: an unwritable directory would
      // otherwise turn every dispatch into a log line. Statistics are
      // best-effort by construction (fail-open extends to the stats).
      if (!writeWarned) {
        writeWarned = true
        warn(
          `mcp-adapter: the usage statistics at ${file} could not be written `
          + `(${error instanceof Error ? error.message : String(error)}) — tracking continues in memory only`,
        )
      }
    }
  }

  function schedule(): void {
    dirty = true
    if (writing !== null) return
    const run = (async () => {
      try {
        while (dirty) {
          dirty = false
          await writeNow()
        }
      } finally {
        writing = null
      }
    })()
    writing = run
    void run.catch(() => undefined)
  }

  return {
    get: () => mirror,
    total: () => usageTotalCalls(mirror),
    record(tool: string, failed: boolean): number {
      mirror = recordUsageCall(mirror, tool, failed)
      schedule()
      return usageTotalCalls(mirror)
    },
    async flush(): Promise<void> {
      while (writing !== null) await writing.catch(() => undefined)
    },
  }
}

/**
 * Boot-time read. A missing file is the fresh-install zero state (silent); an
 * unreadable or unparseable one is warned about ONCE here and degrades to
 * zero statistics, so the only visible effect of a corrupt file is that
 * suggestions start collecting from scratch again.
 */
function loadInitialUsage(file: string, warn: UsageWarn): UsageDocument {
  if (!existsSync(file)) return { tools: {} }
  try {
    return normalizeUsage(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    warn(
      `mcp-adapter: the usage statistics at ${file} are unreadable `
      + `(${error instanceof Error ? error.message : String(error)}) — starting from zero statistics`,
    )
    return { tools: {} }
  }
}

// ---- keep suggestions (the document jev fills) ----

/**
 * One suggestion row. `basis` is the human-readable usage evidence the
 * suggestion was derived from (calls / errors / recency) — the row is a
 * PROPOSAL about prompt economics, never an applied config change (red line
 * ③: the model face writes nothing, and neither does the operator's
 * settings — `/mcp suggest` only renders).
 */
export interface SuggestionRecord {
  /** The folded tool the row is about. */
  tool: string
  /** jev's calibrated probability that it is worth keeping in every prompt. */
  probability: number
  /** Band the probability fell into (thresholds.ts, kind 'suggest'). */
  band: JevBand
  /** Usage evidence, e.g. `24 calls, 1 error, last used 2026-09-27`. */
  basis: string
  /** ISO time the batch produced this row. */
  _at: string
}

/** A probability is usable only when it is a finite 0..1 number. */
function probability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value : undefined
}

/**
 * Sanitize a parsed suggestions document into rows that are safe to render.
 * Rows without a name or a usable probability are dropped rather than shown as
 * "0%" — a fabricated number is worse than a missing row.
 *
 * @param raw - the parsed JSON (an array of rows, or anything at all).
 * @returns the renderable rows, in document order.
 */
export function normalizeSuggestions(raw: unknown): SuggestionRecord[] {
  if (!Array.isArray(raw)) return []
  const out: SuggestionRecord[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Partial<Record<keyof SuggestionRecord, unknown>>
    const p = probability(row.probability)
    if (typeof row.tool !== 'string' || row.tool === '' || p === undefined) continue
    out.push({
      tool: row.tool,
      probability: p,
      band: row.band === 'adopt' || row.band === 'record' || row.band === 'fallback' ? row.band : 'record',
      basis: typeof row.basis === 'string' ? row.basis : '',
      _at: typeof row._at === 'string' ? row._at : '',
    })
  }
  return out
}

/**
 * Replace the whole suggestion document with one batch (atomic tmp+rename;
 * a crash leaves either the previous batch or the new one, never a mix).
 * Throws on failure — the caller is the fire-and-forget seam, which contains
 * it; a failed write means "this round's suggestions are lost", never a broken
 * caller.
 *
 * @param dir - the plugin's gate directory.
 * @param records - the batch rows.
 */
export async function writeSuggestions(dir: string, records: readonly SuggestionRecord[]): Promise<void> {
  const file = suggestionsFile(dir)
  const payload = JSON.stringify(records, null, 2) + '\n'
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)
}

/**
 * Read the current suggestions (empty when there are none, unreadable, or
 * corrupt — the display layer's "no suggestions yet" is the same shape as
 * "the file was lost", so the operator is never shown a half-truth).
 *
 * @param dir - the plugin's gate directory.
 * @param warn - optional warning seam for an unreadable document.
 * @returns the renderable rows.
 */
export async function readSuggestions(dir: string, warn?: UsageWarn): Promise<SuggestionRecord[]> {
  try {
    return normalizeSuggestions(JSON.parse(await readFile(suggestionsFile(dir), 'utf8')))
  } catch (error) {
    if (warn !== undefined && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      warn(
        `mcp-adapter: the keep suggestions at ${suggestionsFile(dir)} are unreadable `
        + `(${error instanceof Error ? error.message : String(error)}) — showing none`,
      )
    }
    return []
  }
}

/** One tool the keep-suggestion batch may ask about. */
export interface SuggestCandidate {
  /** The folded tool name. */
  tool: string
  /** Recorded dispatches — the evidence a "keep" claim must rest on. */
  calls: number
  /** How many of them failed. */
  errors: number
  /** ISO time of the most recent call. */
  lastUsedAt: string
  /** First {@link SUGGEST_DESCRIPTION_CHARS} chars of the description. */
  description: string
}

/** How much of a tool's description travels into the jev state text. */
export const SUGGEST_DESCRIPTION_CHARS = 200

/** The minimal shape a folded-tool pool must have. */
export interface DescribableSchema {
  readonly name: string
  readonly description: string
}

/**
 * The candidate set for one keep-suggestion batch: the tools that are
 * CURRENTLY FOLDED OUT of the prompt (the fold predicate is injected, so this
 * function stays free of config plumbing) AND have at least one recorded call.
 *
 * A folded tool nobody ever called is deliberately excluded: it has no usage
 * evidence to build a "keep this in every prompt" claim on, and burning a
 * remote question on it would put the least informative tools first. Ordered
 * by calls descending (the tools that already earn their place come first),
 * name ascending as the tie-break, capped at {@link RANK_CANDIDATE_LIMIT}.
 *
 * @param doc - the usage mirror.
 * @param schemas - visible schemas (production: `ctx.tools.schemas()`).
 * @param isFolded - the live fold predicate for one name.
 * @param limit - max candidates (default {@link RANK_CANDIDATE_LIMIT}).
 * @returns the candidates, most-used first.
 */
export function usageSuggestCandidates(
  doc: UsageDocument,
  schemas: readonly DescribableSchema[],
  isFolded: (name: string) => boolean,
  limit: number = RANK_CANDIDATE_LIMIT,
): SuggestCandidate[] {
  const byName = new Map(schemas.map(schema => [schema.name, schema]))
  const out: SuggestCandidate[] = []
  for (const [tool, stats] of Object.entries(doc.tools)) {
    if (stats.calls <= 0) continue
    if (!isFolded(tool)) continue
    const schema = byName.get(tool)
    out.push({
      tool,
      calls: stats.calls,
      errors: stats.errors,
      lastUsedAt: stats.lastUsedAt,
      description: (schema?.description ?? '').slice(0, SUGGEST_DESCRIPTION_CHARS),
    })
  }
  out.sort((left, right) => (right.calls - left.calls) || left.tool.localeCompare(right.tool))
  return out.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
}

/** The usage evidence rendered next to a suggestion, in one line. */
export function suggestionBasis(candidate: Pick<SuggestCandidate, 'calls' | 'errors' | 'lastUsedAt'>): string {
  const when = candidate.lastUsedAt === '' ? 'unknown' : candidate.lastUsedAt.slice(0, 10)
  return `${candidate.calls} call(s), ${candidate.errors} error(s), last used ${when}`
}

/**
 * The exact `keep` config fragment a suggestion would translate to. Rendered
 * as TEXT for the operator — nothing writes it (red line ③).
 *
 * @param tool - the suggested tool name.
 * @returns a copy-pasteable keep-pattern line.
 */
export function keepSuggestionFragment(tool: string): string {
  return `keep: ["${tool}"]`
}

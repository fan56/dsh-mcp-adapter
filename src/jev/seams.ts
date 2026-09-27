/**
 * The three System One seams (jev business wiring) — and ONLY these three
 * places in the plugin may call out to a decision backend.
 *
 * WHERE THEY ARE ALLOWED TO RUN (red line ①, hot paths stay remote-free):
 *  - {@link askKeepSuggestions} — the background keep-suggestion batch, fired
 *    by the usage counter and awaited by nobody;
 *  - {@link rankListQuery} — `mcp_list {query}` only, i.e. when the MODEL
 *    explicitly asked for a ranked view;
 *  - {@link rankDidYouMean} — `mcp_call`'s unknown-tool branch, i.e. an error
 *    the model is going to read anyway.
 *  The assemble waterfall, `mcp_list` without a query, and a SUCCESSFUL
 *  dispatch never appear in this file's call graph.
 *
 * FAIL-OPEN (red line ②): every export returns a "no opinion" value on ANY
 * failure — disabled, timeout, 5xx, bad JSON, a thrown hook, an unparseable
 * answer. None of them throws. The caller's lexical order then stands, which
 * is the pre-seam behavior; a jev outage is indistinguishable from jev being
 * off.
 *
 * CALIBRATION: the batch in {@link askKeepSuggestions} is the one seam that
 * reads a band (thresholds.ts, kind 'suggest') — and only as a DISPLAY label
 * on a suggestion row, and only for a PRIMARY probability. The two ranking
 * seams log their probabilities with band 'record': a rank is relative
 * ordering, and adopting/vetoing thresholds ported from another plugin's
 * protocol would be a category error. An laya probability is not calibrated at
 * all (dual.ts: relative use only), so a pace-maker answer NEVER takes a band
 * and NEVER becomes a suggestion row — see {@link askKeepSuggestions}.
 *
 * @module jev/seams
 */

import { jevAskDual } from './dual.ts'
import type { JevDualConfig } from './dual.ts'
import { band } from './thresholds.ts'
import { digestFor } from './log.ts'
import type { DecisionLog, JevVerdictRecord } from './log.ts'
import { RANK_CANDIDATE_LIMIT } from '../rank.ts'
import type { RankCandidate } from '../rank.ts'
import { suggestionBasis } from '../usage.ts'
import type { SuggestCandidate, SuggestionRecord } from '../usage.ts'

/**
 * Everything a seam needs from the host, read PER CALL so a settings-page
 * write takes effect on the next request (0.1.7 volatile config contract).
 * Production builds one of these in apply() over the live config refs.
 */
export interface JevRuntime {
  /** The master switch; false means "no call, and no failure". */
  enabled(): boolean
  /** Resolved backend/model/timeout/secret/pace-maker settings. */
  config(): JevDualConfig
  /** decisions.jsonl sink (createDecisionLog over the gate directory). */
  log(): DecisionLog
}

/** A tool as the ranking seams see it: a name plus a blurb for the criteria. */
export type { RankCandidate } from '../rank.ts'

/** A probability is usable only when it is a finite 0..1 number. */
export function noulProbability(answer: unknown): number | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const p = (answer as { noul?: unknown }).noul
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined
}

/** The option-probability map of a `choice` answer, when present and usable. */
function choiceProbabilities(answer: unknown): Record<string, number> | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const raw = (answer as { probabilities?: unknown }).probabilities
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [option, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) out[option] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** The single winning option of a `choice` answer, when present. */
function choiceWinner(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const choice = (answer as { choice?: unknown }).choice
  return typeof choice === 'string' && choice !== '' ? choice : undefined
}

const RANK_QUESTION_ID = 'r1'

/**
 * The ranking question both rank seams share (one batched choice request
 * each). The option KEY is the tool name, so the answer maps back onto the
 * candidate pool without an index that could drift.
 */
function rankQuestion(
  instructions: string,
  candidates: readonly RankCandidate[],
): { type: 'choice'; instructions: string; criteria: Record<string, string> } {
  const criteria: Record<string, string> = {}
  for (const candidate of candidates) {
    const blurb = candidate.description.replace(/\s+/gu, ' ').trim().slice(0, 200)
    criteria[candidate.name] = blurb === '' ? candidate.name : `${candidate.name}: ${blurb}`
  }
  return { type: 'choice', instructions, criteria }
}

/**
 * Turn one jev ranking answer into an order. A full probability map sorts by
 * probability descending (ties keep the lexical order); a bare `choice` field
 * only moves the winner to the front; anything unparseable reports "no
 * opinion" so the caller keeps the order it already had.
 *
 * @param candidates - the pool the question was asked about, in lexical order.
 * @param answer - the raw answer value for {@link RANK_QUESTION_ID}.
 * @returns the reordered names, or undefined for "no opinion".
 */
export function orderFromChoice(
  candidates: readonly RankCandidate[],
  answer: unknown,
): readonly string[] | undefined {
  const names = candidates.map(candidate => candidate.name)
  const index = new Map(names.map((name, position) => [name, position]))
  const raw = choiceProbabilities(answer)
  // A probability map that scores NONE of the candidates says nothing about
  // their order — treat it as no opinion, not as "all equal".
  const probabilities = raw === undefined
    ? undefined
    : Object.fromEntries(Object.entries(raw).filter(([name]) => index.has(name)))
  if (probabilities !== undefined && Object.keys(probabilities).length > 0) {
    return [...names].sort((left, right) => {
      const a = probabilities[left] ?? -1
      const b = probabilities[right] ?? -1
      return (b - a) || ((index.get(left) ?? 0) - (index.get(right) ?? 0))
    })
  }
  const winner = choiceWinner(answer)
  if (winner === undefined || !index.has(winner)) return undefined
  return [winner, ...names.filter(name => name !== winner)]
}

/**
 * Log one verdict row per candidate the ranking answer scored. `band: 'record'`
 * and `agree: 'n/a'` are deliberate: a relative order has no adopt/veto
 * threshold to reconcile against, and inventing one would poison the
 * calibration analysis with a band nothing acts on.
 */
async function logRankVerdicts(
  log: DecisionLog,
  lane: 'list-rank' | 'didyoumean',
  state: string,
  instructions: string,
  candidates: readonly RankCandidate[],
  answer: unknown,
  backend: string,
  degraded: boolean,
): Promise<void> {
  const probabilities = choiceProbabilities(answer)
  if (probabilities === undefined) return
  const at = new Date().toISOString()
  const rows: JevVerdictRecord[] = candidates
    .map(candidate => ({ candidate, p: probabilities[candidate.name] }))
    .filter((entry): entry is { candidate: RankCandidate; p: number } => entry.p !== undefined)
    .map(entry => ({
      at,
      lane,
      questionId: RANK_QUESTION_ID,
      qtype: 'choice' as const,
      ref: `tool:${entry.candidate.name}`,
      digest: digestFor(state, RANK_QUESTION_ID, instructions),
      probability: entry.p,
      band: 'record' as const,
      agree: 'n/a' as const,
      backend,
      degraded,
    }))
  await log.logVerdicts(rows)
}

/**
 * Seam B: rerank `mcp_list {query}` candidates by relevance.
 *
 * The incoming order is the LEXICAL one (see ../rank.ts) and is also the
 * fail-open result: any failure, disabled switch, or unusable answer returns
 * `undefined`, which the caller reads as "keep what you had".
 *
 * A DEGRADED answer (the local laya pace-maker took over because the primary
 * backend failed) is usable here: relative ordering is exactly what a rank
 * is, and jev/dual.ts's contract allows degraded results for relative use
 * only — which is all this seam does.
 *
 * @param query - the model's query text.
 * @param ordered - lexical order (best first), already capped by the caller.
 * @param env - the live jev runtime.
 * @returns the jev order, or undefined for "no opinion".
 */
export async function rankListQuery(
  query: string,
  ordered: readonly RankCandidate[],
  env: JevRuntime,
): Promise<readonly string[] | undefined> {
  const candidates = ordered.slice(0, RANK_CANDIDATE_LIMIT)
  if (candidates.length < 2) return undefined
  const instructions = `下面这些 MCP 工具里，哪一个与检索 query 最相关？请选出相关性最高的那一个。query：${query}`
  const state = [
    '任务背景：模型正在通过 mcp_list 浏览被折叠出常驻 prompt 的 MCP 工具，需要按与当前任务的相关性挑选。',
    `检索 query：${query}`,
    `候选工具数：${candidates.length}`,
  ].join('\n')
  return rankSeam('list-rank', state, instructions, candidates, env)
}

/**
 * Seam C: rerank the near-miss candidates of an unregistered tool name.
 *
 * Same fail-open contract as {@link rankListQuery}. Only runs when the lexical
 * prefilter found MORE THAN ONE candidate — a single lexical hit needs no
 * ranking, so the cold branch stays free when it has nothing to offer.
 *
 * @param tool - the name dispatch could not resolve.
 * @param ordered - lexical near-miss order (best first).
 * @param env - the live jev runtime.
 * @returns the jev order, or undefined for "no opinion".
 */
export async function rankDidYouMean(
  tool: string,
  ordered: readonly RankCandidate[],
  env: JevRuntime,
): Promise<readonly string[] | undefined> {
  const candidates = ordered.slice(0, RANK_CANDIDATE_LIMIT)
  if (candidates.length < 2) return undefined
  const instructions = `模型刚刚尝试调用 MCP 工具「${tool}」，但这个名字没有注册。哪一个候选最可能就是它想调用的工具？`
  const state = [
    '任务背景：模型通过 mcp_call 分发被折叠出常驻 prompt 的 MCP 工具，工具名拼错时会走到 not-registered 分支。',
    `未注册的工具名：${tool}`,
    `候选工具数：${candidates.length}`,
  ].join('\n')
  return rankSeam('didyoumean', state, instructions, candidates, env)
}

/** Shared body of both ranking seams (one batched choice request each). */
async function rankSeam(
  lane: 'list-rank' | 'didyoumean',
  state: string,
  instructions: string,
  candidates: readonly RankCandidate[],
  env: JevRuntime,
): Promise<readonly string[] | undefined> {
  try {
    if (!env.enabled()) return undefined
    const dual = await jevAskDual({
      state,
      questions: { [RANK_QUESTION_ID]: rankQuestion(instructions, candidates) },
      config: env.config(),
      lane,
      // fail-open is real here: the caller's lexical order IS the fallback.
      fallback: true,
      log: env.log(),
    })
    if (!dual.ok) return undefined
    const answer = dual.answers[RANK_QUESTION_ID]
    const order = orderFromChoice(candidates, answer)
    if (order === undefined) return undefined
    // Telemetry must never turn a good answer into a failed seam.
    await logRankVerdicts(
      env.log(), lane, state, instructions, candidates, answer, dual.source, dual.source === 'laya',
    ).catch(() => undefined)
    return order
  } catch {
    // contained — the seam has no throw path, by contract
    return undefined
  }
}

/** The keep-suggestion question for one candidate (two-sided noul criteria). */
function keepQuestion(candidate: SuggestCandidate): { type: 'noul'; instructions: string; criteria: { true: string; false: string } } {
  const instructions = `候选 MCP 工具「${candidate.tool}」当前不在常驻 prompt 里（已折叠，模型每次要用都得先 mcp_list 查到它）。`
    + `记录到的使用情况：${suggestionBasis(candidate)}。描述：${candidate.description}。`
    + '该工具值得在每次对话中都常驻 prompt（即加入 keep 名单）吗？'
  return {
    type: 'noul',
    instructions,
    criteria: {
      true: `值得常驻——「${candidate.tool}」被反复调用，把它的 schema 常驻 prompt 能省掉每次查找与展开的成本`,
      false: `不值得常驻——「${candidate.tool}」的调用频次或不可替代性不足以抵消常驻 schema 的 token 成本，保持折叠即可`,
    },
  }
}

/** The state text the keep-suggestion batch is asked against. */
function keepState(candidates: readonly SuggestCandidate[]): string {
  const lines = candidates.map(candidate => [
    `- ${candidate.tool}: ${suggestionBasis(candidate)}`,
    candidate.description === '' ? '' : `  ${candidate.description}`,
  ].filter(line => line !== '').join('\n'))
  return [
    '任务背景：模型通过 mcp_list/mcp_call 使用被折叠出常驻 prompt 的 MCP 工具，每个折叠工具的 schema 都要按需展开。',
    `候选工具数：${candidates.length}（记录到的调用情况与工具描述）`,
    ...lines,
  ].join('\n')
}

/**
 * Seam A: ask, in ONE batched noul request, whether each folded-and-used tool
 * earns a permanent place in every prompt.
 *
 * Fire-and-forget by contract: the caller never awaits this on a hot path.
 * `null` means "this round produced nothing" (disabled, call failed, no
 * candidates, unusable answers, DEGRADED primary) — the caller then keeps the
 * PREVIOUS batch in suggestions.json, and the usage record is unaffected
 * either way.
 *
 * ABSOLUTE SCORES ONLY FROM THE PRIMARY: a suggestion row is a calibrated
 * probability plus a band plus an actionable "keep it resident" line that a
 * human reads in `/mcp suggest`. When the primary failed and the local laya
 * pace-maker took over, that answer is usable for RELATIVE ranking only
 * (dual.ts) and laya's negatives sit in the same band as its positives — so a
 * degraded round returns `null` instead of rendering uncalibrated numbers. The
 * answer is still logged (band 'record', degraded=true): the laya-vs-jev bench
 * and the fallback-rate health metric must not lose a round.
 *
 * @param candidates - folded tools with recorded calls, most-used first.
 * @param env - the live jev runtime.
 * @returns one row per answered candidate, or null.
 */
export async function askKeepSuggestions(
  candidates: readonly SuggestCandidate[],
  env: JevRuntime,
): Promise<SuggestionRecord[] | null> {
  const batch = candidates.slice(0, RANK_CANDIDATE_LIMIT)
  if (batch.length === 0) return null
  const state = keepState(batch)
  const questions: Record<string, ReturnType<typeof keepQuestion>> = {}
  const meta: { qid: string; candidate: SuggestCandidate; instructions: string }[] = []
  for (const candidate of batch) {
    const qid = `c${meta.length + 1}`
    const question = keepQuestion(candidate)
    questions[qid] = question
    meta.push({ qid, candidate, instructions: question.instructions })
  }
  try {
    if (!env.enabled()) return null
    const dual = await jevAskDual({
      state,
      questions,
      config: env.config(),
      lane: 'usage-suggest',
      // Nothing to fall back to: suggestions are additive display, and a
      // failed round simply leaves the previous batch in place.
      fallback: true,
      log: env.log(),
    })
    if (!dual.ok) return null
    // The driving source produces the rows; the pace-maker (when it answered
    // alongside a healthy primary) contributes comparison rows only, exactly
    // as §6.2 prescribes.
    const driving = {
      answers: dual.answers,
      backend: dual.source,
      degraded: dual.source === 'laya',
    }
    const sources = [driving]
    if (dual.source === 'primary' && dual.layaResult?.ok === true) {
      sources.push({ answers: dual.layaResult.answers, backend: 'laya', degraded: false })
    }
    const at = new Date().toISOString()
    const records: SuggestionRecord[] = []
    const rows: JevVerdictRecord[] = []
    for (const source of sources) {
      for (const entry of meta) {
        const probability = noulProbability(source.answers[entry.qid])
        if (probability === undefined) continue // unparseable answer: no fabricated row
        // A pace-maker probability is uncalibrated, so it never takes a band
        // (`band()` would be a category error) and never becomes a
        // suggestion row — whichever way it got here: a comparison row
        // beside a healthy primary, or a degraded takeover.
        const fromPaceMaker = source.backend !== 'primary'
        const verdictBand = fromPaceMaker ? 'record' as const : band(probability, 'suggest')
        rows.push({
          at,
          lane: 'usage-suggest',
          questionId: entry.qid,
          qtype: 'noul',
          ref: `tool:${entry.candidate.tool}`,
          digest: digestFor(state, entry.qid, entry.instructions),
          probability,
          band: verdictBand,
          // Candidates are folded by construction, so there is no legacy
          // "it was already kept" disposition to reconcile against.
          agree: 'n/a',
          backend: source.backend,
          degraded: source.degraded,
        })
        if (fromPaceMaker) continue // telemetry/bench row only — never a suggestion
        records.push({
          tool: entry.candidate.tool,
          probability,
          band: verdictBand,
          basis: suggestionBasis(entry.candidate),
          _at: at,
        })
      }
    }
    await env.log().logVerdicts(rows).catch(() => undefined)
    // A degraded round produced verdict rows and nothing else: no primary
    // drove it, so there is no calibrated number to show and no record to
    // write — the previous batch stands (see the module doc).
    if (records.length === 0) return null
    records.sort((left, right) => right.probability - left.probability || left.tool.localeCompare(right.tool))
    return records
  } catch {
    // contained — a broken batch must never reach the dispatch path
    return null
  }
}

/**
 * Lexical pre-ranking for the two model-facing search seams (`mcp_list
 * {query}` and `mcp_call`'s unknown-tool branch).
 *
 * WHY A SEPARATE MODULE: these are the pure, dependency-free halves of seams
 * B and C. They must stay callable from `node --test` without the meta-tool
 * definitions, AND from `jev/seams.ts` (which reranks whatever this module
 * produced) — so they cannot live in src/index.ts without an import cycle
 * (index.ts → jev/seams.ts → index.ts).
 *
 * CONTRACT (red line ②): everything here is deterministic, synchronous and
 * offline. A jev answer is only ever a REORDER of what these functions already
 * produced (see {@link mergeNameOrder}); any jev failure degrades to the
 * order computed below, so this file is the fail-open baseline of both seams.
 *
 * SCRIPT: the lexical prefilter runs over the ASCII tokens when the query has
 * any, and falls back to a CJK substring match when it has none (see
 * {@link cjkQuery}) — the model asks this plugin's questions in Chinese.
 *
 * @module rank
 */

/** Cap on the candidate list handed to a jev batch (both ranking seams). */
export const RANK_CANDIDATE_LIMIT = 40

/** How many ranked tools a `mcp_list {query}` answer actually shows. */
export const LIST_RESULT_LIMIT = 10

/** How many near-misses the unknown-tool error names. */
export const DID_YOU_MEAN_LIMIT = 3

/** Max edit distance a near-miss may have to be offered. */
export const DID_YOU_MEAN_MAX_DISTANCE = 3

/** The minimal shape ranking needs from a tool. */
export interface RankableEntry {
  readonly name: string
  readonly description: string
}

/**
 * What the ranking seams pass around: a tool plus the blurb that goes into a
 * decision question (or into the lexical score). Named separately from
 * {@link RankableEntry} because it crosses the seam boundary (index.ts builds
 * the pools, jev/seams.ts asks about them).
 */
export type RankCandidate = RankableEntry

/**
 * Lowercase alphanumeric tokens of one string, split on non-alphanumeric runs
 * AND on camelCase / letter-digit boundaries — so `create_issue`,
 * `createIssue` and `createissue` all reduce to overlapping tokens. Tool
 * naming conventions vary per MCP vendor; the search seam must not depend on
 * one of them.
 *
 * ASCII ONLY, on purpose: the token weights in {@link scoreQueryMatch} are
 * calibrated on token equality, and a CJK query has no ASCII tokens to
 * compare. Chinese/other CJK text is matched by the substring fallback
 * ({@link cjkQuery}) instead, and that fallback is a SEPARATE path so the
 * ASCII ranking cannot drift.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const chunk of text.split(/[^A-Za-z0-9]+/)) {
    if (chunk === '') continue
    for (const part of chunk.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])/)) {
      if (part !== '') out.push(part.toLowerCase())
    }
  }
  return out
}

/** All alphanumerics of one string, lowercased (`create_issue` → `createissue`). */
function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, '')
}

// ---------------------------------------------------------------------------
// CJK fallback (added 09-27). dsh is a Chinese-language ecosystem, so the
// model's `mcp_list {query}` is very often Chinese — and Chinese has no
// spaces, no case and no ASCII letters, so tokenize() returns NOTHING and the
// prefilter reported "no MCP tool matches the query" for a query it had never
// actually searched. The fallback is a substring match over the query's CJK
// runs, kept out of the ASCII path so the ASCII weights stay exactly as
// calibrated.
// ---------------------------------------------------------------------------

/** One run of Han / kana / Hangul text. */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/** The CJK content of one string, with everything else dropped. */
function cjkText(text: string): string {
  return (text.match(CJK_RUN) ?? []).join('')
}

/** A CJK query reduced to what a substring matcher can use. */
interface CjkQuery {
  /** The whole CJK query squashed (`搜索 文件` → `搜索文件`). */
  text: string
  /** Search units: the bigrams of each run, a lone character standing whole. */
  tokens: readonly string[]
}

/**
 * Reduce a query to its CJK content, or null when it has none (an ASCII or
 * punctuation-only query takes the token path instead).
 *
 * BIGRAMS, not single characters: they are the Chinese analogue of an ASCII
 * word, so `搜索文件` searches 搜索 / 索文 / 文件 and a description that
 * merely happens to contain 文 is not a match. A one-character run has no
 * bigram and stands for itself, so `文` still finds `读取文件`.
 */
function cjkQuery(query: string): CjkQuery | null {
  const text = cjkText(query)
  if (text === '') return null
  const tokens: string[] = []
  for (const run of query.match(CJK_RUN) ?? []) {
    if (run.length < 2) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2))
  }
  return { text, tokens }
}

/**
 * The CJK counterpart of {@link scoreQueryMatch}: substring, not equality —
 * a CJK tool name is compared as a whole, then bigram-by-bigram against the
 * NAME before the DESCRIPTION, with the same weights as the ASCII path so the
 * two rank a mixed catalog the same way.
 *
 * Latin text is stripped from both sides: it cannot carry a CJK query, and
 * leaving it in would let `读取文件` match the latin bytes of a name.
 */
function scoreCjkMatch(entry: RankableEntry, query: CjkQuery): number {
  const name = cjkText(entry.name)
  if (name !== '' && name === query.text) return 1000
  const description = cjkText(entry.description)
  let score = 0
  for (const token of query.tokens) {
    if (name.includes(token)) score += 4
    else if (description.includes(token)) score += 1
  }
  if (query.tokens.length > 1 && name.includes(query.text)) score += 8
  return score
}

/**
 * Lexical score of one entry against a tokenized query. 0 means "no match at
 * all" and is what the rankers filter on — an unmatched entry is never shown
 * as a result, however long its description is.
 *
 * Weights: exact full-name equality dominates; a query token found in the
 * NAME beats one found only in the DESCRIPTION; a whole-phrase substring hit
 * beats a scattered per-token hit.
 *
 * @param entry - the tool being scored.
 * @param tokens - query tokens from {@link tokenize}.
 * @param queryCompact - the whole query squashed to alphanumerics.
 * @returns the score (0 = no match).
 */
export function scoreQueryMatch(entry: RankableEntry, tokens: readonly string[], queryCompact: string): number {
  const nameCompact = compact(entry.name)
  if (nameCompact === queryCompact && queryCompact !== '') return 1000
  const nameTokens = new Set(tokenize(entry.name))
  const descriptionTokens = new Set(tokenize(entry.description))
  // Vendors ship glued names in prose ("Create an issue on GitHub"), where the
  // token splitter sees git+hub. The squashed description is the last resort
  // so a query for "github" still finds them — at description weight.
  const descriptionCompact = compact(entry.description)
  let score = 0
  for (const token of tokens) {
    if (nameTokens.has(token)) score += 4
    else if (nameCompact.includes(token)) score += 2
    else if (descriptionTokens.has(token)) score += 1
    else if (descriptionCompact.includes(token)) score += 1
  }
  if (tokens.length > 1 && queryCompact !== '' && nameCompact.includes(queryCompact)) score += 8
  return score
}

/**
 * Rank entries against a free-text query: best score first, name ascending as
 * the deterministic tie-break, entries with no lexical match dropped, at most
 * `limit` survivors.
 *
 * A query with no ASCII token falls back to the CJK substring prefilter
 * ({@link cjkQuery}) — the model writes this plugin's queries in Chinese, and
 * "no tokens" must not read as "nothing matched". A query with neither ASCII
 * nor CJK content (blank, punctuation) still matches nothing.
 *
 * Pure and synchronous — this is the order a failed/failed-open jev rerank
 * degrades to, and the only order produced when `jevEnabled` is false.
 *
 * @param query - the model's raw query text.
 * @param entries - the catalog entries to score (input is never mutated).
 * @param limit - max survivors; omit for "every match".
 * @returns the surviving entries, best first.
 */
export function rankByQuery<T extends RankableEntry>(
  query: string,
  entries: readonly T[],
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const tokens = tokenize(query)
  const queryCompact = compact(query)
  // Only a query the ASCII tokenizer cannot see at all takes the CJK path;
  // a mixed query keeps the (calibrated) ASCII ranking it always had.
  const cjk = tokens.length === 0 ? cjkQuery(query) : null
  if (tokens.length === 0 && cjk === null) return []
  const scored: { entry: T; score: number }[] = []
  for (const entry of entries) {
    const score = cjk === null ? scoreQueryMatch(entry, tokens, queryCompact) : scoreCjkMatch(entry, cjk)
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((left, right) => (right.score - left.score) || left.entry.name.localeCompare(right.entry.name))
  return scored.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit).map(item => item.entry)
}

/**
 * Reorder a list of NAMES by an external ranking (the jev answer). Names the
 * ranking does not mention — and names it repeats — keep their original
 * relative order at the tail, so a short or partial answer degrades to "jev's
 * prefix + lexical remainder" instead of dropping candidates. Names that were
 * not in `ordered` at all are ignored.
 *
 * @param ordered - the lexical order being permuted.
 * @param ranking - tool names, best first, as returned by the reranker.
 * @returns a new array; `ordered` is never mutated.
 */
export function mergeNameOrder(ordered: readonly string[], ranking: readonly string[]): string[] {
  const known = new Set(ordered)
  const out: string[] = []
  const taken = new Set<string>()
  for (const name of ranking) {
    if (!known.has(name) || taken.has(name)) continue
    taken.add(name)
    out.push(name)
  }
  for (const name of ordered) if (!taken.has(name)) out.push(name)
  return out
}

/**
 * Levenshtein distance between two names, or `undefined` when it is provably
 * greater than `max`. The length pre-check plus the per-row minimum make the
 * common "clearly not a near-miss" case O(max) instead of O(n·m); names are
 * short anyway, but the pool can be a full catalog and this runs inside a
 * dispatch error path.
 *
 * @param a - first name (case-insensitive).
 * @param b - second name (case-insensitive).
 * @param max - distances above this report "no".
 * @returns the distance, or undefined when it exceeds `max`.
 */
export function editDistanceWithin(a: string, b: string, max: number): number | undefined {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  if (left === right) return 0
  if (Math.abs(left.length - right.length) > max) return undefined
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current: number[] = [row]
    let rowMin = row
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      const value = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost)
      current.push(value)
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return undefined
    previous = current
  }
  const distance = previous[right.length]
  return distance <= max ? distance : undefined
}

/** Where one near-miss landed: a typo of the name, or merely a shared token. */
export type DidYouMeanTier = 'edit' | 'token'

/** One scored near-miss candidate. */
export interface DidYouMeanCandidate {
  /** The candidate's registered tool name. */
  name: string
  /** How it matched: within the edit distance, or on a shared token. */
  tier: DidYouMeanTier
  /** Edit distance (0 for token-only matches, which are not distance-graded). */
  distance: number
  /** Tokens shared with the mistyped name. */
  shared: number
}

/**
 * Lexical near-miss candidates for one unregistered tool name: everything
 * within {@link DID_YOU_MEAN_MAX_DISTANCE} edits, plus anything sharing a
 * name token, best first. This is the always-on floor of the unknown-tool
 * branch — it runs whether or not jev is enabled, needs no network, and is
 * the order that stands when a jev rerank fails.
 *
 * @param tool - the name dispatch could not resolve.
 * @param pool - candidate names (production: the visible prefix tools).
 * @param limit - max candidates (default {@link DID_YOU_MEAN_LIMIT}).
 * @param ignoreTokens - tokens that must NOT count as a shared-token match.
 *   The caller's fold prefix goes here: every candidate in the pool starts
 *   with it, so "shares mcp" is not evidence of anything.
 * @returns the candidates, best first (edit tier, then fewest edits, then
 *   most shared tokens, then shorter, then alphabetical).
 */
export function didYouMeanCandidates(
  tool: string,
  pool: readonly string[],
  limit: number = DID_YOU_MEAN_LIMIT,
  ignoreTokens: readonly string[] = [],
): DidYouMeanCandidate[] {
  const ignored = new Set(ignoreTokens)
  const toolTokens = new Set(tokenize(tool).filter(token => !ignored.has(token)))
  const scored: DidYouMeanCandidate[] = []
  for (const name of pool) {
    if (name === tool) continue
    const distance = editDistanceWithin(tool, name, DID_YOU_MEAN_MAX_DISTANCE)
    if (distance !== undefined) {
      scored.push({ name, tier: 'edit', distance, shared: sharedTokens(toolTokens, name) })
      continue
    }
    const shared = sharedTokens(toolTokens, name)
    if (shared > 0) scored.push({ name, tier: 'token', distance: 0, shared })
  }
  scored.sort((left, right) =>
    (tierRank(left.tier) - tierRank(right.tier))
    || (left.distance - right.distance)
    || (right.shared - left.shared)
    || (left.name.length - right.name.length)
    || left.name.localeCompare(right.name))
  return scored.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
}

/** Edit-tier candidates always outrank token-only ones. */
function tierRank(tier: DidYouMeanTier): number {
  return tier === 'edit' ? 0 : 1
}

/** How many distinct tokens the candidate's name shares with the mistyped one. */
function sharedTokens(toolTokens: ReadonlySet<string>, name: string): number {
  let shared = 0
  for (const token of new Set(tokenize(name))) if (toolTokens.has(token)) shared += 1
  return shared
}

/** Which ordering produced a suggestion list — shown in the error text. */
export type DidYouMeanSource = 'lexical' | 'jev'

/**
 * The suffix appended to the unknown-tool error. The base message stays
 * byte-identical to the pre-seam one, so a caller that only knew the old text
 * still matches it; the suggestion is an addition, and its provenance is
 * always stated (an unranked guess must not look like a ranked one).
 *
 * @param names - suggested tool names, best first.
 * @param source - who produced the order.
 * @returns `''` when there is nothing to suggest.
 */
export function didYouMeanMessage(names: readonly string[], source: DidYouMeanSource): string {
  if (names.length === 0) return ''
  const label = source === 'jev' ? 'jev reranked' : 'lexical'
  return ` Did you mean: ${names.map(name => `"${name}"`).join(', ')}? (${label})`
}

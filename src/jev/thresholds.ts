/**
 * System One decision bands (design 2026-09-25 §5), ported from
 * dsh-topics-memory `src/jev/thresholds.ts` with the band kind renamed
 * `rerank` → `suggest` for this plugin's `/mcp suggest` seam.
 *
 * !!! CALIBRATION NOTICE — READ BEFORE ACTING ON A BAND !!!
 * The numbers below are PLACEHOLDERS copied over from topics-memory to keep
 * the file's shape identical for diffing. They were calibrated for THAT
 * plugin's own question protocol and corpus; this plugin's protocol differs
 * (different candidates, different instructions, batch shape), so the
 * absolute probabilities move. Every value MUST be re-swept against this
 * plugin's own protocol before any band is treated as a calibration
 * conclusion — do NOT carry over topics-memory's numbers.
 *
 * WHERE A BAND IS READ TODAY: exactly one place — seam A (`jev/seams.ts`
 * askKeepSuggestions) reads `band(p, 'suggest')` as the DISPLAY label on a
 * `/mcp suggest` row that already carries the raw probability. Nothing
 * auto-acts on a band, and a pace-maker (laya) probability never takes one:
 * uncalibrated scores are logged as band 'record' and produce no suggestion
 * row, so a degraded round yields no band at all. Until this plugin's own
 * re-sweep lands, a band must be read as "above the placeholder cutoff", not
 * as "adopt/veto is justified".
 *
 * @module jev/thresholds
 */

/** `/mcp suggest` (建议补的 mcp 工具): adopt ≥ 0.60, strong-veto < 0.10. */
export const SUGGEST_ADOPT = 0.6
export const SUGGEST_FALLBACK = 0.1

/** Second band kind, kept for shape parity with the source file and for the
 *  lanes that are not calibrated yet — the values are placeholders too. */
export const MERGE_PAIR_ADOPT = 0.5
export const MERGE_PAIR_FALLBACK = 0.15

export type JevBand = 'adopt' | 'record' | 'fallback'
export type JevBandKind = 'suggest' | 'mergePair'

/** Map a noul probability to its band: adopt → act on it, record → only log
 *  it, fallback → hard veto back to the legacy behavior. */
export function band(probability: number, kind: JevBandKind): JevBand {
  const floor = kind === 'suggest' ? SUGGEST_FALLBACK : MERGE_PAIR_FALLBACK
  const adopt = kind === 'suggest' ? SUGGEST_ADOPT : MERGE_PAIR_ADOPT
  if (probability >= adopt) return 'adopt'
  if (probability >= floor) return 'record'
  return 'fallback'
}

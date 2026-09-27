/**
 * System One (jev) configuration slice — the seven keys, ported from
 * dsh-topics-memory `src/config.ts` §4 and expressed in this plugin's
 * schemastery form.
 *
 * WHY A SEPARATE MODULE (not a sixth entry in ../index.ts's `Config`):
 * the adapter's settings schema is the single `z.object({...})` exported as
 * `Config` from src/index.ts, and this stage forbids touching that file.
 * So the seven keys live here as a plain field record with two export forms:
 *
 *  - {@link JEV_CONFIG_FIELDS} — a plain `Record<key, Schema>`, written to
 *    be SPREAD into the host schema next stage:
 *        export const Config = z.object({ ...JEV_CONFIG_FIELDS, ...ownFields }) as unknown as z<AdapterConfig>
 *    (verified: schemastery `z.object` accepts spread field records and the
 *    defaults survive);
 *  - {@link JevConfig} — the same seven keys as a standalone schema, so the
 *    keys are already runtime-validatable (and tested) before they are wired
 *    into the settings page.
 *
 * Until that wiring lands, nothing reads these values: `src/index.ts` does
 * not import this module, so the plugin behaves exactly as before.
 *
 * All seven are VOLATILE (0.1.7 settings contract: a settings-page write
 * swaps the value in place without remounting the plugin), so every consumer
 * must read through the ref per use.
 *
 * @module jev/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * Live-reference shape. Structurally identical to `VolatileRef` in
 * ../index.ts; redeclared here so this module never imports the plugin
 * entry (which will import this module once the keys are wired).
 */
export interface JevVolatileRef<T> {
  get(): T
}

/** Resolved value of the seven keys, as `apply` will read them. */
export interface JevConfigValue {
  /** Default-off master switch: false means zero behavior change anywhere —
   *  no call is made, and the usage stats stop with it. */
  jevEnabled: JevVolatileRef<boolean>
  /** Decision backend: zen (free, opencode.ai) | native (typesafe
   *  first-party) | openrouter (decisions protocol). */
  jevBackend: JevVolatileRef<'zen' | 'native' | 'openrouter'>
  /** Pinned model id; '' = resolve the backend default at call time
   *  (distillProvider sentinel pattern): jev-1.13-free / jev-1.13.0 /
   *  typesafe/jev-1.13 — an upgrade is a deliberate act. */
  jevModel: JevVolatileRef<string>
  /** Single-request timeout in ms (positive integer); one AbortSignal, NO
   *  retry (the calling lane's next cadence is the natural retry, fail-open
   *  hard-coded). */
  jevTimeoutMs: JevVolatileRef<number>
  /** External secret list for the outbound secret gate (JEV_SECRET_FILE
   *  semantics, design §3.3); swapping the path hot reloads the list. */
  jevSecretFile: JevVolatileRef<string>
  /** Local laya pace-maker (design §3.4): fire a parallel laya call on every
   *  jev request; its verdict is logged for comparison and takes over ONLY
   *  when the primary backend fails (degraded). Default off — zero extra
   *  requests, and laya-serve not running costs a refused connection. */
  jevLayaFallback: JevVolatileRef<boolean>
  /** laya-serve systemone endpoint for the pace-maker. */
  jevLayaUrl: JevVolatileRef<string>
}

/** The seven keys, in settings-page order. */
export const JEV_CONFIG_KEYS = [
  'jevEnabled',
  'jevBackend',
  'jevModel',
  'jevTimeoutMs',
  'jevSecretFile',
  'jevLayaFallback',
  'jevLayaUrl',
] as const

export type JevConfigKey = (typeof JEV_CONFIG_KEYS)[number]

/**
 * The seven field schemas as a plain record — the wiring form for the host
 * schema (`z.object({ ...JEV_CONFIG_FIELDS, … })`).
 */
export const JEV_CONFIG_FIELDS = {
  jevEnabled: z.boolean().default(false).volatile(),
  jevBackend: z.union([z.const('zen'), z.const('native'), z.const('openrouter')]).default('zen').volatile(),
  jevModel: z.string().default('').volatile(),
  jevTimeoutMs: z.natural().min(1).default(3000).volatile(),
  jevSecretFile: z.string().default('').volatile(),
  jevLayaFallback: z.boolean().default(false).volatile(),
  jevLayaUrl: z.string().default('http://127.0.0.1:8000/v1/systemone').volatile(),
} as const

/** The same seven keys as a standalone schema (runtime validation today). */
export const JevConfig = z.object(JEV_CONFIG_FIELDS) as unknown as z<JevConfigValue>

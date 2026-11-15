/**
 * Spike 7 T3: chord analyzer v2 config (docs/audio-spike7-plan.md §2, §5).
 *
 * PROVISIONAL values: the shape is fixed here (T3); T8-T12 set the values (reason for each change goes in a comment
 * at the value, one stage at a time). Only the switches the plan names are listed (YAGNI): the vocabulary `stage`
 * (§2.2), the B method (§2.1, T8) and the identical-pair rule `pairRule` (§2.3, T9). With every switch off
 * (stage V0, bass 'off', pairRule 'off') the output is the frozen ts/dsp (v1a) result bit for bit.
 * chords2ConfigHash() = SHA-256 (first 12 hex) over the canonical JSON (same helpers as ts/dsp/config.ts,
 * ts/bass/config.ts); the v1a chords values are part of it, so the hash changes when any value changes.
 */
import { DEFAULT_CHORDS_CONFIG, type ChordsConfig } from '../dsp/chords';
import { pyCanonicalJson, sha256Hex } from '../dsp/config';
import { DEFAULT_THEORY_PRIOR } from '../dsp/harmony';
import type { Stage } from './vocab';

/** B method of plan §2.1. 'off' = no bass feature. M1-M3 are implemented by T8 (they throw until then). */
export type BassMethod = 'off' | 'M1' | 'M2' | 'M3';
/** Identical-pair rule of plan §2.3. 'off' = the Viterbi reading stays. Implemented by T9. */
export type PairRule = 'off' | 'context' | 'bassRoot';

export interface Chords2Config {
  name: string;
  /** Vocabulary stage (§2.2): V0 = v1a's 120 states, V1 156, V2 204, V3 240. */
  stage: Stage;
  bass: { method: BassMethod };
  pairRule: PairRule;
  /** Clear-win margin a new quality must beat the best base quality by (like v1a `vocab_margin`). */
  newQualityMargin: number;
  /** chords.theory_prior of v1a (the 2nd-pass transition prior strength). */
  theoryPrior: number;
  /** v1a's chords section (Viterbi, vocabulary gate, posterior); read only. */
  chords: ChordsConfig;
}

export const DEFAULT_CHORDS2_CONFIG: Chords2Config = deepFreeze({
  name: 'chords2-v0',
  stage: 'V0',
  bass: { method: 'off' },
  pairRule: 'off',
  // Provisional: the same clear-win margin as v1a's vocab_margin (0.05). T10-T12 tune it per stage.
  newQualityMargin: 0.05,
  theoryPrior: DEFAULT_THEORY_PRIOR,
  chords: DEFAULT_CHORDS_CONFIG,
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Defaults with a (partial, nested) override applied; unknown keys and wrong types throw; result is a new frozen object. */
export function resolveChords2Config(overrides: unknown = {}): Chords2Config {
  if (!isObj(overrides)) throw new Error(`chords2 config overrides must be an object, got ${JSON.stringify(overrides)}`);
  const merge = (def: Json, ov: Json, path: string): Json => {
    const out: Json = {};
    for (const k of Object.keys(ov)) if (!(k in def)) throw new Error(`unknown chords2 config key: ${path}${k}`);
    for (const k of Object.keys(def)) {
      const d = def[k];
      if (!(k in ov)) out[k] = d;
      else if (isObj(d)) {
        if (!isObj(ov[k])) throw new Error(`chords2 config ${path}${k}: expected an object`);
        out[k] = merge(d, ov[k] as Json, `${path}${k}.`);
      } else {
        if (typeof ov[k] !== typeof d || (typeof d === 'number' && !Number.isFinite(ov[k]))) {
          throw new Error(`chords2 config ${path}${k}: expected ${typeof d}, got ${JSON.stringify(ov[k])}`);
        }
        out[k] = ov[k];
      }
    }
    return out;
  };
  const cfg = merge(DEFAULT_CHORDS2_CONFIG as unknown as Json, overrides, '') as unknown as Chords2Config;
  if (!['V0', 'V1', 'V2', 'V3'].includes(cfg.stage)) throw new Error(`chords2 config stage: ${String(cfg.stage)}`);
  if (!['off', 'M1', 'M2', 'M3'].includes(cfg.bass.method)) throw new Error(`chords2 config bass.method: ${String(cfg.bass.method)}`);
  if (!['off', 'context', 'bassRoot'].includes(cfg.pairRule)) throw new Error(`chords2 config pairRule: ${String(cfg.pairRule)}`);
  return deepFreeze(cfg);
}

/** Canonical JSON of the config (sorted keys, compact). */
export function chords2ConfigCanonical(cfg: Chords2Config = DEFAULT_CHORDS2_CONFIG): string {
  return pyCanonicalJson(cfg);
}

/** 12 hex chars of SHA-256 over the canonical JSON; independent of key order. */
export function chords2ConfigHash(cfg: Chords2Config = DEFAULT_CHORDS2_CONFIG): string {
  return sha256Hex(new TextEncoder().encode(chords2ConfigCanonical(cfg))).slice(0, 12);
}

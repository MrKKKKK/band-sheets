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

/** B method of plan §2.1 (T8, bass.ts). 'off' = no bass feature. */
export type BassMethod = 'off' | 'M1' | 'M2' | 'M3';
/** Identical-pair rule of plan §2.3. 'off' = the Viterbi reading stays. Implemented by T9. */
export type PairRule = 'off' | 'context' | 'bassRoot';

/**
 * T8 values of the B methods (bass.ts). Present in `bass` only when a method is on, so the all-off configs keep the
 * T3 / T7 hashes (with the method off nothing reads them).
 */
export interface BassMethodValues {
  /** M1: share of the v1a bass-band chroma (C1-B3, per chord column) subtracted from the full chroma before scoring. */
  m1: { trebleWeight: number };
  /** M2: the same subtraction for its chord scores, the weight of the bass-band chroma of the state's bass tone, and the extra for the root as the bass (bass.ts m2Expand). */
  m2: { trebleWeight: number; bassWeight: number; rootBonus: number };
  /** M3: the treble-cosine margin a reading that holds the bass must beat the root-position reading by. */
  m3: { margin: number };
}
const METHOD_KEYS = ['m1', 'm2', 'm3'] as const;

export interface NewSeventh {
  weight: number;
  margin: number;
}

export interface Chords2Config {
  name: string;
  /** Vocabulary stage (§2.2): V0 = v1a's 120 states, V1 156, V2 204, V3 240. */
  stage: Stage;
  /** B method (§2.1, T8); the method values (BassMethodValues) only when the method is not 'off'. */
  bass: { method: BassMethod } & Partial<BassMethodValues>;
  pairRule: PairRule;
  /** Clear-win margin a new quality must beat the best base quality by (like v1a `vocab_margin`). */
  newQualityMargin: number;
  /**
   * T10: the 7th guard of the new 4-note states (score x weight >= best triad + margin, like v1a's seventh_weight /
   * seventh_margin, which v1a's own states keep). Present only when set, so configs without it keep their T3 / T7 hashes;
   * absent = v1a's seventh_weight / seventh_margin.
   */
  newSeventh?: NewSeventh;
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

/**
 * T8 (tuning split only: the T7 tuning material without pair / V2 / V3, 151 files; docs/audio-spike7-t8.md). Rule,
 * fixed before reading the grids: among values whose fixed truth segments outnumber the broken ones (name, 落, vs the
 * T8-form baseline), the most G1 lines passed on the tuning numbers, ties -> the higher /X-point root on B1.
 *  - m1.trebleWeight 0.75 (grid .25 / .5 / .75 / 1: 2 / 2 / 4 / 3 lines; every weight misses the LR regression line,
 *    LR name .784 / .762 / .674 / .546 against .796).
 *  - m2 (grid trebleWeight .5 / .75 / 1 x bassWeight .1 / .2 / .4 x rootBonus 0 / .05): 1 / .1 / .05 = 4 lines;
 *    every value misses LR (best .762) and the hand-edit line.
 *  - m3.margin 0.05 (grid 0 / .025 / .05 / .075 / .1 / .15 / .2 / .3, round 3 = bass held, root = bass): .025 passes 4
 *    lines but breaks more segments than it fixes (+112 / -119); .05 .. .3 pass 3, .05 has the best B1 /X root (.421).
 */
export const DEFAULT_BASS_METHOD_VALUES: BassMethodValues = deepFreeze({
  m1: { trebleWeight: 0.75 },
  m2: { trebleWeight: 1, bassWeight: 0.1, rootBonus: 0.05 },
  m3: { margin: 0.05 },
});

/**
 * T10 (tuning split only: all 397 T7 tuning files; docs/audio-spike7-t10.md): the V1 values the look ran. Rule, fixed
 * before reading the grid (eval/t10.ts rank, on the pair rule 'bassRoot' rows): regression LR / L0-L3+LV >= G2 - .01 and
 * new-quality output <= 2 % on synthetic without new qualities; then the most of {V1 recall >= .60, precision >= .80};
 * then precision, recall, hand edits. Round 1 grid newQualityMargin -.05 .. .1 x newSeventh (none, w 1 / 1.02 / 1.05 m 0,
 * w 1 m -.02): every value passes the first two and none reaches either V1 line (best precision .450, recall .061;
 * the loosest gates reach recall .196 at precision .172). The top: margin .025, newSeventh w 1 m -.02. No round 2:
 * a narrower grid cannot close a gap of that size (plan §5 stop rule; docs/audio-spike7-t10.md).
 */
export const T10_V1_OVERRIDES = { stage: 'V1', newQualityMargin: 0.025, newSeventh: { weight: 1.0, margin: -0.02 } } as const;

/** The B method values of a config (throws when the method is off: nothing should read them then). */
export function bassValues(cfg: Chords2Config): BassMethodValues {
  const b = cfg.bass;
  if (b.method === 'off' || !b.m1 || !b.m2 || !b.m3) throw new Error('chords2: no B method values (bass.method is off)');
  return { m1: b.m1, m2: b.m2, m3: b.m3 };
}

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
  // newSeventh: optional (see Chords2Config), checked here and left out of the merge
  const { newSeventh, ...rest } = overrides as Json;
  if (newSeventh !== undefined) {
    if (!isObj(newSeventh) || Object.keys(newSeventh).sort().join() !== 'margin,weight' || !Number.isFinite(newSeventh.weight) || !Number.isFinite(newSeventh.margin))
      throw new Error(`chords2 config newSeventh: expected { weight, margin } numbers, got ${JSON.stringify(newSeventh)}`);
  }
  const ov: Json = rest;
  // bass: the method values exist only with a method on (see BassMethodValues), so they are merged against their own defaults
  const ovBass = isObj(ov.bass) ? ov.bass : undefined;
  const ovVals: Json = {};
  const bassRest: Json = {};
  for (const [k, v] of Object.entries(ovBass ?? {})) ((METHOD_KEYS as readonly string[]).includes(k) ? ovVals : bassRest)[k] = v;
  const cfg = merge(DEFAULT_CHORDS2_CONFIG as unknown as Json, ovBass ? { ...ov, bass: bassRest } : ov, '') as unknown as Chords2Config;
  if (cfg.bass.method !== 'off') cfg.bass = { ...cfg.bass, ...(merge(DEFAULT_BASS_METHOD_VALUES as unknown as Json, ovVals, 'bass.') as unknown as BassMethodValues) };
  else if (Object.keys(ovVals).length) throw new Error('chords2 config bass: method values need a bass.method other than off');
  if (!['V0', 'V1', 'V2', 'V3'].includes(cfg.stage)) throw new Error(`chords2 config stage: ${String(cfg.stage)}`);
  if (!['off', 'M1', 'M2', 'M3'].includes(cfg.bass.method)) throw new Error(`chords2 config bass.method: ${String(cfg.bass.method)}`);
  if (!['off', 'context', 'bassRoot'].includes(cfg.pairRule)) throw new Error(`chords2 config pairRule: ${String(cfg.pairRule)}`);
  if (newSeventh !== undefined) cfg.newSeventh = { weight: Number((newSeventh as Json).weight), margin: Number((newSeventh as Json).margin) };
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

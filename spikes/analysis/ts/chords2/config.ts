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
import { enabledBassConfig, type BassConfig } from '../bass/config';
import { DEFAULT_CHORDS_CONFIG, type ChordsConfig } from '../dsp/chords';
import { pyCanonicalJson, sha256Hex } from '../dsp/config';
import { DEFAULT_THEORY_PRIOR } from '../dsp/harmony';
import { resolveF1Config, type F1Config } from './front/config';
import type { Stage } from './vocab';

/**
 * NOT ADOPTED (G2, user 2026-11-22): none of M1-M3 goes to the app; spike 6's bass config (`appBassConfig()`) stays.
 * The methods stay here as switches (default 'off') for a later spike.
 * B method of plan §2.1 (T8, bass.ts). 'off' = no bass feature.
 */
export type BassMethod = 'off' | 'M1' | 'M2' | 'M3';
/**
 * Identical-pair rule of plan §2.3. 'off' = the Viterbi reading stays. NOT ADOPTED (G3, 2026-11-22: V1 is not adopted).
 * The rule is applied in ONE place only: pipeline.ts `pairsAfterBass` (after the bass marks; T10's form). analyze()
 * refuses a config with a rule on. The value is part of the config hash, so a row's hash tells which rule it ran.
 */
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

/** Spike 8 plan §2.3: E1 = the 7th family (d = 10, 11), E2 = E1 + `6` / `m6` (d = 9) and `mM7` (min, d = 11). */
export type AddedRange = 'E1' | 'E2';

/**
 * Spike 8 T5, D2 (plan §2.2, d2.ts): the added tone read over V0's triad from F1. Present in `Chords2Config.d2` only when
 * D2 is on. ρ >= theta adds, thetaLow <= ρ < theta gives a candidate only; thetaLow is also the "sounding" share of the
 * denominator (front/ratio.ts). switchPenalty = the one switch cost of the 2-state smoothing (in ρ - theta per beat).
 */
export interface D2Values {
  range: AddedRange;
  theta: number;
  thetaLow: number;
  switchPenalty: number;
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
  /**
   * Spike 8 T6, D1 (plan §2.2): score the chord templates on F1's octave-aware output folded to 12 pitch classes
   * (octaveChroma.ts foldF1) instead of v1a's chroma. Present only when true, so configs without it keep their hashes;
   * absent = off (v1a's chroma). The bass (`/X`) is not touched (appBassConfig()).
   */
  octaveChroma?: true;
  /** Spike 8 T5, D2 (plan §2.2, d2.ts; D2Values). Present only when on (stage V0 only), so configs without it keep their hashes. */
  d2?: D2Values;
  /**
   * Spike 8 T5: F1's values (front/config.ts) when D1 or D2 reads F1; present exactly then (set by resolveChords2Config),
   * so a row's hash also says which F1 ran. Absent otherwise (nothing reads F1).
   */
  f1?: F1Config;
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
 * Spike 8 T5: D2's values when `d2` is on and an override does not set them. PROVISIONAL, set before any tuning number
 * (T7 tunes theta / thetaLow / switchPenalty on the tuning split only; T9 E2):
 *  - thetaLow 0.3: T4's provisional value (front/config.ts until T5; T4's tests and accuracy table were measured with it).
 *  - theta 0.5: an added tone at half the sounding triad tones' mean strength; above thetaLow, not read from any result.
 *  - switchPenalty 0.1: one switch costs as much as 0.1 of ρ above theta on one beat (a 2-beat added tone at the end of
 *    a run needs ρ > theta + .05; one in the middle of a run, two switches, ρ > theta + .1).
 *  - range E1 (plan §2.3: E2 after G1).
 */
export const DEFAULT_D2_VALUES: D2Values = deepFreeze({ range: 'E1', theta: 0.5, thetaLow: 0.3, switchPenalty: 0.1 });

/**
 * NOT ADOPTED (G2, 2026-11-22). Kept as switches.
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
 * NOT ADOPTED (G3, 2026-11-22: V1 is not adopted, no V2). Kept as a switch.
 * T10 (tuning split only: all 397 T7 tuning files; docs/audio-spike7-t10.md): the V1 values the look ran. Rule, fixed
 * before reading the grid (eval/t10.ts rank, on the pair rule 'bassRoot' rows): regression LR / L0-L3+LV >= G2 - .01 and
 * new-quality output <= 2 % on synthetic without new qualities; then the most of {V1 recall >= .60, precision >= .80};
 * then precision, recall, hand edits. Round 1 grid newQualityMargin -.05 .. .1 x newSeventh (none, w 1 / 1.02 / 1.05 m 0,
 * w 1 m -.02): every value passes the first two and none reaches either V1 line (best precision .450, recall .061;
 * the loosest gates reach recall .196 at precision .172). The top: margin .025, newSeventh w 1 m -.02. No round 2:
 * a narrower grid cannot close a gap of that size (plan §5 stop rule; docs/audio-spike7-t10.md).
 */
export const T10_V1_OVERRIDES = { stage: 'V1', newQualityMargin: 0.025, newSeventh: { weight: 1.0, margin: -0.02 } } as const;

/**
 * The bass config the app takes from spike 7 (spike 6 conclusion 4, docs/audio-spike6-plan.md; user 2026-11-22): spike
 * 6's G2 config (slash marks, cliche split, weakMinConfidence 0.4) WITHOUT `cliche.redecideRoot`. Hash 77cc49d1ca67
 * (pinned in config.test.ts). Its numbers on the tuning synthetic sets are in docs/audio-spike7-t17.md; on the dev /
 * recording material it was never measured (no new look). The same config as bass.ts `marksConfig()`.
 */
export const appBassConfig = (): BassConfig => enabledBassConfig({ cliche: { redecideRoot: false } });

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
  // newSeventh / octaveChroma / d2 / f1: optional (see Chords2Config), checked here and left out of the merge
  const { newSeventh, octaveChroma, d2, f1, ...rest } = overrides as Json;
  if (octaveChroma !== undefined && typeof octaveChroma !== 'boolean') throw new Error(`chords2 config octaveChroma: expected boolean, got ${JSON.stringify(octaveChroma)}`);
  // d2: true / an object of D2Values (merged against DEFAULT_D2_VALUES) = on; false / absent = off
  if (d2 !== undefined && typeof d2 !== 'boolean' && !isObj(d2)) throw new Error(`chords2 config d2: expected boolean or object, got ${JSON.stringify(d2)}`);
  if (f1 !== undefined && !isObj(f1)) throw new Error(`chords2 config f1: expected an object, got ${JSON.stringify(f1)}`);
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
  if (octaveChroma === true) cfg.octaveChroma = true;
  if (d2 === true || isObj(d2)) {
    const v = merge(DEFAULT_D2_VALUES as unknown as Json, d2 === true ? {} : d2, 'd2.') as unknown as D2Values;
    if (!['E1', 'E2'].includes(v.range)) throw new Error(`chords2 config d2.range: ${String(v.range)}`);
    if (!(v.thetaLow >= 0 && v.theta >= v.thetaLow && v.switchPenalty >= 0)) throw new Error(`chords2 config d2: need 0 <= thetaLow <= theta and switchPenalty >= 0, got ${JSON.stringify(v)}`);
    if (cfg.stage !== 'V0') throw new Error('chords2 config d2: D2 reads the V0 Viterbi (plan §2.2), stage must be V0');
    cfg.d2 = v;
  }
  if (cfg.octaveChroma || cfg.d2) cfg.f1 = resolveF1Config((f1 ?? {}) as Partial<F1Config>);
  else if (f1 !== undefined) throw new Error('chords2 config f1: F1 values need octaveChroma or d2 on');
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

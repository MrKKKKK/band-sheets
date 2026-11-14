/**
 * Spike 6 T0: bass analyzer config (docs/audio-spike6-plan.md sections 2, 5, 6 decision 3).
 *
 * PROVISIONAL values: the shape is fixed here (T0), the values are set by T5-T10 on the synthetic tuning split only
 * (reason for each change goes in a comment at the value). `enabled: false` = the bass stage is OFF: the output is then
 * the frozen ts/dsp (v1a) result bit for bit (`chords[].bass` stays null). Only values the plan's stages refer to are
 * listed (YAGNI): low CQT (B-1 2), segment bass (B-1 1-4), slash marks (B-2), cliche split (B-3), notes (B-4).
 * configHash() = SHA-256 (first 12 hex) over the canonical JSON (same helpers as ts/dsp/config.ts, ts/drum/config.ts).
 * T8 BASELINE FROZEN (docs/audio-spike6-t8.md): bass-ON hash 9b8d16cf12cb (default/off dfed4fc0704f). T9 added
 * slash.fifthMinConfidence (docs/audio-spike6-t9.md), T10 renamed it slash.weakMinConfidence (it also covers the minor
 * 3rd) and set the B-3 values (docs/audio-spike6-t10.md); the current pins are in config.test.ts. After T10 values
 * change only by a user decision (G2), with the reason at the value and the new pins.
 */
import { pyCanonicalJson, sha256Hex } from '../dsp/config';

export interface BassConfig {
  name: string;
  /** Master switch of the whole bass stage. false = v1a output unchanged. */
  enabled: boolean;
  /** B-1 stage 2: pitch-class-unfolded low CQT (C1 = 32.7 Hz upward, `octaves` octaves). */
  lowCqt: { fminHz: number; octaves: number; binsPerOctave: number };
  /** B-1: which of the plan's four methods (1 = existing bass chroma, 2 = lowest clear pitch, 3 = onset-synchronous, 4 = beat HMM). Only 2 is implemented since T5 (docs/audio-spike6-t5.md). */
  segment: {
    method: 1 | 2 | 3 | 4;
    /** Weight of the segment head (its first beat) when averaging. */
    headWeight: number;
    /** Harmonic-sum overtone count for the lowest-pitch rule (method 2). */
    harmonics: number;
    /** HMM stay probability between beats (method 4; removed in T5, value unused). */
    stayProb: number;
  };
  /**
   * B-2 slash marks: a `/X` below `minConfidence` is not written (the root stays). `weakMinConfidence`: a perfect-5th
   * or minor-3rd bass is an inversion only at this confidence or more; otherwise only a pedal or passing bass (T9 / T10,
   * slash.ts).
   */
  slash: { minConfidence: number; minBeats: number; weakMinConfidence: number };
  /**
   * B-3 (T10, cliche.ts): `split` = split a segment where the bass moves by scale step, both sides lasting at least
   * `minBeats` beats, and mark a line's last note on the 6th; false = off. `redecideRoot` (redecide.ts, plan section 3
   * decision 6) = re-read a maj / min triad as its third-related triad when the treble chroma favours it by
   * `redecideRatio` or more; false = off.
   */
  cliche: { split: boolean; minBeats: number; redecideRoot: boolean; redecideRatio: number };
  /** B-4 (optional): write `bassNotes`. */
  notes: { enabled: boolean };
  score: { toleranceSec: number };
}

export const BASS_CONFIG_GROUPS = ['lowCqt', 'segment', 'slash', 'cliche', 'notes', 'score'] as const;

export const DEFAULT_BASS_CONFIG: BassConfig = deepFreeze({
  name: 'bass-v0',
  enabled: false,
  // T5: 3 -> 5 octaves (C1-B5): B-1's candidates are C1-B3 and the harmonic sum reads their overtones up to h = 4.
  lowCqt: { fminHz: 32.7, octaves: 5, binsPerOctave: 36 },
  // T5 (tuning split only; docs/audio-spike6-t5.md): method 1 -> 2 (truth segments, all levels, headWeight 2:
  // methods 1-4 = .962 / .984 / .970 / .960; methods 1, 3, 4 removed after commit 41ee6fc). headWeight 2 -> 3
  // (1 .944, 2 .984, 3 .986, 4 .986). harmonics 4 kept (3 .981, 5 .983, 6 .978 with headWeight 2).
  // stayProb: method 4 only, unused since T5.
  segment: { method: 2, headWeight: 3, harmonics: 4, stayProb: 0.8 },
  // T6 (tuning split only; docs/audio-spike6-t6.md): minConfidence 0.5 -> 0.1 = the largest value whose slash F on the
  // truth segments stays within .01 of the best (0 .901, .05 .899, .1 .893, .15 .888, .2 .874, .5 .587); wrong /X is
  // ~0 on truth segments at every value and .010 / .008 / .007 on v1a segments at 0 / .1 / .2. minBeats 1 kept (v1a
  // segments are whole beats, so it only matters for sub-beat segments).
  // T9 (tuning split + the non-held-out LR variants; docs/audio-spike6-t9.md, G1 decision 4): fifthMinConfidence 0.4 (new;
  // 0 = T8). LR wrong /X (no-slash songs, left hand 5-1-5'-1) at 0 / .2 / .3 / .4 / .5 / .6 / off: .104 / .059 / .043 /
  // .034 / .032 / .031 / .031; truth-segment slash F .893 / .889 / .889 / .886 / .877 / .870 / .865. 0.4 = the smallest
  // value whose LR rate is within .005 of the floor (every non-pedal, non-passing 5th off), with F within .01 of T8.
  // T10 (same data; docs/audio-spike6-t10.md): the minor 3rd joins the 5th under weakMinConfidence (deferred from T9):
  // v1a-segment /X precision .817 -> .841, LR wrong /X .034 -> .031, truth-segment slash F unchanged (.886).
  slash: { minConfidence: 0.1, minBeats: 1, weakMinConfidence: 0.4 },
  // T10 (tuning split + LR; docs/audio-spike6-t10.md). Both switches stay OFF HERE (bass-off hash/output = v1a); G2 turned
  // both ON in enabledBassConfig() (plan section 5 G2 decisions). minBeats 2 (with split): truth-segment slash F 1 / 2 / 3 = .913 / .948 / .948, v1a-segment F .258 / .245 /
  // .236 with precision .830 / .824 / .817 (before the minor-3rd rule), LR .035 / .034 / .034; 2 = the smallest value
  // that keeps a walking line (one note per beat) whole. redecideRatio 4 (with split): the smallest ratio whose
  // v1a-segment /X precision stays >= .80 (G1 target): ratio 2 / 3 / 4 / 5 / 6 -> .750 / .766 / .811 / .809 / .817,
  // edits saved per 100 beats 2.52 / 2.32 / 2.04 / 1.93 / 1.78 (split alone 1.30); LR unchanged at every ratio >= 2.
  cliche: { split: false, minBeats: 2, redecideRoot: false, redecideRatio: 4 },
  notes: { enabled: false },
  score: { toleranceSec: 0.05 },
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameKind(def: unknown, v: unknown): boolean {
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === typeof def;
}

/** Defaults with a (partial, nested) override applied; unknown keys and wrong types throw; result is a new frozen object. */
export function resolveBassConfig(overrides: unknown = {}): BassConfig {
  if (!isObj(overrides)) throw new Error(`bass config overrides must be an object, got ${JSON.stringify(overrides)}`);
  const merge = (def: Json, ov: Json, path: string): Json => {
    const out: Json = {};
    for (const k of Object.keys(ov)) if (!(k in def)) throw new Error(`unknown bass config key: ${path}${k}`);
    for (const k of Object.keys(def)) {
      const d = def[k];
      if (!(k in ov)) {
        out[k] = d;
      } else if (isObj(d)) {
        if (!isObj(ov[k])) throw new Error(`bass config ${path}${k}: expected an object`);
        out[k] = merge(d, ov[k] as Json, `${path}${k}.`);
      } else {
        if (!sameKind(d, ov[k])) throw new Error(`bass config ${path}${k}: expected ${typeof d}, got ${JSON.stringify(ov[k])}`);
        out[k] = ov[k];
      }
    }
    return out;
  };
  return deepFreeze(merge(DEFAULT_BASS_CONFIG as unknown as Json, overrides, '') as unknown as BassConfig);
}

/**
 * The bass stage ON (what the CLI and the Worker run): defaults with `enabled: true`, then the overrides (T7).
 * G2 (user, 2026-11-14; docs/audio-spike6-plan.md section 5): B-3 `cliche.split` and the root re-decision
 * `cliche.redecideRoot` (ratio 4) are ON here. DEFAULT_BASS_CONFIG keeps them false so the bass-OFF hash and output
 * stay v1a's; an override of `cliche` is applied on top of the ON values (a partial `cliche` keeps the rest ON).
 */
export function enabledBassConfig(overrides: unknown = {}): BassConfig {
  if (!isObj(overrides)) throw new Error(`bass config overrides must be an object, got ${JSON.stringify(overrides)}`);
  const cliche = isObj(overrides.cliche) ? overrides.cliche : {};
  return resolveBassConfig({ enabled: true, ...overrides, cliche: { split: true, redecideRoot: true, ...cliche } });
}

/** Canonical JSON of the config (sorted keys, compact). */
export function bassConfigCanonical(cfg: BassConfig = DEFAULT_BASS_CONFIG): string {
  return pyCanonicalJson(cfg);
}

/** 12 hex chars of SHA-256 over the canonical JSON; independent of key order. */
export function bassConfigHash(cfg: BassConfig = DEFAULT_BASS_CONFIG): string {
  return sha256Hex(new TextEncoder().encode(bassConfigCanonical(cfg))).slice(0, 12);
}

/**
 * Spike 8 T4: config of the octave-aware pitch front end F1 (docs/audio-spike8-plan.md §2.1, decision 1).
 *
 * The values are fixed formulas and hand-set numbers only (no trained model). Each value says where it came from; the
 * ones marked "tuning" were chosen on the synthetic TUNING split only (c2-t-*, docs/audio-spike8-t4.md). Chords2Config
 * carries these values as `f1` only when D1 (`octaveChroma`) or D2 (`d2`) reads F1, so the all-off hash 607593f71c46 is
 * untouched (T5).
 * f1ConfigHash() = SHA-256 (first 12 hex) over the canonical JSON (same helpers as ../config.ts).
 */
import { pyCanonicalJson, sha256Hex } from '../../dsp/config';

export interface F1Config {
  name: string;
  /** The unfolded CQT (ts/bass lowCqt, called, not changed): C1 upward, `octaves` octaves (C1-B7 = rows 0-83). */
  cqt: { fminHz: number; octaves: number; binsPerOctave: number };
  /** Candidate fundamentals, MIDI (C1-B5). C1-B1 are candidates only so a low bass note's overtones are subtracted. */
  candLo: number;
  candHi: number;
  /** Lowest MIDI that is a pitch output (C2); detected notes below it only report `lowest`. */
  outLo: number;
  /** Harmonics h = 1..harmonics in the harmonic sum (out-of-range ones are not counted; the sum is a weighted mean). */
  harmonics: number;
  /** Harmonic weight g(h) = h^-weightPow (1 = 1/h). */
  weightPow: number;
  /** Smooth envelope: mean of the detected note's harmonic amplitudes over h-k..h+k (k = this), Klapuri's idea. */
  envHalfWidth: number;
  /** Phantom guard (§2.1 step 3): the fundamental or an odd harmonic bin must hold >= guard x the candidate's salience. */
  guard: number;
  /** Stop when the best remaining salience < stopRatio x the beat's first pick, or `maxNotes` notes are taken. */
  stopRatio: number;
  maxNotes: number;
  /** Absolute floor: a beat whose best salience is below floorRatio x the file's median first pick yields no notes. */
  floorRatio: number;
}

export const DEFAULT_F1_CONFIG: F1Config = deepFreeze({
  name: 'f1-v0',
  // plan §2.1 / §6: 7 octaves from C1 (the bass stage's 5 octaves are its lower part; docs/audio-spike8-t4.md "共有")
  cqt: { fminHz: 32.7, octaves: 7, binsPerOctave: 36 },
  candLo: 24,
  candHi: 83,
  outLo: 36,
  // plan §2.1: h = 1..8 (higher partials of the piano leave the semitone box)
  harmonics: 8,
  // tuning (docs/audio-spike8-t4.md, rule fixed before the grid: the unit tests must pass, then the highest added-tone
  // recall with every fake type <= .05). weightPow 1 -> .5: with 1/h a weak-fundamental note loses to its octave and
  // leaves its 3rd partial as a false 7th / 9th (only .5 passes the tests); .75 / 1 fail them.
  weightPow: 0.5,
  // envHalfWidth 2 and guard .3 / .7 tried: 2 fails the tests, guard changes nothing on the tuning set (kept at .5)
  envHalfWidth: 1,
  guard: 0.5,
  // tuning: .08 / .1 / .12 / .15 pass the tests (recall .49 / .47 / .45 / .42); .04 / .06 let E3's leftovers through
  stopRatio: 0.08,
  // plan §2.1: at most 8 notes
  maxNotes: 8,
  // provisional, not swept (silence guard; the input is loudness-aligned by prepareInput)
  floorRatio: 0.05,
  // θ_low (0.3 here until T5) moved to ../config.ts DEFAULT_D2_VALUES (T5: D2 owns it); hash 05a3e9144919 -> new pin
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** 12 hex chars of SHA-256 over the canonical JSON. */
export function f1ConfigHash(cfg: F1Config = DEFAULT_F1_CONFIG): string {
  return sha256Hex(new TextEncoder().encode(pyCanonicalJson(cfg))).slice(0, 12);
}

/** Defaults with a flat override (unknown keys / wrong types throw). For the tuning sweep and tests. */
export function resolveF1Config(over: Partial<F1Config> = {}): F1Config {
  const out: Record<string, unknown> = { ...DEFAULT_F1_CONFIG };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in DEFAULT_F1_CONFIG)) throw new Error(`unknown F1 config key: ${k}`);
    if (typeof v !== typeof (DEFAULT_F1_CONFIG as unknown as Record<string, unknown>)[k]) throw new Error(`F1 config ${k}: wrong type`);
    out[k] = v;
  }
  return deepFreeze(out as unknown as F1Config);
}

/**
 * Spike 4 T0: humming analyzer config (docs/audio-spike4-plan.md section 2 table, design decision 2).
 *
 * Values from the plan, frozen as the T8 baseline (hum-v0, 2d3c76d270cd), then tuned in T9 on the synthetic tuning
 * split only and confirmed on dev (hum-v1; see the T9 comments at each changed value). Searched but NOT changed
 * (ts/hum/tune.ts, out/hum/t9/): trimFraction .3/.35, glide 16, refFrames 48, medianFrames 3, biasMethod 'trunc'
 * (better on tuning, worse on dev), endExtendFraction .5 (H0 quant drops), pyin (tuning H2 drops), octaveCheckRatio .5
 * (no tuning effect; dev H3 better: left to T10).
 * configHash() = SHA-256 (first 12 hex) over the canonical JSON (sorted keys, compact; same helpers as the
 * spike-3 ts/dsp/config.ts), so the key order of an object never changes the hash. Numbers are written the
 * way pyCanonicalJson does (integral -> int, else Python float repr): keep that stable when editing defaults.
 */
import { pyCanonicalJson, sha256Hex } from '../dsp/config';

export interface HumConfig {
  name: string;
  audio: { sr: number };
  f0: {
    /** YIN window and hop in samples (1024 = 46 ms, 256 = 11.6 ms at 22050 Hz). */
    win: number;
    hop: number;
    fminHz: number;
    fmaxHz: number;
    /** Absolute threshold of the cumulative-mean-normalized difference. */
    yinThreshold: number;
    /** pYIN-style: several thresholds + HMM over pitch states (switch, default off). */
    pyin: boolean;
    pyinThresholds: number[];
    /** HMM pitch states per semitone (5 = 20 cents). */
    binsPerSemitone: number;
    /** Max pitch-state jump per frame, in semitones (HMM transition width). */
    maxJumpSemitones: number;
    voicedToUnvoiced: number;
    unvoicedToVoiced: number;
    /** Sub-octave check (f0.ts octaveCheck): move the pick to the dip near 2 tau when its d' <= ratio * d'(tau) ... */
    octaveCheckRatio: number;
    /** ... and d'(tau) - d'(2 tau) >= this (0 ratio = off). */
    octaveCheckMinD: number;
    /** pYIN threshold prior Beta(a, b) (pyin.ts pyinWeights; paper default [2, 18], mean 0.1). */
    pyinBeta: number[];
  };
  voicing: {
    /** Frames at least this far (dB) above the recording's noise floor count as voiced. */
    noiseMarginDb: number;
    /** Percentile (0..1) of frame level taken as the noise floor. */
    noisePercentile: number;
    /** Minimum voiced probability (pYIN / 1 - aperiodicity). */
    minVoicedProb: number;
    /** Gaps shorter than this (ms) inside a voiced run are bridged. */
    bridgeGapMs: number;
  };
  segment: {
    /** Median filter width over f0 frames. */
    medianFrames: number;
    /** A new note starts when the smoothed pitch moves this fraction of a semitone from the running note pitch ... */
    moveSemitones: number;
    /** ... for at least this long (ms). */
    minMoveMs: number;
    /** Frames inside pitch glides (|d pitch/dt| above this, semitones per second) do not count for pitch. */
    glideSemitonesPerSec: number;
    /** Notes shorter than this many 16ths are merged into a neighbour. */
    minNoteSixteenths: number;
    /** Split repeated same-pitch notes at loudness dips ("la la"). */
    splitOnDips: boolean;
    /** A dip is this many dB below both neighbouring maxima. */
    dipDb: number;
    /** Notes via the Tony-style note HMM (switch, default off). */
    noteHmm: boolean;
    /** Frames of the running note reference of the pitch split (notes.ts rule 3; 36 = ~0.42 s at hop 256). */
    refFrames: number;
    /** Consecutive stable frames before a note has a reference pitch (rule 3). */
    settleFrames: number;
    /** Unvoiced gaps up to this long without a level dip are f0 dropouts and joined (rule 1b), ms. */
    joinGapMs: number;
    /** Vibrato guard after a dip (rule 5): window (ms) and swing size (semitones). */
    vibratoWindowMs: number;
    vibratoSwingSemitones: number;
  };
  pitch: {
    /** Fraction of the note trimmed at both ends before taking the median. */
    trimFraction: number;
    /** Remove the recording-wide tuning offset before rounding to semitones. */
    tuning: boolean;
    /** Max pitch candidates per note (excluding the chosen one). */
    candidatesMax: number;
    /** Candidates are offered when the pitch is within this many cents of a semitone boundary. */
    boundaryCents: number;
    /** Fix short notes 12 semitones from both neighbours. */
    octaveFix: boolean;
    octaveFixMaxSixteenths: number;
    /** Use HumInfo.key to reorder boundary candidates (switch, default off; decision 6). */
    keyPrior: boolean;
  };
  grid: {
    /** Grid per whole note: 16 = 16th-note grid. */
    subdivision: number;
    /** 8th-note triplet grid per beat chosen by smaller error (switch, default off). */
    triplet: boolean;
    /** Max grid alternatives per note. */
    candidatesMax: number;
    /** Remove the median onset offset (sang early/late) first. */
    onsetBias: boolean;
    /** Gaps shorter than this many 8ths between notes become legato (note extended), longer become rests. */
    legatoGapEighths: number;
    /** quantize.ts QuantizeOptions (rules 2, 5, 6, 7, 9); see there. */
    endExtendFraction: number;
    minNoteSteps: number;
    maxBiasSec: number;
    minBiasNotes: number;
    padLastBar: boolean;
    tripletMargin: number;
    biasMethod: 'local' | 'trunc';
  };
}

export const HUM_CONFIG_GROUPS = ['audio', 'f0', 'voicing', 'segment', 'pitch', 'grid'] as const;

export const DEFAULT_HUM_CONFIG: HumConfig = deepFreeze({
  // T9 (tuned on the synthetic TUNING split with ts/hum/tune.ts, confirmed on DEV; T8 baseline = 'hum-v0', 2d3c76d270cd).
  // Each changed value says why; 'tuning'/'dev' numbers are per-level means of F onset / quant exact / edits per keyboard step.
  name: 'hum-v1',
  audio: { sr: 22050 },
  f0: {
    win: 1024,
    hop: 256,
    fminHz: 65,
    fmaxHz: 1050,
    yinThreshold: 0.15,
    pyin: false,
    pyinThresholds: [0.05, 0.1, 0.15, 0.2, 0.3],
    binsPerSemitone: 5,
    maxJumpSemitones: 2.0,
    voicedToUnvoiced: 0.05,
    unvoicedToVoiced: 0.05,
    octaveCheckRatio: 0.35,
    octaveCheckMinD: 0.02,
    pyinBeta: [2, 18],
  },
  voicing: {
    // T9: 10 -> 6. The 20 dB-noise H3 takes lost quiet note ends / soft "n~" onsets to the level gate; H3 F onset
    // tuning .864 -> .879, dev .801 -> .814 (with the other T9 values); H0-H2 unchanged.
    noiseMarginDb: 6.0,
    noisePercentile: 0.1,
    // T9: 0.5 -> 0.4. Fewer dropped frames in breathy H3 notes; dev H1 F onset .978 -> .983 (alone), H2/H3 quant up.
    minVoicedProb: 0.4,
    // T9: 30 -> 20. A shorter bridge keeps the short closure gaps between same-pitch repeats as boundaries
    // (H3 tuning quant exact .394 -> .412 in the first search; removing it from the final set: dev H3 quant .464 -> .449).
    bridgeGapMs: 20,
  },
  segment: {
    medianFrames: 5,
    moveSemitones: 0.6,
    minMoveMs: 60,
    // T9: 12 -> 14. Vibrato/scoop flanks of H2/H3 voices were "not stable", so the reference settled late and short
    // notes were merged; H2 F onset tuning .955 -> .991, dev .967 -> .996, H3 dev .818 -> .858. 16 was better on tuning
    // but dropped dev H1 F onset .978 -> .928 (not adopted).
    glideSemitonesPerSec: 14.0,
    minNoteSixteenths: 0.5,
    splitOnDips: true,
    // T9: 6 -> 5 (G1 priority: same-pitch repeats on closed-mouth "n~", H3). H3 quant exact tuning .354 -> .388 (alone),
    // removing it from the final set: dev H3 F onset .858 -> .831. 4.5 / 5.5 were worse on tuning.
    dipDb: 5.0,
    noteHmm: false,
    refFrames: 36,
    settleFrames: 3,
    joinGapMs: 80,
    vibratoWindowMs: 200,
    // T9: 0.15 -> 0.2. The vibrato guard blocked real dips after pitch noise of H2/H3 (+-15 cents counted as a swing);
    // tuning H3 quant exact .404 -> .416, H2 .855 -> .862 (leave-one-out); dev unchanged.
    vibratoSwingSemitones: 0.2,
  },
  pitch: {
    trimFraction: 0.25,
    tuning: true,
    candidatesMax: 3,
    boundaryCents: 20,
    octaveFix: true,
    // T9: 4 -> 1 (T5 proposal: the rule only ever moved correct notes on synthetic). Tuning unchanged; dev H0 F onset
    // .996 -> 1.000 (the one dev H0/H1 octave error was this rule).
    octaveFixMaxSixteenths: 1,
    keyPrior: false,
  },
  grid: {
    subdivision: 16,
    triplet: false,
    candidatesMax: 2,
    onsetBias: true,
    legatoGapEighths: 0.5,
    endExtendFraction: 0.3,
    minNoteSteps: 1,
    maxBiasSec: 0.08,
    minBiasNotes: 4,
    padLastBar: true,
    tripletMargin: 0.5,
    biasMethod: 'local',
  },
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
  if (Array.isArray(def)) return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === typeof def;
}

/**
 * Defaults with a (partial, nested) override applied. Unknown keys and wrong types throw; the result is a
 * new frozen object (the defaults are never mutated). Key order of `overrides` is irrelevant.
 */
export function resolveHumConfig(overrides: unknown = {}): HumConfig {
  if (!isObj(overrides)) throw new Error(`hum config overrides must be an object, got ${JSON.stringify(overrides)}`);
  const merge = (def: Json, ov: Json, path: string): Json => {
    const out: Json = {};
    for (const k of Object.keys(ov)) if (!(k in def)) throw new Error(`unknown hum config key: ${path}${k}`);
    for (const k of Object.keys(def)) {
      const d = def[k];
      if (!(k in ov)) {
        out[k] = Array.isArray(d) ? [...d] : d;
      } else if (isObj(d)) {
        if (!isObj(ov[k])) throw new Error(`hum config ${path}${k}: expected an object`);
        out[k] = merge(d, ov[k] as Json, `${path}${k}.`);
      } else {
        if (!sameKind(d, ov[k])) throw new Error(`hum config ${path}${k}: expected ${Array.isArray(d) ? 'number[]' : typeof d}, got ${JSON.stringify(ov[k])}`);
        out[k] = Array.isArray(ov[k]) ? [...(ov[k] as number[])] : ov[k];
      }
    }
    return out;
  };
  return deepFreeze(merge(DEFAULT_HUM_CONFIG as unknown as Json, overrides, '') as unknown as HumConfig);
}

/** Canonical JSON of the config (sorted keys, compact). */
export function humConfigCanonical(cfg: HumConfig = DEFAULT_HUM_CONFIG): string {
  return pyCanonicalJson(cfg);
}

/** 12 hex chars of SHA-256 over the canonical JSON; independent of key order. */
export function humConfigHash(cfg: HumConfig = DEFAULT_HUM_CONFIG): string {
  return sha256Hex(new TextEncoder().encode(humConfigCanonical(cfg))).slice(0, 12);
}

/** Alias with the spike-3 name. */
export const configHash = humConfigHash;

/** Leaves whose value differs from the default, as 'group.key' -> value (for logs). */
export function humConfigSummary(cfg: HumConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (a: Json, b: Json, p: string) => {
    for (const k of Object.keys(b)) {
      if (isObj(b[k])) walk(a[k] as Json, b[k] as Json, `${p}${k}.`);
      else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[`${p}${k}`] = a[k];
    }
  };
  walk(cfg as unknown as Json, DEFAULT_HUM_CONFIG as unknown as Json, '');
  return out;
}

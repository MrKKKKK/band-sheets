/**
 * Spike 4 T0: humming analyzer config (docs/audio-spike4-plan.md section 2 table, design decision 2).
 *
 * All values are PROVISIONAL (from the plan; tuned on synthetic audio only, baseline frozen at T8).
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
  };
}

export const HUM_CONFIG_GROUPS = ['audio', 'f0', 'voicing', 'segment', 'pitch', 'grid'] as const;

export const DEFAULT_HUM_CONFIG: HumConfig = deepFreeze({
  name: 'hum-v0',
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
  },
  voicing: { noiseMarginDb: 10.0, noisePercentile: 0.1, minVoicedProb: 0.5, bridgeGapMs: 30 },
  segment: {
    medianFrames: 5,
    moveSemitones: 0.6,
    minMoveMs: 60,
    glideSemitonesPerSec: 12.0,
    minNoteSixteenths: 0.5,
    splitOnDips: true,
    dipDb: 6.0,
    noteHmm: false,
  },
  pitch: {
    trimFraction: 0.25,
    tuning: true,
    candidatesMax: 3,
    boundaryCents: 20,
    octaveFix: true,
    octaveFixMaxSixteenths: 4,
    keyPrior: false,
  },
  grid: { subdivision: 16, triplet: false, candidatesMax: 2, onsetBias: true, legatoGapEighths: 0.5 },
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

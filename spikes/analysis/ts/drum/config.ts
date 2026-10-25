/**
 * Spike 5 T0: drum analyzer config (docs/audio-spike5-plan.md sections 2, 5, 6 decision 2).
 *
 * PROVISIONAL values: the shape is fixed here (T0), the values are set by T5-T7 and tuned in T10-T12 on the
 * synthetic tuning split only (reason for each change goes in a comment at the value). Only values the plan's tasks
 * refer to are listed (YAGNI): onset detection (T5), bands (T5), classify / NMF / refit / HPSS switches (T6), toms and
 * cymbals (T11), strength (T7), grid / swing (T7), scoring tolerance (T3).
 * configHash() = SHA-256 (first 12 hex) over the canonical JSON (sorted keys, compact; same helpers as ts/dsp/config.ts
 * and ts/hum/config.ts), so key order never changes the hash. Keep numbers in a form pyCanonicalJson writes stably.
 */
import { pyCanonicalJson, sha256Hex } from '../dsp/config';

export interface DrumConfig {
  name: string;
  /** Analysis sample rate (plan section 2: 22050, or 44100 for the high bands; T5 decides). */
  audio: { sr: number };
  onset: {
    /** STFT window and hop in samples. */
    win: number;
    hop: number;
    /** Log compression of the band magnitudes: log(1 + gamma * mag). */
    logGamma: number;
    /** Per-recording threshold: median of the onset function + this many MADs (T5). */
    thresholdMads: number;
    /** Local-max picking window (ms) and minimum distance between hits of one band (ms). */
    peakWindowMs: number;
    minDistanceMs: number;
  };
  bands: {
    /** Band edges in Hz: low (BD), mid (SD body / noise), high (HH, cymbals). */
    edgesHz: number[];
  };
  classify: {
    /** Switches tried in order by T6 (each gets its own table). */
    nmf: boolean;
    refit: boolean;
    hpss: boolean;
    nmfIterations: number;
    /** Number of 2nd-candidate instruments kept per hit (plan decision 5). */
    candidatesMax: number;
  };
  toms: {
    /** S-9 (T11): tom hits are split by low-peak height into this many groups. */
    groups: number;
  };
  cymbals: {
    /** S-9 (T11): decay length (ms) above which a high-band hit is open / crash-like, and the HH / HO split. */
    openDecayMs: number;
    /** HH and HO are never hit together: a hit within this window (ms) of an open one is merged. */
    openExclusiveMs: number;
  };
  strength: {
    /** Strength percentiles (0..1) of the recording splitting ghost / normal / accent. */
    ghostPercentile: number;
    accentPercentile: number;
  };
  grid: {
    /** Grid per whole note: 16 = 16th-note grid. */
    subdivision: number;
    /** 8th-note triplet grid per beat, chosen by the shuffle decision. */
    triplet: boolean;
    /** Remove the median onset offset first. */
    onsetBias: boolean;
    maxBiasSec: number;
  };
  swing: {
    /** A bar is swung when the median off-beat position ratio exceeds this (0.5 = straight, 0.667 = 2:1). */
    ratioMin: number;
    /** Minimum off-beat pairs in a bar to decide. */
    minPairs: number;
  };
  score: {
    /** Onset match tolerance (s): main (mir_eval default) and the tight one (synthetic only). Plan section 3 decision 4. */
    toleranceSec: number;
    tightSec: number;
  };
}

export const DRUM_CONFIG_GROUPS = ['audio', 'onset', 'bands', 'classify', 'toms', 'cymbals', 'strength', 'grid', 'swing', 'score'] as const;

export const DEFAULT_DRUM_CONFIG: DrumConfig = deepFreeze({
  name: 'drum-v0',
  audio: { sr: 22050 },
  onset: {
    win: 1024,
    hop: 256,
    logGamma: 100,
    thresholdMads: 3,
    peakWindowMs: 30,
    minDistanceMs: 30,
  },
  bands: { edgesHz: [30, 200, 3000, 10000] },
  classify: { nmf: false, refit: false, hpss: false, nmfIterations: 100, candidatesMax: 1 },
  toms: { groups: 3 },
  cymbals: { openDecayMs: 250, openExclusiveMs: 50 },
  strength: { ghostPercentile: 0.2, accentPercentile: 0.85 },
  grid: { subdivision: 16, triplet: false, onsetBias: true, maxBiasSec: 0.08 },
  swing: { ratioMin: 0.58, minPairs: 3 },
  score: { toleranceSec: 0.05, tightSec: 0.025 },
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

/** Defaults with a (partial, nested) override applied; unknown keys and wrong types throw; result is a new frozen object. */
export function resolveDrumConfig(overrides: unknown = {}): DrumConfig {
  if (!isObj(overrides)) throw new Error(`drum config overrides must be an object, got ${JSON.stringify(overrides)}`);
  const merge = (def: Json, ov: Json, path: string): Json => {
    const out: Json = {};
    for (const k of Object.keys(ov)) if (!(k in def)) throw new Error(`unknown drum config key: ${path}${k}`);
    for (const k of Object.keys(def)) {
      const d = def[k];
      if (!(k in ov)) {
        out[k] = Array.isArray(d) ? [...d] : d;
      } else if (isObj(d)) {
        if (!isObj(ov[k])) throw new Error(`drum config ${path}${k}: expected an object`);
        out[k] = merge(d, ov[k] as Json, `${path}${k}.`);
      } else {
        if (!sameKind(d, ov[k])) throw new Error(`drum config ${path}${k}: expected ${Array.isArray(d) ? 'number[]' : typeof d}, got ${JSON.stringify(ov[k])}`);
        out[k] = Array.isArray(ov[k]) ? [...(ov[k] as number[])] : ov[k];
      }
    }
    return out;
  };
  return deepFreeze(merge(DEFAULT_DRUM_CONFIG as unknown as Json, overrides, '') as unknown as DrumConfig);
}

/** Canonical JSON of the config (sorted keys, compact). */
export function drumConfigCanonical(cfg: DrumConfig = DEFAULT_DRUM_CONFIG): string {
  return pyCanonicalJson(cfg);
}

/** 12 hex chars of SHA-256 over the canonical JSON; independent of key order. */
export function drumConfigHash(cfg: DrumConfig = DEFAULT_DRUM_CONFIG): string {
  return sha256Hex(new TextEncoder().encode(drumConfigCanonical(cfg))).slice(0, 12);
}

/** Leaves whose value differs from the default, as 'group.key' -> value (for logs). */
export function drumConfigSummary(cfg: DrumConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (a: Json, b: Json, p: string) => {
    for (const k of Object.keys(b)) {
      if (isObj(b[k])) walk(a[k] as Json, b[k] as Json, `${p}${k}.`);
      else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[`${p}${k}`] = a[k];
    }
  };
  walk(cfg as unknown as Json, DEFAULT_DRUM_CONFIG as unknown as Json, '');
  return out;
}

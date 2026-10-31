// Spike 5 T12b: the "realistic" tuning-only variants (level R1 = D1 + the differences R2/R3 measured between the
// synthetic material and the user's line-out recordings, docs/audio-spike5-r3.md 「合成に足す変化の案」).
//
// On top of D1 (close mic, dry, no noise; fills on so toms occur):
//   1. HH dynamics: per-hit level pattern in the audio (quarter 0 dB, other 8ths -0.6 * depth, 16ths -depth, depth
//      6-15 dB per variant) + gauss 2.5 dB. RD gets half the depth. MIDI velocity alone gives only 1-2 dB (sf2 layers).
//   2. HH / RD bus below SD: HH group -10..-20 dB, RD -2..-8 dB (all hits).
//   3. Darker HH / RD: high-shelf cut (RBJ, S = 1) at 5-7 kHz, -4..-9 dB, on HH group / RD / RD.bell voices (a 2nd-order
//      low-pass at 3.5-6 kHz overshot: HH centroid 1.6-3.7 kHz vs the recordings' 5.5 kHz).
//   4. Timing: one jitter per grid position (simultaneous hits share it), sigma 15-25 ms (clip 2.5 sigma), a fixed
//      offset per piece (-10..+10 ms), a slow drift (-20..+20 ms per minute of bar-1-relative time).
//   5. Low-body SD near the high tom's pitch: a damped sine (100-140 Hz, decay 40-90 ms, 0.08-0.2 x the SD voice's
//      energy) added to every SD voice, and the toms resampled by one ratio so T1's
//      pitch is the body's x 0.95-1.10 (tomPitch ratio T1 / SD ~1, r3.md decision 6). The recordings' SD share below
//      120 Hz (~.42) is NOT copied: a body that strong (90-120 Hz, 0.25-0.6 x) made the analyzer add a BD to ~1/3 of the
//      SD hits, which the recordings do not show (BD precision .95), so the body stays small (share ~.1-.3).
// Every draw comes from the variant's own `real*` streams: D1 variants of other sets are untouched (golden hashes).

import { resolveDrumConfig } from '../../ts/drum/config';
import { tomPitch } from '../../ts/drum/toms';
import type { DrumInst } from '../../ts/drum/types';
import { gauss } from '../hum/voice';
import { onsetIndex, type Kit, type OneShot, type VoiceRequest } from './kits';
import type { TimedHit } from './notation';
import { HH_GROUP } from './patterns';
import { streamOf, type DrumVariant } from './variants';

const uni = (rnd: () => number, lo: number, hi: number) => lo + (hi - lo) * rnd();
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const DARK: ReadonlySet<DrumInst> = new Set<DrumInst>([...HH_GROUP, 'RD', 'RD.bell']);
export const REAL_JITTER_CLIP = 2.5;

export interface RealParams {
  /** HH level pattern depth (dB): quarter 0, other 8ths -0.6 depth, 16ths -depth. */
  hhDepthDb: number;
  hhBusDb: number;
  rdBusDb: number;
  /** Per-hit level spread (dB, gauss). */
  levelSigmaDb: number;
  /** High-shelf corner (Hz) and gain (dB) on the HH / RD voices. */
  darkHz: number;
  darkDb: number;
  jitterSigmaSec: number;
  /** Fixed offset per written piece (s). */
  instOffsetSec: Record<string, number>;
  /** Timing drift (s per s since bar 1). */
  driftPerSec: number;
  /** SD body: frequency (Hz), decay (s), energy re the SD voice; T1's target pitch re the body. */
  bodyHz: number;
  tomRatio: number;
  bodyDecaySec: number;
  bodyEnergy: number;
}

const OFFSET_PIECES = ['BD', 'SD', 'HH', 'RD', 'CR', 'T1', 'T2', 'FT'] as const;
/** Piece whose fixed timing offset a hit uses (extensions follow their base piece). */
const offsetPiece = (i: DrumInst): string => (HH_GROUP.has(i) ? 'HH' : i === 'RD.bell' || i === 'CB' ? 'RD' : i === 'SP' || i === 'CN' ? 'CR' : i.startsWith('SD') ? 'SD' : i);

export function realParams(v: DrumVariant): RealParams {
  const s = streamOf(v, 'real', { perKit: true });
  const instOffsetSec: Record<string, number> = {};
  const hhDepthDb = r3(uni(s, 6, 15));
  const hhBusDb = r3(uni(s, -20, -10));
  const rdBusDb = r3(uni(s, -8, -2));
  const darkHz = Math.round(uni(s, 5000, 7000));
  const darkDb = r3(uni(s, -9, -4));
  const jitterSigmaSec = r3(uni(s, 15, 25)) / 1000;
  for (const p of OFFSET_PIECES) instOffsetSec[p] = r3(uni(s, -10, 10)) / 1000;
  const driftPerSec = r3(uni(s, -20, 20)) / 1000 / 60;
  return {
    hhDepthDb,
    hhBusDb,
    rdBusDb,
    levelSigmaDb: 2.5,
    darkHz,
    darkDb,
    jitterSigmaSec,
    instOffsetSec,
    driftPerSec,
    bodyHz: r3(uni(s, 100, 140)),
    tomRatio: r3(uni(s, 0.95, 1.1)),
    bodyDecaySec: r3(uni(s, 0.04, 0.09)),
    bodyEnergy: r3(uni(s, 0.08, 0.2)),
  };
}

/** The performed time of every hit (replaces D1's independent per-hit jitter; `timed` carries zero jitter). */
export function realTimes(v: DrumVariant, rp: RealParams, timed: readonly TimedHit[], startSec: number): TimedHit[] {
  const s = streamOf(v, 'realJitter', { perKit: true });
  const shared = new Map<string, number>();
  return timed.map((h) => {
    const key = `${h.bar}:${h.tick}`;
    let j = shared.get(key);
    if (j === undefined) {
      j = Math.max(-REAL_JITTER_CLIP, Math.min(REAL_JITTER_CLIP, gauss(s))) * rp.jitterSigmaSec;
      shared.set(key, j);
    }
    return { ...h, t: h.t + j + (rp.instOffsetSec[offsetPiece(h.inst)] ?? 0) + rp.driftPerSec * Math.max(0, h.t - startSec) };
  });
}

/** Extra gain (linear) of a hit: bus + HH / RD level pattern + spread. `beat` = ticks per beat. */
export function realGain(h: TimedHit, rp: RealParams, beat: number, rnd: () => number): number {
  let db = 0;
  const hh = HH_GROUP.has(h.inst);
  const rd = h.inst === 'RD' || h.inst === 'RD.bell';
  if (hh || rd) {
    const depth = hh ? rp.hhDepthDb : rp.hhDepthDb / 2;
    const pos = h.tick % beat;
    db += (hh ? rp.hhBusDb : rp.rdBusDb) + (pos === 0 ? 0 : pos % (beat / 2) === 0 ? -0.6 * depth : -depth);
    db += gauss(rnd) * rp.levelSigmaDb;
  }
  return 10 ** (db / 20);
}

/** RBJ high shelf (S = 1), causal, zero initial state. */
export function highShelf(x: Float32Array, fc: number, gainDb: number, sr: number): Float32Array {
  const A = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * fc) / sr;
  const c = Math.cos(w);
  const alpha = (Math.sin(w) / 2) * Math.SQRT2;
  const sa = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * c + sa;
  const b0 = (A * (A + 1 + (A - 1) * c + sa)) / a0;
  const b1 = (-2 * A * (A - 1 + (A + 1) * c)) / a0;
  const b2 = (A * (A + 1 + (A - 1) * c - sa)) / a0;
  const a1 = (2 * (A - 1 - (A + 1) * c)) / a0;
  const a2 = (A + 1 - (A - 1) * c - sa) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Linear-interpolation resample: ratio < 1 lowers the pitch (and lengthens the one-shot). */
export function resample(x: Float32Array, ratio: number): Float32Array {
  const n = Math.floor((x.length - 1) / ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const k = Math.floor(p);
    const f = p - k;
    y[i] = x[k] * (1 - f) + x[k + 1] * f;
  }
  return y;
}

/** SD voice + damped sine body starting at the voice's onset (2 ms raised-cosine attack). */
export function addBody(voice: OneShot, hz: number, decaySec: number, energy: number, sr: number): Float32Array {
  const x = voice.x;
  let e = 0;
  for (let i = voice.onset; i < x.length; i++) e += x[i] * x[i];
  const att = Math.round(0.002 * sr);
  const n = x.length - voice.onset;
  const body = new Float64Array(n);
  let eb = 0;
  for (let i = 0; i < n; i++) {
    const env = (i < att ? 0.5 * (1 - Math.cos((Math.PI * i) / att)) : 1) * Math.exp(-i / sr / decaySec);
    body[i] = env * Math.sin((2 * Math.PI * hz * i) / sr);
    eb += body[i] * body[i];
  }
  const g = eb > 0 ? Math.sqrt((energy * e) / eb) : 0;
  const y = Float32Array.from(x);
  for (let i = 0; i < n; i++) y[voice.onset + i] += g * body[i];
  return y;
}

const TOMS: ReadonlySet<DrumInst> = new Set<DrumInst>(['T1', 'T2', 'FT']);

/** The variant's kit with the realistic voice changes (dark HH / RD, SD body, toms retuned). Memoized per voice object. */
export function realKit(kit: Kit, rp: RealParams, sr: number): Kit {
  const memo = new Map<OneShot, OneShot>();
  const toms = resolveDrumConfig({}).toms;
  let tomShift: number | undefined;
  const shiftOf = (req: VoiceRequest): number => {
    if (tomShift === undefined) {
      const tom = kit.instruments.includes('T1') ? 'T1' : kit.instruments.includes('T2') ? 'T2' : 'FT';
      const v = kit.voice({ ...req, inst: tom, layer: kit.layers(tom) - 1, rr: 0 });
      tomShift = (rp.bodyHz * rp.tomRatio) / tomPitch(v.x, sr, v.onset / sr, toms);
    }
    return tomShift;
  };
  return {
    ...kit,
    voice(req: VoiceRequest): OneShot {
      const v = kit.voice(req);
      const kind = DARK.has(req.inst) ? 'dark' : req.inst === 'SD' ? 'sd' : TOMS.has(req.inst) ? 'tom' : null;
      if (!kind) return v;
      let out = memo.get(v);
      if (!out) {
        const x =
          kind === 'dark'
            ? highShelf(v.x, rp.darkHz, rp.darkDb, sr)
            : kind === 'sd'
              ? addBody(v, rp.bodyHz, rp.bodyDecaySec, rp.bodyEnergy, sr)
              : resample(v.x, shiftOf(req));
        out = { x, onset: onsetIndex(x, sr) };
        memo.set(v, out);
      }
      return out;
    },
  };
}

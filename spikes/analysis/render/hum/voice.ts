// Spike 4 T1: voice-like source for the synthetic humming (docs/audio-spike4-plan.md section 4).
//
// H0: a sine (+ a 2nd harmonic at -16 dB, still exactly one rising zero crossing per period).
// H1+: a harmonic source (harmonic k at k^-tilt, harmonic 1 optionally weakened, harmonics up to ~5 kHz,
// computed with the Chebyshev recurrence sin(k phi) = 2 cos(phi) sin((k-1) phi) - sin((k-2) phi)), shaped by
// formant peaks (RBJ peaking biquads: vowel "a" or the closed-mouth "n" murmur + a low-pass), "ta"
// consonant bursts, breath noise between phrases. The clean voice is scaled to a fixed peak (VOICE_PEAK);
// breath, bursts and click bleed are set relative to that peak.

import { midiToHz, type Performance } from './contour';
import type { Register } from './melodies';
import { streamOf, type HumVariant, type SynthParams } from './variants';

export const VOICE_PEAK = 0.5;
const MAX_HARMONIC_HZ = 5000;
const MAX_HARMONICS = 40;

interface Peak {
  hz: number;
  db: number;
  q: number;
}

const VOWELS: Record<'a' | 'n', { peaks: Peak[]; lowpassHz?: number }> = {
  a: {
    peaks: [
      { hz: 750, db: 12, q: 5 },
      { hz: 1200, db: 9, q: 6 },
      { hz: 2600, db: 5, q: 7 },
    ],
  },
  n: {
    peaks: [
      { hz: 270, db: 12, q: 3 },
      { hz: 2100, db: 3, q: 5 },
    ],
    lowpassHz: 1200,
  },
};

/** Biquad coefficients [b0, b1, b2, a1, a2] (normalized by a0). */
type Coefs = [number, number, number, number, number];

export function peakingCoefs(hz: number, db: number, q: number, sr: number): Coefs {
  const A = 10 ** (db / 40);
  const w = (2 * Math.PI * hz) / sr;
  const al = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + al / A;
  return [(1 + al * A) / a0, (-2 * c) / a0, (1 - al * A) / a0, (-2 * c) / a0, (1 - al / A) / a0];
}

export function bandpassCoefs(hz: number, q: number, sr: number): Coefs {
  const w = (2 * Math.PI * hz) / sr;
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  return [al / a0, 0, -al / a0, (-2 * Math.cos(w)) / a0, (1 - al) / a0];
}

/** In-place direct-form-I biquad. */
export function biquad(x: Float64Array, [b0, b1, b2, a1, a2]: Coefs): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

function onePoleLowpass(x: Float64Array, hz: number, sr: number): void {
  const a = Math.exp((-2 * Math.PI * hz) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i] + a * y;
    x[i] = y;
  }
}

export function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** The voiced part only (phrases), unscaled. */
export function synthPhrases(perf: Performance, p: SynthParams, sr: number, n: number): Float64Array {
  const out = new Float64Array(n);
  const amps = new Float64Array(MAX_HARMONICS + 1);
  perf.phrases.forEach((ph, k) => {
    let maxHz = 0;
    for (const j of ph.notes) maxHz = Math.max(maxHz, midiToHz(perf.sung[j].target + 0.7));
    const K = p.source === 'sine' ? 2 : Math.max(1, Math.min(MAX_HARMONICS, Math.floor(MAX_HARMONIC_HZ / maxHz)));
    for (let h = 1; h <= K; h++) amps[h] = p.source === 'sine' ? (h === 1 ? 1 : 0.15) : h ** -p.tilt;
    if (p.source === 'voice') amps[1] *= 10 ** (p.fundamentalDb / 20);
    const i0 = Math.max(0, Math.ceil(ph.start * sr));
    const i1 = Math.min(n - 1, Math.floor(ph.end * sr));
    let phase = 0;
    let q = ph.notes[0];
    const last = ph.notes[ph.notes.length - 1];
    for (let i = i0; i <= i1; i++) {
      const t = i / sr;
      while (q < last && perf.sung[q + 1].start <= t) q++;
      const env = perf.envAt(t, k, q);
      phase += (2 * Math.PI * midiToHz(perf.pitchAt(t, q))) / sr;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      if (env === 0) continue;
      const s1 = Math.sin(phase);
      const c2 = 2 * Math.cos(phase);
      let prev = 0;
      let cur = s1;
      let acc = amps[1] * s1;
      for (let h = 2; h <= K; h++) {
        const nx = c2 * cur - prev;
        prev = cur;
        cur = nx;
        acc += amps[h] * nx;
      }
      out[i] += env * acc;
    }
  });
  return out;
}

export function applyVowel(x: Float64Array, vowel: 'a' | 'n', reg: Register, sr: number): void {
  const v = VOWELS[vowel];
  const scale = reg === 'high' ? 1.12 : 1;
  for (const pk of v.peaks) biquad(x, peakingCoefs(pk.hz * scale, pk.db, pk.q, sr));
  if (v.lowpassHz) onePoleLowpass(x, v.lowpassHz * scale, sr);
}

function peakAbs(x: Float64Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

/** Band-passed noise bursts (breaths, consonants) added in place with a sin(pi x) envelope. */
function addNoiseBursts(x: Float64Array, spans: { start: number; end: number }[], level: number, hz: number, q: number, rnd: () => number, sr: number) {
  for (const s of spans) {
    const i0 = Math.max(0, Math.round(s.start * sr));
    const i1 = Math.min(x.length, Math.round(s.end * sr));
    if (i1 - i0 < 4) continue;
    const buf = new Float64Array(i1 - i0);
    for (let i = 0; i < buf.length; i++) buf[i] = gauss(rnd);
    biquad(buf, bandpassCoefs(hz, q, sr));
    let ss = 0;
    for (const b of buf) ss += b * b;
    const norm = level / Math.sqrt(ss / buf.length || 1);
    for (let i = 0; i < buf.length; i++) x[i0 + i] += norm * buf[i] * Math.sin((Math.PI * i) / buf.length);
  }
}

/** Click bleed: short decaying sines on every beat (accent on beat 1), from the count-in to the end. */
export function addClicks(x: Float64Array, clicks: { t: number; down: boolean }[], level: number, sr: number): void {
  const len = Math.round(0.025 * sr);
  for (const c of clicks) {
    const i0 = Math.round(c.t * sr);
    const f = c.down ? 2000 : 1500;
    for (let i = 0; i < len && i0 + i < x.length; i++) x[i0 + i] += level * Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / sr / 0.004);
  }
}

/**
 * The dry signal of a variant: voice scaled to VOICE_PEAK, plus "ta" bursts and breaths. Click bleed and
 * room/noise are added by degrade.ts. `clean` is the voice alone (for checks).
 */
export function synthVoice(v: HumVariant, perf: Performance, p: SynthParams, reg: Register, sr: number, n: number): Float64Array {
  const x = synthPhrases(perf, p, sr, n);
  if (p.source === 'voice') applyVowel(x, p.vowel, reg, sr);
  const pk = peakAbs(x);
  if (pk > 0) for (let i = 0; i < n; i++) x[i] *= VOICE_PEAK / pk;
  if (p.articulation === 'ta') {
    const bursts = perf.phrases.map((ph) => ({ start: ph.start - 0.012, end: ph.start + 0.002 }));
    addNoiseBursts(x, bursts, 0.12 * VOICE_PEAK, 4000, 0.7, streamOf(v, `burst-h${v.level}`), sr);
  }
  if (p.breathDb !== null) addNoiseBursts(x, perf.breaths, 10 ** (p.breathDb / 20) * VOICE_PEAK, 1800, 0.8, streamOf(v, `breathnoise-h${v.level}`), sr);
  return x;
}

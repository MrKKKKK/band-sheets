import { describe, expect, it } from 'vitest';
import { midiToHz, perform } from './contour';
import { allHumVariants, humScore, synthParams } from './variants';
import { biquad, peakingCoefs, synthPhrases, synthVoice, VOICE_PEAK } from './voice';

const SR = 22050;
const find = (name: string) => allHumVariants().find((v) => v.name === name)!;

/** |X(f)| of x[a..b) (Goertzel, Hann window). */
function mag(x: ArrayLike<number>, f: number, a: number, b: number): number {
  const w = (2 * Math.PI * f) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a));
    const s = x[i] * h + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2);
}

function steady(fundamentalDb: number) {
  const v = find('syn-h1-etude-s2');
  const score = humScore(v);
  const p = { ...synthParams(v), vibrato: false, glide: false, scoopProb: 0, fundamentalDb };
  const perf = perform(v, score, p);
  const n = perf.sung[0];
  const x = synthPhrases(perf, p, SR, Math.round((perf.durationSec + 1) * SR));
  const a = Math.round((n.start + 0.3) * SR);
  return { x, f0: midiToHz(n.target), a, b: a + 8192, perf, p, v, score };
}

describe('synthPhrases', () => {
  it('is silent outside phrases', () => {
    const { x, perf } = steady(0);
    const first = Math.floor(perf.phrases[0].start * SR) - 1;
    for (let i = 0; i < first; i++) expect(x[i]).toBe(0);
  });
  it('a weak fundamental lowers harmonic 1 against harmonic 2 by the set amount', () => {
    const full = steady(0);
    const weak = steady(-20);
    const r = (s: ReturnType<typeof steady>) => mag(s.x, s.f0, s.a, s.b) / mag(s.x, 2 * s.f0, s.a, s.b);
    expect(20 * Math.log10(r(weak) / r(full))).toBeCloseTo(-20, 0);
  });
});

describe('formants', () => {
  it('a peaking biquad boosts its centre frequency by its gain', () => {
    const x = new Float64Array(SR).map((_, i) => Math.sin((2 * Math.PI * 750 * i) / SR));
    biquad(x, peakingCoefs(750, 12, 5, SR));
    expect(20 * Math.log10(mag(x, 750, SR / 2, SR) / mag(new Float64Array(SR).map((_, i) => Math.sin((2 * Math.PI * 750 * i) / SR)), 750, SR / 2, SR))).toBeCloseTo(12, 1);
  });
});

describe('synthVoice', () => {
  it('scales the voice to VOICE_PEAK and is deterministic', () => {
    const v = find('syn-h2-kirakira-s3');
    const score = humScore(v);
    const p = synthParams(v);
    const perf = perform(v, score, p);
    const n = Math.round((perf.durationSec + 1) * SR);
    const a = synthVoice(v, perf, p, score.register, SR, n);
    const b = synthVoice(v, perf, p, score.register, SR, n);
    expect(a).toEqual(b);
    let pk = 0;
    for (const s of a) pk = Math.max(pk, Math.abs(s));
    expect(pk).toBeGreaterThanOrEqual(VOICE_PEAK - 1e-9);
    expect(pk).toBeLessThan(VOICE_PEAK * 1.3); // breath may add a little
  });
});

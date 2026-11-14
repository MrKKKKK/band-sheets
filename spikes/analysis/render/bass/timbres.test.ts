import { describe, expect, it } from 'vitest';
import { getTimbre, SAMPLE_RATE, timbreAvailable, type TimbreId } from './timbres';

/**
 * f0 check of a voice against MIDI `m` (BASS_SAMPLES.md: Growlybass is mapped an octave up, so this catches a wrong
 * key offset): the sustain is periodic at the expected period P (YIN cumulative-mean-normalized difference < 0.3 at a
 * lag within 3 % of P; refined lag gives the cents), and the fundamental is present (DFT at f0 no more than 30 dB below
 * the strongest of the first 6 harmonics: an octave-up sound has no energy at f0). A pizzicato E3 has its 2nd
 * harmonic 18 dB above the fundamental, so "the strongest partial" alone would not do.
 */
function f0Check(x: Float32Array, from: number, m: number) {
  const sr = SAMPLE_RATE;
  const want = 440 * 2 ** ((m - 69) / 12);
  const P = sr / want;
  const W = Math.round(0.4 * sr);
  const maxLag = Math.ceil(P * 1.03) + 2;
  const d = new Float64Array(maxLag + 1);
  let run = 0;
  const cmnd = new Float64Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const e = x[from + i] - x[from + i + tau];
      s += e * e;
    }
    d[tau] = s;
    run += s;
    cmnd[tau] = (s * tau) / run;
  }
  let best = Math.floor(P * 0.97);
  for (let t = best; t <= Math.ceil(P * 1.03); t++) if (cmnd[t] < cmnd[best]) best = t;
  const [a, b, c] = [d[best - 1], d[best], d[best + 1]];
  const lag = best + (a - c) / (2 * (a - 2 * b + c));
  const dft = (hz: number) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < W; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);
      const ph = (2 * Math.PI * hz * i) / sr;
      re += x[from + i] * w * Math.cos(ph);
      im += x[from + i] * w * Math.sin(ph);
    }
    return Math.hypot(re, im);
  };
  const f = sr / lag;
  const harm = [1, 2, 3, 4, 5, 6].map((k) => dft(k * f));
  return { cmnd: cmnd[best], cents: 1200 * Math.log2(f / want), fundDb: 20 * Math.log10(harm[0] / Math.max(...harm)) };
}

describe('bass timbres: pitch', { timeout: 120_000 }, () => {
  for (const id of ['A', 'B', 'C'] as TimbreId[]) {
    it.skipIf(!timbreAvailable(id))(`timbre ${id}: f0 of E1, A1, E2, A2, E3, G3 is the MIDI note (not an octave off)`, () => {
      const t = getTimbre(id);
      for (const m of [28, 33, 40, 45, 52, 55])
        for (const vel of [50, 100]) {
          const v = t.voice(m, vel, 0);
          const r = f0Check(v.x, v.onset + Math.round(0.3 * SAMPLE_RATE), m);
          expect(r.cmnd, `${id} ${m} v${vel} periodic at P`).toBeLessThan(0.3);
          expect(Math.abs(r.cents), `${id} ${m} v${vel} cents`).toBeLessThan(40);
          expect(r.fundDb, `${id} ${m} v${vel} fundamental present`).toBeGreaterThan(-30);
        }
    });
  }

  it.skipIf(!timbreAvailable('B'))('the check rejects an octave error (B voice of E2 tested as E1 and as E3)', () => {
    const v = getTimbre('B').voice(40, 100, 0);
    const from = v.onset + Math.round(0.3 * SAMPLE_RATE);
    const up = f0Check(v.x, from, 52); // expecting an octave higher than it sounds: no period at P/2
    expect(up.cmnd < 0.3 && up.fundDb > -30 && Math.abs(up.cents) < 40).toBe(false);
    const down = f0Check(v.x, from, 28); // expecting an octave lower: no energy at f0/2
    expect(down.cmnd < 0.3 && down.fundDb > -30 && Math.abs(down.cents) < 40).toBe(false);
  });
});

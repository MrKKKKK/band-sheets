import { describe, expect, it } from 'vitest';
import {
  beatTrackFrames,
  candidates,
  chooseOctave,
  convolveSame,
  estimateTempo,
  fit,
  hanningSym,
  localmax,
  median,
  prior,
  stdDdof1F32,
  tempoFrequencies,
  trackBeats,
} from './beats';

const SR = 22050;
const HOP = 512;

/** Clicks (decaying 2 kHz bursts) every `period` samples from `start`, plus a crude onset envelope. */
function clickTrack(bpm: number, seconds: number, start = 0.25 * SR) {
  const n = Math.round(seconds * SR);
  const y = new Float32Array(n);
  const period = (60 / bpm) * SR;
  const onsets: number[] = [];
  for (let c = start; c + 400 < n; c += period) {
    const s = Math.round(c);
    onsets.push(s);
    for (let i = 0; i < 400; i++) y[s + i] = Math.exp(-i / 60) * Math.sin((2 * Math.PI * 2000 * i) / SR);
  }
  // onset envelope: positive log-energy rise of centred 2048-sample frames (stand-in for onset_strength)
  const frames = 1 + Math.floor(n / HOP);
  const logE = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * HOP - 1024; i < f * HOP + 1024; i++) if (i >= 0 && i < n) e += y[i] * y[i];
    logE[f] = Math.log10(e + 1e-10);
  }
  const env = new Float32Array(frames);
  for (let f = 1; f < frames; f++) env[f] = Math.max(0, logE[f] - logE[f - 1]);
  return { y, env, onsets: onsets.map((s) => s / SR) };
}

describe('numpy / librosa helpers', () => {
  it('localmax: never index 0, the end when above its left neighbour, flat peaks at the left edge', () => {
    expect(Array.from(localmax([3, 1, 2, 2, 1, 5]))).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it('convolveSame matches np.convolve(mode="same")', () => {
    expect(Array.from(convolveSame([0, 1, 2, 3, 4, 5], [1, 2, 3]))).toEqual([1, 4, 10, 16, 22, 22]);
  });

  it('hanningSym is np.hanning (symmetric, zero ends)', () => {
    const w = hanningSym(5);
    expect(Array.from(w).map((v) => +v.toFixed(12))).toEqual([0, 0.5, 1, 0.5, 0]);
  });

  it('float32 std is close to the float64 one', () => {
    const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 3);
    let m = 0;
    for (const v of x) m += v;
    m /= x.length;
    let s = 0;
    for (const v of x) s += (v - m) ** 2;
    expect(stdDdof1F32(x)).toBeCloseTo(Math.sqrt(s / (x.length - 1)), 5);
  });

  it('median averages the two middle values', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
  });

  it('tempoFrequencies is 60 sr / (hop k)', () => {
    const b = tempoFrequencies(344);
    expect(b[0]).toBe(Infinity);
    expect(b[22]).toBeCloseTo(117.45, 2);
  });
});

describe('Ellis DP', () => {
  it('drops beats in leading / trailing silence (localscore <= 0) even with trim=False', () => {
    const { env } = clickTrack(120, 20);
    const padded = new Float32Array(env.length + 400);
    padded.set(env, 200);
    const frames = beatTrackFrames(padded, tempoFrequencies(344)[22]);
    expect(frames.length).toBeGreaterThan(30);
    expect(frames[0]).toBeGreaterThan(200 - 22);
    expect(frames[frames.length - 1]).toBeLessThan(200 + env.length + 22);
  });

  it('returns nothing for an all-zero envelope', () => {
    expect(beatTrackFrames(new Float32Array(100), 120).length).toBe(0);
  });
});

describe('tempo rule', () => {
  const times = Float64Array.from({ length: 16 }, (_, i) => 0.5 + i * 0.5);

  it('candidates: T, 2T, both T/2 phases', () => {
    const c = candidates(times);
    expect(c.map(([n]) => n)).toEqual(['T', '2T', 'T/2a', 'T/2b']);
    expect(c[1][1].length).toBe(31);
    expect(c[2][1][1]).toBe(1.5);
    expect(c[3][1][0]).toBe(1.0);
  });

  it('prior is flat in 70..150 and decays by exp(-2) per octave outside', () => {
    expect(prior(100)).toBe(1);
    expect(prior(35)).toBeCloseTo(Math.exp(-2), 12);
    expect(prior(300)).toBeCloseTo(Math.exp(-2), 12);
  });

  it('keeps T when the events sit on the grid, takes T/2 when T is far too fast', () => {
    expect(fit(times, times)).toBe(1);
    expect(chooseOctave(times, 120, times).chosen).toBe('T');
    const fast = Float64Array.from({ length: 64 }, (_, i) => i * 0.2); // 300 BPM
    const ev = Float64Array.from({ length: 32 }, (_, i) => i * 0.4); // 150 BPM pulse
    expect(chooseOctave(fast, 300, ev).chosen).toBe('T/2a');
  });
});

describe('synthetic 120 BPM click', () => {
  it('tracks 120 BPM', () => {
    const { y, env, onsets } = clickTrack(120, 30);
    const est = estimateTempo(env);
    expect([21, 22]).toContain(est.bin); // 120 BPM = 21.5 frames per beat, between two bins
    const grid = trackBeats({ onsetEnv: env, yPerc: y }, () => onsets);
    expect(grid.tempo).toBeCloseTo(120, 6);
    expect(grid.times.length).toBeGreaterThanOrEqual(onsets.length - 2);
    // every beat sits on a click (within 10 ms)
    for (const t of grid.times) expect(Math.min(...onsets.map((o) => Math.abs(o - t)))).toBeLessThan(0.01);
  });
});

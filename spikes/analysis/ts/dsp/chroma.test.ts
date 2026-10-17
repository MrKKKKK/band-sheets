import { describe, expect, it } from 'vitest';
import {
  aggregate,
  chordColumns,
  columns,
  columnTimes,
  cqToChromaMap,
  frameChroma,
  lastBeatEnd,
  SCALE,
  timeToFrames,
} from './chroma';
import { MemTracker } from './core/mem';

const SR = 22050;

describe('cq_to_chroma', () => {
  it('pitch class c = bins {3c - 1, 3c, 3c + 1} (mod 36), C first for fmin 32.7', () => {
    const m = cqToChromaMap(216, 36, 32.7);
    expect(m[0]).toBe(0);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(1);
    expect(m[35]).toBe(0);
    expect(m[34]).toBe(11);
    expect(m[36 + 35]).toBe(0);
    expect(m[3 * 9]).toBe(9);
    // fmin at A (MIDI 9 mod 12) rolls the rows by 9
    expect(cqToChromaMap(36, 36, 55)[0]).toBe(9);
  });
});

describe('columns helpers (py/dsp/chroma.py)', () => {
  it('timeToFrames = floor(int(t * sr) / hop)', () => {
    expect(timeToFrames(0, SR, 512)).toBe(0);
    expect(timeToFrames(512 / SR, SR, 512)).toBe(1);
    expect(timeToFrames(1.0, SR, 512)).toBe(43);
    expect(timeToFrames(-0.001, SR, 512)).toBe(-1);
  });

  it('lastBeatEnd: last beat + median interval, capped at the audio end', () => {
    expect(lastBeatEnd([1, 2, 3.5], 10)).toBe(4.75);
    expect(lastBeatEnd([1, 2, 3.5], 4)).toBe(4);
    expect(lastBeatEnd([3], 2)).toBe(3);
    expect(lastBeatEnd([], 7)).toBe(7);
  });

  it('columnTimes per_beat 2: half-beat midpoints, the last one up to lastBeatEnd', () => {
    expect(Array.from(columnTimes([1, 2, 3.5], 10, 2))).toEqual([1, 1.5, 2, 2.75, 3.5, 4.125]);
    expect(Array.from(columnTimes([1, 2], 10, 1))).toEqual([1, 2]);
  });

  it('aggregate: median of [a, b) (mean of the middle two), at least one frame, clipped', () => {
    const nF = 5;
    const frames = new Float64Array(12 * nF);
    for (let t = 0; t < nF; t++) frames[t] = [1, 4, 2, 8, 16][t];
    const out = aggregate(frames, nF, [0, 3, 3, 9]);
    expect(out[0]).toBe(2); // median(1, 4, 2)
    expect(out[1]).toBe(8); // empty -> frame 3 only
    expect(out[2]).toBe(12); // frames 3..4 -> (8 + 16) / 2
    const mean = aggregate(frames, nF, [0, 2], 'mean');
    expect(mean[0]).toBe(2.5);
  });

  it('columns: beat bounds, on-beat chord columns start where the beats do', () => {
    const nF = 400;
    const full = new Float64Array(12 * nF).fill(0.5);
    const bass = new Float64Array(12 * nF).fill(0.25);
    const times = [0.5, 1.0, 1.5, 2.0];
    const c = columns(full, bass, nF, times, 3.0, 2);
    expect(Array.from(c.bounds)).toEqual([21, 43, 64, 86, 107]);
    expect(c.cBounds.length).toBe(9);
    expect(c.cBounds[0]).toBe(21);
    expect(c.cBounds[2]).toBe(43);
    expect(c.cBounds[1]).toBe(timeToFrames(0.75, SR, 512));
    expect(c.chroma.length).toBe(12 * 4);
    expect(c.cChroma.length).toBe(12 * 8);
    expect(c.bass[0]).toBe(0.25);
    const one = columns(full, bass, nF, times, 3.0, 1);
    expect(one.cChroma).toBe(one.chroma);
    const empty = columns(full, bass, nF, [], 3.0, 2);
    expect(empty.chroma.length).toBe(0);
    expect(Array.from(empty.bounds)).toEqual([0]);
  });
});

/**
 * Python reference (out/t6/sine_ref.py, librosa 0.11.0 through py/dsp/chroma._frame_chroma): 5 s of
 * a unit-amplitude sine, median over frames 20..F-20 of the column sum, full and bass chroma, and the
 * estimated tuning.
 */
const SINE_REF: { name: string; f: number; tuning: number; full: number; bass: number }[] = [
  { name: 'C2', f: 65.40639132514966, tuning: 0.0, full: 1.6758740094199311, bass: 1.6755072738451418 },
  { name: 'C3', f: 130.8127826502993, tuning: 0.0, full: 1.1852473034639845, bass: 1.184717698622262 },
  { name: 'C4', f: 261.6255653005986, tuning: -0.12, full: 0.8526685620541685, bass: 0.17906223641039107 },
  { name: 'C5', f: 523.2511306011972, tuning: 0.04, full: 0.588521165572456, bass: 0.00016205311876547058 },
  { name: 'C6', f: 1046.5022612023945, tuning: -0.03, full: 0.4232390582736116, bass: 3.998474596755841e-6 },
  { name: 'C7', f: 2093.004522404789, tuning: -0.02, full: 0.0727295045981009, bass: 2.148237763321959e-6 },
  { name: 'A2', f: 110.0, tuning: 0.0, full: 1.29793311849935, bass: 1.297484105959302 },
  { name: 'E4', f: 329.6275569128699, tuning: 0.07, full: 0.7446600866445807, bass: 0.00020327124257164545 },
  { name: 'G5', f: 783.9908719634985, tuning: 0.02, full: 0.4824544055605656, bass: 1.8681942179910038e-6 },
];

const SILENT = 0.002; // no_chord_energy / 10 (plan section 4)

function medianColumnSum(m: Float64Array, F: number): number {
  const s: number[] = [];
  for (let t = 20; t < F - 20; t++) {
    let x = 0;
    for (let c = 0; c < 12; c++) x += m[c * F + t];
    s.push(x);
  }
  s.sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

describe('frameChroma: unit sines vs librosa (T6 done-condition: +-3 %)', () => {
  it.each(SINE_REF)('$name', ({ f, tuning, full, bass }) => {
    const n = SR * 5;
    const y = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR));
    const fc = frameChroma(y);
    expect(fc.frames).toBe(216);
    expect(fc.tuningFull).toBeCloseTo(tuning, 9);
    const fs = medianColumnSum(fc.full, fc.frames);
    const bs = medianColumnSum(fc.bass, fc.frames);
    expect(Math.abs(fs / full - 1)).toBeLessThan(0.03);
    // Bass of high notes is decimation-filter stopband leakage (1e-6 .. 2e-4): only "silent on both
    // sides" is meaningful there.
    if (bass >= SILENT) expect(Math.abs(bs / bass - 1)).toBeLessThan(0.03);
    else expect(bs).toBeLessThan(SILENT);
  });

  it('SCALE is 1/80', () => {
    expect(SCALE).toBe(1 / 80);
  });
});

describe('chordColumns', () => {
  it('runs end to end with injected tuning and counts memory', () => {
    const n = SR * 4;
    const y = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR));
    const mem = new MemTracker();
    mem.adopt(y);
    const cc = chordColumns(y, [0.5, 1, 1.5, 2, 2.5], n / SR, { tuningFull: 0, tuningBass: 0 }, mem);
    expect(cc.perBeat).toBe(2);
    expect(cc.cChroma.length).toBe(12 * 10);
    // A3 (pitch class 9) dominates every column
    for (let i = 0; i < 10; i++) {
      let best = 0;
      for (let c = 1; c < 12; c++) if (cc.cChroma[c * 10 + i] > cc.cChroma[best * 10 + i]) best = c;
      expect(best).toBe(9);
    }
    expect(mem.peak).toBeGreaterThan(y.byteLength);
    expect(mem.peak).toBeLessThan(3 * y.byteLength);
  });
});

/**
 * Full (6-octave) and bass (3-octave) CQTs are each trimmed to the minimum frame count over their own
 * octaves, so the bass can have one frame more. Python (out/t6/framecount_ref.py, chroma.chord_columns
 * with the default config) keeps both counts: bounds come from the full count, bass columns are
 * aggregated over the bass count. Signal: 0.3 x (220 + 277.18 + 82.41 Hz) sines; beats every 0.5 s
 * from 0.5 s to duration - 0.3 s plus one at duration - 0.005 s. Values = column sums of the last two
 * columns.
 */
const FRAMECOUNT_REF = [
  { n: 1323000, full: 2584, bass: 2585, nTimes: 120, boundsTail: [2562, 2583, 2583], cBoundsTail: [2583, 2583, 2583], bassLast: [0.7680725317448378, 1.2831795871257783], colLast: [1.64267158806324, 1.64267158806324] },
  { n: 66151, full: 130, bass: 130, nTimes: 6, boundsTail: [107, 128, 129], cBoundsTail: [128, 129, 129], bassLast: [0.7685446314513683, 1.2442098319530488], colLast: [1.5552225470542909, 1.5203959703445435] },
  { n: 66545, full: 130, bass: 131, nTimes: 6, boundsTail: [107, 129, 129], cBoundsTail: [129, 129, 129], bassLast: [0.7738617146387697, 1.2204404890537264], colLast: [1.589722126722336, 1.589722126722336] },
  { n: 70142, full: 137, bass: 138, nTimes: 6, boundsTail: [107, 136, 136], cBoundsTail: [136, 136, 136], bassLast: [0.7451271576806904, 1.285138574242592], colLast: [1.665668570995331, 1.665668570995331] },
  { n: 66152, full: 130, bass: 130, nTimes: 6, boundsTail: [107, 128, 129], cBoundsTail: [128, 129, 129], bassLast: [0.764364430680871, 1.2360887587070466], colLast: [1.5551304519176485, 1.520873272418976] },
];

function colSum(m: Float64Array, cols: number, c: number): number {
  let s = 0;
  for (let r = 0; r < 12; r++) s += m[r * cols + c];
  return s;
}

describe('full / bass frame counts may differ (matches Python)', () => {
  it.each(FRAMECOUNT_REF)('n = $n: full $full, bass $bass', (ref) => {
    const n = ref.n;
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y[i] = 0.3 * Math.sin(2 * Math.PI * 220.0 * t) + 0.3 * Math.sin(2 * Math.PI * 277.1826309768721 * t) + 0.3 * Math.sin(2 * Math.PI * 82.40688922821748 * t);
    }
    const dur = n / SR;
    const k = Math.ceil((dur - 0.3 - 0.5) / 0.5);
    const times = Array.from({ length: k }, (_, i) => 0.5 + i * 0.5);
    times.push(dur - 0.005);
    expect(times.length).toBe(ref.nTimes);
    const cc = chordColumns(y, times, dur);
    expect(cc.frames.frames).toBe(ref.full);
    expect(cc.frames.bassFrames).toBe(ref.bass);
    expect(Array.from(cc.bounds.slice(-3))).toEqual(ref.boundsTail);
    expect(Array.from(cc.cBounds.slice(-3))).toEqual(ref.cBoundsTail);
    const nb = times.length;
    const nc = cc.cBounds.length - 1;
    const errs: number[][] = [];
    for (let j = 0; j < 2; j++) {
      const db = colSum(cc.bass, nb, nb - 2 + j) / ref.bassLast[j] - 1;
      const dc = colSum(cc.cChroma, nc, nc - 2 + j) / ref.colLast[j] - 1;
      errs.push([db, dc]);
    }
    // Chord columns (full CQT) within 0.5 %. The bass columns here are 1-2 frames at the very end of
    // an abruptly cut sine, where the 16:1 decimation's end-of-signal handling differs (soxr vs our
    // zero-padded half-band cascade): measured up to 0.93 % (n 66545), so 1.5 % here. This is an
    // edge effect of the decimator, not of the frame-count logic (counts / bounds above are exact);
    // on the song dumps the plan's 0.5 % holds (chroma.parity.test.ts).
    for (const [db, dc] of errs) {
      expect(Math.abs(dc)).toBeLessThan(0.005);
      expect(Math.abs(db)).toBeLessThan(0.015);
    }
  }, 60_000);

  it('bass columns are aggregated over the bass frame count (a column starting at the full end)', () => {
    const nF = 10;
    const full = new Float64Array(12 * nF).fill(1);
    const bass = new Float64Array(12 * (nF + 1));
    for (let t = 0; t <= nF; t++) bass[t * 1] = t; // pitch class 0 = frame index
    // bounds [5, 10, 10]: column 1 starts at the full end -> full uses frame 9, bass frame 10
    const c = columns(full, bass, nF, [5 * 512 / SR, 100], 1000, 1, 'median', SR, 512, nF + 1);
    expect(Array.from(c.bounds)).toEqual([5, 10, 10]);
    expect(c.bass[1]).toBe(10);
    expect(c.chroma[1]).toBe(1);
    const same = columns(full, bass, nF, [5 * 512 / SR, 100], 1000, 1, 'median', SR, 512);
    expect(same.bass[1]).toBe(9);
  });
});

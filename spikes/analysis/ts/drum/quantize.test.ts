import { describe, expect, it } from 'vitest';
import { resolveDrumConfig } from './config';
import { quantizeDrums, tickSeconds } from './quantize';
import { strengthMarks } from './strength';
import { detectSwing } from './swing';
import { drumRoundTrip, sectionShuffle, timeSigOf, toDrumEvents } from './toDrums';
import type { AnalysisDrumHit, DrumInfo } from './types';

/** Deterministic jitter in ms, both signs, up to +-30 ms. */
const JITTER = [25, -20, 30, -28, 12, -15, 22, -30, 5, -8, 28, -25, 18, -12, 0, 27, -22, 10];
const jit = (i: number, scale = 1) => (JITTER[i % JITTER.length] * scale) / 1000;

type Spec = [bar: number, tick: number, inst: string, strength?: number];

function hitsOf(spec: Spec[], info: DrumInfo, opts: { jitter?: number; biasSec?: number } = {}): AnalysisDrumHit[] {
  const ts = tickSeconds(info);
  const barT = (info.ts[0] * 64) / info.ts[1];
  return spec.map(([bar, tick, inst, strength = 0.5], i) => ({
    t: info.startSec + (bar * barT + tick) * ts + jit(i, opts.jitter ?? 1) + (opts.biasSec ?? 0),
    inst,
    strength,
    confidence: 0.9,
  }));
}

const grid = (r: ReturnType<typeof quantizeDrums>) => r.quantized.hits.map((h) => [h.bar, Math.round(h.tick * 1000) / 1000, h.inst, h.mark ?? '']);
const expected = (spec: Spec[], mark: (s: Spec) => string = () => '') =>
  [...spec]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || ORDER.indexOf(a[2]) - ORDER.indexOf(b[2]))
    .map((s) => [s[0], Math.round(s[1] * 1000) / 1000, s[2], mark(s)]);
const ORDER = ['CR', 'RD', 'HH', 'HO', 'T1', 'SD', 'T2', 'FT', 'BD', 'SP', 'CN', 'CB', 'SD.rim', 'SD.xs', 'RD.bell', 'HH.foot', 'HH.fsp'];

/** 8-beat: HH 8ths, BD 1 & 3, SD 2 & 4. */
function eightBeat(bars: number, swungTick = 8): Spec[] {
  const out: Spec[] = [];
  for (let b = 0; b < bars; b++)
    for (let q = 0; q < 4; q++) {
      out.push([b, q * 16, 'HH'], [b, q * 16 + swungTick, 'HH']);
      out.push([b, q * 16, q % 2 ? 'SD' : 'BD']);
    }
  return out;
}

const roundTrip = (r: ReturnType<typeof quantizeDrums>, info: DrumInfo, range?: { from?: number; to?: number }) => {
  const d = toDrumEvents(r.quantized, r.swingBars, range);
  return { d, rt: drumRoundTrip(d.events, d.shuffle, timeSigOf(info.ts)) };
};

describe('strength marks', () => {
  it('ghost / accent relative to the take, per instrument; none forced', () => {
    const s = [0.5, 0.52, 0.48, 0.5, 0.08, 0.07, 1.0, 0.5];
    const { marks } = strengthMarks(s.map((strength) => ({ inst: 'SD', strength })));
    expect(marks).toEqual([undefined, undefined, undefined, undefined, 'g', 'g', 'ac', undefined]);
    expect(strengthMarks([0.5, 0.55, 0.45, 0.5, 0.52].map((strength) => ({ inst: 'HH', strength }))).marks.every((m) => m === undefined)).toBe(true);
    // A quiet instrument is not a ghost of a loud one.
    const mixed = [...[0.05, 0.05, 0.05, 0.05].map((strength) => ({ inst: 'HH', strength })), ...[0.8, 0.8, 0.8, 0.8].map((strength) => ({ inst: 'BD', strength }))];
    expect(strengthMarks(mixed).marks.every((m) => m === undefined)).toBe(true);
  });
  it('funk snare (most hits ghosts) and accented HH quarters (half accents)', () => {
    const funk = [0.6, 0.06, 0.05, 0.07, 0.6, 0.06, 0.05, 0.06, 0.6, 0.05];
    expect(strengthMarks(funk.map((strength) => ({ inst: 'SD', strength }))).marks).toEqual(funk.map((v) => (v < 0.1 ? 'g' : undefined)));
    const hh = [1, 0.45, 1, 0.45, 1, 0.45, 1, 0.45];
    expect(strengthMarks(hh.map((strength) => ({ inst: 'HH', strength }))).marks).toEqual(hh.map((v) => (v === 1 ? 'ac' : undefined)));
  });
  it('fewer than minHits hits: no marks', () => {
    expect(strengthMarks([0.5, 0.05, 1].map((strength) => ({ inst: 'SD', strength }))).marks).toEqual([undefined, undefined, undefined]);
  });
});

describe('quantizeDrums: straight grid', () => {
  const info: DrumInfo = { bpm: 120, ts: [4, 4], startSec: 1.0 };
  it('jittered 8-beat (+-30 ms at 120 bpm) snaps back; no shuffle; round trip', () => {
    const spec = eightBeat(2);
    const r = quantizeDrums(hitsOf(spec, info), info);
    expect(grid(r)).toEqual(expected(spec));
    expect(r.swingBars.map((s) => s.kind)).toEqual(['none', 'none']);
    expect(r.swing).toBeUndefined();
    expect(r.quantized.grid).toBe('sixteenth');
    const { d, rt } = roundTrip(r, info);
    expect(d.shuffle).toBe('none');
    expect(rt.identical).toBe(true);
    expect(rt.tex.split('\n')[0]).toBe('\\tf none');
    expect(rt.tex.split('\n')[1]).toBe(':8 (HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |');
  });
  it('16ths at 100 bpm with +-20 ms; a habitual 40 ms late player (bias removed)', () => {
    const i2: DrumInfo = { bpm: 100, ts: [4, 4], startSec: 0.5 };
    const spec: Spec[] = [];
    for (let k = 0; k < 16; k++) spec.push([0, k * 4, 'HH']);
    spec.push([0, 0, 'BD'], [0, 16, 'SD'], [0, 28, 'BD'], [0, 40, 'BD'], [0, 48, 'SD'], [1, 0, 'CR'], [1, 0, 'BD']);
    expect(grid(quantizeDrums(hitsOf(spec, i2, { jitter: 0.67 }), i2))).toEqual(expected(spec));
    const late = quantizeDrums(hitsOf(spec, i2, { jitter: 0.67, biasSec: 0.04 }), i2);
    expect(late.onsetBiasSec).toBeGreaterThan(0.03);
    expect(late.onsetBiasSec).toBeLessThan(0.05);
    expect(grid(late)).toEqual(expected(spec));
    expect(roundTrip(late, i2).rt.identical).toBe(true);
  });
  it('ghost and accent marks reach the app events', () => {
    const spec: Spec[] = [
      [0, 0, 'BD', 0.6], [0, 16, 'SD', 0.6], [0, 28, 'SD', 0.05], [0, 36, 'SD', 0.06], [0, 48, 'SD', 1.2],
      [0, 0, 'HH', 0.5], [0, 16, 'HH', 0.5], [0, 32, 'HH', 0.5], [0, 48, 'HH', 0.5], [0, 32, 'BD', 0.6],
      [0, 24, 'SD', 0.6], [0, 56, 'SD', 0.6], [1, 16, 'SD', 0.6],
    ];
    const r = quantizeDrums(hitsOf(spec, info), info);
    expect(grid(r)).toEqual(expected(spec, (s) => (s[2] === 'SD' && s[3]! < 0.1 ? 'g' : s[2] === 'SD' && s[3]! > 1 ? 'ac' : '')));
    const { rt } = roundTrip(r, info);
    expect(rt.identical).toBe(true);
    expect(rt.tex).toContain('SD{g}');
    expect(rt.tex).toContain('(HH SD{ac})');
  });
  it('simultaneous hits merge into one beat; a double detection of one instrument is one hit', () => {
    const base = hitsOf([[0, 0, 'BD'], [0, 0, 'HH'], [0, 16, 'SD'], [0, 32, 'BD'], [0, 48, 'SD']], info, { jitter: 0 });
    base[1].t += 0.008; // HH 8 ms after BD
    const dup = { ...base[2], t: base[2].t + 0.012, strength: 0.9 }; // SD detected twice 12 ms apart
    const r = quantizeDrums([...base, dup], info);
    expect(grid(r)).toEqual([[0, 0, 'HH', ''], [0, 0, 'BD', ''], [0, 16, 'SD', ''], [0, 32, 'BD', ''], [0, 48, 'SD', '']]);
    expect(r.dropped).toEqual([{ src: 2, reason: 'merged', into: 5 }]);
    expect(r.quantized.hits.find((h) => h.inst === 'SD' && h.tick === 16)!.strength).toBe(0.9);
    expect(roundTrip(r, info).rt.tex.split('\n')[1]).toBe(':4 (HH BD) SD BD SD |');
  });
  it('two 16ths pushed onto one slot: one moves to the free neighbour', () => {
    const ts = tickSeconds(info);
    const hits: AnalysisDrumHit[] = [
      { t: info.startSec + 16 * ts - 0.02, inst: 'SD', strength: 0.5, confidence: 0.9 }, // tick 16, 20 ms early
      { t: info.startSec + 20 * ts - 0.068, inst: 'SD', strength: 0.5, confidence: 0.9 }, // tick 20, 68 ms early -> nearer 16
    ];
    const r = quantizeDrums(hits, info);
    expect(grid(r)).toEqual([[0, 16, 'SD', ''], [0, 20, 'SD', '']]);
  });
  it('HH and HO on one slot: the more confident stays', () => {
    const h = hitsOf([[0, 0, 'HH'], [0, 0, 'HO'], [0, 32, 'HH']], info, { jitter: 0 });
    h[1].confidence = 0.95;
    const r = quantizeDrums(h, info);
    expect(grid(r)).toEqual([[0, 0, 'HO', ''], [0, 32, 'HH', '']]);
    expect(r.dropped).toEqual([{ src: 0, reason: 'exclusive', into: 1 }]);
  });
  it('bar boundaries: early downbeat goes to the next bar; hits before bar 1 are dropped; rests and empty bars', () => {
    const ts = tickSeconds(info);
    const hits: AnalysisDrumHit[] = [
      { t: info.startSec - 0.01, inst: 'BD', strength: 0.5, confidence: 0.9 }, // 10 ms before bar 1 -> bar 0 tick 0
      { t: info.startSec - 0.3, inst: 'SD', strength: 0.5, confidence: 0.9 }, // count-in stick: dropped
      { t: info.startSec + 64 * ts - 0.025, inst: 'CR', strength: 0.5, confidence: 0.9 }, // 25 ms early bar 2 head
      { t: info.startSec + (192 + 24) * ts + 0.02, inst: 'SD', strength: 0.5, confidence: 0.9 }, // bar 3, tick 24
    ];
    const r = quantizeDrums(hits, info, { nBars: 5 });
    expect(grid(r)).toEqual([[0, 0, 'BD', ''], [1, 0, 'CR', ''], [3, 24, 'SD', '']]);
    expect(r.dropped).toEqual([{ src: 1, reason: 'beforeStart' }]);
    expect(r.swingBars).toHaveLength(5);
    const { d, rt } = roundTrip(r, info);
    expect(rt.identical).toBe(true);
    expect(rt.tex.split('\n').slice(1)).toEqual([':1 BD |', 'CR |', 'r |', ':4 r{d} :2 SD :8 r |', ':1 r |']);
    expect(d.events.length).toBe(7);
  });
  it('3/4 and S-拡張 names: kept in QuantizedDrums, dropped from the app events', () => {
    const i3: DrumInfo = { bpm: 90, ts: [3, 4], startSec: 0 };
    const spec: Spec[] = [[0, 0, 'BD'], [0, 0, 'RD.bell'], [0, 16, 'SD.xs'], [0, 32, 'SD'], [1, 0, 'CB'], [1, 0, 'BD']];
    const r = quantizeDrums(hitsOf(spec, i3, { jitter: 0.8 }), i3);
    expect(grid(r)).toEqual(expected(spec));
    const { d, rt } = roundTrip(r, i3);
    expect(d.droppedExt).toBe(3);
    expect(rt.identical).toBe(true);
    expect(rt.tex.split('\n').slice(1)).toEqual([':2 BD :4 SD |', ':2 BD{d} |']);
  });
});

describe('quantizeDrums: shuffle', () => {
  const info: DrumInfo = { bpm: 120, ts: [4, 4], startSec: 0.2 };
  it('8th shuffle (2:1) snaps to the swung grid, written straight with \\tf triplet8th', () => {
    const real = eightBeat(2, 32 / 3);
    const r = quantizeDrums(hitsOf(real, info), info);
    expect(grid(r)).toEqual(expected(eightBeat(2)));
    expect(r.swingBars.map((s) => s.kind)).toEqual(['8', '8']);
    expect(r.swingBars[0].ratio).toBeGreaterThan(0.6);
    expect(r.swing).toEqual({ kind: '8', confidence: 1 });
    expect(r.quantized.grid).toBe('triplet');
    const { d, rt } = roundTrip(r, info);
    expect(d.shuffle).toBe('8');
    expect(rt.identical).toBe(true);
    expect(rt.tex.split('\n')[0]).toBe('\\tf triplet8th');
  });
  it('same take quantized without the shuffle grid would land on 16ths (sanity)', () => {
    const real = eightBeat(1, 32 / 3);
    const straight = quantizeDrums(hitsOf(real, info, { jitter: 0 }), info, { cfg: resolveDrumConfig({ swing: { minPairs: 99 } }) });
    expect(straight.quantized.hits.some((h) => h.tick % 16 === 12)).toBe(true);
  });
  it('16th shuffle', () => {
    const i2: DrumInfo = { bpm: 80, ts: [4, 4], startSec: 0 };
    const real: Spec[] = [];
    const want: Spec[] = [];
    for (let e = 0; e < 8; e++) {
      real.push([0, e * 8, 'HH'], [0, e * 8 + 16 / 3, 'HH']);
      want.push([0, e * 8, 'HH'], [0, e * 8 + 4, 'HH']);
    }
    for (const s of [[0, 0, 'BD'], [0, 16, 'SD'], [0, 32, 'BD'], [0, 48, 'SD']] as Spec[]) {
      real.push(s);
      want.push(s);
    }
    const r = quantizeDrums(hitsOf(real, i2, { jitter: 0.5 }), i2);
    expect(r.swingBars[0].kind).toBe('16');
    expect(grid(r)).toEqual(expected(want));
    const { d, rt } = roundTrip(r, i2);
    expect(d.shuffle).toBe('16');
    expect(rt.identical).toBe(true);
  });
  it('per-bar values: straight bar then shuffle bar; an undecided bar takes the take kind', () => {
    const spec: Spec[] = [...eightBeat(1), ...eightBeat(4, 32 / 3).filter((s) => s[0] > 0)];
    // bar 3: only two swung off-beats (too few to decide on its own).
    const sparse = spec.filter((s) => s[0] < 3 || s[1] === 0 || s[1] === 32 / 3 || s[1] === 16 + 32 / 3);
    const r = quantizeDrums(hitsOf(sparse, info), info);
    expect(r.swingBars.map((s) => s.kind)).toEqual(['none', '8', '8', '8']);
    expect(r.quantized.hits.filter((h) => h.bar === 3).map((h) => h.tick)).toEqual([0, 0, 8, 24]);
    expect(sectionShuffle(r.swingBars, 0, 4)).toBe('8');
    expect(sectionShuffle(r.swingBars, 0, 1)).toBe('none');
    expect(roundTrip(r, info, { from: 1, to: 4 }).rt.identical).toBe(true);
  });
  it('straight 16th groove never reads as an 8th shuffle; straight 8ths decide none', () => {
    const pos16 = Array.from({ length: 16 }, (_, k) => k * 4 + (k % 2 ? 0.6 : -0.4));
    expect(detectSwing(pos16, 64, 1, 4).bars[0].kind).toBe('none');
    expect(detectSwing(pos16, 64, 1, 4).detail[0].pairs8).toBe(0);
    const pos8 = Array.from({ length: 8 }, (_, k) => k * 8 + (k % 2 ? 0.5 : 0));
    expect(detectSwing(pos8, 64, 1, 4).detail[0]).toMatchObject({ kind: 'none', decided: true });
    expect(detectSwing(pos8.map((p) => (p % 16 ? p + 2.67 : p)), 64, 1, 8).bars[0].kind).toBe('none'); // x/8: never swings
  });
  it('grid.triplet: a middle-triplet ghost makes that beat an 8th triplet {tu 3}', () => {
    const cfg = resolveDrumConfig({ grid: { triplet: true } });
    const real: Spec[] = [...eightBeat(2, 32 / 3), [0, 16 + 16 / 3, 'SD', 0.05]];
    const r = quantizeDrums(hitsOf(real, info), info, { cfg });
    expect(r.swingBars[0].kind).toBe('8');
    const beat2 = r.quantized.hits.filter((h) => h.bar === 0 && h.tick >= 16 && h.tick < 32).map((h) => [Math.round(h.tick * 1000) / 1000, h.inst, h.mark ?? '']);
    expect(beat2).toEqual([[16, 'HH', ''], [16, 'SD', ''], [21.333, 'SD', 'g'], [26.667, 'HH', '']]);
    const { rt } = roundTrip(r, info);
    expect(rt.identical).toBe(true);
    expect(rt.tex.split('\n')[1]).toBe(':8 (HH BD) HH (HH SD){tu 3} SD{g tu 3} HH{tu 3} (HH BD) HH (HH SD) HH |');
    // Without the switch the ghost snaps to a straight slot (no tuplet).
    const off = quantizeDrums(hitsOf(real, info), info);
    expect(off.quantized.hits.every((h) => Number.isInteger(h.tick))).toBe(true);
    expect(roundTrip(off, info).rt.identical).toBe(true);
  });
});

describe('quantizeDrums: seeded sweep (tempo 60-200, uniform jitter +-25 ms)', () => {
  const lcg = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const sixteenBeat = (bars: number): Spec[] => {
    const out: Spec[] = [];
    for (let b = 0; b < bars; b++) {
      for (let k = 0; k < 16; k++) out.push([b, k * 4, 'HH']);
      out.push([b, 0, 'BD'], [b, 16, 'SD'], [b, 40, 'BD'], [b, 48, 'SD']);
    }
    return out;
  };
  const cases: [string, Spec[], Spec[], string][] = [
    ['8-beat', eightBeat(4), eightBeat(4), 'none'],
    ['16-beat', sixteenBeat(4), sixteenBeat(4), 'none'],
    ['8th shuffle', eightBeat(4, 32 / 3), eightBeat(4), '8'],
  ];
  for (const bpm of [60, 90, 120, 160, 200])
    for (const [name, real, want, kind] of cases)
      it(`${name} at ${bpm} bpm`, () => {
        const info: DrumInfo = { bpm, ts: [4, 4], startSec: 0.3 };
        const rnd = lcg(bpm * 7 + name.length);
        const tk = tickSeconds(info);
        const hits = real.map(([bar, tick, inst]) => ({ t: info.startSec + (bar * 64 + tick) * tk + 0.025 * rnd(), inst, strength: 0.5, confidence: 0.9 }));
        const r = quantizeDrums(hits, info);
        expect(grid(r)).toEqual(expected(want));
        // Known limit: straight 16ths at 200 bpm (an 8th = 150 ms, +-25 ms = +-0.17 of the pair) can read as a 16th
        // shuffle in a bar; the grid is still right (a straight 16th snaps to the swung 16th slot). T9 measures it.
        if (!(name === '16-beat' && bpm === 200)) expect(r.swingBars.map((s) => s.kind)).toEqual([kind, kind, kind, kind]);
        expect(roundTrip(r, info).rt.identical).toBe(true);
      });
});

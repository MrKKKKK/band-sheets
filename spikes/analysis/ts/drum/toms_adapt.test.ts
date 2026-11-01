// Spike 5 T11b: unit tests of the per-take tom adaptation (toms.ts tomFeatures / tomSeeds / ratioVote, classify.ts
// tomAdaptedBasis, s9Evidence bd / sd).
import { describe, expect, it } from 'vitest';
import { s9Evidence, tomAdaptedBasis, type TemplateGroup } from './classify';
import { DEFAULT_DRUM_CONFIG } from './config';
import { ratioVote, tomFeatures, tomSeeds, type TomFeatures } from './toms';
import type { DrumInst } from './types';

const toms = DEFAULT_DRUM_CONFIG.toms;
const sr = 44100;
const sine = (hz: number) => Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * hz * i) / sr) * Math.exp(-i / sr / 0.3));

describe('toms: tomFeatures', () => {
  it('a 150 Hz tone: pitch 150, a body, no sub, no high', () => {
    const f = tomFeatures(sine(150), sr, 0.1, toms);
    expect(Math.abs(f.pitch - 150)).toBeLessThan(3);
    expect(f.body).toBeGreaterThan(0.9);
    expect(f.sub).toBeLessThan(0.05);
    expect(f.high).toBeLessThan(0.05);
  });
  it('a 45 Hz tone is sub (a bass drum), a 5 kHz tone is high, an 800 Hz tone has no body (a cowbell)', () => {
    expect(tomFeatures(sine(45), sr, 0.1, toms).sub).toBeGreaterThan(0.9);
    expect(tomFeatures(sine(5000), sr, 0.1, toms).high).toBeGreaterThan(0.9);
    expect(tomFeatures(sine(800), sr, 0.1, toms).body).toBeLessThan(0.05);
  });
});

const tomF = (pitch: number): TomFeatures => ({ pitch, sub: 0, high: 0, body: 1 });
const sdOnly = { present: [false, true, false], share: [0, 0.9, 0] };
const none = { present: [false, false, false], share: [0, 0, 0] };

describe('toms: tomSeeds', () => {
  const sd = Array.from({ length: 4 }, () => tomF(200));
  it('seeds = tom-like onsets pitched below adaptPitchRatio x the take snare pitch (median of S-3 SD-only onsets)', () => {
    const f = [...sd, tomF(130), tomF(120), tomF(110), tomF(100), tomF(190)];
    const cls = [...sd.map(() => sdOnly), none, none, none, none, none];
    const r = tomSeeds(f, cls, toms);
    expect(r.sdPitch).toBe(200);
    expect(r.seeds).toEqual([false, false, false, false, true, true, true, true, false]);
  });
  it('excludes sub / high / no body / S-3 HH alone / a confident S-3 BD', () => {
    const f = [...sd, tomF(120), tomF(120), tomF(120), tomF(120), { ...tomF(120), sub: 0.5 }, { ...tomF(120), high: 0.5 }, { ...tomF(120), body: 0.1 }, tomF(120), tomF(120)];
    const hhOnly = { present: [false, false, true], share: [0, 0, 0.9] };
    const bd = { present: [true, false, false], share: [0.8, 0, 0] };
    const bdWeak = { present: [true, false, false], share: [0.3, 0, 0] };
    const cls = [...sd.map(() => sdOnly), none, none, none, bdWeak, none, none, none, hhOnly, bd];
    expect(tomSeeds(f, cls, toms).seeds.slice(4)).toEqual([true, true, true, true, false, false, false, false, false]);
  });
  it('none without enough snare onsets or with fewer than adaptMinHits seeds', () => {
    expect(tomSeeds([tomF(200), tomF(120), tomF(120), tomF(120), tomF(120)], [sdOnly, none, none, none, none], toms)).toEqual({ seeds: [false, false, false, false, false], sdPitch: NaN });
    const f = [...sd, tomF(120)];
    expect(tomSeeds(f, [...sd.map(() => sdOnly), none], { ...toms, adaptMinHits: 2 }).seeds.some(Boolean)).toBe(false);
  });
});

describe('toms: ratioVote', () => {
  it('nearest (log2) ratio of the pitch to the snare pitch; NaN when unknown', () => {
    const r = [0.62, 0.52, 0.35];
    expect(ratioVote(124, 200, r)).toBe(0);
    expect(ratioVote(104, 200, r)).toBe(1);
    expect(ratioVote(62, 200, r)).toBe(2);
    expect(ratioVote(NaN, 200, r)).toBeNaN();
    expect(ratioVote(100, NaN, r)).toBeNaN();
  });
});

describe('classify: tomAdaptedBasis', () => {
  // 4 mel bands; kit columns BD (band 0), SD (band 2), T1 (band 1)
  const base = {
    W: [Float64Array.from([1, 0, 0, 0]), Float64Array.from([0, 0, 1, 0]), Float64Array.from([0, 1, 0, 0])],
    group: ['BD', 'SD', 'other'] as TemplateGroup[],
    metal: [false, false, false],
    inst: ['BD', 'SD', 'T1'] as (DrumInst | null)[],
  };
  const sdObs = Float64Array.from([0, 0, 1, 0]);
  const sdF = Array.from({ length: 4 }, () => tomF(200));
  const cls = [...sdF.map(() => sdOnly), none, none, none, none];
  it('replaces the kit tom columns by one column per pitch group of the seeds, named via the snare-pitch ratio', () => {
    const obs = [...sdF.map(() => sdObs), Float64Array.from([0, 0.5, 0, 0.5]), Float64Array.from([0, 0.5, 0, 0.5]), Float64Array.from([0.5, 0, 0, 0.5]), Float64Array.from([0.5, 0, 0, 0.5])];
    const f = [...sdF, tomF(124), tomF(124), tomF(70), tomF(70)];
    const b = tomAdaptedBasis(base, obs, f, cls, toms)!;
    expect(b.inst).toEqual(['BD', 'SD', 'T1', 'FT']);
    expect(b.group).toEqual(['BD', 'SD', 'other', 'other']);
    expect(Array.from(b.W[2])).toEqual([0, 0.5, 0, 0.5]);
    expect(Array.from(b.W[3])).toEqual([0.5, 0, 0, 0.5]);
  });
  it('keeps the basis (null) when a group mean is within adaptKeepCos of a kit tom column, or without seeds', () => {
    const obs = [...sdF.map(() => sdObs), ...Array.from({ length: 4 }, () => Float64Array.from([0, 1, 0, 0.05]))];
    const f = [...sdF, tomF(124), tomF(124), tomF(124), tomF(124)];
    expect(tomAdaptedBasis(base, obs, f, cls, toms)).toBeNull();
    expect(tomAdaptedBasis(base, obs, [...sdF, tomF(190), tomF(190), tomF(190), tomF(190)], cls, toms)).toBeNull();
  });
});

describe('classify: s9Evidence bd / sd', () => {
  it('sums the BD and SD group columns (incl. adapted ones)', () => {
    const ev = s9Evidence({ inst: ['BD', null, 'SD', 'T1'], group: ['BD', 'BD', 'SD', 'other'], h: [Float64Array.from([1, 2, 3, 4])] });
    expect(ev[0]).toMatchObject({ total: 10, bd: 3, sd: 3, tom: 4 });
  });
});

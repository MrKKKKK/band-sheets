import { describe, expect, it } from 'vitest';
import { allBassVariants, streamOf, synthParams, type BassVariant } from './variants';

describe('bass variants and splits', () => {
  const all = allBassVariants();
  const count = (f: (v: BassVariant) => boolean) => all.filter(f).length;

  it('sizes: 6 styles x 4 levels per seed and timbre; tuning 3 x A, dev 2 x (A, B), held-out 2 x C', () => {
    expect(all.length).toBe(24 * 9);
    expect(count((v) => v.split === 'tuning')).toBe(72);
    expect(count((v) => v.split === 'dev')).toBe(96);
    expect(count((v) => v.split === 'heldOut')).toBe(48);
    for (const l of [0, 1, 2, 3]) expect(count((v) => v.level === l)).toBe(54);
    expect(new Set(all.map((v) => v.name)).size).toBe(all.length);
  });

  it('timbres per split: tuning A, dev A and B, held-out C only; heldOut flag = split', () => {
    for (const v of all) {
      expect(v.heldOut).toBe(v.split === 'heldOut');
      expect(v.timbre === 'C').toBe(v.heldOut);
      if (v.split === 'tuning') expect([v.timbre, v.seed <= 3]).toEqual(['A', true]);
    }
    expect([...new Set(all.filter((v) => v.split === 'dev').map((v) => v.timbre))].sort()).toEqual(['A', 'B']);
  });

  it('timbre C and the held-out room are refused outside held-out; held-out refuses A / B', () => {
    for (const v of all) expect(synthParams(v).room.kind === 'fdn').toBe(v.heldOut && v.level >= 2);
    const dev = all.find((v) => v.split === 'dev' && v.level === 2)!;
    expect(() => synthParams({ ...dev, timbre: 'C' })).toThrow(/held-out only/);
    expect(() => synthParams({ ...dev, heldOut: true })).toThrow();
    const tun = all.find((v) => v.split === 'tuning')!;
    expect(() => synthParams({ ...tun, timbre: 'B' })).toThrow(/not in the tuning split/);
    const ho = all.find((v) => v.heldOut)!;
    expect(() => synthParams({ ...ho, timbre: 'A' })).toThrow();
    expect(() => synthParams({ ...ho, timbre: 'B' })).toThrow();
  });

  it('held-out streams are salted: same style / seed key gives different draws', () => {
    const ho = all.find((v) => v.heldOut)!;
    expect(streamOf(ho, 'song')()).not.toBe(streamOf({ ...ho, heldOut: false }, 'song')());
  });

  it('levels: B0 bass only and exact, B1 piano + jitter, B2 drums / melody / drift / room / 30 dB, B3 phone + 20 dB + LH octave', () => {
    for (const v of all) {
      const p = synthParams(v);
      if (v.level === 0) expect([p.comp, p.jitterSigmaSec, p.velocitySigma, p.roundRobin, p.room.kind, p.noiseSnrDb, p.pianoRoot]).toEqual([null, 0, 0, false, 'none', null, false]);
      if (v.level === 1) {
        expect(p.comp).not.toBeNull();
        expect(p.jitterSigmaSec).toBeGreaterThanOrEqual(0.005);
        expect(p.jitterSigmaSec).toBeLessThanOrEqual(0.01);
        expect([p.drumsAndMelody, p.room.kind, p.noiseSnrDb, p.drift]).toEqual([false, 'none', null, false]);
      }
      if (v.level === 2) expect([p.drumsAndMelody, p.drift, p.marks, p.noiseSnrDb, p.phone, p.lhOctave]).toEqual([true, true, true, 30, false, false]);
      if (v.level === 3) expect([p.drumsAndMelody, p.phone, p.noiseSnrDb, p.lhOctave]).toEqual([true, true, 20, true]);
      expect(p.leadSec * 100).toBeCloseTo(Math.round(p.leadSec * 100), 9);
    }
  });

  it('the seed and style fix tempo, lead-in, piano shape and piano-root for every level and timbre', () => {
    const one = all.filter((v) => v.style === 'twoBeat' && v.seed === 5 && v.level >= 1).map((v) => synthParams(v));
    expect(new Set(one.map((p) => `${p.bpm}:${p.leadSec}:${p.comp}:${p.pianoRoot}`)).size).toBe(1);
    const roots = all.filter((v) => v.level === 1).map((v) => synthParams(v).pianoRoot);
    expect(roots.filter(Boolean).length).toBeGreaterThan(roots.length * 0.2);
    expect(roots.filter((r) => !r).length).toBeGreaterThan(roots.length * 0.2);
  });
});

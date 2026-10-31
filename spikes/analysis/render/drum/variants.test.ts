import { describe, expect, it } from 'vitest';
import { allDrumVariants, streamOf, synthParams, type DrumVariant } from './variants';

describe('drum variants and splits', () => {
  const all = allDrumVariants();
  const count = (f: (v: DrumVariant) => boolean) => all.filter(f).length;

  it('sizes: 38 variants per seed and kit (9 styles at D0 / D3, 10 with ext at D1 / D2); T12 ext2: 2 per seed and kit', () => {
    expect(all.length).toBe(570 + 36);
    const old = (v: DrumVariant) => v.style !== 'ext2';
    expect(count((v) => old(v) && v.split === 'tuning' && v.kit === 'A')).toBe(114);
    expect(count((v) => old(v) && v.split === 'tuning' && v.kit === 'D')).toBe(114);
    expect(count((v) => old(v) && v.split === 'tuning' && v.kit === 'H')).toBe(114);
    expect(all.filter((v) => v.style === 'ext2').every((v) => v.split === 'tuning' && v.seed >= 21 && v.seed <= 26 && (v.level === 1 || v.level === 2))).toBe(true);
    expect(count((v) => v.style === 'ext2')).toBe(6 * 3 * 2);
    expect(count((v) => v.split === 'dev')).toBe(152);
    expect(count((v) => v.split === 'heldOut')).toBe(76);
    for (const l of [0, 3]) expect(count((v) => old(v) && v.level === l && v.split === 'tuning' && v.kit === 'A')).toBe(27);
    for (const l of [1, 2]) expect(count((v) => old(v) && v.level === l && v.split === 'tuning' && v.kit === 'A')).toBe(30);
    expect(count((v) => old(v) && v.ext)).toBe(2 * 15);
    expect(new Set(all.map((v) => v.name)).size).toBe(all.length);
  });

  it('kits per split: tuning A, dev A and B, held-out C only; heldOut flag = split', () => {
    for (const v of all) {
      expect(v.heldOut).toBe(v.split === 'heldOut');
      expect(v.kit === 'C').toBe(v.heldOut);
      if (v.split === 'tuning') expect(v.seed <= 3 ? v.kit === 'A' : v.seed >= 21 || ['D', 'H'].includes(v.kit)).toBe(true);
      if (v.kit === 'D' || v.kit === 'H') expect([v.split, [11, 12, 13, 21, 22, 23, 24, 25, 26].includes(v.seed)]).toEqual(['tuning', true]);
    }
    expect([...new Set(all.filter((v) => v.split === 'dev').map((v) => v.kit))].sort()).toEqual(['A', 'B']);
  });

  it('the held-out room (fdn) is only drawn for held-out variants; kit C / held-out elsewhere is refused', () => {
    for (const v of all) {
      const p = synthParams(v);
      expect(p.room.kind === 'fdn').toBe(v.heldOut && v.level >= 2);
    }
    const dev = all.find((v) => v.split === 'dev' && v.level === 2)!;
    expect(() => synthParams({ ...dev, kit: 'C' })).toThrow();
    expect(() => synthParams({ ...dev, heldOut: true })).toThrow();
    const ho = all.find((v) => v.heldOut)!;
    expect(() => synthParams({ ...ho, kit: 'A' })).toThrow();
  });

  it('kits D and H (T10b) are tuning only, on their own seeds', () => {
    const dev = all.find((v) => v.split === 'dev' && v.level === 2)!;
    const ho = all.find((v) => v.heldOut)!;
    const tun = all.find((v) => v.split === 'tuning' && v.kit === 'A')!;
    for (const kit of ['D', 'H'] as const) {
      expect(() => synthParams({ ...dev, kit })).toThrow(/tuning only/);
      expect(() => synthParams({ ...ho, kit })).toThrow();
      expect(() => synthParams({ ...tun, kit })).toThrow(/own tuning seeds/);
    }
  });

  it('held-out streams are salted: same style / seed key gives different draws', () => {
    const ho = all.find((v) => v.heldOut)!;
    expect(streamOf(ho, 'score')()).not.toBe(streamOf({ ...ho, heldOut: false }, 'score')());
  });

  it('levels: D0 dry / exact, D1 jitter, D2 room + 30 dB, D3 phone + 20 dB + other tuning', () => {
    for (const v of all) {
      const p = synthParams(v);
      if (v.level === 0) expect([p.jitterSigmaSec, p.velocitySigma, p.swingRatio, p.mic, p.room.kind, p.noiseSnrDb]).toEqual([0, 0, 2 / 3, 'close', 'none', null]);
      if (v.level === 1) {
        expect(p.jitterSigmaSec).toBeGreaterThanOrEqual(0.005);
        expect(p.jitterSigmaSec).toBeLessThanOrEqual(0.01);
        expect([p.mic, p.room.kind, p.noiseSnrDb]).toEqual(['close', 'none', null]);
      }
      if (v.level === 2) expect([p.mic, p.noiseSnrDb, p.fills]).toEqual(['oh', 30, true]);
      if (v.level === 3) {
        expect([p.mic, p.noiseSnrDb, p.denseCymbals]).toEqual(['phone', 20, true]);
        expect(v.kit === 'A' || v.kit === 'H' ? p.program === 16 : Math.abs(p.cents) >= 100).toBe(true);
      }
      expect(p.room.kind === 'mic').toBe((v.kit === 'B' || v.kit === 'D') && v.level >= 2);
    }
  });

  it('the seed fixes tempo and lead-in for every level and kit', () => {
    const one = all.filter((v) => v.style === 'funk' && v.seed === 4).map((v) => synthParams(v));
    expect(new Set(one.map((p) => `${p.bpm}:${p.leadSec}`)).size).toBe(1);
  });
});

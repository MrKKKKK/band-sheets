import { describe, expect, it } from 'vitest';
import { allHumVariants, humScore, splitOf, streamOf, synthParams, type HumVariant } from './variants';

const find = (name: string) => allHumVariants().find((v) => v.name === name)!;

describe('allHumVariants', () => {
  const vs = allHumVariants();
  it('is 4 melodies x 5 levels x 7 seeds with unique names, H0..H3 first in the T1 order', () => {
    expect(vs).toHaveLength(140);
    expect(new Set(vs.map((v) => v.name)).size).toBe(140);
    expect(vs.slice(0, 112).every((v) => v.level <= 3)).toBe(true);
  });
  it('splits by seed: tuning 1-3, dev 4-5, held-out 6-7 (heldOut flag only there)', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(splitOf)).toEqual(['tuning', 'tuning', 'tuning', 'dev', 'dev', 'heldOut', 'heldOut']);
    for (const v of vs) expect(v.heldOut).toBe(v.seed >= 6);
    expect(vs.filter((v) => v.heldOut)).toHaveLength(40);
  });
});

describe('humScore', () => {
  it('is the same for all levels of one melody and seed', () => {
    const s = [0, 1, 2, 3, 4].map((l) => humScore(find(`syn-h${l}-rand-s4`)));
    for (const x of s) expect(x).toEqual(s[0]);
  });
  it('held-out streams are salted differently', () => {
    const v: HumVariant = find('syn-h2-saints-s6');
    const a = streamOf(v, 'x')();
    const b = streamOf({ ...v, heldOut: false }, 'x')();
    expect(a).not.toBe(b);
  });
});

describe('synthParams', () => {
  it('H0 is an exact sine', () => {
    const p = synthParams(find('syn-h0-kirakira-s1'));
    expect(p.source).toBe('sine');
    expect([p.pitchSigmaCents, p.onsetSigmaSec, p.tuningCents, p.driftCents, p.vibDepthCents]).toEqual([0, 0, 0, 0, 0]);
    expect([p.noiseSnrDb, p.reverbRt60, p.clickDb, p.breathDb]).toEqual([null, null, null, null]);
  });
  it('H1 adds voice, vibrato, glides, scoops but no jitter or noise', () => {
    const p = synthParams(find('syn-h1-kirakira-s1'));
    expect(p.source).toBe('voice');
    expect(['la', 'ta']).toContain(p.articulation);
    expect(p.vibrato && p.glide && p.scoopProb > 0).toBe(true);
    expect([p.pitchSigmaCents, p.onsetSigmaSec, p.noiseSnrDb]).toEqual([0, 0, null]);
  });
  it('H2 adds pitch/timing jitter, breath and 30 dB noise', () => {
    const p = synthParams(find('syn-h2-kirakira-s1'));
    expect(p.pitchSigmaCents).toBeGreaterThanOrEqual(15);
    expect(p.pitchSigmaCents).toBeLessThanOrEqual(25);
    expect(p.onsetSigmaSec).toBeGreaterThanOrEqual(0.02);
    expect(p.noiseSnrDb).toBe(30);
    expect(p.breathDb).not.toBeNull();
    expect(p.reverbRt60).toBeNull();
  });
  it('H3 is the closed-mouth hum with a weak fundamental, 20 dB noise, reverb and click bleed', () => {
    for (const s of [1, 4, 7]) {
      const p = synthParams(find(`syn-h3-rand-s${s}`));
      expect(p.articulation).toBe('n');
      expect(p.fundamentalDb).toBeLessThanOrEqual(-15);
      expect(p.noiseSnrDb).toBe(20);
      expect(p.reverbRt60).toBeGreaterThan(0);
      expect(p.clickDb).not.toBeNull();
      expect(p.pitchSigmaCents).toBeGreaterThanOrEqual(25);
    }
  });
});

describe('synthParams H4 (realistic)', () => {
  it('H3 degradations + every-note scoops, portamento, wider pitch spread, irregular vibrato', () => {
    const hums = new Set<string>();
    for (const m of ['saints', 'kirakira', 'etude', 'rand'])
      for (const s of [1, 2, 3, 4, 5, 6, 7]) {
        const p = synthParams(find(`syn-h4-${m}-s${s}`));
        const R = p.realism!;
        hums.add(R.hum);
        expect([p.noiseSnrDb, p.reverbRt60 !== null, p.clickDb !== null, p.fundamentalDb <= -15]).toEqual([20, true, true, true]);
        expect(p.onsetSigmaSec).toBeGreaterThanOrEqual(0.04);
        expect(p.pitchSigmaCents).toBeGreaterThanOrEqual(40);
        expect(p.pitchSigmaCents).toBeLessThanOrEqual(60);
        expect(Math.abs(p.tuningCents)).toBeLessThanOrEqual(50);
        if (R.hum === 'n') {
          expect([p.articulation, p.vowel]).toEqual(['n', 'n']);
          expect(p.tuningCents).toBeLessThan(0);
        } else expect([p.articulation, p.vowel]).toEqual(['la', 'a']);
        expect([p.scoopProb, p.scoopCents, p.scoopSec, p.glideSec]).toEqual([1, [100, 300], [0.1, 0.25], [0.08, 0.2]]);
        expect(p.vibDepthCents).toBeGreaterThanOrEqual(25);
        expect(p.vibDepthCents).toBeLessThanOrEqual(50);
        expect(R.wanderCents).toEqual([30, 60]);
        expect(R.wanderSec).toEqual([0.2, 0.5]);
      }
    expect(hums).toEqual(new Set(['n', 'la']));
  });
  it('H0..H3 carry no realism field (their truths are unchanged)', () => {
    for (const l of [0, 1, 2, 3]) expect('realism' in synthParams(find(`syn-h${l}-rand-s4`))).toBe(false);
  });
});

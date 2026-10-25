import { describe, expect, it } from 'vitest';
import { A_VELOCITY_STEPS, getKit, kitAvailable, layerOf, SAMPLE_RATE } from '../../render/drum/kits';
import { classifyOnsets, hitsOf, melSpectrogram, observation, solveActivations, specParams, type OnsetClass } from './classify';
import { DEFAULT_DRUM_CONFIG, resolveDrumConfig } from './config';
import { detectOnsets } from './onset';
import { DRUM_TEMPLATES } from './templates';
import type { DrumInst } from './types';

describe('solveActivations', () => {
  const W = [
    [0.5, 0.5, 0, 0],
    [0, 0.25, 0.25, 0.5],
    [0.1, 0.1, 0.4, 0.4],
  ];
  const mix = (h: number[]) => W[0].map((_, m) => h.reduce((s, v, k) => s + v * W[k][m], 0));
  for (const beta of [1, 2]) {
    it(`recovers a non-negative mixture (beta ${beta})`, () => {
      const h = solveActivations(W, mix([2, 0.5, 0]), 2000, beta);
      expect(h[0]).toBeCloseTo(2, 2);
      expect(h[1]).toBeCloseTo(0.5, 2);
      expect(h[2]).toBeLessThan(0.01);
    });
  }
  it('is all zero for a silent observation', () => {
    expect([...solveActivations(W, [0, 0, 0, 0], 10)]).toEqual([0, 0, 0]);
  });
});

describe('observation', () => {
  it('removes what was already sounding (a steady tone gives ~0)', () => {
    const p = specParams(DEFAULT_DRUM_CONFIG);
    const y = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < y.length; i++) y[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    const x = observation(melSpectrogram(y, p), 0.5, p);
    const s = melSpectrogram(y, p);
    const level = s.data.subarray(40 * s.bands, 41 * s.bands).reduce((a, b) => a + b, 0);
    expect(x.reduce((a, b) => a + b, 0)).toBeLessThan(1e-3 * level);
  });
});

describe('hitsOf', () => {
  const o = (present: boolean[], confidence: number[]): OnsetClass => ({ t: 1, a: [1, 1, 1], share: [0.3, 0.3, 0.3], otherShare: 0, present, confidence, strength: [3, 2, 1] });
  it('one hit per present class, alts = the best absent classes', () => {
    const hs = hitsOf([o([true, false, true], [0.9, 0.3, 0.7])], 1);
    expect(hs.map((h) => [h.inst, h.strength, h.confidence])).toEqual([
      ['BD', 3, 0.9],
      ['HH', 1, 0.7],
    ]);
    expect(hs[0].alts).toEqual([{ inst: 'SD', confidence: 0.3 }]);
    expect(hitsOf([o([true, true, true], [0.9, 0.8, 0.7])], 1).every((h) => h.alts === undefined)).toBe(true);
    expect(hitsOf([o([true, false, false], [0.9, 0.2, 0.4])], 2)[0].alts?.map((a) => a.inst)).toEqual(['HH', 'SD']);
  });
});

describe('templates.ts', () => {
  it('matches the default config spectrum params and every column sums to 1', () => {
    expect(DRUM_TEMPLATES.params).toEqual(specParams(DEFAULT_DRUM_CONFIG));
    for (const c of DRUM_TEMPLATES.columns) {
      expect(c.w).toHaveLength(DEFAULT_DRUM_CONFIG.classify.melBands);
      expect(c.w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    }
    expect(new Set(DRUM_TEMPLATES.columns.map((c) => c.group))).toEqual(new Set(['BD', 'SD', 'HH', 'other', 'ext', 'extCym']));
  });
  it('a config whose spectrum params differ is refused', () => {
    const cfg = resolveDrumConfig({ classify: { melBands: 24 } });
    const det = detectOnsets(new Float32Array(SAMPLE_RATE), SAMPLE_RATE, cfg);
    expect(() => classifyOnsets(det, cfg)).toThrow(/make_templates/);
  });
});

/**
 * Simultaneous hits from the tuning kit's one-shots (kit A). A steady groove (BD / SD / HH alone) gives the take its
 * references; the probe hits sit between them.
 */
describe.skipIf(!kitAvailable('A'))('classify on kit A one-shots (simultaneous hits, ghost, open HH)', () => {
  const kit = getKit('A');
  const voice = (inst: DrumInst, vel: number) => kit.voice({ inst, layer: layerOf(vel, A_VELOCITY_STEPS), rr: 0, mics: { dry: 1 }, cents: 0, program: 0 });
  const probes: { at: number; insts: [DrumInst, number][]; expect: string[] }[] = [];
  const hits: { at: number; inst: DrumInst; vel: number }[] = [];
  let t = 0.5;
  const groove = () => {
    for (const [inst, vel] of [
      ['BD', 100],
      ['HH', 90],
      ['SD', 100],
      ['HH', 90],
    ] as [DrumInst, number][]) {
      hits.push({ at: t, inst, vel });
      t += 0.25;
    }
  };
  const probe = (insts: [DrumInst, number][], exp: string[]) => {
    probes.push({ at: t, insts, expect: exp });
    for (const [inst, vel] of insts) hits.push({ at: t, inst, vel });
    t += 0.5;
  };
  groove();
  groove();
  probe([['BD', 100], ['HH', 90]], ['BD', 'HH']);
  groove();
  probe([['SD', 100], ['HH', 90]], ['HH', 'SD']);
  groove();
  probe([['BD', 100], ['SD', 100], ['HH', 90]], ['BD', 'HH', 'SD']);
  groove();
  probe([['SD', 34]], ['SD']); // ghost alone
  groove();
  probe([['SD', 40], ['HH', 70]], ['HH', 'SD']); // ghost-level SD under a hi-hat
  groove();
  probe([['HO', 90]], ['HH']); // open HH is HH in S-3
  groove();
  probe([['HO', 90], ['BD', 100]], ['BD', 'HH']);
  groove();
  const y = new Float32Array(Math.round((t + 1.5) * SAMPLE_RATE));
  for (const h of hits) {
    const v = voice(h.inst, h.vel);
    const start = Math.round(h.at * SAMPLE_RATE) - v.onset;
    for (let i = 0; i < v.x.length && start + i < y.length; i++) if (start + i >= 0) y[start + i] += v.x[i];
  }
  const det = detectOnsets(y, SAMPLE_RATE);
  const res = classifyOnsets(det);
  const at = (sec: number) =>
    res.hits
      .filter((h) => Math.abs(h.t - sec) < 0.03)
      .map((h) => h.inst)
      .sort();

  for (const p of probes) {
    it(`${p.insts.map(([i, v]) => `${i}@${v}`).join(' + ')} -> ${p.expect.join(' + ')}`, () => {
      expect(at(p.at)).toEqual(p.expect);
    });
  }
  it('the groove hits are single instruments, with strength and confidence in range', () => {
    const groove = hits.filter((h) => !probes.some((p) => Math.abs(p.at - h.at) < 0.01));
    let ok = 0;
    for (const h of groove) if (JSON.stringify(at(h.at)) === JSON.stringify([h.inst === 'HO' ? 'HH' : h.inst])) ok++;
    expect(ok).toBe(groove.length);
    for (const h of res.hits) {
      expect(h.strength).toBeGreaterThan(0);
      expect(h.confidence).toBeGreaterThanOrEqual(0.5);
      expect(h.confidence).toBeLessThanOrEqual(1);
      for (const a of h.alts ?? []) expect(a.confidence).toBeLessThan(0.5);
    }
  });
  it('a ghost SD is weaker than the groove SDs (strength feeds strength.ts marks)', () => {
    const sd = res.hits.filter((h) => h.inst === 'SD');
    const ghost = sd.find((h) => Math.abs(h.t - probes[3].at) < 0.03)!;
    const normal = sd.filter((h) => !probes.some((p) => Math.abs(p.at - h.t) < 0.03)); // groove SDs (alone, velocity 100)
    expect(normal.length).toBeGreaterThan(5);
    for (const n of normal) expect(20 * Math.log10(n.strength / ghost.strength)).toBeGreaterThan(6); // isolated one-shots: 9.6 dB
  });
});

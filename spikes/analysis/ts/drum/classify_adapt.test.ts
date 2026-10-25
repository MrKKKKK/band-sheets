// Spike 5 T10: unit tests of the per-take adaptation helpers (classify.ts steps 2b' 2d 5).
import { describe, expect, it } from 'vitest';
import { adaptColumns, bandCentroid, classParts, cosine, gateOk, massBelow, metalTakeIsHh, takeEq, type AdaptCfg, type OnsetClass } from './classify';

const centres = [50, 100, 200, 1000, 3000, 6000, 10000, 14000];
const cfg: AdaptCfg = { adaptKeepCos: 0.98, adaptShare: 0.2, adaptMinHits: 2, adaptLowHz: 150, adaptLowMin: 0.3, adaptHighHz: 5000, adaptHighMin: 0.3 };
const BD = [4, 3, 1, 0.5, 0.2, 0, 0, 0];
const SD = [0.1, 0.2, 3, 2, 1, 0.2, 0.1, 0];
const HH = [0, 0, 0, 0.1, 0.5, 2, 3, 2];
const cls = (present: boolean[], share: number[]): OnsetClass => ({ t: 0, a: share, share, otherShare: 0, present, confidence: [0, 0, 0], strength: share });
const vec = (v: number[]) => Float64Array.from(v);
const norm = (v: ArrayLike<number>) => {
  const s = Array.from(v).reduce((a, b) => a + b, 0);
  return Array.from(v, (x) => x / s);
};

describe('band features', () => {
  it('bandCentroid: index-weighted mean, NaN when empty; BD < SD < HH', () => {
    expect(bandCentroid([0, 1, 0, 1])).toBe(2);
    expect(bandCentroid([0, 0])).toBeNaN();
    expect(bandCentroid(BD)).toBeLessThan(bandCentroid(SD));
    expect(bandCentroid(SD)).toBeLessThan(bandCentroid(HH));
  });
  it('massBelow and cosine', () => {
    expect(massBelow([1, 1, 2, 0, 0, 0, 0, 0], centres, 150)).toBe(0.5);
    expect(massBelow([0, 0, 0, 0, 0, 0, 0, 0], centres, 150)).toBe(0);
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
  it('gateOk: BD needs low mass, HH high mass, SD neither', () => {
    expect([0, 1, 2].map((k) => gateOk(k, BD, centres, cfg))).toEqual([true, false, false]);
    expect([0, 1, 2].map((k) => gateOk(k, SD, centres, cfg))).toEqual([false, true, false]);
    expect([0, 1, 2].map((k) => gateOk(k, HH, centres, cfg))).toEqual([false, false, true]);
  });
});

describe('classParts', () => {
  it('each class part = x minus the other columns (clipped at 0); metal columns count for HH when asked', () => {
    const W = [norm(BD), norm(SD), norm(HH), norm([0, 0, 0, 0, 0, 1, 1, 1])];
    const h = [2, 1, 0, 0.5];
    const x = W[0].map((_, m) => W.reduce((s, w, k) => s + w[m] * h[k], 0));
    const p = classParts(x, W, ['BD', 'SD', 'HH', 'other'], h, [false, false, false, false]);
    p[0].forEach((v, m) => expect(v).toBeCloseTo(2 * W[0][m], 12));
    p[1].forEach((v, m) => expect(v).toBeCloseTo(W[1][m], 12));
    expect(Math.max(...p[2])).toBeCloseTo(0, 12); // HH has no activation, the metal column is removed
    const q = classParts(x, W, ['BD', 'SD', 'HH', 'other'], h, [false, false, false, true]);
    q[2].forEach((v, m) => expect(v).toBeCloseTo(0.5 * W[3][m], 12));
  });
});

describe('adaptColumns', () => {
  const parts = (bd: number[], sd: number[], hh: number[]) => [vec(bd), vec(sd), vec(hh)];
  const z = [0, 0, 0, 0, 0, 0, 0, 0];
  it('mean of the normalised parts of the confident hits per class', () => {
    const P = [parts(BD, z, z), parts(BD.map((v) => v * 3), z, z), parts(z, SD, z), parts(z, SD, z), parts(z, z, HH), parts(z, z, HH)];
    const C = [cls([true, false, false], [1, 0, 0]), cls([true, false, false], [0.9, 0, 0]), cls([false, true, false], [0, 1, 0]), cls([false, true, false], [0, 1, 0]), cls([false, false, true], [0, 0, 1]), cls([false, false, true], [0, 0, 1])];
    const cols = adaptColumns(P, C, [true, true, true, true, true, true], centres, cfg);
    cols[0]!.forEach((v, m) => expect(v).toBeCloseTo(norm(BD)[m], 12));
    cols[1]!.forEach((v, m) => expect(v).toBeCloseTo(norm(SD)[m], 12));
    cols[2]!.forEach((v, m) => expect(v).toBeCloseTo(norm(HH)[m], 12));
    // HH seeds must decay fast; too few seeds -> null
    expect(adaptColumns(P, C, [true, true, true, true, false, true], centres, cfg)[2]).toBeNull();
    // low share, or a part failing its band gate, is no seed
    const lowShare = C.map((c) => ({ ...c, share: c.share.map((s) => s * 0.1) }));
    expect(adaptColumns(P, lowShare, P.map(() => true), centres, cfg)).toEqual([null, null, null]);
    const wrongGate = [parts(SD, z, z), parts(SD, z, z)];
    expect(adaptColumns(wrongGate, C.slice(0, 2), [true, true], centres, cfg)[0]).toBeNull();
  });
  it('a class whose kit column already fits (cosine >= adaptKeepCos) is not adapted', () => {
    const P = [parts(BD, z, z), parts(BD, z, z)];
    const C = [cls([true, false, false], [1, 0, 0]), cls([true, false, false], [1, 0, 0])];
    expect(adaptColumns(P, C, [true, true], centres, cfg, [[norm(BD)], [], []])[0]).toBeNull();
    expect(adaptColumns(P, C, [true, true], centres, cfg, [[norm(SD)], [], []])[0]).not.toBeNull();
  });
  it('adapted templates out of the centroid order BD < SD < HH are both dropped', () => {
    // an "SD" seed set lower than the BD one (passes the SD gate but sits below BD's centroid)
    const lowSd = [0, 0, 1, 0, 0, 0, 0, 0];
    const highBd = [2, 0, 0, 0, 0, 0, 0, 3];
    const P = [parts(highBd, z, z), parts(highBd, z, z), parts(z, lowSd, z), parts(z, lowSd, z), parts(z, z, HH), parts(z, z, HH)];
    const C = [0, 0, 1, 1, 2, 2].map((k) => cls([k === 0, k === 1, k === 2], [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]));
    const cols = adaptColumns(P, C, P.map(() => true), centres, cfg);
    expect(cols[0]).toBeNull();
    expect(cols[1]).toBeNull();
    expect(cols[2]).not.toBeNull();
  });
});

describe('metalTakeIsHh', () => {
  const act = (metal: number) => ({ a: [0, 0, 1 - metal], other: metal, metal });
  it('true when most metal-dominated onsets decay fast (at least minHits of them); fastMin 0 = always', () => {
    const acts = [act(0.9), act(0.8), act(0.7), act(0.6), act(0.1)];
    expect(metalTakeIsHh(acts, [true, true, true, false, false], 0.5, 4)).toBe(true);
    expect(metalTakeIsHh(acts, [true, false, false, false, true], 0.5, 4)).toBe(false);
    expect(metalTakeIsHh(acts, [true, true, true, true, true], 0.5, 5)).toBe(false);
    expect(metalTakeIsHh([], [], 0, 4)).toBe(true);
  });
});

describe('takeEq', () => {
  it('recovers a smooth per-band channel gain (observed / fitted), clamped to +-maxDb', () => {
    const W = [norm(BD), norm(SD), norm(HH)];
    const g = [0.5, 0.5, 0.5, 1, 1, 2, 2, 2];
    const hs = [
      [1, 0, 0],
      [0, 1, 1],
      [2, 1, 0],
    ];
    const obs = hs.map((h) => W[0].map((_, m) => g[m] * W.reduce((s, w, k) => s + w[m] * h[k], 0)));
    const eq = takeEq(obs, W, hs, 20);
    expect(eq[0]).toBeCloseTo(0.5, 6);
    expect(eq[7]).toBeCloseTo(2, 6);
    expect(takeEq(obs, W, hs, 3)[7]).toBeCloseTo(10 ** (3 / 20), 6);
  });
});

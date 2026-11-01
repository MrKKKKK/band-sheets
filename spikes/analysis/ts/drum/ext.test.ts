// Spike 5 T12: unit tests of the S-拡張 rules (ext.ts extHits, tonalPeak).
import { describe, expect, it } from 'vitest';
import { DEFAULT_DRUM_CONFIG } from './config';
import { extHits, tonalPeak, type ExtEvidence } from './ext';
import type { AnalysisDrumHit } from './types';

const cfg = DEFAULT_DRUM_CONFIG.ext;
const RISE = DEFAULT_DRUM_CONFIG.cymbals.riseDb;
const hit = (t: number, inst: string): AnalysisDrumHit => ({ t, inst, strength: 1, confidence: 0.8 });
const ev = (o: Partial<ExtEvidence> = {}): ExtEvidence => ({ act: {}, total: 1, drop: -3, tonal: 5, tonalHz: 3000, foot: 0, ...o });
const insts = (hs: AnalysisDrumHit[]) => hs.map((h) => h.inst).sort();

describe('ext: tonalPeak', () => {
  it('a single partial is tonal at its frequency; flat noise is not', () => {
    const size = 1024;
    const sr = 1024 * 10; // 10 Hz per bin
    const mag = new Float64Array(size / 2 + 1).fill(1);
    mag[50] = 80; // 500 Hz
    const p = tonalPeak(mag, size, sr, 300, 4000);
    expect(p.hz).toBe(500);
    expect(p.tonal).toBe(80);
    expect(tonalPeak(new Float64Array(size / 2 + 1).fill(1), size, sr, 300, 4000).tonal).toBe(1);
    expect(tonalPeak(new Float64Array(size / 2 + 1), size, sr, 300, 4000).tonal).toBeNaN();
  });
});

describe('ext: extHits', () => {
  it('without S-拡張 evidence the S-9 hits pass unchanged', () => {
    const s9 = [hit(0, 'BD'), hit(0, 'HH'), hit(0.5, 'SD')];
    const out = extHits(s9, [0, 0.5], [ev({ act: { HH: 1 } }), ev({ act: { SD: 1 } })], RISE, cfg);
    expect(out).toEqual(s9);
  });
  it('splash / china by the template vote on a CR that does not bloom; a blooming crash stays CR', () => {
    const vote = { CR: 0.1, SP: 0.9, CN: 0 };
    expect(insts(extHits([hit(0, 'CR')], [0], [ev({ act: vote, drop: -1.5 })], RISE, cfg))).toEqual(['SP']);
    expect(insts(extHits([hit(0, 'CR')], [0], [ev({ act: { CR: 0.05, CN: 0.95 }, drop: -1 })], RISE, cfg))).toEqual(['CN']);
    expect(insts(extHits([hit(0, 'CR')], [0], [ev({ act: vote, drop: 3 })], RISE, cfg))).toEqual(['CR']);
    expect(insts(extHits([hit(0, 'CR')], [0], [ev({ act: { CR: 0.4, SP: 0.6 }, drop: -1 })], RISE, cfg))).toEqual(['CR']);
    const sp = extHits([hit(0, 'CR')], [0], [ev({ act: vote, drop: -1.5 })], RISE, cfg)[0];
    expect(sp.alts?.[0].inst).toBe('CR');
  });
  it('ride bell: template vote only on an RD; the tonal peak also on an HH', () => {
    const bell = { RD: 0.3, 'RD.bell': 0.7 };
    expect(insts(extHits([hit(0, 'RD')], [0], [ev({ act: bell })], RISE, cfg))).toEqual(['RD.bell']);
    expect(insts(extHits([hit(0, 'HH')], [0], [ev({ act: bell })], RISE, cfg))).toEqual(['HH']);
    expect(insts(extHits([hit(0, 'HH')], [0], [ev({ act: { HH: 1 }, tonal: 60, tonalHz: 3000 })], RISE, cfg))).toEqual(['RD.bell']);
    expect(insts(extHits([hit(0, 'HH')], [0], [ev({ act: { HH: 1 }, tonal: 60, tonalHz: 800 })], RISE, cfg))).toEqual(['HH']);
  });
  it('cowbell: added by its share or a fast tonal peak in its range (not with a tom); it removes an S-9 HH there', () => {
    expect(insts(extHits([hit(0, 'BD')], [0], [ev({ act: { CB: 0.5, BD: 0.5 } })], RISE, cfg))).toEqual(['BD', 'CB']);
    expect(insts(extHits([hit(0, 'HH')], [0], [ev({ act: { HH: 1 }, tonal: 80, tonalHz: 470, drop: -10 })], RISE, cfg))).toEqual(['CB']);
    expect(insts(extHits([hit(0, 'T2')], [0], [ev({ act: { T2: 1 }, tonal: 80, tonalHz: 470, drop: -10 })], RISE, cfg))).toEqual(['T2']);
    expect(insts(extHits([hit(0, 'HH')], [0], [ev({ act: { HH: 1 }, tonal: 80, tonalHz: 470, drop: -3 })], RISE, cfg))).toEqual(['HH']);
  });
  it('cross-stick replaces the S-9 SD or is added; not on a CR onset', () => {
    expect(insts(extHits([hit(0, 'SD'), hit(0, 'RD')], [0], [ev({ act: { 'SD.xs': 0.6, RD: 0.4 } })], RISE, cfg))).toEqual(['RD', 'SD.xs']);
    expect(insts(extHits([hit(0, 'HH')], [0], [ev({ act: { 'SD.xs': 0.6, HH: 0.4 } })], RISE, cfg))).toEqual(['HH', 'SD.xs']);
    expect(insts(extHits([hit(0, 'CR')], [0], [ev({ act: { 'SD.xs': 0.6, CR: 0.4 }, drop: 3 })], RISE, cfg))).toEqual(['CR']);
  });
  it('pedal HH by the foot template share: relabels an HH, adds a hit without metal, off at footShare 0', () => {
    expect(insts(extHits([hit(0, 'HH')], [0], [ev({ act: { HH: 1 }, foot: 0.8 })], RISE, cfg))).toEqual(['HH.foot']);
    expect(insts(extHits([hit(0, 'SD')], [0], [ev({ act: { SD: 1 }, foot: 0.8 })], RISE, cfg))).toEqual(['HH.foot', 'SD']);
    expect(insts(extHits([hit(0, 'HH')], [0], [ev({ act: { HH: 1 }, foot: 0.8 })], RISE, { ...cfg, footShare: 0 }))).toEqual(['HH']);
  });
  it('keeps time order across onsets', () => {
    const out = extHits([hit(0, 'BD'), hit(0.25, 'HH'), hit(0.5, 'SD')], [0, 0.25, 0.5], [ev(), ev({ act: { CB: 1 } }), ev()], RISE, cfg);
    expect(out.map((h) => `${h.t} ${h.inst}`)).toEqual(['0 BD', '0.25 CB', '0.5 SD']);
  });
});

// Spike 5 T11: unit tests of the S-9 helpers (cymbals.ts, toms.ts, classify.ts s9Evidence).
import { describe, expect, it } from 'vitest';
import { hhUnderDrum, s9Evidence, type MelSpec } from './classify';
import { DEFAULT_DRUM_CONFIG } from './config';
import { cosToProfile, highDrops, metalLabel, type MetalVotes } from './cymbals';
import { groupNames, groupPitches, tomPitch } from './toms';

const cy = DEFAULT_DRUM_CONFIG.cymbals;
const votes = (v: Partial<MetalVotes>): MetalVotes => ({ HH: 0, HO: 0, RD: 0, CR: 0, ...v });

describe('cymbals: highDrops', () => {
  // 2 bands, centres 1 kHz and 8 kHz; only the 8 kHz band counts (fminHz 5000)
  const centres = [1000, 8000];
  const spec = (high: number[]): MelSpec => ({ frames: high.length, bands: 2, data: Float32Array.from(high.flatMap((h) => [100, h])) });
  const o = { fminHz: 5000, dropFrames: 6, dropMinFrames: 3 };
  it('dB from the peak (onset .. +2) to dropFrames later; low band ignored', () => {
    const s = spec([1, 10, 100, 50, 25, 12.5, 10, 10, 10, 1, 1, 1]);
    // onset frame 1, peak at 2, +6 = frame 8 (10): -10 dB
    expect(highDrops(s, centres, [1], o)[0]).toBeCloseTo(-10, 6);
  });
  it('scales a shorter window before the next onset; NaN when too short', () => {
    const s = spec([1, 100, 10, 10, 10, 10, 10, 10, 10, 10]);
    // onset 1 (peak 1), next onset at 5 -> d = min(6, 5 - 1 - 1) = 3: -10 dB * 6 / 3 = -20
    expect(highDrops(s, centres, [1, 5], o)[0]).toBeCloseTo(-20, 6);
    expect(Number.isNaN(highDrops(s, centres, [1, 4], o)[0])).toBe(true);
  });
  it('a blooming crash rises (positive)', () => {
    const s = spec([1, 10, 20, 30, 40, 40, 40, 40, 40, 40, 40]);
    expect(highDrops(s, centres, [1], o)[0]).toBeGreaterThan(0);
  });
});

describe('classify: hhUnderDrum (T12b)', () => {
  const c = { hhCoShare: 0.02, hhCoLevelDb: -15 };
  it('a quiet HH under BD / SD only: share and level re the take HH reference', () => {
    expect(hhUnderDrum([false, true, false], 0.03, 0.2, 1, c)).toBe(true); // -14 dB
    expect(hhUnderDrum([true, false, false], 0.03, 0.1, 1, c)).toBe(false); // -20 dB
    expect(hhUnderDrum([false, true, false], 0.01, 0.9, 1, c)).toBe(false); // share too small
    expect(hhUnderDrum([false, false, false], 0.03, 0.9, 1, c)).toBe(false); // no BD / SD
    expect(hhUnderDrum([false, true, true], 0.03, 0.9, 1, c)).toBe(false); // already present
    expect(hhUnderDrum([false, true, false], 0.5, 0.9, 1, { hhCoShare: 1, hhCoLevelDb: -15 })).toBe(false); // off
  });
});

describe('cymbals: cosToProfile', () => {
  const centres = [500, 2000, 6000, 10000];
  it('compares bands >= fminHz with the mean closed-HH profile; NaN without enough profile onsets', () => {
    const obs = [Float64Array.from([9, 0, 1, 2]), Float64Array.from([0, 0, 2, 4]), Float64Array.from([5, 0, 4, 0])];
    const c = cosToProfile(obs, centres, [true, true, false], 1000, 2);
    expect(c[1]).toBeCloseTo(1, 9); // same shape above 1 kHz as the profile, the 500 Hz band ignored
    expect(c[2]).toBeCloseTo(1 / Math.sqrt(5), 9);
    expect(cosToProfile(obs, centres, [true, false, false], 1000, 2).every(Number.isNaN)).toBe(true);
  });
});

describe('cymbals: metalLabel', () => {
  it('fast drop -> HH whatever the vote; rising -> CR', () => {
    expect(metalLabel(votes({ RD: 1 }), -8, NaN, cy).inst).toBe('HH');
    expect(metalLabel(votes({ HH: 1, RD: 0.6 }), 2, NaN, cy).inst).toBe('CR');
    // rising but nearly all HH template: stays with the vote
    expect(metalLabel(votes({ HH: 1, RD: 0.1 }), 2, NaN, cy).inst).toBe('HH');
  });
  it('slow and no dominant vote: HO when it looks like the take closed HH, else RD / CR by the vote', () => {
    const v = votes({ HH: 0.4, HO: 0.2, RD: 0.3, CR: 0.1 });
    expect(metalLabel(v, -2, 0.97, cy).inst).toBe('HO');
    expect(metalLabel(v, -2, 0.8, cy).inst).toBe('RD');
    expect(metalLabel(votes({ HH: 0.4, RD: 0.1, CR: 0.3, HO: 0.2 }), -2, NaN, { ...cy, crNeedsRise: false }).inst).toBe('CR');
  });
  it('crNeedsRise (T12b): a CR that does not bloom becomes HH or RD by the vote; a rising one stays; NaN drop keeps it', () => {
    const r = { ...cy, crNeedsRise: true };
    expect(metalLabel(votes({ CR: 0.9, HH: 0.1 }), -2, NaN, r)).toEqual({ inst: 'HH', alt: 'CR' });
    expect(metalLabel(votes({ CR: 0.6, HO: 0.3, RD: 0.1 }), -2, NaN, r).inst).toBe('RD');
    expect(metalLabel(votes({ CR: 0.9, HH: 0.1 }), 2, NaN, r).inst).toBe('CR');
    expect(metalLabel(votes({ CR: 0.9, HH: 0.1 }), NaN, NaN, r).inst).toBe('CR');
    expect(metalLabel(votes({ CR: 0.9, HH: 0.1 }), -2, NaN, { ...cy, crNeedsRise: false }).inst).toBe('CR');
    // a splash / china (its column holds >= crKeepSpCn of the CR vote) does not bloom either: stays CR for S-ext
    expect(metalLabel(votes({ CR: 0.9, HH: 0.1 }), -2, NaN, r, 0.9).inst).toBe('CR');
    expect(metalLabel(votes({ CR: 0.9, HH: 0.1 }), -2, NaN, r, 0.5).inst).toBe('HH');
  });
  it('a dominant vote stands in the middle zone; alt = runner-up', () => {
    const r = metalLabel(votes({ HO: 0.8, RD: 0.2 }), -2, 0.5, cy);
    expect(r).toEqual({ inst: 'HO', alt: 'RD' });
    expect(metalLabel(votes({ RD: 0.9 }), Number.NaN, NaN, cy).inst).toBe('RD');
  });
});

describe('toms', () => {
  it('tomPitch finds a sine within a few Hz', () => {
    const sr = 44100;
    const y = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 147 * i) / sr) * Math.exp(-i / sr / 0.3));
    const f = tomPitch(y, sr, 0.1, DEFAULT_DRUM_CONFIG.toms);
    expect(Math.abs(f - 147)).toBeLessThan(3);
  });
  it('groupPitches splits at the largest gaps >= minGapOct, highest group first; NaN joins the median group', () => {
    const p = [200, 202, 150, 151, 100, 99, NaN];
    expect(groupPitches(p, 3, 0.12)).toEqual({ group: [0, 0, 1, 1, 2, 2, 1], count: 3 });
    // only 2 groups allowed: the largest gap (200 -> 150 vs 150 -> 100: 0.415 < 0.585 oct) wins
    expect(groupPitches(p.slice(0, 6), 2, 0.12)).toEqual({ group: [0, 0, 0, 0, 1, 1], count: 2 });
    expect(groupPitches([120, 125, 118], 3, 0.12)).toEqual({ group: [0, 0, 0], count: 1 });
    expect(groupPitches([], 3, 0.12)).toEqual({ group: [], count: 0 });
  });
  it('groupNames: 3 groups by pitch; fewer by the template vote, pitch order kept', () => {
    expect(groupNames(3, [2, 2, 2])).toEqual(['T1', 'T2', 'FT']);
    expect(groupNames(2, [0.1, 1.1])).toEqual(['T1', 'T2']);
    expect(groupNames(2, [1.0, 1.9])).toEqual(['T2', 'FT']);
    expect(groupNames(2, [NaN, NaN])).toEqual(['T1', 'FT']);
    expect(groupNames(1, [1.8])).toEqual(['FT']);
  });
});

describe('classify: s9Evidence', () => {
  it('sums tom columns (vote = mean template index) and metal votes (RD.bell -> RD, SP / CN -> CR, adapted HH -> HH)', () => {
    const ev = s9Evidence({
      inst: ['BD', 'T1', 'FT', 'HH', null, 'RD.bell', 'CN', 'HO'],
      group: ['BD', 'other', 'other', 'HH', 'HH', 'extCym', 'extCym', 'HH'],
      h: [Float64Array.from([1, 1, 3, 0.5, 0.5, 2, 1, 1])],
    });
    expect(ev[0].total).toBe(10);
    expect(ev[0].tom).toBe(4);
    expect(ev[0].tomVote).toBeCloseTo(1.5, 12);
    expect(ev[0].metal).toEqual({ HH: 1, HO: 1, RD: 2, CR: 1 });
  });
});

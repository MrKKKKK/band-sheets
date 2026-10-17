import { describe, expect, it } from 'vitest';
import { allVariants } from './variants';

describe('allVariants', () => {
  // Modulation variants (spike 2, T23) are tested in modulate.test.ts.
  const v = allVariants().filter((x) => !x.modulation);
  const l0 = v.filter((x) => x.level === 0 && !x.heldOut && !x.name.startsWith('etude7') );
  it('has unique names and a level on every variant', () => {
    expect(new Set(v.map((x) => x.name)).size).toBe(v.length);
    for (const x of v) expect([0, 1, 2, 3, 'LR', 'V']).toContain(x.level);
    expect(v.length).toBeLessThanOrEqual(56); // 50 + the 6 LR '-hard' variants of T4b
  });
  it('keeps the 21 spike 0 variants unchanged at level 0', () => {
    expect(l0).toHaveLength(21);
    for (const x of l0) {
      expect(x.comp).toBeUndefined();
      expect(x.soundFont).toBeUndefined();
      expect(x.tempoCurve).toBeUndefined();
      expect(x.etudeSeed).toBeUndefined();
    }
  });
  it('flags the held-out etude2 (seed 2, 7th-heavy) and etude3 (LR) and nothing else', () => {
    const held = v.filter((x) => x.heldOut && !x.name.startsWith('etude3-'));
    expect(held.length).toBeGreaterThanOrEqual(3);
    for (const x of held) {
      expect(x.name.startsWith('etude2-')).toBe(true);
      expect(x.etudeSeed).toBe(2);
      expect(x.seventhShare).toBeGreaterThan(0.3);
    }
    expect(new Set(held.map((x) => x.level))).toEqual(new Set([0, 1, 2]));
    expect(v.filter((x) => x.name.startsWith('etude2-')).every((x) => x.heldOut)).toBe(true);
    expect(v.some((x) => x.name.startsWith('etude7-') && !x.heldOut && x.seventhShare)).toBe(true);
  });
  it('has L1 shapes, L2 drift with a valid curve, and L3', () => {
    const lv = (n: number) => v.filter((x) => x.level === n);
    expect(lv(1).some((x) => x.soundFont === 'musescore')).toBe(true);
    expect(lv(1).some((x) => x.comp === 'arp8')).toBe(true);
    expect(lv(1).some((x) => x.comp === 'whole')).toBe(true);
    expect(lv(1).some((x) => x.pianoGainDb === -9)).toBe(true);
    for (const x of v.filter((y) => y.tempoCurve)) {
      expect(x.tempoCurve).toHaveLength(32);
      expect(x.tempoCurve![0]).toBe(x.tempo);
      expect(Math.max(...x.tempoCurve!)).toBeLessThanOrEqual(x.tempo * 1.07);
      expect(Math.min(...x.tempoCurve!)).toBeGreaterThanOrEqual(x.tempo * 0.93);
    }
    expect(lv(3).length).toBeGreaterThan(0);
  });
  it('names the key ones as planned', () => {
    const names = v.map((x) => x.name);
    for (const n of [
      'full-t116-shuffle',
      'piano-t80-straight',
      'full-t116-straight-click',
      'etude-piano-t90-straight',
      'etude-full-t140-straight',
      'etude-full-t90-shuffle',
      'full-t116-straight-lead1.37s',
    ])
      expect(names).toContain(n);
  });
  it('splits 13 saints and 8 etude', () => {
    expect(l0.filter((x) => x.song === 'saints')).toHaveLength(13);
    expect(l0.filter((x) => x.song === 'etude')).toHaveLength(8);
  });
  it('has shuffle only where asWritten, and lead-in only in the lead variants', () => {
    for (const x of l0) {
      expect(x.name.includes('shuffle')).toBe(x.swing === 'asWritten');
      expect(x.name.includes('-lead')).toBe((x.leadInSec ?? 0) > 0);
    }
    expect(l0.filter((x) => x.leadInSec).map((x) => x.leadInSec)).toEqual([1.37, 0.62]);
  });
  it('uses lead-ins that are whole samples at 44.1 kHz', () => {
    for (const x of v) if (x.leadInSec) expect(Number.isInteger(Math.round(x.leadInSec * 1e6) * 44100 / 1e6)).toBe(true);
  });

  // ---- spike 2 (T4) ----
  const lr = v.filter((x) => x.level === 'LR');
  it('level LR: REC-like piano on the etude (seed 1) and saints, grades 0 and 1 (another timbre)', () => {
    for (const x of lr) {
      expect(x.comp).toBe('rec');
      expect(x.mix).toBe('piano');
      expect(x.tempo).toBe(124);
      expect(x.name.endsWith(x.recStyle === 'hard' ? '-rec-hard' : '-rec')).toBe(true);
      expect(x.recSeed).toBeDefined();
      expect([0, 1]).toContain(x.lrGrade);
      expect(x.soundFont === 'musescore').toBe(x.lrGrade === 1);
    }
    const tuning = lr.filter((x) => !x.heldOut);
    expect(tuning.map((x) => x.name).sort()).toEqual([
      'etude-piano-t124-straight-rec',
      'etude-piano-t124-straight-rec-hard',
      'etude-piano-t124-straight-sf-muse-rec',
      'etude-piano-t124-straight-sf-muse-rec-hard',
      'piano-t124-straight-rec',
      'piano-t124-straight-rec-hard',
      'piano-t124-straight-sf-muse-rec',
      'piano-t124-straight-sf-muse-rec-hard',
    ]);
    for (const x of tuning) expect(x.etudeSeed).toBeUndefined();
  });
  it('etude3: held out, AABA with a 1-beat pickup, seed 3, LR only', () => {
    const e3 = v.filter((x) => x.name.startsWith('etude3-'));
    expect(e3.map((x) => x.name)).toEqual([
      'etude3-piano-t124-straight-rec',
      'etude3-piano-t124-straight-sf-muse-rec',
      'etude3-piano-t124-straight-rec-hard',
      'etude3-piano-t124-straight-sf-muse-rec-hard',
    ]);
    for (const x of e3) {
      expect(x).toMatchObject({ heldOut: true, level: 'LR', etudeSeed: 3, etudeForm: 'aaba', pickupBeats: 1, recSeed: 3 });
    }
  });
  it('T4b: the harder REC-like style only on the -rec-hard variants, same grades and seeds as T4', () => {
    const hard = lr.filter((x) => x.recStyle === 'hard');
    expect(hard).toHaveLength(6);
    for (const x of hard) {
      const t4 = lr.find((y) => y.name === x.name.replace(/-hard$/, ''))!;
      expect({ ...x, name: t4.name, recStyle: undefined }).toEqual({ ...t4, recStyle: undefined });
    }
    for (const x of v) if (x.recStyle) expect(x.comp).toBe('rec');
  });
  it('level V: one etude with the wider vocabulary, tuning', () => {
    const lv = v.filter((x) => x.level === 'V');
    expect(lv.map((x) => x.name)).toEqual(['etudevoc-full-t90-straight']);
    expect(lv[0].vocabShare).toBeGreaterThan(0);
    expect(lv[0].heldOut).toBeUndefined();
  });
  it('keeps the first 38 (spike 1) variants as they were', () => {
    expect(v.slice(0, 38).every((x) => typeof x.level === 'number')).toBe(true);
    for (const x of v.slice(0, 38)) {
      expect(x.lrGrade).toBeUndefined();
      expect(x.recSeed).toBeUndefined();
      expect(x.pickupBeats).toBeUndefined();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { chordPcs, parseChord2 } from './chordName';
import { chartOf, writtenNotes } from './render';
import { allC2Variants, C2_SETS, splitOfName, synthParams } from './variants';
import { handPcs, lhNotes, rhCandidates, rhVoicing, RH_HI, RH_LO } from './voicing';

const pcs = (name: string, form?: 'full' | 'no5' | 'rootless') => {
  const h = handPcs(parseChord2(name), form);
  return { rh: [...h.rh].sort((a, b) => a - b), lhAbove: h.lhAbove };
};

describe('voicing', () => {
  it('right hand: triads whole, a 4-note chord leaves its bass tone to the left hand, a non-chord bass leaves the hand as is', () => {
    expect(pcs('C/E').rh).toEqual([0, 4, 7]);
    expect(pcs('C/D').rh).toEqual([0, 4, 7]);
    expect(pcs('C7').rh).toEqual([4, 7, 10]);
    expect(pcs('Am7/G').rh).toEqual([0, 4, 9]);
    expect(pcs('Am6').rh).toEqual([0, 4, 6]);
    expect(pcs('AmM7').rh).toEqual([0, 4, 8]);
  });

  it('9th forms: full = RH 3-7-9 + LH 1-5, no5 = RH 3-7-9, rootless = RH 3-5-7-9', () => {
    expect(pcs('C9', 'full')).toEqual({ rh: [2, 4, 10], lhAbove: [7] });
    expect(pcs('C9', 'no5')).toEqual({ rh: [2, 4, 10], lhAbove: [] });
    expect(pcs('Cmaj9', 'rootless')).toEqual({ rh: [2, 4, 7, 11], lhAbove: [] }); // = Em7 over C
    expect(pcs('Cm9', 'rootless')).toEqual({ rh: [2, 3, 7, 10], lhAbove: [] }); // = Ebmaj7 over C
    expect(() => handPcs(parseChord2('C9/E'))).toThrow();
  });

  it('candidates are close inversions inside the range; an unchanged chord keeps its exact shape (C -> C/D -> C/E)', () => {
    for (const v of rhCandidates([0, 4, 7])) {
      expect(v[v.length - 1] - v[0]).toBeLessThan(12);
      expect(v[0]).toBeGreaterThanOrEqual(RH_LO);
      expect(v[v.length - 1]).toBeLessThanOrEqual(RH_HI);
    }
    const c = rhVoicing([0, 4, 7], null, 66);
    expect(rhVoicing(handPcs(parseChord2('C/D')).rh, c, 66)).toEqual(c);
    // inner-voice cliche: only one voice moves by a semitone
    const am = rhVoicing(handPcs(parseChord2('Am')).rh, [57, 60, 64], 64);
    const mM7 = rhVoicing(handPcs(parseChord2('AmM7')).rh, am, 64);
    expect(mM7.filter((m) => !am.includes(m))).toHaveLength(1);
  });

  it('left hand: bass in C2..B2, octave, and the 1-5 guard only over a root with a perfect 5th (never on 9ths)', () => {
    expect(lhNotes(parseChord2('C'), 'single')).toEqual([36]);
    expect(lhNotes(parseChord2('G'), 'octave')).toEqual([31, 43]);
    expect(lhNotes(parseChord2('C#'), 'octave')).toEqual([37, 49]);
    expect(lhNotes(parseChord2('C'), 'fifth')).toEqual([36, 43]);
    expect(lhNotes(parseChord2('C/E'), 'fifth')).toEqual([40]);
    expect(lhNotes(parseChord2('Bm7b5'), 'fifth')).toEqual([47]);
    expect(lhNotes(parseChord2('C9'), 'fifth')).toEqual([36]);
  });

  it('every chart of every variant: the hands of each chord sound exactly its pitch classes, and the hands never cross', () => {
    for (const v of allC2Variants()) {
      const p = synthParams(v);
      const chart = chartOf(v, p);
      const notes = writtenNotes(chart, p, v.bass !== null);
      chart.chords.forEach((c, i) => {
        const mine = notes.filter((n) => n.seg === i);
        const set = [...new Set(mine.map((n) => n.midi % 12))].sort((a, b) => a - b);
        expect(set, `${v.name} ${c.text}`).toEqual(chordPcs(c.chord, c.form === 'no5' ? 1 : 0));
        const lhMax = Math.max(...mine.filter((n) => n.part === 'lh').map((n) => n.midi));
        expect(Math.min(...mine.filter((n) => n.part === 'rh').map((n) => n.midi))).toBeGreaterThan(lhMax);
      });
    }
  });
});

describe('variants', () => {
  const all = allC2Variants();
  it('counts, unique names, split by name, held-out timbres only in held-out', () => {
    expect(new Set(all.map((v) => v.name)).size).toBe(all.length);
    for (const v of all) {
      expect(splitOfName(v.name)).toBe(v.split);
      expect(v.heldOut).toBe(v.split === 'heldOut');
      expect(v.piano === 'P2').toBe(v.heldOut);
      if (v.bass !== null) expect(v.bass === 'C').toBe(v.heldOut);
      expect(v.bass === null).toBe(v.variation === 'piano' || v.variation === 'lh15');
      const p = synthParams(v);
      expect(p.room.kind === 'fdn').toBe(v.heldOut && v.variation !== 'clean');
    }
    expect(splitOfName('out/chords2/c2-h-v1-human-s8.wav')).toBe('heldOut');
    expect(splitOfName('syn-b0-walking-tA-s1')).toBeNull();
    expect(C2_SETS.flatMap((s) => s.seeds)).toEqual([1, 2, 3, 4, 5, 8, 9]);
  });

  it('refuses held-out timbres or rooms outside held-out and the reverse', () => {
    const v = all.find((x) => x.name === 'c2-d-v1-human-s4')!;
    expect(() => synthParams({ ...v, piano: 'P2' })).toThrow();
    expect(() => synthParams({ ...v, bass: 'C' })).toThrow();
    expect(() => synthParams({ ...v, seed: 8 })).toThrow();
    const h = all.find((x) => x.name === 'c2-h-v1-human-s8')!;
    expect(() => synthParams({ ...h, piano: 'P1' })).toThrow();
    expect(() => synthParams({ ...h, heldOut: false })).toThrow();
  });

  it('the variations of a seed play the same chart; tuning seed 1 keeps the rows in their own key', () => {
    const chartText = (name: string) => {
      const v = all.find((x) => x.name === name)!;
      return chartOf(v).chords.map((c) => c.text).join(' ');
    };
    expect(chartText('c2-d-v2-human-s5')).toBe(chartText('c2-d-v2-lh15-s5'));
    expect(chartText('c2-t-pair-a1-clean-s1')).toBe('C F G7 C6');
    expect(synthParams(all.find((x) => x.name === 'c2-t-pair-a1-piano-s1')!).transpose).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { parseSong } from '../../../src/lib/parseSong';
import { saintsSampleText } from '../../../src/lib/saintsSample';
import { chordTimeline } from './chordTimeline';
import { chordEtude } from './etude';
import { modulatedBars, modulateSong, modulationKeys, transposeMelodyBars } from './modulate';
import { buildScoreTex, importScore } from './truth';
import { pianoPartBody } from './pianoPart';
import type { Modulation, Variant } from './types';
import { allVariants } from './variants';

const saints = parseSong(saintsSampleText);
const saintsTl = chordTimeline(saints);
const etude = parseSong(chordEtude(1).text);
const etudeTl = chordTimeline(etude);

const chordsOf = (tl: ReturnType<typeof chordTimeline>, bar0: number, bar1: number) =>
  tl.chords.filter((c) => c.bar >= bar0 && c.bar < bar1).map((c) => c.text);

describe('modulateSong / chords', () => {
  const m: Modulation = { sections: [1], semitones: 2, baseKey: 'C', tag: 'x' };
  const mod = chordTimeline(modulateSong(saints, m));
  it('saints last section +2: hand-computed chords (C->D, G7->A7, C7->D7, F->G)', () => {
    expect(chordsOf(saintsTl, 16, 32)).toEqual(['C', 'G7', 'C', 'C7', 'F', 'C', 'G7', 'C']);
    expect(chordsOf(mod, 16, 32)).toEqual(['D', 'A7', 'D', 'D7', 'G', 'D', 'A7', 'D']);
  });
  it('other sections and the structure are unchanged', () => {
    expect(chordsOf(mod, 0, 16)).toEqual(chordsOf(saintsTl, 0, 16));
    expect(mod.bars).toBe(saintsTl.bars);
    expect(mod.sections).toEqual(saintsTl.sections);
    expect(mod.chords.map((c) => [c.bar, c.beat])).toEqual(saintsTl.chords.map((c) => [c.bar, c.beat]));
  });
  it('saints last section +7: C->G, G7->D7, C7->G7, F->C', () => {
    const t = chordTimeline(modulateSong(saints, { ...m, semitones: 7 }));
    expect(chordsOf(t, 16, 32)).toEqual(['G', 'D7', 'G', 'G7', 'C', 'G', 'D7', 'G']);
  });
  it('etude B1 and B2 +7: C->G, F->C, Eb->Bb', () => {
    const mm: Modulation = { sections: [1, 3], semitones: 7, baseKey: 'C', tag: 'x' };
    const t = chordTimeline(modulateSong(etude, mm));
    const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
    const split = (s: string) => /^([A-G][#b]?)(.*)$/.exec(s)!.slice(1);
    for (const c of etudeTl.chords) {
      const got = t.chords.find((x) => x.bar === c.bar && x.beat === c.beat)!.text;
      const inB = (c.bar >= 8 && c.bar < 16) || c.bar >= 24;
      if (!inB) expect(got).toBe(c.text);
      else {
        const [r, q] = split(c.text);
        const [gr, gq] = split(got);
        expect(gq).toBe(q);
        expect(PC[gr]).toBe((PC[r] + 7) % 12);
      }
    }
  });
  it('rejects bad input', () => {
    expect(() => modulateSong(saints, { ...m, sections: [5] })).toThrow();
    expect(() => modulateSong(saints, { ...m, semitones: 0 })).toThrow();
    expect(() => modulateSong(saints, { ...m, sections: [] })).toThrow();
    expect(() => modulateSong(saints, { ...m, sections: [1, 1] })).toThrow();
  });
});

describe('modulationKeys', () => {
  it('saints last +2: C from 0, D from bar 16', () => {
    const m: Modulation = { sections: [1], semitones: 2, baseKey: 'C', tag: 'x' };
    expect(modulationKeys(saintsTl, m)).toEqual([{ startBar: 0, key: 'C' }, { startBar: 16, key: 'D' }]);
  });
  it('etude B1+B2 +7: four runs; last section +1 -> Db at bar 24', () => {
    expect(modulationKeys(etudeTl, { sections: [1, 3], semitones: 7, baseKey: 'C', tag: 'x' })).toEqual([
      { startBar: 0, key: 'C' }, { startBar: 8, key: 'G' }, { startBar: 16, key: 'C' }, { startBar: 24, key: 'G' },
    ]);
    expect(modulationKeys(etudeTl, { sections: [3], semitones: 1, baseKey: 'C', tag: 'x' })).toEqual([
      { startBar: 0, key: 'C' }, { startBar: 24, key: 'Db' },
    ]);
  });
  it('minor base key keeps m; first section modulated starts at bar 0; adjacent sections merge', () => {
    expect(modulationKeys(etudeTl, { sections: [0, 1], semitones: 7, baseKey: 'Am', tag: 'x' })).toEqual([
      { startBar: 0, key: 'Em' }, { startBar: 16, key: 'Am' },
    ]);
  });
  it('pickup bars shift the numbering', () => {
    const m: Modulation = { sections: [1], semitones: 2, baseKey: 'C', tag: 'x' };
    expect(modulationKeys(saintsTl, m, 1)).toEqual([{ startBar: 0, key: 'C' }, { startBar: 15, key: 'D' }]);
  });
});

describe('transposeMelodyBars', () => {
  const m: Modulation = { sections: [1], semitones: 2, baseKey: 'C', tag: 'x' };
  const v: Variant = { song: 'saints', mix: 'full', tempo: 116, swing: 'none', click: false, name: 't' };
  const pitches = (score: ReturnType<typeof importScore>) => {
    const staff = score.tracks.find((t) => t.name !== 'Piano' && !t.staves[0].isPercussion)!.staves[0];
    return staff.bars.map((b) => b.voices[0].beats.flatMap((be) => be.notes.map((n) => n.octave * 12 + n.tone)));
  };
  it('moves the notes of the modulated bars by n semitones, others untouched; piano and drums untouched', () => {
    const tex = buildScoreTex(saints, pianoPartBody(saintsTl), { ...v, mix: 'full' });
    const a = importScore(tex);
    const b = importScore(tex);
    transposeMelodyBars(b, modulatedBars(saintsTl, m), 2);
    const pa = pitches(a);
    const pb = pitches(b);
    expect(pa).toHaveLength(32);
    pa.forEach((bar, i) => expect(pb[i]).toEqual(i >= 16 ? bar.map((x) => x + 2) : bar));
    const piano = (s: typeof a) => s.tracks.find((t) => t.name === 'Piano')!.staves[0].bars.map((x) => x.voices[0].beats.map((be) => be.notes.map((n) => n.octave * 12 + n.tone)));
    expect(piano(b)).toEqual(piano(a));
  });
});

describe('variants', () => {
  const mods = allVariants().filter((v) => v.modulation);
  it('7 modulation variants; names unique and tagged; only the etude2 one is held out', () => {
    expect(mods.map((v) => v.name)).toHaveLength(7);
    expect(new Set(allVariants().map((v) => v.name)).size).toBe(allVariants().length);
    expect(mods.every((v) => v.name.includes('-mod'))).toBe(true);
    expect(mods.filter((v) => v.heldOut).map((v) => v.etudeSeed)).toEqual([2]);
    expect(mods.filter((v) => v.level === 'LR').every((v) => v.comp === 'rec' && v.lrGrade === 1)).toBe(true);
  });
});

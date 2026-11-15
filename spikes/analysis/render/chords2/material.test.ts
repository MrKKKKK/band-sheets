import { describe, expect, it } from 'vitest';
import { OTHER_ROWS, TRUTH_ROWS } from '../../ts/chords2/identicalPairs';
import { STAGE_ADDS, stageQualities } from '../../ts/chords2/vocab';
import { bassPc, chordName, chordPcs, notePc, parseChord2, upperName } from './chordName';
import { bChart, parseBars, phraseChart, PHRASES, stageChart, STAGE_SECTIONS, type Chart } from './material';
import { prng } from '../prng';
import { pairOther, rowTruth } from './truth';

describe('chordName', () => {
  it('reads and writes every chords2 quality, with /X, sharps out, flats in', () => {
    expect(parseChord2('AmM7/G#')).toEqual({ root: 9, quality: 'mM7', bass: 8 });
    expect(parseChord2('Bbmaj9')).toEqual({ root: 10, quality: 'maj9', bass: null });
    expect(parseChord2('C/C')).toEqual({ root: 0, quality: 'maj', bass: null });
    expect(chordName(parseChord2('Ebm7b5/A'))).toBe('D#m7b5/A');
    for (const q of stageQualities('V3')) expect(parseChord2(chordName({ root: 2, quality: q, bass: 7 })).quality).toBe(q);
    expect(() => parseChord2('C13')).toThrow();
  });

  it('pitch classes: template (+ 9th no-5th form) plus the bass', () => {
    expect(chordPcs(parseChord2('C6/E'))).toEqual([0, 4, 7, 9]);
    expect(chordPcs(parseChord2('C/D'))).toEqual([0, 2, 4, 7]);
    expect(chordPcs(parseChord2('C9'), 1)).toEqual([0, 2, 4, 10]);
  });
});

describe('parseBars', () => {
  it('splits bars evenly and keeps the @row marks', () => {
    expect(parseBars('Dm DmM7 | G7@A1,B2')).toEqual([
      { beat: 0, beats: 2, name: 'Dm', rows: [] },
      { beat: 2, beats: 2, name: 'DmM7', rows: [] },
      { beat: 4, beats: 4, name: 'G7', rows: ['A1', 'B2'] },
    ]);
    expect(() => parseBars('C D E')).toThrow();
  });
});

const prevOf = (ch: Chart, i: number) => (i > 0 ? upperName(ch.chords[i - 1].chord) : null);
const nextOf = (ch: Chart, i: number) => (i + 1 < ch.chords.length ? upperName(ch.chords[i + 1].chord) : null);
const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : chordName(parseChord2(a)) === chordName(parseChord2(b)));

describe('truth-table phrases (every row of identicalPairs.ts, in its own key and transposed)', () => {
  for (const k of [0, 5]) {
    it(`transposed by ${k}: each TRUTH_ROW is the X of exactly one phrase with its key, prev, next, bass and readings`, () => {
      const seen = new Map<string, number>();
      for (const p of PHRASES) {
        const ch = phraseChart(p, k);
        ch.chords.forEach((c, i) => {
          for (const id of c.rows ?? []) {
            seen.set(id, (seen.get(id) ?? 0) + 1);
            const t = TRUTH_ROWS.find((r) => r.id === id);
            const o = OTHER_ROWS.find((r) => r.id === id);
            const row = t ?? o!;
            const minor = row.key.endsWith('m');
            expect(ch.key, id).toEqual({ tonic: (notePc(minor ? row.key.slice(0, -1) : row.key) + k) % 12, minor });
            const tr = (name: string | null) => (name === null ? null : chordName({ ...parseChord2(name), root: (parseChord2(name).root + k) % 12, bass: null }));
            expect(same(prevOf(ch, i), tr(row.prev)), `${id} prev`).toBe(true);
            expect(same(nextOf(ch, i), tr(row.next)), `${id} next`).toBe(true);
            const rt = rowTruth(id, k);
            expect(c.text, `${id} X`).toBe(rt.truth);
            if (t) {
              expect(bassPc(c.chord)).toBe((notePc(t.bass) + k) % 12);
              expect(upperName(pairOther(c.chord)!.other)).toBe(rt.candidate);
              expect(t.conflict).toBe(bassPc(c.chord) !== c.chord.root);
            } else {
              // OTHER_ROWS: the notes played, low to high (pitch classes)
              expect(chordPcs(c.chord)).toEqual([...new Set(o!.notes.split(' ').map((n) => (notePc(n) + k) % 12))].sort((a, b) => a - b));
            }
          }
        });
      }
      for (const r of [...TRUTH_ROWS, ...OTHER_ROWS]) expect(seen.get(r.id), r.id).toBe(1);
    });
  }

  it('a phrase uses only the qualities of its stage', () => {
    for (const p of PHRASES) {
      const qs = stageQualities(p.stage);
      for (const c of phraseChart(p, 0).chords) expect(qs, `${p.id} ${c.text}`).toContain(c.chord.quality);
    }
  });
});

describe('stage songs', () => {
  it('V1-V3: 16 bars, 4 sections, only the stage vocabulary, every new quality of the stage in every song, all three 9th forms in V3', () => {
    for (const stage of ['V1', 'V2', 'V3'] as const) {
      const qs = stageQualities(stage);
      const seen = new Set<string>();
      for (let s = 1; s <= 7; s++) {
        const ch = stageChart(stage, prng(s));
        for (const q of STAGE_ADDS[stage]) expect(ch.chords.map((c) => c.chord.quality), `${stage} seed ${s}`).toContain(q);
        expect([ch.bars, ch.sections.length]).toEqual([16, 4]);
        expect(ch.chords.reduce((a, c) => a + c.beats, 0)).toBe(64);
        for (const c of ch.chords) {
          expect(qs).toContain(c.chord.quality);
          seen.add(c.chord.quality);
        }
        if (stage === 'V3') expect(new Set(ch.chords.filter((c) => c.form).map((c) => c.form))).toEqual(new Set(['full', 'no5', 'rootless']));
        else expect(ch.chords.some((c) => c.form)).toBe(false);
      }
      for (const q of STAGE_ADDS[stage]) expect(seen, `${stage} ${q}`).toContain(q);
    }
  });

  it('every stage template parses and lasts 4 bars', () => {
    for (const tpls of Object.values(STAGE_SECTIONS))
      for (const t of tpls) {
        const raw = parseBars(t.text);
        expect(raw.reduce((a, r) => a + r.beats, 0), t.kind).toBe(16);
        for (const r of raw) parseChord2(r.name);
      }
  });

  it('B: spike 6 songs, slash chords present, consecutive equal chords merged', () => {
    const ch = bChart(prng(3));
    expect(ch.chords.reduce((a, c) => a + c.beats, 0)).toBe(64);
    expect(ch.chords.some((c) => c.chord.bass !== null)).toBe(true);
    for (let i = 1; i < ch.chords.length; i++) expect(ch.chords[i].text === ch.chords[i - 1].text && ch.chords[i].beat === ch.chords[i - 1].beat + ch.chords[i - 1].beats).toBe(false);
  });
});

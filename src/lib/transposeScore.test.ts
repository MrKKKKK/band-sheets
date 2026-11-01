import { importer, model, Settings } from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { partsToAlphaTex } from './partsToAlphaTex';
import { disambiguateChordCase, restoreChordNames } from './chordCase';
import { transposeScore } from './transposeScore';

function read(tex: string): model.Score {
  const imp = new importer.AlphaTexImporter();
  imp.logErrors = false;
  imp.initFromString(tex, new Settings());
  return imp.readScore();
}
const midi = (s: model.Score, bar = 0) =>
  s.tracks[0].staves[0].bars[bar].voices[0].beats.map((b) =>
    b.notes.map((n) => n.realValue),
  );

const MEL =
  '.\n\\track "M"\n\\ts 4 4\n\\ks c\n:4 C4{ch "C"} E4{ch "Am7/G"} G4 r |\n';

describe('transposeScore', () => {
  it('shifts notes, key signature and chord names', () => {
    const s = read(MEL);
    transposeScore(s, -2);
    expect(midi(s)).toEqual([[58], [62], [65], []]);
    const bar = s.tracks[0].staves[0].bars[0];
    expect(bar.keySignature).toBe(-2);
    expect(bar.keySignatureType).toBe(model.KeySignatureType.Major);
    const names = [...s.tracks[0].staves[0].chords!.values()].map(
      (c) => c.name,
    );
    expect(names).toEqual(['Bb', 'Gm7/F']);
  });
  it('is a no-op at 0 and wraps octaves', () => {
    const s = read(MEL);
    transposeScore(s, 0);
    expect(midi(s)).toEqual([[60], [64], [67], []]);
    transposeScore(s, 6);
    expect(midi(s)).toEqual([[66], [70], [73], []]);
    expect(s.tracks[0].staves[0].bars[0].keySignature).toBe(6);
  });
  it('keeps minor keys minor', () => {
    const s = read('.\n\\track "M"\n\\ks aminor\n:4 A3 B3 |\n');
    transposeScore(s, 1);
    const bar = s.tracks[0].staves[0].bars[0];
    expect(bar.keySignature).toBe(-5); // Bbm
    expect(bar.keySignatureType).toBe(model.KeySignatureType.Minor);
  });
  it('leaves drums alone', () => {
    const tex = partsToAlphaTex({
      meta: { title: '' },
      chart: [],
      parts: [
        {
          name: 'D',
          body: '\\instrument percussion\n:8 (HH BD) HH (HH SD) HH |',
        },
      ],
    });
    const s = read(tex);
    const before = JSON.stringify(
      s.tracks[0].staves[0].bars[0].voices[0].beats.map((b) =>
        b.notes.map((n) => n.percussionArticulation),
      ),
    );
    transposeScore(s, 3);
    const after = JSON.stringify(
      s.tracks[0].staves[0].bars[0].voices[0].beats.map((b) =>
        b.notes.map((n) => n.percussionArticulation),
      ),
    );
    expect(after).toBe(before);
  });
  it('resets forced accidentals so the new key decides the spelling', () => {
    const s = read('.\n\\track "M"\n\\ks c\n:4 Bb3 |\n');
    transposeScore(s, 0);
    transposeScore(s, 5);
    const n = s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(n.realValue).toBe(63);
    expect(n.accidentalMode).toBe(model.NoteAccidentalMode.Default);
  });
});

describe('transposeScore keeps chord quality case', () => {
  const names = (s: model.Score) =>
    [...s.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats)].map(
      (b) => b.chord?.name,
    );
  const TEX = (chords: string[]) =>
    `.\n\\track "M"\n\\ts 4 4\n\\ks c\n${chords.map((c) => `:4 C4{ch "${c}"}`).join(' ')} |\n`;
  const CHORDS = ['C#M7', 'C#m7', 'DbM7', 'C#M7/G#', 'CmM7', 'C#m7-5', 'CM9'];

  it('works after disambiguate -> restore, both directions', () => {
    for (const [semi, expected] of [
      [1, ['DM7', 'Dm7', 'DM7', 'DM7/A', 'DbmM7', 'Dm7-5', 'DbM9']],
      [-1, ['CM7', 'Cm7', 'CM7', 'CM7/G', 'BmM7', 'Cm7-5', 'BM9']],
    ] as const) {
      const s = read(disambiguateChordCase(TEX(CHORDS)));
      restoreChordNames(s);
      transposeScore(s, semi);
      expect(names(s)).toEqual(expected);
    }
  });
});

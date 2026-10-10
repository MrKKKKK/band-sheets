/**
 * Display transposition of an imported alphaTab score (issue #7).
 *
 * Route (chosen after checking alphaTab 1.8.4): mutate the imported MODEL
 * right after import (`api.scoreLoaded`, before layout), like
 * `percussionStemsUp`; the stored alphaTex is never touched. alphaTab's own
 * display transposition (`staff.displayTranspositionPitch`) moves the notes
 * but neither the key signature's spelling choice nor the `ch` chord names,
 * and text rewriting of alphaTex would have to understand every spelling of
 * a hand-written part. On the model:
 *  - every note of a non-percussion staff moves by `semitones`
 *    (`octave`/`tone`); `accidentalMode` is reset to Default so alphaTab
 *    spells it by the (new) key signature;
 *  - every bar's key signature becomes `transposeKey(...)` (fewest
 *    accidentals, ≤ 7);
 *  - chord names (`staff.chords`, the `ch "…"` text) go through
 *    `transposeChord`, spelled by the staff's first bar's new key.
 * Drums (percussion staves) are left alone.
 */
import { model } from '@coderline/alphatab';
import { keyFifths, transposeChord, transposeKey } from './transpose';

const MAJOR = 'Cb Gb Db Ab Eb Bb F C G D A E B F# C#'.split(' ');
const MINOR = 'Ab Eb Bb F C G D A E B F# C# G# D# A#'.split(' ');

function barKey(bar: model.Bar): string {
  const i = bar.keySignature + 7;
  return bar.keySignatureType === model.KeySignatureType.Minor
    ? `${MINOR[i]}m`
    : MAJOR[i];
}

export function transposeScore(score: model.Score, semitones: number): void {
  if (semitones === 0) return;
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      let chordKey: string | undefined;
      for (const bar of staff.bars) {
        const next = transposeKey(barKey(bar), semitones);
        const fifths = keyFifths(next ?? undefined);
        if (next !== null && fifths !== null) {
          bar.keySignature = fifths as model.KeySignature;
          chordKey ??= next;
        }
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              const value = note.octave * 12 + note.tone + semitones;
              note.octave = Math.floor(value / 12);
              note.tone = value - note.octave * 12;
              note.accidentalMode = model.NoteAccidentalMode.Default;
            }
          }
        }
      }
      for (const chord of staff.chords?.values() ?? []) {
        chord.name = transposeChord(chord.name, semitones, chordKey);
      }
    }
  }
}

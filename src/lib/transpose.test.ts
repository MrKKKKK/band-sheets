import { describe, expect, it } from 'vitest';
import type { ChartSection } from './song';
import {
  clampTranspose,
  displayKey,
  formatTranspose,
  keyLabel,
  respellChord,
  transposeChartSection,
  transposeChord,
  transposeKey,
} from './transpose';

describe('clampTranspose', () => {
  it('clamps to -6..6 and rounds', () => {
    expect(clampTranspose(9)).toBe(6);
    expect(clampTranspose(-9)).toBe(-6);
    expect(clampTranspose(2.4)).toBe(2);
    expect(clampTranspose(Number.NaN)).toBe(0);
  });
});

describe('formatTranspose', () => {
  it('uses real signs and the minus sign', () => {
    expect(formatTranspose(0)).toBe('0');
    expect(formatTranspose(3)).toBe('+3');
    expect(formatTranspose(-2)).toBe('−2');
  });
});

describe('transposeKey', () => {
  it('prefers the signature with fewer accidentals', () => {
    expect(transposeKey('C', -2)).toBe('Bb');
    expect(transposeKey('C', 1)).toBe('Db');
    expect(transposeKey('C', 3)).toBe('Eb');
    expect(transposeKey('G', 2)).toBe('A');
    expect(transposeKey('E', 1)).toBe('F');
    expect(transposeKey('A', 4)).toBe('Db');
    expect(transposeKey('D', 5)).toBe('G');
  });
  it('breaks the 6-accidental tie by direction', () => {
    expect(transposeKey('C', 6)).toBe('F#');
    expect(transposeKey('C', -6)).toBe('Gb');
  });
  it('handles minor keys', () => {
    expect(transposeKey('Am', 2)).toBe('Bm');
    expect(transposeKey('Am', 1)).toBe('Bbm');
    expect(transposeKey('Em', -1)).toBe('Ebm');
    expect(transposeKey('Am', 6)).toBe('D#m');
    expect(transposeKey('Am', -6)).toBe('Ebm');
    expect(transposeKey('F#m', 1)).toBe('Gm');
  });
  it('is identity at 0 for valid keys and null for invalid ones', () => {
    expect(transposeKey('Bb', 0)).toBe('Bb');
    expect(transposeKey('', 2)).toBeNull();
    expect(transposeKey('H', 2)).toBeNull();
    expect(transposeKey(undefined, 2)).toBeNull();
  });
});

describe('transposeChord', () => {
  it('returns the text unchanged at 0', () => {
    expect(transposeChord('C#m7', 0, 'C')).toBe('C#m7');
  });
  it('keeps qualities and extensions', () => {
    const q = [
      '',
      'm',
      '7',
      'maj7',
      'm7',
      'add9',
      'sus4',
      'dim',
      'aug',
      'm7b5',
    ];
    for (const s of q) expect(transposeChord(`C${s}`, 2, 'D')).toBe(`D${s}`);
  });
  it('transposes slash chords (root and bass)', () => {
    expect(transposeChord('C/E', 2, 'D')).toBe('D/F#');
    expect(transposeChord('Am7/G', -2, 'Bb')).toBe('Gm7/F');
    expect(transposeChord('Cadd9/B', 3, 'Eb')).toBe('Ebadd9/D');
  });
  it('leaves opaque text alone', () => {
    for (const t of ['N.C.', '(C)', '%', 'x2']) {
      expect(transposeChord(t, 2, 'D')).toBe(t);
    }
    expect(transposeChord('C6/9', 2, 'D')).toBe('D6/9');
  });
  it('does not touch notes inside parentheses', () => {
    expect(transposeChord('C7(b9)', 2, 'D')).toBe('D7(b9)');
    expect(transposeChord('Bm7(b5)', 1, 'C')).toBe('Cm7(b5)');
  });
  it('spells by the target key', () => {
    expect(transposeChord('C', 1, 'Db')).toBe('Db');
    expect(transposeChord('C', 1, 'C#')).toBe('C#');
    expect(transposeChord('F', 1, 'Gb')).toBe('Gb');
    expect(transposeChord('B', 6, 'F#')).toBe('F');
    expect(transposeChord('Em', 1, 'F#')).toBe('Fm');
    expect(transposeChord('G', -2, 'Bb')).toBe('F');
    expect(transposeChord('A', -2, 'Bb')).toBe('G');
    expect(transposeChord('Bb', -2, 'Bb')).toBe('Ab');
    expect(transposeChord('E', -2, 'Bb')).toBe('D');
  });
  it('uses the key of a minor target', () => {
    expect(transposeChord('Am', 1, 'Bbm')).toBe('Bbm');
    expect(transposeChord('E7', 1, 'Bbm')).toBe('F7');
    expect(transposeChord('C', 1, 'Bbm')).toBe('Db');
  });
  it('without a usable key follows the input accidental, else direction', () => {
    expect(transposeChord('Bb', 1, undefined)).toBe('B');
    expect(transposeChord('Bb', 2, undefined)).toBe('C');
    expect(transposeChord('Bb', 3, undefined)).toBe('Db');
    expect(transposeChord('F#', 1, undefined)).toBe('G');
    expect(transposeChord('F#', 2, undefined)).toBe('G#');
    expect(transposeChord('C', 1, undefined)).toBe('C#');
    expect(transposeChord('C', -1, undefined)).toBe('B');
    expect(transposeChord('D', -1, undefined)).toBe('Db');
  });
  it('wraps around the octave', () => {
    expect(transposeChord('B', 1, 'C')).toBe('C');
    expect(transposeChord('C', -1, 'B')).toBe('B');
  });
});

describe('transposeChartSection', () => {
  const section: ChartSection = {
    kind: 'verse',
    label: 'A',
    lines: [
      { segments: [{ chord: 'C', lyrics: 'a' }, { lyrics: 'b' }] },
      { raw: '# C' },
      { segments: [] },
    ],
  };
  it('maps chords only and returns the same object at 0', () => {
    expect(transposeChartSection(section, 0, 'C')).toBe(section);
    const t = transposeChartSection(section, -2, 'Bb');
    expect(t.lines[0]).toEqual({
      segments: [{ chord: 'Bb', lyrics: 'a' }, { lyrics: 'b' }],
    });
    expect(t.lines[1]).toEqual({ raw: '# C' });
    expect(t.lines[2]).toEqual({ segments: [] });
    expect(section.lines[0]).toEqual({
      segments: [{ chord: 'C', lyrics: 'a' }, { lyrics: 'b' }],
    });
  });
});

describe('keyLabel', () => {
  it('shows the original and transposed key', () => {
    expect(keyLabel('C', 0)).toBe('キー C');
    expect(keyLabel('C', -2)).toBe('キー C → B♭（−2）');
    expect(keyLabel('Am', 6)).toBe('キー Am → D♯m（+6）');
  });
  it('is null without a usable key', () => {
    expect(keyLabel(undefined, 2)).toBeNull();
    expect(keyLabel('xx', 0)).toBeNull();
  });
  it('displayKey uses ♭ and ♯', () => {
    expect(displayKey('Bbm')).toBe('B♭m');
    expect(displayKey('F#')).toBe('F♯');
    expect(displayKey('B')).toBe('B');
  });
});

describe('respellChord', () => {
  it('respells by the target key, root and slash bass', () => {
    expect(respellChord('G#', 'Ab')).toBe('Ab');
    expect(respellChord('C#m', 'Ab')).toBe('Dbm');
    expect(respellChord('C#m7/G#', 'Ab')).toBe('Dbm7/Ab');
    expect(respellChord('Bb', 'A')).toBe('A#');
    expect(respellChord('Dbmaj7', 'E')).toBe('C#maj7');
  });
  it('keeps the ? mark, quality text and non-chords', () => {
    expect(respellChord('G#m7b5?', 'Db')).toBe('Abm7b5?');
    expect(respellChord('C#/G#?', 'Ab')).toBe('Db/Ab?');
    expect(respellChord('N.C.', 'Ab')).toBe('N.C.');
  });
  it('C / Am / no key keeps the chord own style', () => {
    expect(respellChord('Bb', 'C')).toBe('Bb');
    expect(respellChord('A#', 'Am')).toBe('A#');
    expect(respellChord('Bb', undefined)).toBe('Bb');
  });
  it('plain letters are unchanged', () => {
    expect(respellChord('Am7', 'Eb')).toBe('Am7');
  });
});

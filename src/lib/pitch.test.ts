import { describe, expect, it } from 'vitest';
import {
  codeToSemitone,
  formatPitch,
  keyAccidentals,
  midiToPitch,
  parsePitch,
  pitchToMidi,
  semitoneToPitch,
  staffStep,
  stepToPitch,
  transpose,
  transposeOctave,
} from './pitch';

describe('parsePitch', () => {
  it('parses letter, accidental and octave', () => {
    expect(parsePitch('C4')).toEqual({
      letter: 'C',
      accidental: '',
      octave: 4,
    });
    expect(parsePitch('C#4')).toEqual({
      letter: 'C',
      accidental: '#',
      octave: 4,
    });
    expect(parsePitch('Db4')).toEqual({
      letter: 'D',
      accidental: 'b',
      octave: 4,
    });
    expect(parsePitch('Bb3')).toEqual({
      letter: 'B',
      accidental: 'b',
      octave: 3,
    });
    expect(parsePitch('G0')).toEqual({
      letter: 'G',
      accidental: '',
      octave: 0,
    });
    expect(parsePitch('A8')).toEqual({
      letter: 'A',
      accidental: '',
      octave: 8,
    });
  });

  it.each([
    '',
    'H4',
    'C9',
    'C-1',
    'c4',
    'C##4',
    'C4x',
    'C',
    '4',
    'C 4',
    'Cb#4',
  ])('rejects %j', (s) => {
    expect(parsePitch(s)).toBeNull();
  });

  it('round-trips through formatPitch', () => {
    for (const s of ['C4', 'C#4', 'Db4', 'Bb3', 'G0', 'A8', 'E4', 'F5']) {
      expect(formatPitch(parsePitch(s)!)).toBe(s);
    }
  });
});

describe('pitchToMidi', () => {
  it('C4 is 60', () => {
    expect(pitchToMidi(parsePitch('C4')!)).toBe(60);
  });

  it.each([
    ['C4', 60],
    ['C#4', 61],
    ['Db4', 61],
    ['B3', 59],
    ['C5', 72],
    ['Bb3', 58],
    ['A0', 21],
  ])('pitchToMidi(%s) → %d', (s, midi) => {
    expect(pitchToMidi(parsePitch(s)!)).toBe(midi);
  });
});

describe('midiToPitch', () => {
  it.each([
    ['C', 'C#4'],
    ['G', 'C#4'],
    ['D', 'C#4'],
    ['F', 'Db4'],
    ['Bb', 'Db4'],
    ['Eb', 'Db4'],
    ['Am', 'C#4'],
    ['Em', 'C#4'],
  ])('spells midi 61 in key %s', (key, expected) => {
    expect(formatPitch(midiToPitch(61, key))).toBe(expected);
  });

  it('defaults to sharp spelling with no key', () => {
    expect(formatPitch(midiToPitch(61))).toBe('C#4');
    expect(formatPitch(midiToPitch(70))).toBe('A#4');
  });

  it('spells naturals the same regardless of key', () => {
    expect(formatPitch(midiToPitch(60, 'Bb'))).toBe('C4');
    expect(formatPitch(midiToPitch(60, 'G'))).toBe('C4');
  });

  it('round-trips through pitchToMidi for a range of midi numbers', () => {
    for (let m = 36; m <= 96; m++) {
      expect(pitchToMidi(midiToPitch(m))).toBe(m);
      expect(pitchToMidi(midiToPitch(m, 'Bb'))).toBe(m);
    }
  });
});

describe('transpose', () => {
  it('transposes by semitones and re-spells per key', () => {
    expect(formatPitch(transpose(parsePitch('C4')!, 1))).toBe('C#4');
    expect(formatPitch(transpose(parsePitch('C4')!, 1, 'F'))).toBe('Db4');
    expect(formatPitch(transpose(parsePitch('C4')!, -1))).toBe('B3');
    expect(formatPitch(transpose(parsePitch('C4')!, 12))).toBe('C5');
  });
});

describe('transposeOctave', () => {
  it('shifts the octave by one, keeping spelling', () => {
    expect(formatPitch(transposeOctave(parsePitch('C#4')!, 1))).toBe('C#5');
    expect(formatPitch(transposeOctave(parsePitch('Db4')!, -1))).toBe('Db3');
  });
});

describe('codeToSemitone', () => {
  it.each([
    ['KeyA', 0],
    ['KeyW', 1],
    ['KeyS', 2],
    ['KeyE', 3],
    ['KeyD', 4],
    ['KeyF', 5],
    ['KeyT', 6],
    ['KeyG', 7],
    ['KeyY', 8],
    ['KeyH', 9],
    ['KeyU', 10],
    ['KeyJ', 11],
    ['KeyK', 12],
  ])('%s → %d', (code, semitone) => {
    expect(codeToSemitone(code)).toBe(semitone);
  });

  it.each(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'Space', 'Digit1', '', 'keyA'])(
    'unknown code %j → null',
    (code) => {
      expect(codeToSemitone(code)).toBeNull();
    },
  );
});

describe('semitoneToPitch', () => {
  it('maps baseOctave + semitone to a pitch, sharp by default', () => {
    expect(formatPitch(semitoneToPitch(4, 0))).toBe('C4');
    expect(formatPitch(semitoneToPitch(4, 12))).toBe('C5');
    expect(formatPitch(semitoneToPitch(4, 10))).toBe('A#4');
  });

  it('respells per key', () => {
    expect(formatPitch(semitoneToPitch(4, 10, 'F'))).toBe('Bb4');
  });
});

describe('staffStep', () => {
  it.each([
    ['E4', 0],
    ['F4', 1],
    ['G4', 2],
    ['F5', 8],
    ['C4', -2],
  ])('staffStep(%s) → %d', (s, step) => {
    expect(staffStep(parsePitch(s)!)).toBe(step);
  });
});

describe('stepToPitch', () => {
  it('applies the key signature accidental for that letter', () => {
    expect(formatPitch(stepToPitch(1, 'G'))).toBe('F#4'); // F → F#
    expect(formatPitch(stepToPitch(4, 'F'))).toBe('Bb4'); // B → Bb
    expect(formatPitch(stepToPitch(1))).toBe('F4'); // no key: natural
    expect(formatPitch(stepToPitch(1, 'C'))).toBe('F4');
    expect(formatPitch(stepToPitch(1, 'Am'))).toBe('F4');
  });

  it('round-trips with staffStep (letter and octave, ignoring accidental)', () => {
    for (let step = -2; step <= 8; step++) {
      const p = stepToPitch(step);
      expect(staffStep(p)).toBe(step);
    }
    const sharp = parsePitch('F#4')!;
    expect(staffStep(sharp)).toBe(1);
    const back = stepToPitch(staffStep(sharp));
    expect(back.letter).toBe('F');
    expect(back.octave).toBe(4);
  });
});

describe('keyAccidentals', () => {
  it.each([
    ['C', {}],
    ['Am', {}],
    ['G', { F: '#' }],
    ['D', { F: '#', C: '#' }],
    ['F', { B: 'b' }],
    ['Bb', { B: 'b', E: 'b' }],
    ['Eb', { B: 'b', E: 'b', A: 'b' }],
    ['Em', { F: '#' }],
  ])('%s → %j', (key, expected) => {
    expect(keyAccidentals(key)).toEqual(expected);
  });

  it('returns {} for an invalid key', () => {
    expect(keyAccidentals('H')).toEqual({});
    expect(keyAccidentals(undefined)).toEqual({});
  });
});

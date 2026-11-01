import { describe, expect, it } from 'vitest';
import { noteName } from './noteNames';

describe('noteName', () => {
  it('names a pitch per mode', () => {
    expect(noteName('C4', 'doremi')).toBe('ド');
    expect(noteName('F#4', 'doremi')).toBe('ファ♯');
    expect(noteName('Bb3', 'letter')).toBe('B♭');
    expect(noteName('C4', 'none')).toBe('');
    expect(noteName('X', 'letter')).toBe('');
  });
});

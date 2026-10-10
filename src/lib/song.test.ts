import { describe, expect, it } from 'vitest';
import { sampleSong } from './fixtures/sampleSong';
import { isDrumPart, isRawLine } from './song';

describe('isDrumPart', () => {
  it('is true only when the body declares a percussion instrument', () => {
    expect(sampleSong.parts.map(isDrumPart)).toEqual([false, true]);
    expect(isDrumPart({ name: 'Drums', body: 'HH |' })).toBe(false);
    expect(isDrumPart({ name: 'x', body: '\\Instrument  Percussion' })).toBe(
      true,
    );
  });
});

describe('isRawLine', () => {
  it('distinguishes raw lines', () => {
    expect(isRawLine({ raw: '# x' })).toBe(true);
    expect(isRawLine({ segments: [] })).toBe(false);
  });
});

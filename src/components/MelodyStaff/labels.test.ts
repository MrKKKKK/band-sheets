import { describe, expect, it } from 'vitest';
import { stateChangeMessage } from './labels';

describe('stateChangeMessage', () => {
  const base = { duration: '4', dotted: false, baseOctave: 4 } as const;

  it('describes duration / dot / base octave changes', () => {
    expect(stateChangeMessage(base, { ...base, duration: '8' })).toBe(
      '8分音符',
    );
    expect(stateChangeMessage(base, { ...base, dotted: true })).toBe(
      '付点あり',
    );
    expect(
      stateChangeMessage({ ...base, dotted: true }, { ...base, dotted: false }),
    ).toBe('付点なし');
    expect(stateChangeMessage(base, { ...base, baseOctave: 5 })).toBe(
      '基準オクターブ 5',
    );
    expect(
      stateChangeMessage(base, { ...base, duration: '2', dotted: true }),
    ).toBe('付点2分音符');
  });

  it('null when nothing changed', () => {
    expect(stateChangeMessage(base, { ...base })).toBeNull();
  });
});

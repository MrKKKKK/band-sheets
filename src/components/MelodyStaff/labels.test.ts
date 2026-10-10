import { describe, expect, it } from 'vitest';
import { describeEvent, stateChangeMessage } from './labels';

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

describe('describeEvent', () => {
  it('includes the chord of a note or a rest', () => {
    expect(
      describeEvent(
        { kind: 'note', pitch: 'G4', ticks: 64, lyric: 'saints', chord: 'G7' },
        3,
      ),
    ).toBe('4音目: ソ4、全音符、歌詞 saints、コード G7');
    expect(describeEvent({ kind: 'rest', ticks: 16, chord: 'N.C.' }, 0)).toBe(
      '1音目: 4分休符、コード N.C.',
    );
    expect(describeEvent({ kind: 'rest', ticks: 16 }, 0)).toBe(
      '1音目: 4分休符',
    );
  });
});

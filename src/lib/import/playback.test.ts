import { describe, expect, it } from 'vitest';
import type { MelodyEvent } from '../melody';
import { parseMelody } from '../melodyParse';
import { serializeMelody } from '../melodyTex';
import { midiToHz, playbackNotes } from './playback';

const n = (pitch: string, ticks: number, slot?: number): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
  ...(slot !== undefined ? { tuplet: { n: 3, slot } } : {}),
});
const r = (ticks: number, slot?: number): MelodyEvent => ({
  kind: 'rest',
  ticks,
  ...(slot !== undefined ? { tuplet: { n: 3, slot } } : {}),
});

const round = (xs: ReturnType<typeof playbackNotes>) =>
  xs.map((x) => ({
    ...x,
    start: Math.round(x.start * 1e6) / 1e6,
    duration: Math.round(x.duration * 1e6) / 1e6,
    hz: Math.round(x.hz * 1e3) / 1e3,
  }));

describe('midiToHz', () => {
  it('A4 = 440 Hz, equal temperament', () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBeCloseTo(880, 9);
    expect(midiToHz(60)).toBeCloseTo(261.626, 3);
  });
});

describe('playbackNotes', () => {
  it('times notes from the bar-1 head at the song tempo (quarters); rests are silent', () => {
    // 120 quarters/min: a quarter (16 ticks) = 0.5 s
    const out = playbackNotes(
      [r(16), n('C4', 16), n('E4', 8), r(8), n('A4', 16)],
      120,
      2,
    );
    expect(round(out)).toEqual([
      { index: 1, start: 2.5, duration: 0.5, midi: 60, hz: 261.626 },
      { index: 2, start: 3, duration: 0.25, midi: 64, hz: 329.628 },
      { index: 4, start: 3.5, duration: 0.5, midi: 69, hz: 440 },
    ]);
  });

  it('a note across a barline (tied when written) sounds once', () => {
    const events = [r(48), n('F4', 32), r(48)];
    // the written form ties it; reading it back gives the same single event
    const back = parseMelody(serializeMelody(events, { num: 4, den: 4 }), {
      num: 4,
      den: 4,
    });
    expect(back.ok && back.events).toEqual(events);
    expect(round(playbackNotes(events, 60, 0))).toEqual([
      { index: 1, start: 3, duration: 2, midi: 65, hz: 349.228 },
    ]);
  });

  it('tuplet slots last span / n (an 8th triplet = a third of a quarter)', () => {
    const out = playbackNotes(
      [n('C4', 8, 0), r(8, 1), n('E4', 8, 2), n('G4', 16)],
      60,
      0,
    );
    expect(round(out)).toEqual([
      { index: 0, start: 0, duration: 0.333333, midi: 60, hz: 261.626 },
      { index: 2, start: 0.666667, duration: 0.333333, midi: 64, hz: 329.628 },
      { index: 3, start: 1, duration: 1, midi: 67, hz: 391.995 },
    ]);
  });

  it('6/8 draft at {tempo: 90}: a dotted quarter lasts 1 s', () => {
    expect(round(playbackNotes([n('D4', 24)], 90, 0))).toEqual([
      { index: 0, start: 0, duration: 1, midi: 62, hz: 293.665 },
    ]);
  });

  it('flat spellings and an empty list', () => {
    expect(playbackNotes([n('Bb3', 16)], 120, 0)[0].midi).toBe(58);
    expect(playbackNotes([], 120, 0)).toEqual([]);
  });

  it('rejects a tempo that is not a positive number', () => {
    expect(() => playbackNotes([n('C4', 16)], 0, 0)).toThrow(RangeError);
    expect(() => playbackNotes([n('C4', 16)], NaN, 0)).toThrow(RangeError);
  });
});

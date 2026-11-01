import { describe, expect, it } from 'vitest';
import { clickBeats } from './clickTrack';
import { takeBars, takeClickNotes } from './takeView';

const meter = { tempo: 96, ts: { num: 4, den: 4 } };

describe('takeBars', () => {
  it('counts the bars after the count-in, rounded', () => {
    expect(takeBars({ durationSec: 24, bar1Sec: 2.5 })).toBe(9);
    expect(takeBars({ durationSec: 7.4, bar1Sec: 2.5 })).toBe(2);
  });

  it('is never negative', () => {
    expect(takeBars({ durationSec: 1, bar1Sec: 2.5 })).toBe(0);
  });
});

describe('takeClickNotes', () => {
  it('has one note per click of the take, at the click times', () => {
    const notes = takeClickNotes({ meter, durationSec: 10 });
    const beats = clickBeats(96, meter.ts, 10);
    expect(notes).toHaveLength(beats.length);
    expect(notes[0]).toMatchObject({ index: 0, start: 0 });
    expect(notes[5].start).toBeCloseTo(beats[5].sec);
  });
});

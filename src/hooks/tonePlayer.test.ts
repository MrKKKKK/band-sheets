import { describe, expect, it, vi } from 'vitest';
import { createTonePlayer, TONE_GAIN } from './tonePlayer';

function fakeContext() {
  const oscs: {
    frequency: { value: number };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    type: string;
  }[] = [];
  const gains: { ramps: [number, number][] }[] = [];
  const ctx = {
    currentTime: 10,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    createOscillator: () => {
      const o = {
        type: '',
        frequency: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      oscs.push(o);
      return o;
    },
    createGain: () => {
      const g = {
        ramps: [] as [number, number][],
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: (v: number, t: number) =>
            g.ramps.push([v, t]),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(g);
      return g;
    },
  };
  return { ctx, oscs, gains };
}

const notes = [
  { index: 0, start: 1, duration: 0.5, midi: 69, hz: 440 },
  { index: 2, start: 2, duration: 1, midi: 72, hz: 523.25 },
];

describe('createTonePlayer', () => {
  it('schedules the notes after fromSec on the context clock, a running note cut at fromSec', () => {
    const f = fakeContext();
    const create = vi.fn(() => f.ctx as unknown as AudioContext);
    const p = createTonePlayer(create);
    expect(p.now()).toBe(0);
    expect(p.start(notes, 2.5)).toBeCloseTo(10.03);
    expect(p.now()).toBe(10);
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.oscs).toHaveLength(1);
    expect(f.oscs[0].frequency.value).toBe(523.25);
    expect(f.oscs[0].type).toBe('sine');
    const at = f.oscs[0].start.mock.calls[0][0] as number;
    expect(at).toBeCloseTo(10.03);
    expect(f.oscs[0].stop.mock.calls[0][0]).toBeCloseTo(at + 0.5);
    expect(Math.max(...f.gains[0].ramps.map((r) => r[0]))).toBe(TONE_GAIN);
  });

  it('stop() stops what is scheduled; start() replaces it; one context is reused', () => {
    const f = fakeContext();
    const create = vi.fn(() => f.ctx as unknown as AudioContext);
    const p = createTonePlayer(create);
    p.start(notes, 0);
    expect(f.oscs).toHaveLength(2);
    p.start(notes, 0);
    expect(f.oscs[0].stop).toHaveBeenCalledTimes(2); // scheduled end + replaced
    p.playOne(440, 0.4);
    expect(f.oscs).toHaveLength(5);
    // the candidate tone is not cut by start / stop
    p.stop();
    p.start(notes, 0);
    expect(f.oscs[4].stop).toHaveBeenCalledTimes(1); // its own scheduled end only
    p.close();
    expect(f.ctx.close).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

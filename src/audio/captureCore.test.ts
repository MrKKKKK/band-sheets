import { describe, expect, it } from 'vitest';
import {
  CaptureCore,
  CHUNK_FRAMES,
  LEVEL_FRAMES,
  type CaptureMessage,
} from './captureCore';

const Q = 128;

function setup() {
  const msgs: CaptureMessage[] = [];
  const core = new CaptureCore((m) => msgs.push(m));
  /** Runs quanta from `fromFrame` to `toFrame`; sample value = its frame / 1e6 (so we can check placement). */
  const run = (fromFrame: number, toFrame: number, channels = 1) => {
    for (let f = fromFrame; f < toFrame; f += Q) {
      const ch = Array.from({ length: channels }, (_, c) =>
        Float32Array.from({ length: Q }, (_, i) =>
          c === 0 ? (f + i) / 1e6 : -(f + i) / 1e6 + 0.5,
        ),
      );
      core.process(ch, f, Q);
    }
  };
  const chunks = () =>
    msgs.filter(
      (m): m is Extract<CaptureMessage, { type: 'chunk' }> =>
        m.type === 'chunk',
    );
  const ends = () => msgs.filter((m) => m.type === 'end');
  return { core, msgs, run, chunks, ends };
}

describe('CaptureCore', () => {
  it('sends nothing but levels before a capture', () => {
    const { run, msgs } = setup();
    run(0, LEVEL_FRAMES * 2);
    expect(msgs.map((m) => m.type)).toEqual(['level', 'level']);
  });

  it('reports the peak of each level window and resets it', () => {
    const msgs: CaptureMessage[] = [];
    const core = new CaptureCore((m) => msgs.push(m));
    const loud = new Float32Array(Q).fill(-0.8);
    const quiet = new Float32Array(Q).fill(0.1);
    for (let i = 0; i < LEVEL_FRAMES / Q; i++)
      core.process([i === 3 ? loud : quiet], i * Q, Q);
    for (let i = 0; i < LEVEL_FRAMES / Q; i++)
      core.process([quiet], LEVEL_FRAMES + i * Q, Q);
    expect(msgs).toEqual([
      { type: 'level', peak: expect.closeTo(0.8, 6) },
      { type: 'level', peak: expect.closeTo(0.1, 6) },
    ]);
  });

  it('captures exactly [from, end) in chunks of CHUNK_FRAMES with their frames, then ends with limit', () => {
    const { core, run, chunks, ends } = setup();
    core.command({ type: 'start', id: 7, from: 1000, end: 1000 + 10000 });
    run(0, 20000);
    const cs = chunks();
    expect(cs.map((c) => c.frame)).toEqual([
      1000,
      1000 + CHUNK_FRAMES,
      1000 + 2 * CHUNK_FRAMES,
    ]);
    expect(cs.map((c) => c.data.length)).toEqual([
      CHUNK_FRAMES,
      CHUNK_FRAMES,
      10000 - 2 * CHUNK_FRAMES,
    ]);
    expect(cs.every((c) => c.id === 7)).toBe(true);
    expect(cs[0].data[0]).toBeCloseTo(1000 / 1e6, 9);
    expect(cs[2].data.at(-1)).toBeCloseTo(10999 / 1e6, 9);
    expect(ends()).toEqual([
      { type: 'end', id: 7, frame: 11000, reason: 'limit' },
    ]);
  });

  it('every chunk comes before the end message', () => {
    const { core, run, msgs } = setup();
    core.command({ type: 'start', id: 1, from: 0, end: 5000 });
    run(0, 6000);
    const types = msgs.filter((m) => m.type !== 'level').map((m) => m.type);
    expect(types.at(-1)).toBe('end');
    expect(types.filter((t) => t === 'end')).toHaveLength(1);
  });

  it('stop at a future frame ends there with reason stopped', () => {
    const { core, run, chunks, ends } = setup();
    core.command({ type: 'start', id: 1, from: 0, end: 100000 });
    run(0, 1024);
    core.command({ type: 'stop', at: 3000 });
    run(1024, 8000);
    const total = chunks().reduce((n, c) => n + c.data.length, 0);
    expect(total).toBe(3000);
    expect(ends()).toEqual([
      { type: 'end', id: 1, frame: 3000, reason: 'stopped' },
    ]);
  });

  it('stop at a past frame ends at the next quantum, reporting the end of what was sent', () => {
    const { core, run, ends } = setup();
    core.command({ type: 'start', id: 1, from: 0, end: 100000 });
    run(0, 1024);
    core.command({ type: 'stop', at: 500 });
    run(1024, 2048);
    expect(ends()).toEqual([
      { type: 'end', id: 1, frame: 1024, reason: 'stopped' },
    ]);
  });

  it('a stop after the end frame keeps reason limit; stop when idle is ignored', () => {
    const { core, run, ends } = setup();
    core.command({ type: 'stop', at: 10 });
    core.command({ type: 'start', id: 1, from: 0, end: 1000 });
    core.command({ type: 'stop', at: 2000 });
    run(0, 2048);
    expect(ends()).toEqual([
      { type: 'end', id: 1, frame: 1000, reason: 'limit' },
    ]);
  });

  it('a start in the past captures from the current quantum (the take buffer reads the gap as silence)', () => {
    const { core, run, chunks } = setup();
    run(0, 1024);
    core.command({ type: 'start', id: 1, from: 100, end: 2048 });
    run(1024, 2048);
    expect(chunks()[0].frame).toBe(1024);
  });

  it('averages several channels into mono', () => {
    const { core, run, chunks } = setup();
    core.command({ type: 'start', id: 1, from: 0, end: 128 });
    run(0, 128, 2);
    expect([...chunks()[0].data].every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(
      true,
    );
  });

  it('no input channels read as silence', () => {
    const { core, chunks } = setup();
    core.command({ type: 'start', id: 1, from: 0, end: 128 });
    core.process([], 0, 128);
    expect(chunks()[0].data).toEqual(new Float32Array(128));
  });

  it('a new start flushes the previous capture under its own id', () => {
    const { core, run, chunks } = setup();
    core.command({ type: 'start', id: 1, from: 0, end: 100000 });
    run(0, 1024);
    core.command({ type: 'start', id: 2, from: 1024, end: 2048 });
    run(1024, 2048);
    expect(chunks().map((c) => [c.id, c.frame, c.data.length])).toEqual([
      [1, 0, 1024],
      [2, 1024, 1024],
    ]);
  });
});

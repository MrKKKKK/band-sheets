import { describe, expect, it } from 'vitest';
import { barSec } from './clickTrack';
import { makeTake, takeFrames } from './take';

const meter = { tempo: 120, ts: { num: 4, den: 4 } };
const RATE = 48000;

describe('takeFrames', () => {
  const base = {
    sampleRate: RATE,
    t0Frame: 10000,
    limitFrame: 10000 + 600 * RATE,
    reported: { baseLatencySec: 0.01, outputLatencySec: 0.02 },
    remainderMs: 5,
  };

  it('shifts both ends by base + output + remainder', () => {
    const r = takeFrames({ ...base, stopSec: 3 });
    expect(r.compensationFrames).toBe(Math.round(0.035 * RATE));
    expect(r.startFrame).toBe(10000 + r.compensationFrames);
    expect(r.endFrame).toBe(3 * RATE + r.compensationFrames);
  });

  it('ends at the limit frame when the limit ended it (stopSec null)', () => {
    const r = takeFrames({ ...base, stopSec: null });
    expect(r.endFrame).toBe(base.limitFrame);
  });

  it('counts an unmeasured remainder as 0', () => {
    const r = takeFrames({ ...base, remainderMs: null, stopSec: 2 });
    expect(r.compensationFrames).toBe(Math.round(0.03 * RATE));
  });
});

describe('makeTake', () => {
  const slice = (frames: number) => ({
    frames,
    chunks: [new Int16Array(frames).fill(16384)],
  });

  it('is null when nothing is left after bar 1', () => {
    expect(
      makeTake(slice(Math.round(barSec(120, meter.ts) * RATE)), RATE, meter),
    ).toBeNull();
    expect(makeTake(slice(0), RATE, meter)).toBeNull();
  });

  it('makes a WAV file named 録音.wav with the clicks meter, bar 1 and peaks', async () => {
    const frames = 3 * RATE;
    const t = makeTake(slice(frames), RATE, meter);
    expect(t).not.toBeNull();
    expect(t!.file.name).toBe('録音.wav');
    expect(t!.file.type).toBe('audio/wav');
    expect(t!.file.size).toBe(44 + frames * 2);
    expect(t!.durationSec).toBe(3);
    expect(t!.bar1Sec).toBe(2);
    expect(t!.meter).toBe(meter);
    expect(t!.peaks.length).toBe(300);
    expect(t!.peaks[0]).toBe(0.5);
  });
});

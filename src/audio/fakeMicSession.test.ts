import { describe, expect, it, vi } from 'vitest';
import { detectClicks, judgeLatency } from '../lib/mic/latency';
import { createFakeMicSession } from './fakeMicSession';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createFakeMicSession', () => {
  it('lists the default fake mic and opens it', async () => {
    const s = createFakeMicSession();
    expect(await s.listDevices()).toEqual([
      { deviceId: 'fake-mic', label: 'テスト用マイク', isDefault: true },
    ]);
    const mic = await s.open(null, { onInterrupted() {} });
    expect(mic.deviceId).toBe('fake-mic');
    expect(s.openMic).toBe(mic);
    await mic.close();
    expect(s.openMic).toBeNull();
    expect(s.stats).toMatchObject({ opens: 1, closes: 1 });
  });

  it('open fails as configured; no device = notFound', async () => {
    await expect(
      createFakeMicSession({ openError: 'denied' }).open(null, {
        onInterrupted() {},
      }),
    ).rejects.toMatchObject({ kind: 'denied' });
    await expect(
      createFakeMicSession({ devices: [] }).open(null, { onInterrupted() {} }),
    ).rejects.toMatchObject({ kind: 'notFound' });
  });

  it('the clock moves only on advance; levels arrive', async () => {
    const levels: number[] = [];
    const s = createFakeMicSession();
    const mic = await s.open(null, {
      onInterrupted() {},
      onLevel: (p) => levels.push(p),
    });
    expect(mic.now()).toBe(0);
    s.advance(0.5);
    expect(mic.now()).toBeCloseTo(0.5, 2);
    await flush();
    expect(levels.length).toBeGreaterThan(5);
    expect(Math.max(...levels)).toBeCloseTo(0.2, 2);
  });

  it('latencyOnlyWhileClicking: 0 until the first scheduled click has played', async () => {
    const s = createFakeMicSession({ latencyOnlyWhileClicking: true });
    const mic = await s.open(null, { onInterrupted() {} });
    expect(mic.latencyNow()).toEqual({
      baseLatencySec: 0,
      outputLatencySec: 0,
    });
    mic.scheduleClicks([{ time: 0.5, strong: true }]);
    s.advance(0.4);
    expect(mic.latencyNow().outputLatencySec).toBe(0);
    s.advance(0.2);
    expect(mic.latencyNow()).toEqual({
      baseLatencySec: 0.01,
      outputLatencySec: 0.04,
    });
  });

  it('a latency measurement on the fake succeeds with its round trip', async () => {
    const s = createFakeMicSession({ clickRoundTripMs: 100 });
    const mic = await s.open(null, { onInterrupted() {} });
    const r = mic.sampleRate;
    const times = [0.5, 1, 1.5, 2];
    mic.scheduleClicks(times.map((time) => ({ time, strong: false })));
    const cap = mic.startCapture(0.3 * r, 3 * r);
    s.advance(2.4);
    cap.stop(2.5 * r);
    s.advance(0.2);
    expect(await cap.done).toEqual({ frame: 2.5 * r, reason: 'stopped' });
    const from = 0.3 * r;
    const samples = cap.buffer.sliceFloat(from, 2.5 * r);
    const det = detectClicks(
      samples,
      r,
      times.map((t) => t * r - from),
    );
    const v = judgeLatency(det, mic.latencyNow());
    expect(v).toMatchObject({ ok: true, found: 4 });
    if (v.ok) {
      expect(v.roundTripMs).toBeCloseTo(100, 0);
      expect(v.remainderMs).toBeCloseTo(50, 0);
    }
  });

  it('clicks never heard → the measurement fails', async () => {
    const s = createFakeMicSession({ clickRoundTripMs: null });
    const mic = await s.open(null, { onInterrupted() {} });
    const r = mic.sampleRate;
    mic.scheduleClicks(
      [0.5, 1, 1.5, 2].map((time) => ({ time, strong: false })),
    );
    const cap = mic.startCapture(0, 3 * r);
    s.advance(3.1);
    await cap.done;
    const det = detectClicks(
      cap.buffer.sliceFloat(0, 3 * r),
      r,
      [0.5, 1, 1.5, 2].map((t) => t * r),
    );
    expect(judgeLatency(det, mic.latencyNow())).toEqual({
      ok: false,
      reason: 'tooFew',
    });
  });

  it('stopClicks silences the clicks still to come', async () => {
    const s = createFakeMicSession({ voice: 'silence', clickRoundTripMs: 0 });
    const mic = await s.open(null, { onInterrupted() {} });
    const r = mic.sampleRate;
    mic.scheduleClicks([1, 2].map((time) => ({ time, strong: true })));
    const cap = mic.startCapture(0, 3 * r);
    s.advance(1.5);
    mic.stopClicks();
    s.advance(1.6);
    await cap.done;
    const all = cap.buffer.sliceFloat(0, 3 * r);
    expect(Math.max(...all.subarray(r, r + 200).map(Math.abs))).toBeGreaterThan(
      0.5,
    );
    expect(
      Math.max(...all.subarray(2 * r - 10, 2 * r + 200).map(Math.abs)),
    ).toBe(0);
    expect(s.stats.stopClicks).toBe(1);
    expect(s.scheduled).toHaveLength(2);
  });

  it('10 minutes in one call: the capture ends itself at the end frame (limit)', async () => {
    const s = createFakeMicSession({ sampleRate: 8000, voice: 'silence' });
    const mic = await s.open(null, { onInterrupted() {} });
    const cap = mic.startCapture(0, 600 * 8000);
    s.advance(601);
    expect(await cap.done).toEqual({ frame: 600 * 8000, reason: 'limit' });
    expect(cap.buffer.endFrame).toBe(600 * 8000);
  });

  it('interruptions: reported once; ended keeps the clock, contextClosed freezes it and closes the capture', async () => {
    const s = createFakeMicSession();
    const onInterrupted = vi.fn();
    const mic = await s.open(null, { onInterrupted });
    const cap = mic.startCapture(0, 48000 * 10);
    s.advance(1);
    s.interrupt('ended');
    s.interrupt('ended');
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(onInterrupted).toHaveBeenCalledWith('ended');
    s.advance(1);
    expect(mic.now()).toBeCloseTo(2, 2);
    cap.stop(2 * 48000);
    s.advance(0.1);
    expect((await cap.done).reason).toBe('stopped');

    const s2 = createFakeMicSession();
    const m2 = await s2.open(null, { onInterrupted() {} });
    const c2 = m2.startCapture(0, 48000 * 10);
    s2.advance(1);
    s2.interrupt('contextClosed');
    s2.advance(1);
    expect(m2.now()).toBeCloseTo(1, 2);
    expect((await c2.done).reason).toBe('closed');
  });

  it('a new open does not close the earlier mic; each open has its own clock from 0', async () => {
    const s = createFakeMicSession();
    const a = await s.open(null, { onInterrupted() {} });
    s.advance(1);
    const b = await s.open(null, { onInterrupted() {} });
    expect(s.stats.closes).toBe(0);
    expect(b.now()).toBe(0);
    expect(s.openMic).toBe(b);
    await a.close();
    expect(s.openMic).toBe(b);
    expect(s.stats.closes).toBe(1);
  });

  it('clockNeedsResume: the clock stands still until resume()', async () => {
    const s = createFakeMicSession({ clockNeedsResume: true });
    const mic = await s.open(null, { onInterrupted() {} });
    s.advance(1);
    expect(mic.now()).toBe(0);
    await mic.resume();
    s.advance(1);
    expect(mic.now()).toBeCloseTo(1, 2);
  });

  it('setDevices notifies listeners', async () => {
    const s = createFakeMicSession();
    const fn = vi.fn();
    const off = s.onDeviceChange(fn);
    s.setDevices([]);
    off();
    s.setDevices([]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await s.listDevices()).toEqual([]);
  });

  it('tickMs moves the clock by itself until close', async () => {
    vi.useFakeTimers();
    try {
      const s = createFakeMicSession({ tickMs: 50 });
      const mic = await s.open(null, { onInterrupted() {} });
      vi.advanceTimersByTime(500);
      expect(mic.now()).toBeCloseTo(0.5, 2);
      await mic.close();
      vi.advanceTimersByTime(500);
      expect(mic.now()).toBeCloseTo(0.5, 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

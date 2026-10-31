import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeMicSession,
  type FakeMicOptions,
  type FakeMicSession,
} from '../audio/fakeMicSession';
import { MAX_DURATION_SEC } from '../lib/import/analysisTypes';
import {
  createMemoryStorage,
  loadMicRemainder,
  saveMicRemainder,
  type KeyValueStorage,
} from '../lib/storage';
import {
  COUNT_IN_LEAD_SEC,
  INTERRUPTED_WAIT_MS,
  STALL_MS,
  TAIL_WAIT_MS,
  TICK_MS,
  useMicRecorder,
} from './useMicRecorder';

const ts = { num: 4, den: 4 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(
  opts: FakeMicOptions = {},
  storage: KeyValueStorage = createMemoryStorage(),
) {
  const session = createFakeMicSession(opts);
  const said: string[] = [];
  const hook = renderHook(() =>
    useMicRecorder({
      session,
      storage,
      tempo: 120, // 1 bar = 2 s
      ts,
      announce: (t) => said.push(t),
    }),
  );
  return { session, storage, hook, said };
}

/** Moves the mic's clock and the timers together, in TICK_MS steps. */
async function step(session: FakeMicSession, sec: number) {
  const n = Math.round((sec * 1000) / TICK_MS);
  await act(async () => {
    for (let i = 0; i < n; i++) {
      session.advance(TICK_MS / 1000);
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
  });
}

/** Only the timers (the mic's clock stands still). */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function opened(s: ReturnType<typeof setup>) {
  act(() => s.hook.result.current.open());
  await wait(0);
  expect(s.hook.result.current.state.phase).toBe('ready');
}

async function recordFor(s: ReturnType<typeof setup>, sec: number) {
  act(() => s.hook.result.current.record());
  await step(s.session, sec);
}

describe('useMicRecorder', () => {
  it('opens the mic: ready, devices, level, announcement', async () => {
    const s = setup();
    expect(s.hook.result.current.state.phase).toBe('closed');
    await opened(s);
    const r = s.hook.result.current;
    expect(r.state.deviceId).toBe('fake-mic');
    expect(r.state.remainderMs).toBeNull();
    expect(r.devices.map((d) => d.deviceId)).toEqual(['fake-mic']);
    await step(s.session, 0.2);
    expect(s.hook.result.current.level).toBeGreaterThan(0.1);
    expect(s.said).toEqual(['マイクを使えるようになりました。']);
  });

  it('permission denied → micError (M2)', async () => {
    const s = setup({ openError: 'denied' });
    act(() => s.hook.result.current.open());
    await wait(0);
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'micError',
      error: 'denied',
    });
    expect(s.said).toEqual(['マイクが許可されていません。']);
  });

  it('count-in → recording → ■ → take: wav file, bar 1, peaks; the mic is closed', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 1);
    expect(s.hook.result.current.state).toMatchObject({ phase: 'countIn' });
    // every click of the take at once, the first one COUNT_IN_LEAD_SEC after ●
    expect(s.session.scheduled.length).toBe(1200);
    expect(s.session.scheduled[0]).toEqual({
      time: COUNT_IN_LEAD_SEC,
      strong: true,
    });
    await step(s.session, 1.5);
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'recording',
      bar: 1,
    });
    await step(s.session, 2.7); // clock 5.2 → file 5 s
    act(() => s.hook.result.current.stop());
    expect(s.hook.result.current.state.phase).toBe('finishing');
    await step(s.session, 0.3);
    const r = s.hook.result.current;
    expect(r.state).toMatchObject({ phase: 'take', end: 'user' });
    expect(r.take).not.toBeNull();
    const take = r.take!;
    expect(take.bar1Sec).toBe(2);
    expect(take.durationSec).toBeCloseTo(5, 2);
    expect(take.file.type).toBe('audio/wav');
    expect(take.file.size).toBe(44 + Math.round(take.durationSec * 48000) * 2);
    expect(take.peaks.length).toBe(Math.ceil(take.durationSec * 100));
    expect(s.session.openMic).toBeNull();
    expect(s.session.stats.stopClicks).toBeGreaterThan(0);
    expect(r.level).toBe(0);
    expect(s.said.slice(1)).toEqual([
      'カウントを始めました。まだ歌わないでください。',
      '録音を始めました。',
      '録音を止めました。5 秒の録音です。',
    ]);
  });

  it('the compensation puts the heard count-in click at 0 s of the file', async () => {
    // round trip 100 ms = reported 50 ms + remembered 50 ms
    const storage = createMemoryStorage();
    saveMicRemainder(storage, 'fake-mic', 50);
    const s = setup({ voice: 'silence' }, storage);
    await opened(s);
    expect(s.hook.result.current.state.remainderMs).toBe(50);
    await recordFor(s, 3);
    act(() => s.hook.result.current.stop());
    await step(s.session, 0.3);
    const peaks = s.hook.result.current.take!.peaks;
    // clicks every 0.5 s: buckets 0, 50, 100… hold them; in between is silence
    expect(peaks[0]).toBeGreaterThan(0.5);
    expect(peaks[50]).toBeGreaterThan(0.5);
    expect(peaks[25]).toBe(0);
    expect(peaks[49]).toBe(0);
  });

  it('stops by itself at a 600 s file, announcing 「残り 1 分」 once', async () => {
    const s = setup({ sampleRate: 8000, voice: 'silence' });
    await opened(s);
    act(() => s.hook.result.current.record());
    await step(s.session, 540.3); // file 540.1 s
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'recording',
      remainingSec: 60,
    });
    await step(s.session, 61);
    const r = s.hook.result.current;
    expect(r.state).toMatchObject({ phase: 'take', end: 'limit' });
    expect(r.take!.durationSec).toBeLessThanOrEqual(MAX_DURATION_SEC);
    expect(r.take!.durationSec).toBeGreaterThan(MAX_DURATION_SEC - 0.1);
    expect(s.said.filter((t) => t === '残り 1 分です。')).toHaveLength(1);
    expect(s.said.at(-1)).toBe(
      '10 分になったので止めました。10 分 0 秒の録音です。',
    );
  });

  it('the mic unplugged while recording keeps the take (M7 with the reason)', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 4);
    act(() => s.session.interrupt('ended'));
    expect(s.session.stats.stopClicks).toBeGreaterThan(0);
    await step(s.session, 1);
    const r = s.hook.result.current;
    expect(r.state).toMatchObject({ phase: 'take', end: 'ended' });
    expect(r.take!.durationSec).toBeGreaterThan(3.5);
    expect(s.said.at(-1)).toContain('そこまでの録音を残しました');
  });

  it('an interrupted context never delivers the tail: the take is made after the time limit', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 4);
    act(() => s.session.interrupt('contextInterrupted'));
    await wait(INTERRUPTED_WAIT_MS - 10);
    expect(s.hook.result.current.state.phase).toBe('finishing');
    await wait(20);
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'take',
      end: 'contextInterrupted',
    });
    expect(s.hook.result.current.take!.durationSec).toBeGreaterThan(3.5);
  });

  it('a context clock that stands still while recording = interrupted (stalled)', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 4);
    await wait(STALL_MS + TICK_MS);
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'finishing',
      end: 'stalled',
    });
    await wait(INTERRUPTED_WAIT_MS);
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'take',
      end: 'stalled',
    });
  });

  it('■ with no tail arriving: the take is made after TAIL_WAIT_MS + the compensation', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 4);
    act(() => s.hook.result.current.stop());
    await wait(TAIL_WAIT_MS);
    expect(s.hook.result.current.state.phase).toBe('finishing');
    await wait(60); // + 50 ms of reported latency
    expect(s.hook.result.current.state.phase).toBe('take');
  });

  it('an interruption in the count-in reopens the mic and keeps nothing', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 1);
    act(() => s.session.interrupt('contextInterrupted'));
    await wait(0);
    const r = s.hook.result.current;
    expect(r.state).toMatchObject({
      phase: 'ready',
      notice: { kind: 'micStopped', during: 'countIn' },
    });
    expect(r.take).toBeNull();
    expect(s.session.stats.opens).toBe(2);
    expect(s.session.stats.closes).toBe(1);
  });

  it('やめる in the count-in → M3, clicks silenced; ■ before bar 1 → 「短すぎます」', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 1);
    const before = s.session.stats.stopClicks;
    act(() => s.hook.result.current.cancelCountIn());
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'ready',
      notice: null,
    });
    expect(s.session.stats.stopClicks).toBeGreaterThan(before);
    await recordFor(s, 1);
    act(() => s.hook.result.current.stop());
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'ready',
      notice: { kind: 'tooShort' },
    });
    // the timer stopped with the count-in
    await wait(STALL_MS * 2);
    expect(s.hook.result.current.state.phase).toBe('ready');
  });

  it('measures the latency and remembers it per mic', async () => {
    const s = setup({ clickRoundTripMs: 100 });
    await opened(s);
    act(() => s.hook.result.current.measure());
    expect(s.session.stats.resumes).toBe(1);
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'measuring',
      heard: 0,
    });
    await step(s.session, 1);
    expect(s.hook.result.current.state).toMatchObject({ heard: 2 });
    await step(s.session, 2);
    const r = s.hook.result.current;
    expect(r.state.phase).toBe('measured');
    expect(r.state.remainderMs).toBeCloseTo(50, 0);
    expect(loadMicRemainder(s.storage, 'fake-mic')).toBeCloseTo(50, 0);
    expect(s.said.at(-1)).toBe('入力の遅れ 50 ms を覚えました。');
    act(() => r.closeMeasure());
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'ready',
      remainderMs: expect.closeTo(50, 0),
    });
  });

  it('a measurement that hears no click fails and stores nothing', async () => {
    const s = setup({ clickRoundTripMs: null });
    await opened(s);
    act(() => s.hook.result.current.measure());
    await step(s.session, 3);
    expect(s.hook.result.current.state.phase).toBe('measureFailed');
    expect(loadMicRemainder(s.storage, 'fake-mic')).toBeNull();
    expect(s.said.at(-1)).toBe('クリックを拾えませんでした。');
  });

  it('the chosen mic disappearing reopens the default one with a notice', async () => {
    const a = { deviceId: 'a', label: 'A', isDefault: true };
    const b = { deviceId: 'b', label: 'B', isDefault: false };
    const s = setup({ devices: [a, b] });
    await opened(s);
    act(() => s.hook.result.current.chooseMic('b'));
    await wait(0);
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'ready',
      deviceId: 'b',
    });
    act(() => s.session.setDevices([a]));
    await wait(0);
    expect(s.hook.result.current.state).toMatchObject({
      phase: 'ready',
      deviceId: 'a',
      notice: { kind: 'deviceGone' },
    });
    expect(s.hook.result.current.devices).toEqual([a]);
  });

  it('retake asks first; confirming drops the take and reopens the mic', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 4);
    act(() => s.hook.result.current.stop());
    await step(s.session, 0.3);
    act(() => s.hook.result.current.retake());
    expect(s.hook.result.current.state.phase).toBe('confirmRetake');
    expect(s.hook.result.current.take).not.toBeNull();
    act(() => s.hook.result.current.cancelRetake());
    expect(s.hook.result.current.state.phase).toBe('take');
    act(() => s.hook.result.current.retake());
    act(() => s.hook.result.current.confirmRetake());
    await wait(0);
    expect(s.hook.result.current.state.phase).toBe('ready');
    expect(s.hook.result.current.take).toBeNull();
    expect(s.session.stats.opens).toBe(2);
  });

  it('close releases the mic but keeps a take', async () => {
    const s = setup();
    await opened(s);
    act(() => s.hook.result.current.close());
    expect(s.hook.result.current.state.phase).toBe('closed');
    expect(s.session.openMic).toBeNull();

    await opened(s);
    await recordFor(s, 4);
    act(() => s.hook.result.current.stop());
    await step(s.session, 0.3);
    act(() => s.hook.result.current.close());
    expect(s.hook.result.current.state.phase).toBe('take');
    expect(s.hook.result.current.take).not.toBeNull();
  });

  it('unmounting while recording closes the mic, silences the clicks and stops the timer', async () => {
    const s = setup();
    await opened(s);
    await recordFor(s, 3);
    s.hook.unmount();
    expect(s.session.openMic).toBeNull();
    expect(s.session.stats.closes).toBe(1);
    expect(s.session.stats.stopClicks).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a mic that opens after unmounting is closed at once', async () => {
    const s = setup();
    act(() => s.hook.result.current.open());
    s.hook.unmount();
    await wait(0);
    expect(s.session.stats.opens).toBe(1);
    expect(s.session.stats.closes).toBe(1);
  });
});

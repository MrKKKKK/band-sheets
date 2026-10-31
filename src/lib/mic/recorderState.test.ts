import { describe, expect, it } from 'vitest';
import type { MicDevice } from '../../audio/micSession';
import {
  initialRecorderState,
  isTakeTooShort,
  recorderReducer,
  type RecorderEvent,
  type RecorderState,
} from './recorderState';

const meter = { tempo: 120, ts: { num: 4, den: 4 } }; // 1 bar = 2 s
const dev = (deviceId: string, isDefault = false): MicDevice => ({
  deviceId,
  label: deviceId,
  isDefault,
});
const take = { durationSec: 12, bar1Sec: 2 };

function run(...events: RecorderEvent[]): RecorderState {
  return events.reduce(recorderReducer, initialRecorderState);
}

const OPENED: RecorderEvent[] = [
  { type: 'open' },
  { type: 'devices', devices: [dev('a', true), dev('b')] },
  { type: 'opened', deviceId: 'a', remainderMs: 48 },
];
const ready = () => run(...OPENED);
const recording = () =>
  run(
    ...OPENED,
    { type: 'record', meter },
    { type: 'tick', sinceCountInSec: 2.1 },
  );
const finishing = () =>
  recorderReducer(recording(), { type: 'stop', atSec: 9 });
const taken = () => recorderReducer(finishing(), { type: 'finished', take });

/** Every phase, reached through events. */
const PHASES: Record<RecorderState['phase'], () => RecorderState> = {
  closed: () => initialRecorderState,
  opening: () => run({ type: 'open' }),
  micError: () =>
    run({ type: 'open' }, { type: 'openFailed', error: 'denied' }),
  ready,
  measuring: () => recorderReducer(ready(), { type: 'measure' }),
  measured: () =>
    run(
      ...OPENED,
      { type: 'measure' },
      {
        type: 'measureDone',
        remainderMs: 50,
        spreadMs: 2,
      },
    ),
  measureFailed: () =>
    run(...OPENED, { type: 'measure' }, { type: 'measureFailed' }),
  countIn: () => recorderReducer(ready(), { type: 'record', meter }),
  recording,
  finishing,
  take: taken,
  confirmRetake: () => recorderReducer(taken(), { type: 'retake' }),
};

describe('recorderReducer: open', () => {
  it('closed → opening → ready with the device and its remainder', () => {
    const s = ready();
    expect(s).toMatchObject({
      phase: 'ready',
      notice: null,
      deviceId: 'a',
      remainderMs: 48,
    });
  });

  it('open failure → micError; a retry opens the default again', () => {
    const e = run(
      ...OPENED,
      { type: 'chooseMic', deviceId: 'b' },
      { type: 'openFailed', error: 'busy' },
    );
    expect(e).toMatchObject({ phase: 'micError', error: 'busy' });
    expect(recorderReducer(e, { type: 'open' })).toMatchObject({
      phase: 'opening',
      deviceId: null,
    });
  });

  it('reopening after close keeps the chosen mic while it is listed', () => {
    const s = run(
      ...OPENED,
      { type: 'chooseMic', deviceId: 'b' },
      { type: 'opened', deviceId: 'b', remainderMs: null },
      { type: 'close' },
      { type: 'open' },
    );
    expect(s).toMatchObject({ phase: 'opening', deviceId: 'b' });
  });

  it('opened / openFailed are ignored outside opening', () => {
    for (const [name, make] of Object.entries(PHASES)) {
      if (name === 'opening') continue;
      const s = make();
      expect(
        recorderReducer(s, { type: 'opened', deviceId: 'x', remainderMs: 1 }),
      ).toBe(s);
      expect(recorderReducer(s, { type: 'openFailed', error: 'denied' })).toBe(
        s,
      );
    }
  });

  it('open does nothing except from closed / micError', () => {
    for (const [name, make] of Object.entries(PHASES)) {
      if (name === 'closed' || name === 'micError') continue;
      const s = make();
      expect(recorderReducer(s, { type: 'open' })).toBe(s);
    }
  });
});

describe('recorderReducer: devices', () => {
  it('choosing another mic reopens it (remainder unknown until opened)', () => {
    const s = recorderReducer(ready(), { type: 'chooseMic', deviceId: 'b' });
    expect(s).toMatchObject({
      phase: 'opening',
      deviceId: 'b',
      remainderMs: null,
      notice: null,
    });
  });

  it('choosing the open mic or choosing outside M3 does nothing', () => {
    const r = ready();
    expect(recorderReducer(r, { type: 'chooseMic', deviceId: 'a' })).toBe(r);
    const c = PHASES.countIn();
    expect(recorderReducer(c, { type: 'chooseMic', deviceId: 'b' })).toBe(c);
  });

  it('the open mic vanishing in M3 / M4 → the default, with a notice', () => {
    for (const p of [
      'ready',
      'measuring',
      'measured',
      'measureFailed',
    ] as const) {
      const s = recorderReducer(PHASES[p](), {
        type: 'devices',
        devices: [dev('b', true)],
      });
      expect(s).toMatchObject({
        phase: 'opening',
        deviceId: null,
        notice: { kind: 'deviceGone' },
        devices: [dev('b', true)],
      });
      expect(
        recorderReducer(s, {
          type: 'opened',
          deviceId: 'b',
          remainderMs: null,
        }),
      ).toMatchObject({ phase: 'ready', notice: { kind: 'deviceGone' } });
    }
  });

  it('a list change that keeps the mic only updates the list', () => {
    const s = recorderReducer(ready(), {
      type: 'devices',
      devices: [dev('a', true)],
    });
    expect(s).toMatchObject({ phase: 'ready', devices: [dev('a', true)] });
  });

  it('while recording a vanished mic is left to the interruption', () => {
    const s = recorderReducer(recording(), { type: 'devices', devices: [] });
    expect(s.phase).toBe('recording');
    expect(s.devices).toEqual([]);
  });
});

describe('recorderReducer: measuring (M4)', () => {
  it('measure → progress → done keeps the new remainder', () => {
    let s = recorderReducer(ready(), { type: 'measure' });
    expect(s).toMatchObject({ phase: 'measuring', heard: 0 });
    s = recorderReducer(s, { type: 'measureProgress', heard: 3 });
    expect(s).toMatchObject({ heard: 3 });
    expect(recorderReducer(s, { type: 'measureProgress', heard: 3 })).toBe(s);
    s = recorderReducer(s, {
      type: 'measureDone',
      remainderMs: 51,
      spreadMs: 1.5,
    });
    expect(s).toMatchObject({
      phase: 'measured',
      remainderMs: 51,
      spreadMs: 1.5,
    });
    s = recorderReducer(s, { type: 'closeMeasure' });
    expect(s).toMatchObject({ phase: 'ready', remainderMs: 51, notice: null });
  });

  it('failure keeps the old remainder; 「もう一度測る」 measures again', () => {
    const f = PHASES.measureFailed();
    expect(f.remainderMs).toBe(48);
    expect(recorderReducer(f, { type: 'measure' })).toMatchObject({
      phase: 'measuring',
    });
    expect(recorderReducer(PHASES.measured(), { type: 'measure' }).phase).toBe(
      'measuring',
    );
  });

  it('中止 while measuring → ready', () => {
    expect(
      recorderReducer(PHASES.measuring(), { type: 'closeMeasure' }).phase,
    ).toBe('ready');
  });

  it('measure results are ignored after leaving M4', () => {
    const r = ready();
    expect(recorderReducer(r, { type: 'measureFailed' })).toBe(r);
    expect(
      recorderReducer(r, { type: 'measureDone', remainderMs: 1, spreadMs: 0 }),
    ).toBe(r);
  });
});

describe('recorderReducer: count-in and recording', () => {
  it('record → countIn; beats follow the clock; bar 1 → recording', () => {
    let s = recorderReducer(ready(), { type: 'record', meter });
    expect(s).toMatchObject({ phase: 'countIn', beat: 0 });
    s = recorderReducer(s, { type: 'tick', sinceCountInSec: -0.1 });
    expect(s).toMatchObject({ beat: 0 });
    s = recorderReducer(s, { type: 'tick', sinceCountInSec: 0 });
    expect(s).toMatchObject({ beat: 1 });
    expect(recorderReducer(s, { type: 'tick', sinceCountInSec: 0.2 })).toBe(s);
    s = recorderReducer(s, { type: 'tick', sinceCountInSec: 1.5 });
    expect(s).toMatchObject({ beat: 4 });
    s = recorderReducer(s, { type: 'tick', sinceCountInSec: 2 });
    expect(s).toMatchObject({
      phase: 'recording',
      bar: 1,
      beat: 1,
      elapsedSec: 0,
      remainingSec: null,
    });
  });

  it('a late first tick lands on the right bar and second', () => {
    const s = run(
      ...OPENED,
      { type: 'record', meter },
      { type: 'tick', sinceCountInSec: 9.6 },
    );
    expect(s).toMatchObject({
      phase: 'recording',
      bar: 4,
      beat: 4,
      elapsedSec: 7,
    });
  });

  it('6/8 counts eighths', () => {
    const s = run(
      ...OPENED,
      { type: 'record', meter: { tempo: 120, ts: { num: 6, den: 8 } } },
      { type: 'tick', sinceCountInSec: 1.3 },
    );
    expect(s).toMatchObject({ phase: 'countIn', beat: 6 });
  });

  it('remaining time from 9 minutes (file length), announced once', () => {
    let s = recorderReducer(recording(), {
      type: 'tick',
      sinceCountInSec: 539.9,
    });
    expect(s).toMatchObject({ remainingSec: null, oneMinuteAnnounced: false });
    s = recorderReducer(s, { type: 'tick', sinceCountInSec: 540 });
    expect(s).toMatchObject({ remainingSec: 60, oneMinuteAnnounced: true });
    s = recorderReducer(s, { type: 'tick', sinceCountInSec: 599.2 });
    expect(s).toMatchObject({ remainingSec: 1, oneMinuteAnnounced: true });
  });

  it('600 s of file → finishing (limit); a new recording resets the 1-minute flag', () => {
    const s = recorderReducer(recording(), {
      type: 'tick',
      sinceCountInSec: 600,
    });
    expect(s).toMatchObject({
      phase: 'finishing',
      end: 'limit',
      stopSec: null,
    });
    const again = [
      { type: 'tick', sinceCountInSec: 550 },
      { type: 'stop', atSec: 1 },
      { type: 'finished', take },
      { type: 'retake' },
      { type: 'confirmRetake' },
      { type: 'opened', deviceId: 'a', remainderMs: 48 },
      { type: 'record', meter },
    ] satisfies RecorderEvent[];
    expect(again.reduce(recorderReducer, recording()).oneMinuteAnnounced).toBe(
      false,
    );
  });

  it('やめる in the count-in → M3, nothing kept', () => {
    const s = recorderReducer(PHASES.countIn(), { type: 'cancelCountIn' });
    expect(s).toMatchObject({ phase: 'ready', notice: null });
  });

  it('■ before bar 1 → M3 「短すぎます」', () => {
    const s = recorderReducer(PHASES.countIn(), { type: 'stop', atSec: 3 });
    expect(s).toMatchObject({ phase: 'ready', notice: { kind: 'tooShort' } });
  });

  it('■ while recording → finishing with the stop time', () => {
    expect(finishing()).toMatchObject({
      phase: 'finishing',
      end: 'user',
      stopSec: 9,
    });
  });

  it('ticks and stops are ignored elsewhere', () => {
    for (const [name, make] of Object.entries(PHASES)) {
      if (name === 'countIn' || name === 'recording') continue;
      const s = make();
      expect(recorderReducer(s, { type: 'tick', sinceCountInSec: 700 })).toBe(
        s,
      );
      expect(recorderReducer(s, { type: 'stop', atSec: 1 })).toBe(s);
      expect(recorderReducer(s, { type: 'cancelCountIn' })).toBe(s);
    }
  });
});

describe('recorderReducer: interruptions', () => {
  it('while recording: keep what was recorded (finishing with the cause)', () => {
    for (const cause of [
      'ended',
      'contextClosed',
      'contextInterrupted',
      'workletError',
      'stalled',
    ] as const) {
      const s = recorderReducer(recording(), {
        type: 'interrupted',
        cause,
        atSec: 7,
      });
      expect(s).toMatchObject({ phase: 'finishing', end: cause, stopSec: 7 });
      expect(recorderReducer(s, { type: 'finished', take })).toMatchObject({
        phase: 'take',
        end: cause,
        take,
      });
    }
  });

  it('in the count-in: reopen, nothing kept, notice', () => {
    const s = recorderReducer(PHASES.countIn(), {
      type: 'interrupted',
      cause: 'ended',
      atSec: 1,
    });
    expect(s).toMatchObject({
      phase: 'opening',
      deviceId: 'a',
      notice: { kind: 'micStopped', cause: 'ended', during: 'countIn' },
    });
  });

  it('in M3 / M4: reopen with a notice', () => {
    for (const p of [
      'ready',
      'measuring',
      'measured',
      'measureFailed',
    ] as const)
      expect(
        recorderReducer(PHASES[p](), {
          type: 'interrupted',
          cause: 'contextInterrupted',
          atSec: 1,
        }),
      ).toMatchObject({
        phase: 'opening',
        notice: { kind: 'micStopped', during: 'idle' },
      });
  });

  it('ignored with no open mic', () => {
    for (const p of [
      'closed',
      'opening',
      'micError',
      'finishing',
      'take',
      'confirmRetake',
    ] as const) {
      const s = PHASES[p]();
      expect(
        recorderReducer(s, { type: 'interrupted', cause: 'ended', atSec: 1 }),
      ).toBe(s);
    }
  });
});

describe('recorderReducer: take, retake, close', () => {
  it('finished → take (M7); too short → reopen to M3 「短すぎます」', () => {
    expect(taken()).toMatchObject({ phase: 'take', take, end: 'user' });
    expect(
      recorderReducer(finishing(), { type: 'finished', take: null }),
    ).toMatchObject({ phase: 'opening', notice: { kind: 'tooShort' } });
  });

  it('retake asks first (M8): cancel keeps the take, confirm reopens the mic', () => {
    const c = recorderReducer(taken(), { type: 'retake' });
    expect(c).toMatchObject({ phase: 'confirmRetake', take });
    expect(recorderReducer(c, { type: 'cancelRetake' })).toMatchObject({
      phase: 'take',
      take,
    });
    expect(recorderReducer(c, { type: 'confirmRetake' })).toMatchObject({
      phase: 'opening',
      deviceId: 'a',
      notice: null,
    });
  });

  it('retake events do nothing elsewhere', () => {
    const r = ready();
    expect(recorderReducer(r, { type: 'retake' })).toBe(r);
    expect(recorderReducer(r, { type: 'cancelRetake' })).toBe(r);
    expect(recorderReducer(r, { type: 'confirmRetake' })).toBe(r);
  });

  it('close releases the mic everywhere but keeps a take', () => {
    for (const [name, make] of Object.entries(PHASES)) {
      const s = make();
      const c = recorderReducer(s, { type: 'close' });
      if (name === 'take' || name === 'confirmRetake' || name === 'closed')
        expect(c).toBe(s);
      else expect(c.phase).toBe('closed');
    }
  });
});

describe('isTakeTooShort', () => {
  it('needs something after bar 1 and at least 1 s', () => {
    expect(isTakeTooShort(2, 2)).toBe(true);
    expect(isTakeTooShort(2.01, 2)).toBe(false);
    expect(isTakeTooShort(0.9, 0.5)).toBe(true);
    expect(isTakeTooShort(1, 0.5)).toBe(false);
  });
});

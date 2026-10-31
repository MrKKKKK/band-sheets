import { describe, expect, it, vi } from 'vitest';
import type { MicRecorderView } from '../components/MicRecorder/MicRecorder';
import type { MicTake } from '../hooks/useMicRecorder';
import type { RecorderPhase } from '../lib/mic/recorderState';
import { isRecording, micHumSource } from './humMicSource';

const meter = { tempo: 96, ts: { num: 4, den: 4 } };
const take: MicTake = {
  file: new File(['x'], '録音.wav', { type: 'audio/wav' }),
  peaks: new Float32Array(0),
  durationSec: 24,
  bar1Sec: 2.5,
  meter,
};
const info = { durationSec: 24, bar1Sec: 2.5, meter };

function view(phase: RecorderPhase, withTake = false): MicRecorderView {
  const noop = vi.fn();
  return {
    state: { devices: [], deviceId: null, remainderMs: null, ...phase },
    take: withTake ? take : null,
    subscribeLevel: () => () => {},
    getLevel: () => 0,
    open: noop,
    chooseMic: noop,
    measure: noop,
    closeMeasure: noop,
    record: noop,
    cancelCountIn: noop,
    stop: noop,
    retake: vi.fn(),
    cancelRetake: noop,
    confirmRetake: noop,
  };
}

const build = (recorder: MicRecorderView, waitForFile = false) =>
  micHumSource({
    recorder,
    ts: meter.ts,
    onUseFile: vi.fn(),
    saveName: 'x.wav',
    waitForFile,
  });

describe('micHumSource', () => {
  it('before a take: not ready, 「音」 not recorded yet, no 録り方 card', () => {
    const s = build(view({ phase: 'ready', notice: null }));
    expect(s).toMatchObject({
      heading: '1. 歌の音を受け取る',
      ready: false,
      summaryLabel: '音',
      summary: 'まだ録っていません',
      startLabel: '下書きを作る',
      hint: '先に録音してください。',
      locked: false,
    });
    expect(s.how).toBeUndefined();
    expect(s.startNote).toMatch(/カウントの次の拍が 1 小節目の 1 拍目/);
  });

  it('count-in / recording / finishing lock S2', () => {
    for (const phase of [
      { phase: 'countIn', meter, beat: 1 },
      {
        phase: 'recording',
        meter,
        elapsedSec: 3,
        bar: 2,
        beat: 1,
        remainingSec: null,
      },
      { phase: 'finishing', end: 'user', stopSec: 4 },
    ] as RecorderPhase[]) {
      const r = view(phase);
      expect(isRecording(r.state)).toBe(true);
      expect(build(r)).toMatchObject({
        locked: true,
        summary: '録音しています',
        ready: false,
      });
    }
    expect(
      isRecording(view({ phase: 'take', take: info, end: 'user' }).state),
    ).toBe(false);
  });

  it('with a take: ready unless a picked file is still being probed; 録り直す asks (M8)', () => {
    const r = view({ phase: 'take', take: info, end: 'user' }, true);
    const s = build(r);
    expect(s).toMatchObject({
      ready: true,
      summary: 'マイクの録音 0:24',
      hint: '数秒かかります。',
      locked: false,
    });
    expect(build(r, true).ready).toBe(false);
    s.retake.onClick();
    expect(r.retake).toHaveBeenCalled();
    expect(s.retake.label).toBe('録り直す');
  });
});

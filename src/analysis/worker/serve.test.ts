import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze, AnalysisInputError } from '../../lib/analysis/chords/analyze';
import type { HumInput } from '../../lib/analysis/hum/types';
import { diffJson } from '../../test/diffJson';
import { stubNoNetwork } from '../../test/noNetwork';
import type { RunMessage, WorkerMessage } from '../protocol';
import { runChords } from './runChords';
import { runHum } from './runHum';
import { errorMessage, RunnerError, serve } from './serve';

const FIXTURES = join(import.meta.dirname, '../../lib/analysis/fixtures');

/** 44-byte header, 16-bit LE mono PCM (the golden fixtures). */
function readPcmWav(name: string): { y: Float32Array; sr: number } {
  const b = readFileSync(join(FIXTURES, name));
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = (b.byteLength - 44) / 2;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = v.getInt16(44 + i * 2, true) / 32768;
  return { y, sr: v.getUint32(24, true) };
}

function fakeScope() {
  const posted: WorkerMessage[] = [];
  const scope = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (m: WorkerMessage) => posted.push(m),
  };
  const send = (m: unknown) => scope.onmessage?.({ data: m } as MessageEvent);
  return { scope, posted, send };
}

beforeEach(() => stubNoNetwork());
afterEach(() => vi.unstubAllGlobals());

describe('errorMessage', () => {
  it('keeps codes and messages only for input errors; hides everything else', () => {
    expect(errorMessage(new AnalysisInputError('silent', '無音'))).toEqual({
      type: 'error',
      code: 'silent',
      userMessage: '無音',
    });
    expect(errorMessage(new RunnerError('invalid-info', 'bpm'))).toEqual({
      type: 'error',
      code: 'invalid-info',
      userMessage: 'bpm',
    });
    expect(
      errorMessage(new RangeError('Array buffer allocation failed')),
    ).toEqual({ type: 'error', code: 'out-of-memory' });
    expect(errorMessage(new Error('C#m7 at 12.3 s'))).toEqual({
      type: 'error',
      code: 'internal',
    });
    expect(errorMessage('x')).toEqual({ type: 'error', code: 'internal' });
  });
});

describe('serve', () => {
  it('runs once: stages then result; a second message is ignored', () => {
    const { scope, posted, send } = fakeScope();
    serve<Extract<RunMessage, { kind: 'chords' }>>(
      scope,
      'chords',
      (_m, onStage) => {
        onStage('a', 1);
        return 42;
      },
    );
    send({
      type: 'run',
      kind: 'chords',
      samples: new Float32Array(1),
      sampleRate: 1,
    });
    send({
      type: 'run',
      kind: 'chords',
      samples: new Float32Array(1),
      sampleRate: 1,
    });
    expect(posted).toEqual([
      { type: 'stage', stage: 'a', ms: 1 },
      { type: 'result', result: 42 },
    ]);
  });

  it('a message for another kind is an internal error', () => {
    const { scope, posted, send } = fakeScope();
    serve(scope, 'hum', () => 1);
    send({ type: 'run', kind: 'chords' });
    expect(posted).toEqual([{ type: 'error', code: 'internal' }]);
  });
});

describe('runChords', () => {
  it('silent / too-short input: the analyzer input code (validated at the file rate)', () => {
    const { scope, posted, send } = fakeScope();
    serve(scope, 'chords', runChords);
    send({
      type: 'run',
      kind: 'chords',
      samples: new Float32Array(44100 * 2),
      sampleRate: 44100,
    });
    expect(posted.at(-1)).toMatchObject({ type: 'error', code: 'silent' });
    const short = fakeScope();
    serve(short.scope, 'chords', runChords);
    short.send({
      type: 'run',
      kind: 'chords',
      samples: new Float32Array(100).fill(0.5),
      sampleRate: 44100,
    });
    expect(short.posted.at(-1)).toMatchObject({ code: 'too-short' });
  });

  describe('quiet input is normalised before the analyzer (#96)', () => {
    const { y, sr } = readPcmWav('chords.wav');
    const exp: unknown = JSON.parse(
      readFileSync(join(FIXTURES, 'chords.expected.json'), 'utf8'),
    );
    const attenuated = (gainDb: number) => {
      const k = 10 ** (gainDb / 20);
      return y.map((v) => v * k);
    };
    const viaWorker = (samples: Float32Array): unknown => {
      const { scope, posted, send } = fakeScope();
      serve(scope, 'chords', runChords);
      send({ type: 'run', kind: 'chords', samples, sampleRate: sr });
      const last = posted.at(-1) as { type: string; result: unknown };
      expect(last.type).toBe('result');
      return JSON.parse(JSON.stringify(last.result));
    };

    it.each([-10, -18, -24, -30])(
      'chords.wav at %i dB: the Worker result matches chords.expected.json',
      (gainDb) => {
        expect(diffJson(viaWorker(attenuated(gainDb)), exp)).toEqual([]);
      },
    );

    it('the same -24 dB straight into analyze() does NOT match (the test is meaningful)', () => {
      const r = JSON.parse(
        JSON.stringify(analyze(attenuated(-24), { timings: false }).result),
      );
      expect(diffJson(r, exp)).not.toEqual([]);
    });

    it('a file that is silent only after resampling stays `silent` (not lifted into no-beats)', () => {
      // 15 kHz tone at 4e-5 passes the file-rate check, but the 22050 Hz resampling brings it to <= 2^-15
      const n = 44100 * 2;
      const tone = new Float32Array(n).map(
        (_, i) => 4e-5 * Math.sin((2 * Math.PI * 15000 * i) / 44100),
      );
      const { scope, posted, send } = fakeScope();
      serve(scope, 'chords', runChords);
      send({ type: 'run', kind: 'chords', samples: tone, sampleRate: 44100 });
      expect(posted.at(-1)).toMatchObject({ type: 'error', code: 'silent' });
    });
  });
});

describe('runHum', () => {
  it('reproduces the golden result through the Worker loop, with no network use', () => {
    const { y, sr } = readPcmWav('hum.wav');
    const exp = JSON.parse(
      readFileSync(join(FIXTURES, 'hum.expected.json'), 'utf8'),
    ) as {
      info: HumInput;
      result: { melody: unknown };
    };
    const { scope, posted, send } = fakeScope();
    serve(scope, 'hum', runHum);
    const msg = {
      type: 'run',
      kind: 'hum',
      samples: y,
      sampleRate: sr,
      info: exp.info,
      f0Track: false,
    };
    send(msg);
    expect(msg.samples).toBeNull(); // the Worker keeps no reference to the input
    const stages = posted.filter((m) => m.type === 'stage').map((m) => m.stage);
    expect(stages).toEqual([
      'validate',
      'resample',
      'f0',
      'level',
      'notes',
      'quantize',
    ]);
    const last = posted.at(-1) as { type: string; result: { melody: unknown } };
    expect(last.type).toBe('result');
    expect(JSON.parse(JSON.stringify(last.result.melody))).toEqual(
      exp.result.melody,
    );
  });

  it('unusable info: invalid-info with the Japanese message', () => {
    const { scope, posted, send } = fakeScope();
    serve(scope, 'hum', runHum);
    send({
      type: 'run',
      kind: 'hum',
      samples: new Float32Array(10),
      sampleRate: 8000,
      info: { bpm: 5, ts: [4, 4], startSec: 0 },
      f0Track: false,
    });
    expect(posted.at(-1)).toMatchObject({
      type: 'error',
      code: 'invalid-info',
      userMessage: expect.stringContaining('bpm'),
    });
  });
});

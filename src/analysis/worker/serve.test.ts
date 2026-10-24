import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisInputError } from '../../lib/analysis/chords/analyze';
import type { HumInput } from '../../lib/analysis/hum/types';
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

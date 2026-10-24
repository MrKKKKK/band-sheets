import { describe, expect, it, vi } from 'vitest';
import { createAnalysisClient } from './analysisClient';
import type { DecodeOptions } from './decodeFile';
import type { WorkerLike } from './kinds';
import type { RunMessage, WorkerMessage } from './protocol';
import {
  AnalysisError,
  type AnalysisKind,
  type AnalysisProgress,
  type DecodedAudio,
} from './types';

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  posted: { msg: RunMessage; transfer: Transferable[] }[] = [];
  terminated = false;
  readonly kind: AnalysisKind;
  constructor(kind: AnalysisKind) {
    this.kind = kind;
  }
  postMessage(msg: unknown, transfer: Transferable[]): void {
    this.posted.push({ msg: msg as RunMessage, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  send(m: WorkerMessage): void {
    this.onmessage?.({ data: m } as MessageEvent);
  }
}

function setup(decoded?: () => Promise<DecodedAudio>) {
  const workers: FakeWorker[] = [];
  const decode = vi.fn<
    (file: Blob, opts: DecodeOptions) => Promise<DecodedAudio>
  >(
    decoded ??
      (async () => ({
        samples: new Float32Array(8),
        sampleRate: 8000,
        channels: 1,
        durationSec: 0.001,
      })),
  );
  const client = createAnalysisClient({
    createWorker: (kind) => {
      const w = new FakeWorker(kind);
      workers.push(w);
      return w;
    },
    decode,
  });
  return { client, workers, decode };
}

/** Lets the client's async start (decode -> create Worker -> post) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof AnalysisError ? e.code : `other: ${String(e)}`;
  }
}

const audio = (n = 4): DecodedAudio => ({
  samples: new Float32Array(n),
  sampleRate: 22050,
  channels: 1,
  durationSec: n / 22050,
});

describe('createAnalysisClient', () => {
  it('decodes, posts the samples transferred, reports progress per stage, resolves and terminates the Worker', async () => {
    const { client, workers, decode } = setup();
    const progress: AnalysisProgress[] = [];
    const file = new Blob(['x']);
    const p = client.run({ kind: 'chords', source: { file } }, (e) =>
      progress.push(e),
    );
    await flush();
    expect(decode).toHaveBeenCalledWith(file, expect.anything());
    expect(workers).toHaveLength(1);
    const w = workers[0];
    expect(w.kind).toBe('chords');
    const { msg, transfer } = w.posted[0];
    expect(msg).toMatchObject({
      type: 'run',
      kind: 'chords',
      sampleRate: 8000,
    });
    expect(transfer).toEqual([msg.samples.buffer]);
    w.send({ type: 'stage', stage: 'resample', ms: 1 });
    w.send({ type: 'stage', stage: 'load', ms: 1 });
    const result = { beats: [] };
    w.send({ type: 'result', result });
    expect(await p).toBe(result);
    expect(w.terminated).toBe(true);
    expect(w.onmessage).toBeNull();
    expect(progress.map((e) => [e.stage, e.next, e.done, e.total])).toEqual([
      ['decode', 'resample', 1, 13],
      ['resample', 'load', 2, 13],
      ['load', 'beats', 3, 13],
    ]);
  });

  it('hum: passes info and f0Track; already-decoded audio skips decoding and is transferred', async () => {
    const { client, workers, decode } = setup();
    const a = audio();
    const info = { bpm: 100, ts: [4, 4] as [number, number], startSec: 0 };
    const p = client.run({
      kind: 'hum',
      source: { audio: a },
      info,
      f0Track: true,
    });
    await flush();
    expect(decode).not.toHaveBeenCalled();
    const { msg, transfer } = workers[0].posted[0];
    expect(msg).toMatchObject({
      kind: 'hum',
      info,
      f0Track: true,
      firstNoteAuto: false,
      sampleRate: 22050,
    });
    expect(msg.samples).toBe(a.samples);
    expect(transfer).toEqual([a.samples.buffer]);
    workers[0].send({ type: 'result', result: 1 });
    expect(await p).toBe(1);
  });

  it('hum: passes firstNoteAuto (S2: the Worker finds the first note)', async () => {
    const { client, workers } = setup();
    const info = {
      bpm: 100,
      ts: [4, 4] as [number, number],
      firstNoteSec: 0,
      firstNoteTick: 16,
    };
    void client.run({
      kind: 'hum',
      source: { audio: audio() },
      info,
      firstNoteAuto: true,
    });
    await flush();
    expect(workers[0].posted[0].msg).toMatchObject({
      info,
      firstNoteAuto: true,
    });
  });

  it('a Worker error message becomes an AnalysisError with its code and Japanese message', async () => {
    const { client, workers } = setup();
    const p = client.run({ kind: 'chords', source: { audio: audio() } });
    await flush();
    workers[0].send({ type: 'error', code: 'silent', userMessage: '無音です' });
    await expect(p).rejects.toMatchObject({
      code: 'silent',
      userMessage: '無音です',
    });
    expect(workers[0].terminated).toBe(true);
  });

  it('an uncaught Worker error is worker-crashed (out-of-memory when it says so)', async () => {
    const { client, workers } = setup();
    const p1 = client.run({ kind: 'chords', source: { audio: audio() } });
    await flush();
    workers[0].onerror?.({
      message: 'Uncaught Error',
      preventDefault() {},
    } as ErrorEvent);
    expect(await codeOf(p1)).toBe('worker-crashed');
    const p2 = client.run({ kind: 'chords', source: { audio: audio() } });
    await flush();
    workers[1].onerror?.({
      message: 'Uncaught RangeError: Array buffer allocation failed',
      preventDefault() {},
    } as ErrorEvent);
    expect(await codeOf(p2)).toBe('out-of-memory');
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it('cancel() terminates the Worker at once and rejects with cancelled; later messages are ignored', async () => {
    const { client, workers } = setup();
    const progress = vi.fn();
    const p = client.run(
      { kind: 'chords', source: { audio: audio() } },
      progress,
    );
    await flush();
    progress.mockClear();
    client.cancel();
    expect(workers[0].terminated).toBe(true);
    expect(await codeOf(p)).toBe('cancelled');
    workers[0].send({ type: 'stage', stage: 'load', ms: 1 });
    expect(progress).not.toHaveBeenCalled();
    client.cancel(); // idle: no-op
  });

  it('cancel() during decoding: no Worker is created and the decoded audio is dropped', async () => {
    let finishDecode: (a: DecodedAudio) => void = () => {};
    const { client, workers, decode } = setup(
      () => new Promise((r) => (finishDecode = r)),
    );
    const p = client.run({ kind: 'chords', source: { file: new Blob(['x']) } });
    await flush();
    const signal = decode.mock.calls[0][1].signal as AbortSignal;
    client.cancel();
    expect(signal.aborted).toBe(true);
    expect(await codeOf(p)).toBe('cancelled');
    finishDecode(audio());
    await flush();
    expect(workers).toHaveLength(0);
  });

  it('decode errors pass through; anything else becomes internal', async () => {
    const { client } = setup(() =>
      Promise.reject(new AnalysisError('decode-failed')),
    );
    expect(
      await codeOf(
        client.run({ kind: 'chords', source: { file: new Blob([]) } }),
      ),
    ).toBe('decode-failed');
    const other = setup(() => Promise.reject(new Error('boom')));
    expect(
      await codeOf(
        other.client.run({ kind: 'chords', source: { file: new Blob([]) } }),
      ),
    ).toBe('internal');
  });

  it('a new run cancels the active one; each run gets its own Worker', async () => {
    const { client, workers } = setup();
    const p1 = client.run({ kind: 'chords', source: { audio: audio() } });
    await flush();
    const p2 = client.run({ kind: 'chords', source: { audio: audio() } });
    expect(await codeOf(p1)).toBe('cancelled');
    await flush();
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    workers[1].send({ type: 'result', result: 'ok' });
    expect(await p2).toBe('ok');
  });

  it('a Worker that cannot be created is unsupported', async () => {
    const client = createAnalysisClient({
      createWorker: () => {
        throw new Error('no Worker');
      },
    });
    expect(
      await codeOf(
        client.run({
          kind: 'hum',
          source: { audio: audio() },
          info: { bpm: 1, ts: [4, 4] },
        }),
      ),
    ).toBe('unsupported');
  });
});

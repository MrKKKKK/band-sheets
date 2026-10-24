import { describe, expect, it } from 'vitest';
import { createFakeAnalysisClient } from './fakeAnalysisClient';
import { AnalysisError, type AnalysisResultMap } from './types';

const file = new Blob(['x']);
const chordsResult = { beats: [] } as unknown as AnalysisResultMap['chords'];

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof AnalysisError ? e.code : 'other';
  }
}

describe('createFakeAnalysisClient', () => {
  it('replays every stage, then resolves with the given result', async () => {
    const c = createFakeAnalysisClient({ results: { chords: chordsResult } });
    const stages: string[] = [];
    const r = await c.run({ kind: 'chords', source: { file } }, (p) =>
      stages.push(p.stage),
    );
    expect(r).toBe(chordsResult);
    expect(stages[0]).toBe('decode');
    expect(stages).toHaveLength(13);
    expect(c.requests).toHaveLength(1);
  });

  it('fails with the given code after N stages', async () => {
    const c = createFakeAnalysisClient({
      error: 'no-beats',
      userMessage: '拍が見つかりませんでした。',
      failAfterStages: 3,
    });
    const stages: string[] = [];
    const p = c.run({ kind: 'chords', source: { file } }, (e) =>
      stages.push(e.stage),
    );
    await expect(p).rejects.toMatchObject({
      code: 'no-beats',
      userMessage: '拍が見つかりませんでした。',
    });
    expect(stages).toEqual(['decode', 'resample', 'load']);
  });

  it('holds after N stages until cancel()', async () => {
    const c = createFakeAnalysisClient({ holdAfterStages: 2 });
    let done = 0;
    const p = c.run(
      {
        kind: 'hum',
        source: { file },
        info: { bpm: 100, ts: [4, 4], startSec: 0 },
      },
      (e) => (done = e.done),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(2);
    c.cancel();
    expect(await codeOf(p)).toBe('cancelled');
    expect(c.cancelCount).toBe(1);
  });

  it('no result for the kind: internal', async () => {
    const c = createFakeAnalysisClient();
    expect(await codeOf(c.run({ kind: 'chords', source: { file } }))).toBe(
      'internal',
    );
  });
});

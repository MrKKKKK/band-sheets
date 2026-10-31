import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createFakeAnalysisClient,
  type FakeAnalysisOptions,
} from '../analysis/fakeAnalysisClient';
import type { HumRequest } from '../analysis/types';
import { HUM_STEPS } from '../lib/import/humImport';
import {
  humSampleResult,
  humSilentResult,
} from '../lib/import/fixtures/humResults';
import { useAnalysisRun } from './useAnalysisRun';

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const file = (name: string) => new File(['x'], name, { type: 'audio/wav' });

function setup(
  opts: FakeAnalysisOptions = { results: { hum: humSampleResult() } },
  probeSec: number | null = 30,
) {
  const client = createFakeAnalysisClient(opts);
  const hook = renderHook(() =>
    useAnalysisRun<HumRequest>({
      client,
      probe: async () => probeSec,
      steps: HUM_STEPS,
      doneMessage: '終わりました',
      rejectResult: (r) =>
        r.melody.quantized.events.some((e) => e.kind === 'note')
          ? null
          : { severity: 'error', message: 'no voice', retry: true },
    }),
  );
  const req = (f: File): HumRequest => ({
    kind: 'hum',
    source: { file: f },
    info: { bpm: 100, ts: [4, 4], startSec: 2.4 },
  });
  return { client, hook, req };
}

describe('useAnalysisRun.startFile', () => {
  it('works when nothing was picked: analyzing -> review, no 選びました', async () => {
    const { hook, req, client } = setup();
    const take = file('take.wav');
    await act(async () => {
      await hook.result.current.startFile(take, 12, req(take));
    });
    expect(client.requests).toHaveLength(1);
    expect(hook.result.current.phase.kind).toBe('review');
    expect(hook.result.current.live).toBe('終わりました');
    expect(hook.result.current.live).not.toContain('選びました');
  });

  it('announces the start without 選びました', async () => {
    const { hook, req } = setup({
      results: { hum: humSampleResult() },
      holdAfterStages: 1,
    });
    const take = file('take.wav');
    await act(async () => {
      void hook.result.current.startFile(take, 12, req(take));
    });
    const r = hook.result.current;
    expect(r.phase).toMatchObject({
      kind: 'analyzing',
      file: take,
      duration: 12,
    });
    expect(r.live).toContain('段階');
    expect(r.live).not.toContain('選びました');
  });

  it('can be called right after pick in the same handler (no stale phase)', async () => {
    const { hook, req, client } = setup();
    const take = file('take.wav');
    await act(async () => {
      await hook.result.current.pick(file('a.wav'));
      await hook.result.current.startFile(take, 12, req(take));
    });
    expect(client.requests).toHaveLength(1);
    expect(hook.result.current.phase.kind).toBe('review');
  });

  it('on failure returns to the file picked before, with the notice', async () => {
    const { hook, req, client } = setup({ error: 'internal' });
    const picked = file('a.wav');
    await act(async () => {
      await hook.result.current.pick(picked);
    });
    const take = file('take.wav');
    await act(async () => {
      await hook.result.current.startFile(take, 12, req(take));
    });
    expect(hook.result.current.phase).toMatchObject({
      kind: 'pick',
      file: picked,
      duration: 30,
    });
    expect(hook.result.current.phase).toHaveProperty('notice.message');
    // the picked file can still be analysed (start accepts it again)
    await act(async () => {
      await hook.result.current.start(req(picked));
    });
    expect(client.requests).toHaveLength(2);
  });

  it('start + too-long drops the file (back to an empty pick)', async () => {
    const { hook, req } = setup({ error: 'too-long' });
    const f = file('a.wav');
    await act(async () => {
      await hook.result.current.pick(f);
    });
    await act(async () => {
      await hook.result.current.start(req(f));
    });
    expect(hook.result.current.phase).toMatchObject({
      kind: 'pick',
      file: null,
      duration: null,
    });
  });

  it('on failure with nothing picked returns to an empty pick phase', async () => {
    const { hook, req } = setup({ error: 'internal' });
    const take = file('take.wav');
    await act(async () => {
      await hook.result.current.startFile(take, 12, req(take));
    });
    expect(hook.result.current.phase).toMatchObject({
      kind: 'pick',
      file: null,
      duration: null,
    });
  });

  it('keeps the picked file when the take is too long', async () => {
    const { hook, req } = setup({ error: 'too-long' });
    const picked = file('a.wav');
    await act(async () => {
      await hook.result.current.pick(picked);
    });
    const take = file('take.wav');
    await act(async () => {
      await hook.result.current.startFile(take, 12, req(take));
    });
    expect(hook.result.current.phase).toMatchObject({
      kind: 'pick',
      file: picked,
    });
  });

  it('cancel returns to the picked file (not the take)', async () => {
    const { hook, req, client } = setup({
      results: { hum: humSampleResult() },
      holdAfterStages: 1,
    });
    const picked = file('a.wav');
    await act(async () => {
      await hook.result.current.pick(picked);
    });
    const take = file('take.wav');
    await act(async () => {
      void hook.result.current.startFile(take, 12, req(take));
    });
    expect(hook.result.current.phase.kind).toBe('analyzing');
    act(() => hook.result.current.cancel());
    expect(client.cancelCount).toBe(1);
    expect(hook.result.current.phase).toMatchObject({
      kind: 'pick',
      file: picked,
      duration: 30,
    });
    expect(hook.result.current.live).toBe('中止しました。');
  });

  it('cancel with nothing picked returns to an empty pick phase', async () => {
    const { hook, req } = setup({
      results: { hum: humSampleResult() },
      holdAfterStages: 1,
    });
    const take = file('take.wav');
    await act(async () => {
      void hook.result.current.startFile(take, 12, req(take));
    });
    act(() => hook.result.current.cancel());
    expect(hook.result.current.phase).toMatchObject({
      kind: 'pick',
      file: null,
    });
  });

  it('a rejected result (no voice) returns to the picked file', async () => {
    const { hook, req } = setup({ results: { hum: humSilentResult() } });
    const picked = file('a.wav');
    await act(async () => {
      await hook.result.current.pick(picked);
    });
    const take = file('take.wav');
    await act(async () => {
      await hook.result.current.startFile(take, 12, req(take));
    });
    expect(hook.result.current.phase).toMatchObject({
      kind: 'pick',
      file: picked,
    });
  });

  it('does nothing while an analysis runs', async () => {
    const { hook, req, client } = setup({
      results: { hum: humSampleResult() },
      holdAfterStages: 1,
    });
    const take = file('take.wav');
    await act(async () => {
      void hook.result.current.startFile(take, 12, req(take));
    });
    await act(async () => {
      await hook.result.current.startFile(file('b.wav'), 5, req(take));
    });
    expect(client.requests).toHaveLength(1);
  });

  it('leaves pick/start behaviour: pick announces 選びました and start analyses it', async () => {
    const { hook, req } = setup();
    const f = file('a.wav');
    await act(async () => {
      await hook.result.current.pick(f);
    });
    expect(hook.result.current.live).toContain('a.wav を選びました');
    await act(async () => {
      await hook.result.current.start(req(f));
    });
    await flush();
    expect(hook.result.current.phase.kind).toBe('review');
  });
});

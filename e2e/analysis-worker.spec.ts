/**
 * The real analysis Workers in Chromium (plan sections 2.2, 2.3, 5, 7): e2e/harness/analysis.html drives
 * src/analysis/analysisClient.ts on SYNTHETIC fixtures (src/lib/analysis/fixtures/, golden.test.ts) and checks the
 * result equals the golden expectation, that nothing is requested off-origin, one Worker per run, and cancel.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import type {
  Harness,
  HarnessOutcome,
  HarnessRunOptions,
} from '../src/analysis/testing/harness';
import {
  diffJson,
  FIXTURES,
  loopTo,
  offOriginRequests,
  readFixtureJson,
  readFixtureWav,
  writeWav16,
} from './support/analysisAudio';

const HARNESS = '/e2e/harness/analysis.html';

async function open(page: Page): Promise<{ offOrigin: string[] }> {
  // listen before the page loads, so every request (page, modules, Workers) is seen
  const offOrigin = offOriginRequests(
    page,
    new URL(test.info().project.use.baseURL!).origin,
  );
  await page.goto(HARNESS);
  await page.waitForFunction(() => '__analysis' in window);
  return { offOrigin };
}

function run(
  page: Page,
  kind: 'chords' | 'hum',
  opts?: HarnessRunOptions,
): Promise<HarnessOutcome> {
  return page.evaluate(
    ([k, o]) =>
      (window as unknown as { __analysis: Harness }).__analysis.run(k, o),
    [kind, opts] as const,
  );
}

/** Counts Workers and how many of them were closed (terminated). */
function trackWorkers(page: Page) {
  const s = { created: 0, closed: 0 };
  page.on('worker', (w) => {
    s.created++;
    w.on('close', () => s.closed++);
  });
  return s;
}

test('chords: the real Worker reproduces the golden result, no off-origin request, Worker terminated', async ({
  page,
}) => {
  const { offOrigin } = await open(page);
  const workers = trackWorkers(page);
  await page.setInputFiles('#file', join(FIXTURES, 'chords.wav'));
  const out = await run(page, 'chords');
  expect(out).toMatchObject({ ok: true });
  if (!out.ok) return;
  const expected = readFixtureJson<unknown>('chords.expected.json');
  expect(diffJson(out.result, expected)).toEqual([]);
  const stages = await page.evaluate(() =>
    (window as unknown as { __analysis: Harness }).__analysis.progress.map(
      (p) => `${p.stage}:${p.done}/${p.total}`,
    ),
  );
  expect(stages[0]).toBe('decode:1/13');
  expect(stages.at(-1)).toBe('merge2:13/13');
  await expect.poll(() => workers.closed).toBe(1);
  expect(workers.created).toBe(1);
  expect(offOrigin).toEqual([]);
});

test('hum: the real Worker reproduces the golden result (f0 track, notes, quantized melody)', async ({
  page,
}) => {
  const { offOrigin } = await open(page);
  await page.setInputFiles('#file', join(FIXTURES, 'hum.wav'));
  const exp = readFixtureJson<{
    info: NonNullable<HarnessRunOptions['info']>;
    result: { source: { kind: string } };
  }>('hum.expected.json');
  const out = await run(page, 'hum', { info: exp.info, f0Track: true });
  expect(out).toMatchObject({ ok: true });
  if (!out.ok) return;
  const got = out.result as { hum: { meta: { timings?: unknown } } };
  delete got.hum.meta.timings; // not reproducible
  // the golden run was marked 'synthetic'; the app always says 'recording'
  const expected = {
    ...exp.result,
    source: { ...exp.result.source, kind: 'recording' },
  };
  expect(diffJson(got, expected)).toEqual([]);
  expect(offOrigin).toEqual([]);
});

test('cancel: terminates the Worker at once and reports cancelled; a new run works afterwards', async ({
  page,
}) => {
  const { offOrigin } = await open(page);
  const workers = trackWorkers(page);
  const { y, sr } = readFixtureWav('chords.wav');
  await page.setInputFiles(
    '#file',
    writeWav16('chords-60s.wav', loopTo(y, sr, 60), sr),
  );
  const pending = run(page, 'chords', { summaryOnly: true });
  // wait until the Worker is busy (past decode and resample), then cancel
  await page.waitForFunction(
    () =>
      (window as unknown as { __analysis: Harness }).__analysis.progress
        .length >= 2,
  );
  const cancelledAt = Date.now();
  await page.evaluate(() =>
    (window as unknown as { __analysis: Harness }).__analysis.cancel(),
  );
  const out = await pending;
  expect(out).toMatchObject({ ok: false, code: 'cancelled' });
  // at once: terminate() does not wait for the running stage
  expect(Date.now() - cancelledAt).toBeLessThan(1000);
  await expect.poll(() => workers.closed).toBe(1);

  await page.setInputFiles('#file', join(FIXTURES, 'chords.wav'));
  expect(await run(page, 'chords', { summaryOnly: true })).toMatchObject({
    ok: true,
  });
  await expect.poll(() => workers.closed).toBe(2);
  expect(workers.created).toBe(2);
  expect(offOrigin).toEqual([]);
});

for (const kind of ['chords', 'hum'] as const) {
  test(`${kind} Worker: every network path throws inside the Worker`, async ({
    page,
  }) => {
    await open(page);
    const [worker] = await Promise.all([
      page.waitForEvent('worker'),
      page.evaluate(
        (k) =>
          (window as unknown as { __analysis: Harness }).__analysis.spawnIdle(
            k,
          ),
        kind,
      ),
    ]);
    // wait until the Worker's modules ran (serve() installed its handler)
    await expect
      .poll(() => worker.evaluate(() => typeof self.onmessage))
      .toBe('function');
    const results = await worker.evaluate(() => {
      const g = self as unknown as Record<string, (...a: unknown[]) => unknown>;
      const tryCall = (name: string, ...args: unknown[]) => {
        try {
          const f = g[name];
          // called without `new`: an unlocked constructor would throw a TypeError instead
          f.call(self, ...args);
          return 'no error';
        } catch (e) {
          return (e as Error).name;
        }
      };
      return {
        fetch: tryCall('fetch', '/x'),
        XMLHttpRequest: tryCall('XMLHttpRequest'),
        WebSocket: tryCall('WebSocket', 'ws://127.0.0.1:1'),
        EventSource: tryCall('EventSource', '/x'),
        importScripts: tryCall('importScripts', '/x.js'),
      };
    });
    expect(results).toEqual({
      fetch: 'NetworkForbiddenError',
      XMLHttpRequest: 'NetworkForbiddenError',
      WebSocket: 'NetworkForbiddenError',
      EventSource: 'NetworkForbiddenError',
      importScripts: 'NetworkForbiddenError',
    });
    await page.evaluate(() =>
      (window as unknown as { __analysis: Harness }).__analysis.stopIdle(),
    );
  });
}

test('errors: undecodable file, silent audio, unusable hum info', async ({
  page,
}) => {
  const { offOrigin } = await open(page);
  await page.setInputFiles('#file', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not audio'),
  });
  expect(await run(page, 'chords')).toMatchObject({
    ok: false,
    code: 'decode-failed',
  });

  await page.setInputFiles(
    '#file',
    writeWav16('silent-3s.wav', new Float32Array(3 * 22050), 22050),
  );
  const silent = await run(page, 'chords');
  expect(silent).toMatchObject({ ok: false, code: 'silent' });
  if (!silent.ok) expect(silent.userMessage).toContain('無音');

  await page.setInputFiles('#file', join(FIXTURES, 'hum.wav'));
  expect(
    await run(page, 'hum', { info: { bpm: 0, ts: [4, 4], startSec: 0 } }),
  ).toMatchObject({
    ok: false,
    code: 'invalid-info',
  });
  expect(offOrigin).toEqual([]);
});

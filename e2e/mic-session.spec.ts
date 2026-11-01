/**
 * The real MicSession on the DEV server (docs/mic-recording-plan.md §2.5, T3): Chromium's fake mic, the capture
 * worklet loaded as a same-origin module through Vite's `?worker&url` (served as `?worker_file&type=module` in dev),
 * clicks scheduled up front, chunks on the context frame axis. The production build is checked in e2e/csp/.
 * The fake device's timing is not real, so only the plumbing is checked here, not the latency.
 */
import { expect, test } from '@playwright/test';
import type { MicHarness } from '../src/audio/testing/micHarness';
import { offOriginRequests } from './support/analysisAudio';

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  },
});

test('open the default mic, re-open a chosen one by its id, capture 2 s with clicks, blocks arrive, close', async ({
  page,
}) => {
  const offOrigin = offOriginRequests(
    page,
    new URL(test.info().project.use.baseURL!).origin,
  );
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/e2e/harness/mic.html');
  await page.waitForFunction(() => '__mic' in window);
  await page.getByRole('button', { name: 'open' }).click();
  const opened = await page.evaluate(
    () => (window as unknown as { __mic: MicHarness }).__mic.opened,
  );
  if ('error' in opened) throw new Error(opened.error);
  // Chromium's fake `default` has a groupId and label of its own (no real twin), so it stays `default` here; the
  // folding onto a real device is unit-tested and checked on a real PC (plan T3 / G1)
  const def = opened.devices.find((d) => d.isDefault);
  expect(opened.deviceId).toBe(def?.deviceId);
  expect(opened.devices.map((d) => d.deviceId)).not.toContain('communications');
  expect(opened.sampleRate).toBeGreaterThan(0);
  // dev: Vite serves the worklet as a module straight from the source (the build is checked in e2e/csp/)
  expect(opened.workletUrl).toMatch(
    /\/src\/audio\/capture\.worklet\.ts\?worker_file/,
  );

  // a chosen device is opened {exact}: the track reports that very id
  const other = opened.devices.find((d) => !d.isDefault);
  expect(other).toBeDefined();
  const reopened = await page.evaluate(
    (id) => (window as unknown as { __mic: MicHarness }).__mic.reopen(id),
    other!.deviceId,
  );
  if ('error' in reopened) throw new Error(reopened.error);
  expect(reopened.deviceId).toBe(other!.deviceId);
  expect(reopened.label).toBe(other!.label);

  const take = await page.evaluate(() =>
    (window as unknown as { __mic: MicHarness }).__mic.record(2),
  );
  expect(take.end.reason).toBe('stopped');
  const seconds = (take.endFrame - take.firstFrame) / opened.sampleRate;
  expect(seconds).toBeGreaterThan(1.5);
  expect(take.end.frame).toBe(take.endFrame);
  expect(take.levels).toBeGreaterThan(10);
  // Chromium's fake mic plays a beep: something non-silent reached the buffer
  expect(take.peak).toBeGreaterThan(0.01);
  await page.evaluate(() =>
    (window as unknown as { __mic: MicHarness }).__mic.close(),
  );
  expect(errors).toEqual([]);
  expect(offOrigin).toEqual([]);
});

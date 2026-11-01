/**
 * Memory while recording with the mic (docs/mic-recording-plan.md §3 / T7), NOT part of `npm run e2e`:
 *   npm run perf:mic                 # the real thing: records until the 10-minute auto stop (~11 min of real time)
 *   MIC_PERF_SEC=30 npm run perf:mic # a short run (stop by ■ after 30 s) to check the script works
 * Method: Chromium's fake mic plays a generated 11-minute wav (e2e/support/micFakeAudio.ts, the synthetic hum
 * fixture looped; written by perf.globalSetup.ts); the sample song's 「マイクで録る」 screen records. Real time is
 * required: the AudioContext / worklet run on the audio clock, which `page.clock` does not control. Every 5 s we
 * sample (a) the renderer process VmRSS from /proc (largest renderer; Linux), (b) CDP Performance.getMetrics
 * JSHeapUsedSize. "before" = just before ● 録音 (mic open, idle); "increase" = peak - before, taken while recording
 * and again after the take is made (the wav Blob is built then). A table is printed and written to
 * test-results/mic-memory.json. Target (plan): RSS increase <= 150 MB over the 10 minutes.
 */
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEN_DIR } from '../support/analysisAudio';
import { freshStart } from '../support/app';
import { rendererRssMb } from '../support/rss';

const SHORT = Number(process.env.MIC_PERF_SEC ?? 0);
test.setTimeout(SHORT ? 180_000 : 15 * 60_000);

test('mic memory while recording', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshStart(page);
  await page
    .getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' })
    .click();
  await page.getByRole('tab', { name: 'メロディ' }).click();
  await page.getByRole('button', { name: '鼻歌から下書き' }).click();
  await page.getByRole('button', { name: 'マイクで録る' }).click();
  const panel = page.getByTestId('mic-panel');
  await expect(panel).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heapMb = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return (
      (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) /
      1024 /
      1024
    );
  };
  await page.waitForTimeout(1000);
  const before = { rss: rendererRssMb(), heap: await heapMb() };

  const rows: { t: number; rssMb: number; heapMb: number }[] = [];
  let peakRss = before.rss;
  const sample = async (t: number) => {
    const rss = rendererRssMb();
    peakRss = Math.max(peakRss, rss);
    rows.push({
      t,
      rssMb: Math.round(rss),
      heapMb: Math.round(await heapMb()),
    });
  };

  await page.getByRole('button', { name: '● 録音' }).click();
  await expect(panel).toHaveAttribute('data-phase', 'recording', {
    timeout: 20_000,
  });
  const started = Date.now();
  const limitMs = SHORT ? SHORT * 1000 : 11 * 60_000;
  while (Date.now() - started < limitMs) {
    if ((await panel.getAttribute('data-phase')) !== 'recording') break; // 10-minute auto stop
    await sample(Math.round((Date.now() - started) / 1000));
    await page.waitForTimeout(5000);
  }
  if ((await panel.getAttribute('data-phase')) === 'recording')
    await page.getByRole('button', { name: '■ 止める' }).click();
  await expect(panel).toHaveAttribute('data-phase', 'take', {
    timeout: 60_000,
  });
  await sample(Math.round((Date.now() - started) / 1000));

  const last = rows[rows.length - 1];
  const summary = {
    seconds: last.t,
    rssBeforeMb: Math.round(before.rss),
    rssPeakMb: Math.round(peakRss),
    rssIncreaseMb: Math.round(peakRss - before.rss),
    heapBeforeMb: Math.round(before.heap),
    heapAfterMb: last.heapMb,
    targetIncreaseMb: 150,
  };
  console.table(rows);
  console.log(JSON.stringify(summary));
  writeFileSync(
    join(GEN_DIR, '../mic-memory.json'),
    JSON.stringify({ summary, rows }, null, 1) + '\n',
  );
});

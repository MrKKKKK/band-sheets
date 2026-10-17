/**
 * T8: open the bench in the devcontainer's Chromium, run 1 / 3 / 5 minutes and the resampler
 * comparison, and check: no request leaves the page's own origin (every request is counted), the UI
 * timer kept ticking during analysis (the Worker does the work), and the results are sane.
 * The table is written to out/t8/bench.json (gitignored) and printed.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Largest VmRSS (MB) among Chromium renderer processes (the page and its Worker live in one). */
function rendererRssMb(): number {
  let max = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) continue;
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) max = Math.max(max, Number(m[1]) / 1024);
    } catch {
      /* process went away */
    }
  }
  return max;
}

test('bench: 1/3/5 min in a Worker, 0 foreign requests, timer keeps running', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (ws) => requests.push(`websocket ${ws.url()}`));
  page.on('worker', (w) => requests.push(`worker ${w.url()}`));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/bench.html');
  await page.waitForFunction(() => (window as unknown as { __bench: { ready: boolean } }).__bench.ready, null, {
    timeout: 60_000,
  });
  const origin = new URL(page.url()).origin;

  const rows = [];
  for (const min of [1, 3, 5]) {
    const timerBefore = Number(await page.locator('#timer').textContent());
    const rssBefore = rendererRssMb();
    let rssPeak = rssBefore;
    const poll = setInterval(() => (rssPeak = Math.max(rssPeak, rendererRssMb())), 100);
    const row = await page.evaluate(
      (m) => (window as unknown as { __benchApi: { runMinutes(m: number): Promise<unknown> } }).__benchApi.runMinutes(m),
      min,
    );
    clearInterval(poll);
    const timerAfter = Number(await page.locator('#timer').textContent());
    rows.push({ ...(row as object), timerBefore, timerAfter, rendererRssBeforeMb: Math.round(rssBefore), rendererRssPeakMb: Math.round(rssPeak) });
  }
  const resampler = await page.evaluate(() =>
    (window as unknown as { __benchApi: { compareResamplers(): Promise<unknown> } }).__benchApi.compareResamplers(),
  );
  const bench = await page.evaluate(() => (window as unknown as { __bench: { clipSource: string } }).__bench);

  const foreign = requests.filter((u) => {
    const url = u.replace(/^(websocket|worker) /, '');
    return !url.startsWith(origin + '/') && !url.startsWith('blob:' + origin);
  });
  const outDir = join(import.meta.dirname, '../../out/t8');
  mkdirSync(outDir, { recursive: true });
  const report = { clipSource: bench.clipSource, userAgent: await page.evaluate(() => navigator.userAgent), rows, resampler, requests, foreign };
  writeFileSync(join(outDir, 'bench.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  expect(errors).toEqual([]);
  expect(foreign).toEqual([]);
  expect(requests.some((u) => u.startsWith('websocket'))).toBe(false);
  expect(bench.clipSource).toBe('dev synthetic render (clip.wav)');
  for (const r of rows as unknown as {
    inputSec: number;
    ticks: number;
    maxTickGapMs: number;
    wallMs: number;
    beats: number;
    timerBefore: number;
    timerAfter: number;
  }[]) {
    // the 50 ms UI timer fired throughout the analysis: at least half the expected ticks, no stall > 1 s
    expect(r.ticks).toBeGreaterThan(r.wallMs / 50 / 2);
    expect(r.maxTickGapMs).toBeLessThan(1000);
    expect(r.timerAfter).toBeGreaterThan(r.timerBefore);
    expect(r.beats).toBeGreaterThan(r.inputSec * 1.5); // ~116 BPM clip
  }
  expect((resampler as Record<string, number>)['ours vs librosa SNR dB']).toBeGreaterThan(70);
});

test('bench: 5 min alone in a fresh page (peak renderer memory without earlier runs)', async ({ page }) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:5181/')) foreign.push(r.url());
  });
  await page.goto('/bench.html');
  await page.waitForFunction(() => (window as unknown as { __bench: { ready: boolean } }).__bench.ready, null, {
    timeout: 60_000,
  });
  const rssBefore = rendererRssMb();
  let rssPeak = rssBefore;
  const poll = setInterval(() => (rssPeak = Math.max(rssPeak, rendererRssMb())), 100);
  const row = (await page.evaluate(() =>
    (window as unknown as { __benchApi: { runMinutes(m: number): Promise<unknown> } }).__benchApi.runMinutes(5),
  )) as { maxTickGapMs: number };
  clearInterval(poll);
  const report = { ...row, rendererRssBeforeMb: Math.round(rssBefore), rendererRssPeakMb: Math.round(rssPeak) };
  const outDir = join(import.meta.dirname, '../../out/t8');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'bench-fresh5.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  expect(foreign).toEqual([]);
  expect(row.maxTickGapMs).toBeLessThan(1000);
});

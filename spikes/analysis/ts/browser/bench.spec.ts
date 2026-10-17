/**
 * T16: open the bench in the devcontainer's Chromium and run the FULL analyzer (Worker) on 1 / 3 / 5
 * minutes, both "in sequence" (one page, 1 -> 3 -> 5) and "fresh page" (one new page per length).
 * Checks: every request is counted and must stay on the page's own origin (no WebSocket), the 50 ms UI
 * timer keeps ticking, results are sane. RSS = VmRSS of the Chromium renderer process(es) from /proc,
 * polled every 100 ms: before = just before the run starts (page ready, 1-min clip decoded), peak, and
 * increase = peak - before. The table is written to out/t16/bench.json (gitignored).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** VmRSS (MB) of the Chromium renderer processes: the largest one and the sum (page and Worker share one). */
function rendererRssMb(): { max: number; sum: number } {
  let max = 0;
  let sum = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) continue;
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) {
        const mb = Number(m[1]) / 1024;
        max = Math.max(max, mb);
        sum += mb;
      }
    } catch {
      /* process went away */
    }
  }
  return { max, sum };
}

type Api = { __benchApi: { runMinutes(m: number): Promise<unknown> }; __bench: { ready: boolean; clipSource: string } };
interface Row {
  mode: 'sequence' | 'fresh';
  minutes: number;
  inputSec: number;
  wallMs: number;
  totalMs: number;
  stages: { name: string; ms: number; memLive: number; memPeak: number }[];
  memPeak: number;
  workerHeap?: number;
  ticks: number;
  maxTickGapMs: number;
  beats: number;
  chords: number;
  sections: number;
  warnings: string[];
  timerBefore: number;
  timerAfter: number;
  rssBeforeMb: number;
  rssPeakMb: number;
  rssIncreaseMb: number;
  rssSumBeforeMb: number;
  rssSumPeakMb: number;
  rssSumIncreaseMb: number;
}

const ORIGIN = 'http://127.0.0.1:5181';
const rows: Row[] = [];
const requests: string[] = [];
const errors: string[] = [];
let clipSource = '';
let userAgent = '';

function watch(page: Page): void {
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (ws) => requests.push(`websocket ${ws.url()}`));
  page.on('worker', (w) => requests.push(`worker ${w.url()}`));
  page.on('pageerror', (e) => errors.push(String(e)));
}

async function openPage(page: Page): Promise<void> {
  watch(page);
  await page.goto('/bench.html');
  await page.waitForFunction(() => (window as unknown as Api).__bench.ready, null, { timeout: 60_000 });
  clipSource = await page.evaluate(() => (window as unknown as Api).__bench.clipSource);
  userAgent = await page.evaluate(() => navigator.userAgent);
}

async function measure(page: Page, mode: Row['mode'], min: number): Promise<void> {
  const timerBefore = Number(await page.locator('#timer').textContent());
  await page.waitForTimeout(1500); // let earlier garbage settle before the "before" value
  const b = rendererRssMb();
  let peak = b.max;
  let sumPeak = b.sum;
  const poll = setInterval(() => {
    const r = rendererRssMb();
    peak = Math.max(peak, r.max);
    sumPeak = Math.max(sumPeak, r.sum);
  }, 100);
  const row = (await page.evaluate((m) => (window as unknown as Api).__benchApi.runMinutes(m), min)) as Omit<
    Row,
    'mode' | 'minutes'
  >;
  clearInterval(poll);
  const timerAfter = Number(await page.locator('#timer').textContent());
  rows.push({
    ...row,
    mode,
    minutes: min,
    timerBefore,
    timerAfter,
    rssBeforeMb: Math.round(b.max),
    rssPeakMb: Math.round(peak),
    rssIncreaseMb: Math.round(peak - b.max),
    rssSumBeforeMb: Math.round(b.sum),
    rssSumPeakMb: Math.round(sumPeak),
    rssSumIncreaseMb: Math.round(sumPeak - b.sum),
  });
  write();
}

function foreignRequests(): string[] {
  return requests.filter((u) => {
    const url = u.replace(/^(websocket|worker) /, '');
    return !url.startsWith(ORIGIN + '/') && !url.startsWith('blob:' + ORIGIN);
  });
}

function write(): void {
  const outDir = join(import.meta.dirname, '../../out/t16');
  mkdirSync(outDir, { recursive: true });
  const report = { clipSource, userAgent, rows, requestCount: requests.length, requests, foreign: foreignRequests(), errors };
  writeFileSync(join(outDir, 'bench.json'), JSON.stringify(report, null, 2));
}

test.describe.configure({ mode: 'serial' });

test('in sequence: 1 -> 3 -> 5 min in one page', async ({ page }) => {
  await openPage(page);
  for (const min of [1, 3, 5]) await measure(page, 'sequence', min);
});

for (const min of [1, 3, 5]) {
  test(`fresh page: ${min} min`, async ({ page }) => {
    await openPage(page);
    await measure(page, 'fresh', min);
  });
}

test('checks', () => {
  write();
  console.log(JSON.stringify(rows, null, 1));
  expect(errors).toEqual([]);
  expect(requests.filter((u) => u.startsWith('websocket'))).toEqual([]);
  expect(foreignRequests()).toEqual([]);
  expect(clipSource).toBe('dev synthetic render (clip.wav)');
  expect(rows).toHaveLength(6);
  for (const r of rows) {
    expect(r.ticks).toBeGreaterThan(r.wallMs / 50 / 2);
    expect(r.maxTickGapMs).toBeLessThan(1000);
    expect(r.timerAfter).toBeGreaterThan(r.timerBefore);
    expect(r.beats).toBeGreaterThan(r.inputSec * 1.5);
  }
});

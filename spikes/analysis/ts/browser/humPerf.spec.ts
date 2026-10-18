/**
 * Spike 4 T12: speed and memory of the humming analyzer in a real browser (PC Chromium, Worker path of humBench.html).
 * Same method as the spike-3 bench (bench.spec.ts): renderer-process VmRSS from /proc polled every 100 ms (before =
 * just before setInputFiles, increase = peak - before), 50 ms UI timer, every request counted.
 * Input: ONLY dev synthetic hum renders (out/hum, manifest split 'dev', never held-out), concatenated and looped to
 * 1 / 3 / 5 min (mono, gitignored out/hum/t12/). Per length: 3 fresh pages, each = 1 cold run + 2 warm runs.
 * Result table: out/hum/t12/perf.json (gitignored).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from './wav';

const HUM = join(import.meta.dirname, '../../out/hum');
const OUT = join(HUM, 't12');
const ORIGIN = 'http://127.0.0.1:5183';

function writeWav16(path: string, x: Float32Array, sr: number): void {
  const data = x.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768))), 44 + i * 2);
  writeFileSync(path, b);
}

const files: Record<number, string> = {};
let bpm = 100;
let sources: string[] = [];

function makeWavs(): void {
  mkdirSync(OUT, { recursive: true });
  const m = JSON.parse(readFileSync(join(HUM, 'manifest.json'), 'utf8')) as {
    variants: { name: string; bpm: number; heldOut: boolean; split: string }[];
  };
  const dev = m.variants.filter((v) => v.split === 'dev' && !v.heldOut && /^syn-h0-/.test(v.name));
  expect(dev.length).toBeGreaterThan(5);
  expect(dev.every((v) => !v.heldOut && !/hum-\d\d-x/.test(v.name))).toBe(true);
  sources = dev.map((v) => v.name);
  bpm = dev[0].bpm; // one bpm for the whole concatenation: timing only, note accuracy is not judged here
  const clips = dev.map((v) => decodeWav(new Uint8Array(readFileSync(join(HUM, `${v.name}.wav`)))));
  const sr = clips[0].sampleRate;
  expect(clips.every((c) => c.sampleRate === sr && c.channels.length === 1)).toBe(true);
  for (const min of [1, 3, 5]) {
    const n = min * 60 * sr;
    const out = new Float32Array(n);
    for (let o = 0, i = 0; o < n; i++) {
      const c = clips[i % clips.length].channels[0];
      out.set(c.subarray(0, Math.min(c.length, n - o)), o);
      o += c.length;
    }
    files[min] = join(OUT, `concat-${min}min.wav`);
    writeWav16(files[min], out, sr);
  }
}

function rendererRssMb(): { max: number; sum: number } {
  let max = 0;
  let sum = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) continue;
      const mm = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (mm) {
        const mb = Number(mm[1]) / 1024;
        max = Math.max(max, mb);
        sum += mb;
      }
    } catch {
      /* gone */
    }
  }
  return { max, sum };
}

interface Summary {
  noteCount: number;
  stagesMs: Record<string, number>;
  totalMs: number;
  audioSec: number;
  configHash: string;
  warnings: number;
}
interface PageRun {
  summary: Summary;
  wallMs: number;
  decodeMs: number;
  ticks: number;
  maxTickGapMs: number;
}
type Bench = { fileDone: number; error?: { message: string }; runs: PageRun[] };
interface Row {
  minutes: number;
  kind: 'cold' | 'warm';
  page: number;
  wallMs: number;
  decodeMs: number;
  workerTotalMs: number;
  stagesMs: Record<string, number>;
  noteCount: number;
  configHash: string;
  ticks: number;
  maxTickGapMs: number;
  timerBefore: number;
  timerAfter: number;
  rssBeforeMb: number;
  rssPeakMb: number;
  rssIncreaseMb: number;
  rssSumIncreaseMb: number;
}

const rows: Row[] = [];
const requests: string[] = [];
const errors: string[] = [];
const timerState: { page: number; intervals: number; timeouts: number }[] = [];
let userAgent = '';
let pageNo = 0;

async function openPage(page: Page): Promise<void> {
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (ws) => requests.push(`websocket ${ws.url()}`));
  page.on('worker', (w) => requests.push(`worker ${w.url()}`));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const iv = new Set<number>();
    const to = new Set<number>();
    const w = window as unknown as Record<string, unknown>;
    const si = window.setInterval.bind(window);
    const st = window.setTimeout.bind(window);
    window.setInterval = ((f: TimerHandler, ms?: number, ...a: unknown[]) => {
      const id = si(f, ms, ...a);
      iv.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      iv.delete(id as number);
      return clearInterval.call(window, id);
    }) as typeof window.clearInterval;
    window.setTimeout = ((f: TimerHandler, ms?: number, ...a: unknown[]) => {
      const id: number = st(
        typeof f === 'function'
          ? (...x: unknown[]) => {
              to.delete(id);
              (f as (...y: unknown[]) => void)(...x);
            }
          : f,
        ms,
        ...a,
      );
      to.add(id);
      return id;
    }) as typeof window.setTimeout;
    w.__timers = () => ({ intervals: iv.size, timeouts: to.size });
  });
  await page.goto('/humBench.html');
  await page.waitForFunction(() => (window as unknown as { __humBench: { ready: boolean } }).__humBench.ready);
  userAgent = await page.evaluate(() => navigator.userAgent);
}

const bstate = (page: Page) => page.evaluate(() => (window as unknown as { __humBench: Bench }).__humBench);

async function runOnce(page: Page, min: number, kind: Row['kind'], pg: number): Promise<void> {
  const timerBefore = Number(await page.locator('#timer').textContent());
  await page.waitForTimeout(1500);
  const b = rendererRssMb();
  let peak = b.max;
  let sumPeak = b.sum;
  const poll = setInterval(() => {
    const r = rendererRssMb();
    peak = Math.max(peak, r.max);
    sumPeak = Math.max(sumPeak, r.sum);
  }, 100);
  const done0 = (await bstate(page)).fileDone;
  await page.setInputFiles('#file', files[min]);
  await page.fill('#bpm', String(bpm));
  await page.click('#run');
  await page.waitForFunction((n) => (window as unknown as { __humBench: Bench }).__humBench.fileDone > n, done0, { timeout: 300_000 });
  clearInterval(poll);
  const st = await bstate(page);
  if (st.error) errors.push(st.error.message);
  const r = st.runs[st.runs.length - 1];
  const timerAfter = Number(await page.locator('#timer').textContent());
  rows.push({
    minutes: min,
    kind,
    page: pg,
    wallMs: r.wallMs,
    decodeMs: r.decodeMs,
    workerTotalMs: r.summary.totalMs,
    stagesMs: r.summary.stagesMs,
    noteCount: r.summary.noteCount,
    configHash: r.summary.configHash,
    ticks: r.ticks,
    maxTickGapMs: r.maxTickGapMs,
    timerBefore,
    timerAfter,
    rssBeforeMb: Math.round(b.max),
    rssPeakMb: Math.round(peak),
    rssIncreaseMb: Math.round(peak - b.max),
    rssSumIncreaseMb: Math.round(sumPeak - b.sum),
  });
  write();
}

const foreign = () => requests.filter((u) => !u.replace(/^(websocket|worker) /, '').startsWith(ORIGIN + '/') && !u.includes('blob:' + ORIGIN));
function write(): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, 'perf.json'),
    JSON.stringify({ userAgent, bpm, sources, rows, timerState, requestCount: requests.length, requests, foreign: foreign(), errors }, null, 2),
  );
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => makeWavs());

for (const min of [1, 3, 5]) {
  for (const pg of [1, 2, 3]) {
    test(`${min} min, fresh page ${pg}`, async ({ page }) => {
      await openPage(page);
      pageNo++;
      await runOnce(page, min, 'cold', pg);
      await runOnce(page, min, 'warm', pg);
      await runOnce(page, min, 'warm', pg);
      await page.waitForTimeout(500);
      const t = await page.evaluate(() => (window as unknown as { __timers: () => { intervals: number; timeouts: number } }).__timers());
      timerState.push({ page: pageNo, ...t });
      write();
    });
  }
}

test('checks', () => {
  write();
  expect(errors).toEqual([]);
  expect(requests.filter((u) => u.startsWith('websocket'))).toEqual([]);
  expect(foreign()).toEqual([]);
  expect(rows).toHaveLength(27);
  for (const r of rows) {
    expect(r.timerAfter).toBeGreaterThan(r.timerBefore);
    expect(r.ticks).toBeGreaterThan(r.wallMs / 50 / 2);
  }
  // only the page's own 50 ms UI timer is left, and no pending timeouts
  for (const t of timerState) {
    expect(t.intervals).toBe(1);
    expect(t.timeouts).toBe(0);
  }
});

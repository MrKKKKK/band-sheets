/**
 * Spike 6 T12: what the bass stage adds to the chord Worker in a real browser (PC Chromium, Worker path of
 * bassBench.html), at 1 / 3 / 5 min. Same method as drumPerf.spec.ts / humPerf.spec.ts: renderer-process VmRSS from
 * /proc polled every 100 ms (increase = peak - just before the click). Input: ONLY tuning-split, timbre A, level B2
 * synthetic bass renders (out/bass, never dev / held-out / user recordings), concatenated and looped to 1 / 3 / 5 min
 * (mono, gitignored out/bass-perf/). Per length, two phases, each run alone (bench mode select):
 *  - time: one fresh page = 1 cold pair (off, on), then PAIRS warm pairs in alternating order (off-on, on-off, ...);
 *  - mem: MEM_PAIRS pairs where EVERY run gets a fresh page (in the same page the RSS before a run still holds the
 *    previous run's garbage, which made the warm increases swing by +-100 MB at 5 min).
 * Bass on = the Worker's `enabledBassConfig({})` (the G2 defaults). Result: out/bass-perf/perf.json (counts and times only).
 *
 *   docker exec -u node -w /workspaces/band-sheets band-sheets \
 *     npx playwright test --config spikes/analysis/ts/browser/bassPerf.playwright.config.ts
 * (-w = the checkout or worktree root.)
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rendererRssMb, writeWav16 } from './perfProc';
import { decodeWav } from './wav';

const BASS = join(import.meta.dirname, '../../out/bass');
const OUT = join(import.meta.dirname, '../../out/bass-perf');
const ORIGIN = 'http://127.0.0.1:5187';
const MINUTES = [1, 3, 5];
const PAIRS = Number(process.env.BASS_PERF_PAIRS ?? 5);
const MEM_PAIRS = Number(process.env.BASS_PERF_MEM_PAIRS ?? 3);

const files: Record<number, string> = {};

/** Concatenate (looping) the tuning / timbre A / B2 renders, styles interleaved, to 1, 3 and 5 minutes. */
function makeWavs(): string[] {
  mkdirSync(OUT, { recursive: true });
  const m = JSON.parse(readFileSync(join(BASS, 'manifest.json'), 'utf8')) as {
    variants: { name: string; split: string; heldOut: boolean; timbre: string; level: string; seed: number; style: string }[];
  };
  const src = m.variants
    .filter((v) => v.split === 'tuning' && !v.heldOut && v.timbre === 'A' && v.level === 'B2')
    .sort((a, b) => a.seed - b.seed || a.style.localeCompare(b.style));
  expect(src.length).toBeGreaterThan(5);
  const clips = src.map((v) => decodeWav(new Uint8Array(readFileSync(join(BASS, `${v.name}.wav`)))));
  const sr = clips[0].sampleRate;
  expect(clips.every((c) => c.sampleRate === sr && c.channels.length === 1)).toBe(true);
  for (const min of MINUTES) {
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
  return src.map((v) => v.name);
}

interface Summary {
  stages: { name: string; ms: number }[];
  totalMs: number;
  memPeak: number;
  chords: number;
  resultJsonBytes: number;
  bass?: { configHash: string; marked: number };
}
type PageRow = { bass: boolean; inputSec: number; summary: Summary; wallMs: number; maxTickGapMs: number };
type Bench = { fileDone: number; error?: { message: string }; runs: PageRow[] };
interface Row {
  phase: 'time' | 'mem';
  minutes: number;
  pair: number; // 0 = cold
  bass: boolean;
  inputSec: number;
  totalMs: number;
  wallMs: number;
  stagesMs: Record<string, number>;
  memPeakMb: number;
  chords: number;
  marked: number | null;
  configHash: string | null;
  resultJsonBytes: number;
  maxTickGapMs: number;
  rssBeforeMb: number;
  rssPeakMb: number;
  rssIncreaseMb: number;
}

const rows: Row[] = [];
const requests: string[] = [];
const errors: string[] = [];
let userAgent = '';
let sources: string[] = [];

const bstate = (page: Page) => page.evaluate(() => (window as unknown as { __bassBench: Bench }).__bassBench);
const isForeign = (u: string) => !u.replace(/^(websocket|worker) /, '').startsWith(ORIGIN + '/') && !u.includes('blob:' + ORIGIN);

async function runOnce(page: Page, phase: Row['phase'], min: number, pair: number, bass: boolean): Promise<void> {
  await page.waitForTimeout(1500);
  const b = rendererRssMb();
  let peak = b.max;
  const poll = setInterval(() => {
    peak = Math.max(peak, rendererRssMb().max);
  }, 100);
  const done0 = (await bstate(page)).fileDone;
  await page.setInputFiles('#file', files[min]);
  await page.selectOption('#mode', bass ? 'on' : 'off');
  await page.click('#run');
  await page.waitForFunction((n) => (window as unknown as { __bassBench: Bench }).__bassBench.fileDone > n, done0, { timeout: 300_000 });
  clearInterval(poll);
  const st = await bstate(page);
  if (st.error) errors.push(st.error.message);
  const r = st.runs[st.runs.length - 1];
  expect(r.bass).toBe(bass);
  const x = r.summary;
  rows.push({
    phase,
    minutes: min,
    pair,
    bass,
    inputSec: r.inputSec,
    totalMs: x.totalMs,
    wallMs: r.wallMs,
    stagesMs: Object.fromEntries(x.stages.map((s) => [s.name, s.ms])),
    memPeakMb: x.memPeak / 2 ** 20,
    chords: x.chords,
    marked: x.bass?.marked ?? null,
    configHash: x.bass?.configHash ?? null,
    resultJsonBytes: x.resultJsonBytes,
    maxTickGapMs: r.maxTickGapMs,
    rssBeforeMb: Math.round(b.max),
    rssPeakMb: Math.round(peak),
    rssIncreaseMb: Math.round(peak - b.max),
  });
  writeFileSync(join(OUT, 'perf.json'), JSON.stringify({ userAgent, sources, pairs: PAIRS, memPairs: MEM_PAIRS, rows, errors, foreign: requests.filter(isForeign) }, null, 1));
}

const median = (a: number[]) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function openPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (ws) => requests.push(`websocket ${ws.url()}`));
  page.on('worker', (w) => requests.push(`worker ${w.url()}`));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/bassBench.html');
  await page.waitForFunction(() => (window as unknown as { __bassBench: { ready: boolean } }).__bassBench.ready);
  userAgent = await page.evaluate(() => navigator.userAgent);
  return { ctx, page };
}

const order = (pair: number) => (pair % 2 === 0 ? [false, true] : [true, false]);

test('chord Worker without / with the bass stage at 1 / 3 / 5 min', async ({ browser }) => {
  test.setTimeout(3_000_000);
  sources = makeWavs();
  for (const min of MINUTES) {
    const { ctx, page } = await openPage(browser);
    for (let pair = 0; pair <= PAIRS; pair++) for (const bass of order(pair)) await runOnce(page, 'time', min, pair, bass);
    await ctx.close();
    for (let pair = 1; pair <= MEM_PAIRS; pair++) {
      for (const bass of order(pair)) {
        const fresh = await openPage(browser);
        await runOnce(fresh.page, 'mem', min, pair, bass);
        await fresh.ctx.close();
      }
    }
    const of = (phase: Row['phase'], bass: boolean, f: (r: Row) => number) => median(rows.filter((r) => r.phase === phase && r.minutes === min && r.pair > 0 && r.bass === bass).map(f));
    console.log(
      `${min} min (medians): total s off ${of('time', false, (r) => r.totalMs / 1000).toFixed(2)} on ${of('time', true, (r) => r.totalMs / 1000).toFixed(2)}; ` +
        `fresh-page RSS increase MB off ${of('mem', false, (r) => r.rssIncreaseMb)} on ${of('mem', true, (r) => r.rssIncreaseMb)}`,
    );
  }
  expect(errors).toEqual([]);
  expect(requests.filter(isForeign)).toEqual([]);
});

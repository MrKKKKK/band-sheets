/**
 * Spike 5 T13: speed and memory of the drum analyzer in a real browser (PC Chromium, Worker path of drumBench.html), per
 * level S-3 / S-9 / S-ext. Same method as humPerf.spec.ts: renderer-process VmRSS from /proc polled every 100 ms (before =
 * just before setInputFiles, increase = peak - before). Input: ONLY tuning-split, kit A, level D2 synthetic drum renders
 * (out/drum, never held-out / dev / user recordings), concatenated and looped to 1 / 3 / 5 min (mono, gitignored
 * out/drum/t13/). Per (length, level): one fresh page = 1 cold run + 2 warm runs. Result: out/drum/t13/perf.json.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from './wav';

const DRUM = join(import.meta.dirname, '../../out/drum');
const OUT = join(DRUM, 't13');
const ORIGIN = 'http://127.0.0.1:5185';
const LEVELS = ['S-3', 'S-9', 'S-ext'] as const;

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

/** Concatenate (looping) the tuning / kit A / D2 renders to 1, 3 and 5 minutes. */
function makeWavs(): { sources: string[]; bpm: number; files: Record<number, string> } {
  mkdirSync(OUT, { recursive: true });
  const m = JSON.parse(readFileSync(join(DRUM, 'manifest.json'), 'utf8')) as {
    variants: { name: string; bpm: number; heldOut: boolean; split: string; kit: string; level: string; ext: boolean }[];
  };
  const src = m.variants.filter((v) => v.split === 'tuning' && !v.heldOut && v.kit === 'A' && v.level === 'D2' && !v.ext);
  expect(src.length).toBeGreaterThan(5);
  expect(src.every((v) => !v.heldOut && v.split === 'tuning' && v.kit === 'A')).toBe(true);
  bpm = src[0].bpm;
  const clips = src.map((v) => decodeWav(new Uint8Array(readFileSync(join(DRUM, `${v.name}.wav`)))));
  const sr = clips[0].sampleRate;
  expect(clips.every((c) => c.sampleRate === sr)).toBe(true);
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
  return { sources: src.map((v) => v.name), bpm, files };
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
  hitCount: number;
  stagesMs: Record<string, number>;
  totalMs: number;
  analysisMs: number;
  audioSec: number;
  configHash: string;
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
  level: string;
  kind: 'cold' | 'warm';
  wallMs: number;
  decodeMs: number;
  analysisMs: number;
  stagesMs: Record<string, number>;
  hitCount: number;
  configHash: string;
  maxTickGapMs: number;
  rssBeforeMb: number;
  rssPeakMb: number;
  rssIncreaseMb: number;
}

const rows: Row[] = [];
const requests: string[] = [];
const errors: string[] = [];
let userAgent = '';

async function openPage(page: Page): Promise<void> {
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (ws) => requests.push(`websocket ${ws.url()}`));
  page.on('worker', (w) => requests.push(`worker ${w.url()}`));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/drumBench.html');
  await page.waitForFunction(() => (window as unknown as { __drumBench: { ready: boolean } }).__drumBench.ready);
  userAgent = await page.evaluate(() => navigator.userAgent);
}

const bstate = (page: Page) => page.evaluate(() => (window as unknown as { __drumBench: Bench }).__drumBench);

async function runOnce(page: Page, min: number, level: string, kind: Row['kind']): Promise<void> {
  await page.waitForTimeout(1500);
  const b = rendererRssMb();
  let peak = b.max;
  const poll = setInterval(() => {
    peak = Math.max(peak, rendererRssMb().max);
  }, 100);
  const done0 = (await bstate(page)).fileDone;
  await page.setInputFiles('#file', files[min]);
  await page.fill('#bpm', String(bpm));
  await page.selectOption('#level', level);
  await page.click('#run');
  await page.waitForFunction((n) => (window as unknown as { __drumBench: Bench }).__drumBench.fileDone > n, done0, { timeout: 300_000 });
  clearInterval(poll);
  const st = await bstate(page);
  if (st.error) errors.push(st.error.message);
  const r = st.runs[st.runs.length - 1];
  rows.push({
    minutes: min,
    level,
    kind,
    wallMs: r.wallMs,
    decodeMs: r.decodeMs,
    analysisMs: r.summary.analysisMs,
    stagesMs: r.summary.stagesMs,
    hitCount: r.summary.hitCount,
    configHash: r.summary.configHash,
    maxTickGapMs: r.maxTickGapMs,
    rssBeforeMb: Math.round(b.max),
    rssPeakMb: Math.round(peak),
    rssIncreaseMb: Math.round(peak - b.max),
  });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'perf.json'), JSON.stringify({ userAgent, rows, errors, foreign: requests.filter((u) => !u.replace(/^(websocket|worker) /, '').startsWith(ORIGIN + '/') && !u.includes('blob:' + ORIGIN)) }, null, 1));
}

test('drum Worker speed and memory at 1 / 3 / 5 min, per level', async ({ browser }) => {
  test.setTimeout(3_000_000);
  makeWavs();
  for (const min of [1, 3, 5]) {
    for (const level of LEVELS) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await openPage(page);
      await runOnce(page, min, level, 'cold');
      await runOnce(page, min, level, 'warm');
      await runOnce(page, min, level, 'warm');
      await ctx.close();
    }
  }
  expect(errors).toEqual([]);
  const foreign = requests.filter((u) => !u.replace(/^(websocket|worker) /, '').startsWith(ORIGIN + '/') && !u.includes('blob:' + ORIGIN));
  expect(foreign).toEqual([]);
});

/**
 * T16 / T19: open the bench in the devcontainer's Chromium and run the FULL analyzer (Worker).
 *
 * T19 (the real path, the memory verdict): WAV files picked with the file input (setInputFiles ->
 * runFile: File.arrayBuffer -> decodeAudioData on the main thread -> mono in place -> transfer ->
 * resample + analyze in the Worker), 1 / 3 / 5 min x (mono 44.1 kHz, stereo 48 kHz), one fresh page per
 * file. The WAVs are generated here (16-bit PCM, gitignored out/t19/) by concatenating the dev synthetic
 * render out/saints/full-t116-straight.wav (never REC / held-out; checked from its truth JSON); stereo
 * 48 kHz = that clip resampled with our sinc, right channel 0.8 x and 7 ms later than the left.
 * Also: a silent and a 0.1 s file must show the Japanese error with its code in #error.
 * T16 (kept): the in-page array path (runMinutes; the decoded 1-min clip repeated), in sequence and fresh.
 *
 * Checks: every request is counted and must stay on the page's own origin (no WebSocket), the 50 ms UI
 * timer keeps ticking, results are sane. RSS = VmRSS of the Chromium renderer process(es) from /proc,
 * polled every 100 ms: before = just before the run starts (page ready, 1-min clip decoded; for the file
 * runs: before setInputFiles), peak, and increase = peak - before (target <= 300 MB, plan G1). The table
 * is written to out/t19/bench.json (gitignored).
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resampleSinc } from '../dsp/core/resample';
import { decodeWav } from './wav';

const OUT = join(import.meta.dirname, '../../out');
const T19 = join(OUT, 't19');
const CLIP = 'full-t116-straight'; // dev (tuning) synthetic, level 0 (same as the page's clip.wav)

/** 16-bit PCM WAV (interleaved), clipped to [-1, 1). */
function writeWav16(path: string, channels: Float32Array[], sr: number): void {
  const k = channels.length;
  const n = channels[0].length;
  const data = n * k * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(k, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * k * 2, 28);
  b.writeUInt16LE(k * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k; c++) {
      const v = Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32768)));
      b.writeInt16LE(v, o);
      o += 2;
    }
  }
  writeFileSync(path, b);
}

function repeatTo(x: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let o = 0; o < n; o += x.length) out.set(x.subarray(0, Math.min(x.length, n - o)), o);
  return out;
}

type Format = 'mono44100' | 'stereo48000';
const FORMATS: Format[] = ['mono44100', 'stereo48000'];
const wavPath = (f: Format, min: number) => join(T19, `${CLIP}-${f}-${min}min.wav`);

/** Generates the 1 / 3 / 5 min test files (once; kept in out/t19) + the two error files. */
function makeWavs(): void {
  mkdirSync(T19, { recursive: true });
  const truth = JSON.parse(readFileSync(join(OUT, 'saints', `${CLIP}.truth.json`), 'utf8')) as {
    heldOut?: boolean;
    source: { kind: string };
  };
  if (truth.heldOut || truth.source.kind !== 'synthetic') throw new Error(`${CLIP} is not a dev synthetic render`);
  const wav = decodeWav(new Uint8Array(readFileSync(join(OUT, 'saints', `${CLIP}.wav`))));
  if (wav.sampleRate !== 44100 || wav.channels.length !== 1) throw new Error('expected a mono 44.1 kHz clip');
  const mono = wav.channels[0];
  let st: Float32Array[] | null = null;
  for (const min of [1, 3, 5]) {
    const m = wavPath('mono44100', min);
    if (!existsSync(m) || statSync(m).size !== 44 + min * 60 * 44100 * 2) writeWav16(m, [repeatTo(mono, min * 60 * 44100)], 44100);
    const s = wavPath('stereo48000', min);
    if (!existsSync(s) || statSync(s).size !== 44 + min * 60 * 48000 * 4) {
      if (!st) {
        const l = resampleSinc(mono, 44100, 48000);
        const d = Math.round(0.007 * 48000);
        const r = new Float32Array(l.length);
        for (let i = d; i < l.length; i++) r[i] = 0.8 * l[i - d];
        st = [l, r];
      }
      const n = min * 60 * 48000;
      writeWav16(s, [repeatTo(st[0], n), repeatTo(st[1], n)], 48000);
    }
  }
  writeWav16(join(T19, 'silent-3s.wav'), [new Float32Array(3 * 44100)], 44100);
  writeWav16(join(T19, 'short-0.1s.wav'), [mono.slice(44100, 44100 + 4410)], 44100);
}

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
  mode: 'sequence' | 'fresh' | 'file';
  format?: Format;
  fileChannels?: number;
  fileMb?: number;
  transfer?: string;
  mainSec?: { read: number; decode: number; mixdown: number };
  minutes: number;
  inputSec: number;
  inputSr: number;
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

type BenchState = { fileDone: number; error?: string; errorCode?: string; runs: unknown[] };
const state = (page: Page) => page.evaluate(() => (window as unknown as { __bench: BenchState }).__bench);

/** Picks `path` with the file input and waits until runFile has finished (ok or error). */
async function pickFile(page: Page, path: string): Promise<BenchState> {
  const done0 = (await state(page)).fileDone;
  await page.setInputFiles('#file', path);
  await page.waitForFunction(
    (n) => (window as unknown as { __bench: BenchState }).__bench.fileDone > n,
    done0,
    { timeout: 300_000 },
  );
  return state(page);
}

async function measure(
  page: Page,
  mode: Row['mode'],
  min: number,
  file?: { format: Format; path: string },
): Promise<void> {
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
  let row: Omit<Row, 'mode' | 'minutes'>;
  if (file) {
    const st = await pickFile(page, file.path);
    if (st.error) errors.push(`${file.path}: ${st.error}`);
    row = { ...(st.runs[st.runs.length - 1] as Omit<Row, 'mode' | 'minutes'>), format: file.format };
    row.fileMb = Math.round(statSync(file.path).size / 2 ** 20);
  } else {
    row = (await page.evaluate((m) => (window as unknown as Api).__benchApi.runMinutes(m), min)) as Omit<
      Row,
      'mode' | 'minutes'
    >;
  }
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

const inputErrors: { file: string; code?: string; text: string }[] = [];

function write(): void {
  mkdirSync(T19, { recursive: true });
  const report = {
    clipSource,
    userAgent,
    rows,
    inputErrors,
    requestCount: requests.length,
    requests,
    foreign: foreignRequests(),
    errors,
  };
  writeFileSync(join(T19, 'bench.json'), JSON.stringify(report, null, 2));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => makeWavs());

for (const format of FORMATS) {
  for (const min of [1, 3, 5]) {
    test(`file picker (real path): ${format} ${min} min`, async ({ page }) => {
      await openPage(page);
      await measure(page, 'file', min, { format, path: wavPath(format, min) });
    });
  }
}

test('file picker: unusable input shows the Japanese error with its code', async ({ page }) => {
  await openPage(page);
  for (const [name, code] of [
    ['silent-3s.wav', 'silent'],
    ['short-0.1s.wav', 'too-short'],
  ] as const) {
    const st = await pickFile(page, join(T19, name));
    const text = (await page.locator('#error').textContent()) ?? '';
    inputErrors.push({ file: name, code: st.errorCode, text });
    expect(st.errorCode).toBe(code);
    expect(text).toContain(`（${code}）`);
    expect(text).toMatch(/[ぁ-んァ-ン一-龥]/);
  }
  // a good file afterwards clears the message
  await pickFile(page, wavPath('mono44100', 1));
  await expect(page.locator('#error')).toBeEmpty();
});

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
  expect(rows).toHaveLength(12);
  for (const r of rows.filter((x) => x.mode === 'file')) {
    expect(r.inputSec).toBeCloseTo(r.minutes * 60, 0);
    expect(r.fileChannels).toBe(r.format === 'stereo48000' ? 2 : 1);
    expect(r.inputSr).toBe(r.format === 'stereo48000' ? 48000 : 44100);
  }
  for (const r of rows) {
    expect(r.ticks).toBeGreaterThan(r.wallMs / 50 / 2);
    expect(r.maxTickGapMs).toBeLessThan(1000);
    expect(r.timerAfter).toBeGreaterThan(r.timerBefore);
    expect(r.beats).toBeGreaterThan(r.inputSec * 1.5);
  }
});

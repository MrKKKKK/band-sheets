/**
 * Spike 3 T8/T16 bench page (full analyzer) (main thread). Privacy: nothing leaves the page. The only requests are the
 * page's own assets (module scripts, the Worker, and in dev the bundled dev synthetic clip
 * ./clip.wav + Python's 22050 Hz version ./clip-y.f32 for the resampler comparison). A local file
 * chosen with the picker is read with File.arrayBuffer() and only used here.
 *
 * Flow: decodeAudioData on the main thread (not available in Workers) at the file's own rate ->
 * mono (librosa.to_mono) -> the Float32Array is transferred to the Worker, which resamples to
 * 22050 Hz with our resampler as its first stage (so the main thread never runs the long loop;
 * the plan's order "resample, then hand over" is kept inside the Worker) -> full analyze().
 */
/// <reference lib="dom" />
import type { StageStat } from '../dsp/analyze';
import { toMono } from '../dsp/core/resample';
import type { RunRequest, WorkerMessage } from './protocol';
import { synthClip } from './synth';
import { readWavHeader } from './wav';

interface RunRow {
  label: string;
  inputSec: number;
  inputSr: number;
  stages: StageStat[];
  totalMs: number;
  wallMs: number;
  memPeak: number;
  workerHeap?: number;
  mainHeapBefore?: number;
  mainHeapAfter?: number;
  ticks: number;
  maxTickGapMs: number;
  beats: number;
  chords: number;
  sections: number;
  resultJsonBytes: number;
  warnings: string[];
}

interface Bench {
  ready: boolean;
  clipSource: 'dev synthetic render (clip.wav)' | 'in-page synthesized signal';
  clipSr: number;
  clipSec: number;
  runs: RunRow[];
  error?: string;
}

const bench: Bench = { ready: false, clipSource: 'in-page synthesized signal', clipSr: 44100, clipSec: 0, runs: [] };
(window as unknown as { __bench: Bench }).__bench = bench;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const timerEl = $('timer');
const tableBody = $<HTMLTableSectionElement>('rows');

// --- UI timer: keeps ticking while the Worker analyses (a stalled main thread shows as a big gap) ---
const t0 = performance.now();
let ticks = 0;
let lastTick = performance.now();
let maxGap = 0;
setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - lastTick);
  lastTick = now;
  ticks++;
  timerEl.textContent = ((now - t0) / 1000).toFixed(1);
}, 50);

function mainHeap(): number | undefined {
  return (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
}

const mb = (b: number | undefined) => (b === undefined ? '–' : (b / 2 ** 20).toFixed(0));

// --- decoding ---
/** The file's own sample rate: WAV header, MP3 first frame header, else 44100 (assumed). */
function sniffRate(bytes: Uint8Array): number {
  const wav = readWavHeader(bytes);
  if (wav) return wav.sampleRate;
  let o = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    o = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]); // ID3v2 (syncsafe)
  }
  for (let i = o; i + 3 < Math.min(bytes.length, o + 65536); i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      const ver = (bytes[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const idx = (bytes[i + 2] >> 2) & 3;
      const base = [44100, 48000, 32000][idx];
      if (ver === 1 || idx === 3 || base === undefined) continue;
      return ver === 3 ? base : ver === 2 ? base / 2 : base / 4;
    }
  }
  return 44100;
}

async function decode(bytes: ArrayBuffer, rate?: number): Promise<{ mono: Float32Array; sr: number }> {
  const sr = rate ?? sniffRate(new Uint8Array(bytes));
  // decodeAudioData converts to the context's rate; a context at the file's rate keeps the samples as they are
  const ctx = new OfflineAudioContext(1, 1, sr);
  const buf = await ctx.decodeAudioData(bytes.slice(0));
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return { mono: toMono(chans), sr: buf.sampleRate };
}

let clip: { mono: Float32Array; sr: number; bytes?: ArrayBuffer } | null = null;

async function loadClip(): Promise<void> {
  try {
    const r = await fetch('./clip.wav');
    if (!r.ok) throw new Error(String(r.status));
    const bytes = await r.arrayBuffer();
    const d = await decode(bytes);
    clip = { ...d, bytes };
    bench.clipSource = 'dev synthetic render (clip.wav)';
  } catch {
    clip = { mono: synthClip(44100, 60), sr: 44100 };
    bench.clipSource = 'in-page synthesized signal';
  }
  bench.clipSr = clip.sr;
  bench.clipSec = clip.mono.length / clip.sr;
  $('clipinfo').textContent = `${bench.clipSource}, ${bench.clipSec.toFixed(1)} s, ${clip.sr} Hz`;
}

function repeatTo(x: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let o = 0; o < n; o += x.length) out.set(x.subarray(0, Math.min(x.length, n - o)), o);
  return out;
}

// --- worker runs ---
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;

function analyse(label: string, mono: Float32Array, sr: number): Promise<RunRow> {
  const id = nextId++;
  const inputSec = mono.length / sr;
  const heapBefore = mainHeap();
  const ticks0 = ticks;
  maxGap = 0;
  lastTick = performance.now();
  const start = performance.now();
  statusEl.textContent = `${label}: 解析中…`;
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'stage') {
        statusEl.textContent = `${label}: ${m.stage.name} 済み (${(m.stage.ms / 1000).toFixed(2)} s)`;
      } else if (m.type === 'error') {
        reject(new Error(m.message));
      } else {
        const r = m.summary;
        const row: RunRow = {
          label,
          inputSec,
          inputSr: sr,
          stages: r.stages,
          totalMs: r.totalMs,
          wallMs: performance.now() - start,
          memPeak: r.memPeak,
          workerHeap: m.workerHeap,
          mainHeapBefore: heapBefore,
          mainHeapAfter: mainHeap(),
          ticks: ticks - ticks0,
          maxTickGapMs: maxGap,
          beats: r.beats,
          chords: r.chords,
          sections: r.sections,
          resultJsonBytes: r.resultJsonBytes,
          warnings: r.warnings,
        };
        resolve(row);
      }
    };
    const req: RunRequest = { type: 'run', id, sr, channels: [mono] };
    worker.postMessage(req, [mono.buffer]); // transfer: mono is detached here (no copy)
  });
}

const STAGES = ['resample', 'load', 'beats', 'chroma', 'chords', 'downbeat', 'merge', 'sections', 'key', 'keytrack', 'chords2', 'merge2'];

function addRow(r: RunRow): void {
  bench.runs.push(r);
  const tr = document.createElement('tr');
  const cells = [
    r.label,
    `${r.inputSec.toFixed(0)} s @ ${r.inputSr}`,
    ...STAGES.map((s) => {
      const st = r.stages.find((x) => x.name === s);
      return st ? (st.ms / 1000).toFixed(2) : '–';
    }),
    (r.totalMs / 1000).toFixed(2),
    (r.wallMs / 1000).toFixed(2),
    mb(r.memPeak),
    mb(r.workerHeap),
    `${mb(r.mainHeapBefore)} → ${mb(r.mainHeapAfter)}`,
    `${r.ticks} / ${r.maxTickGapMs.toFixed(0)} ms`,
    `${r.beats} / ${r.chords} / ${r.sections}`,
  ];
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    tr.appendChild(td);
  }
  tableBody.appendChild(tr);
}

async function runMinutes(min: number): Promise<RunRow> {
  if (!clip) await loadClip();
  const c = clip as NonNullable<typeof clip>;
  const mono = repeatTo(c.mono, Math.round(min * 60 * c.sr)); // fresh array (the clip stays)
  const row = await analyse(`${min} 分`, mono, c.sr);
  addRow(row);
  statusEl.textContent = `${row.label}: 完了 ${(row.totalMs / 1000).toFixed(2)} s`;
  return row;
}

async function runFile(f: File): Promise<RunRow> {
  const d = await decode(await f.arrayBuffer()); // used only in this page
  const row = await analyse(`ファイル (${d.sr} Hz)`, d.mono, d.sr);
  addRow(row);
  statusEl.textContent = `${row.label}: 完了`;
  return row;
}

async function guarded<T>(f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f();
  } catch (e) {
    bench.error = e instanceof Error ? e.message : String(e);
    statusEl.textContent = `エラー: ${bench.error}`;
    return undefined;
  }
}

$('run1').onclick = () => void guarded(() => runMinutes(1));
$('run3').onclick = () => void guarded(() => runMinutes(3));
$('run5').onclick = () => void guarded(() => runMinutes(5));
$('runall').onclick = () =>
  void guarded(async () => {
    for (const m of [1, 3, 5]) await runMinutes(m);
  });
$<HTMLInputElement>('file').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void guarded(() => runFile(f));
};

(window as unknown as { __benchApi: object }).__benchApi = { runMinutes };
void loadClip().then(() => {
  bench.ready = true;
  statusEl.textContent = '準備できました';
});

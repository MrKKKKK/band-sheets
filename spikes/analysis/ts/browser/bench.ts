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
 *
 * T19 memory on the real path (runFile = the file picker): the file's bytes go to decodeAudioData
 * without a copy (detached by it), the mixdown is written in place into channel 0 of the AudioBuffer
 * (same float32 values as toMono), the AudioBuffer is dropped right after, and channel 0's buffer is
 * transferred to the Worker (falls back to one copy if the browser refuses; `transfer` in the row).
 * Unusable input (AnalysisInputError in the Worker: empty, < 1 s, silent, NaN / Inf, no beats) shows
 * its Japanese message and code in #error.
 */
/// <reference lib="dom" />
import type { StageStat } from '../dsp/analyze';
import type { RunRequest, WorkerMessage } from './protocol';
import { synthClip } from './synth';
import { readWavHeader } from './wav';

interface RunRow {
  label: string;
  /** main thread before the Worker (s): file.arrayBuffer, decodeAudioData, mixdown */
  mainSec?: { read: number; decode: number; mixdown: number };
  fileChannels?: number;
  fileBytes?: number;
  transfer?: 'zero-copy' | 'copied';
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
  errorCode?: string;
  /** file-picker runs finished (ok or error) */
  fileDone: number;
}

const bench: Bench = {
  ready: false,
  clipSource: 'in-page synthesized signal',
  clipSr: 44100,
  clipSec: 0,
  runs: [],
  fileDone: 0,
};
(window as unknown as { __bench: Bench }).__bench = bench;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const errorEl = $('error');
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

/** Mixes the AudioBuffer down to mono IN PLACE in channel 0 (librosa.to_mono, same float32 values as toMono). */
function mixdownInPlace(buf: AudioBuffer): Float32Array {
  const k = buf.numberOfChannels;
  const out = buf.getChannelData(0);
  if (k === 1) return out;
  const chans = Array.from({ length: k }, (_, c) => buf.getChannelData(c));
  const n = out.length;
  if (k === 2) {
    const r = chans[1];
    for (let i = 0; i < n; i++) out[i] = (out[i] + r[i]) * 0.5; // exact in f64, then rounded once
  } else {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < k; c++) s += chans[c][i];
      out[i] = s / k;
    }
  }
  return out;
}

interface Decoded {
  mono: Float32Array;
  sr: number;
  channels: number;
  decodeSec: number;
  mixdownSec: number;
}

/** decodeAudioData DETACHES `bytes` (no copy is made): pass a buffer the caller no longer needs. */
async function decode(bytes: ArrayBuffer, rate?: number): Promise<Decoded> {
  const sr = rate ?? sniffRate(new Uint8Array(bytes));
  // decodeAudioData converts to the context's rate; a context at the file's rate keeps the samples as they are
  const t0 = performance.now();
  let buf: AudioBuffer | null = await new OfflineAudioContext(1, 1, sr).decodeAudioData(bytes);
  const t1 = performance.now();
  const channels = buf.numberOfChannels;
  const outSr = buf.sampleRate;
  const mono = mixdownInPlace(buf);
  buf = null; // the other channels go with the AudioBuffer; only channel 0's storage is kept
  return { mono, sr: outSr, channels, decodeSec: (t1 - t0) / 1000, mixdownSec: (performance.now() - t1) / 1000 };
}

let clip: { mono: Float32Array; sr: number } | null = null;

async function loadClip(): Promise<void> {
  try {
    const r = await fetch('./clip.wav');
    if (!r.ok) throw new Error(String(r.status));
    const d = await decode(await r.arrayBuffer());
    clip = { mono: d.mono, sr: d.sr };
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

class RunError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Posts `mono` to the Worker, transferring its buffer (falls back to one copy if that is refused). */
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
        reject(new RunError(m.message, m.code));
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
          transfer,
        };
        resolve(row);
      }
    };
    let transfer: RunRow['transfer'] = 'zero-copy';
    try {
      const req: RunRequest = { type: 'run', id, sr, channels: [mono] };
      worker.postMessage(req, [mono.buffer as ArrayBuffer]); // transfer: mono is detached here (no copy)
    } catch {
      transfer = 'copied';
      const copy = mono.slice();
      const req: RunRequest = { type: 'run', id, sr, channels: [copy] };
      worker.postMessage(req, [copy.buffer]);
    }
  });
}

const STAGES = ['read', 'resample', 'load', 'beats', 'chroma', 'chords', 'downbeat', 'merge', 'sections', 'key', 'keytrack', 'chords2', 'merge2'];

function addRow(r: RunRow): void {
  bench.runs.push(r);
  const tr = document.createElement('tr');
  const cells = [
    r.label,
    `${r.inputSec.toFixed(0)} s @ ${r.inputSr}`,
    ...STAGES.map((s) => {
      if (s === 'read') return r.mainSec ? (r.mainSec.read + r.mainSec.decode + r.mainSec.mixdown).toFixed(2) : '–';
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

/** The real path: picked file -> bytes -> decodeAudioData -> mono -> Worker (resample, analyze). */
async function runFile(f: File): Promise<RunRow> {
  const t0 = performance.now();
  const bytes = await f.arrayBuffer(); // used only in this page
  const read = (performance.now() - t0) / 1000;
  const fileBytes = bytes.byteLength;
  const d = await decode(bytes); // detaches bytes
  const row = await analyse(`ファイル (${d.channels} ch, ${d.sr} Hz)`, d.mono, d.sr);
  row.mainSec = { read, decode: d.decodeSec, mixdown: d.mixdownSec };
  row.fileChannels = d.channels;
  row.fileBytes = fileBytes;
  addRow(row);
  statusEl.textContent = `${row.label}: 完了`;
  return row;
}

async function guarded<T>(f: () => Promise<T>): Promise<T | undefined> {
  errorEl.textContent = '';
  bench.error = bench.errorCode = undefined;
  try {
    return await f();
  } catch (e) {
    bench.error = e instanceof Error ? e.message : String(e);
    bench.errorCode = e instanceof RunError ? e.code : undefined;
    statusEl.textContent = '解析できませんでした';
    errorEl.textContent = bench.errorCode ? `エラー（${bench.errorCode}）: ${bench.error}` : `エラー: ${bench.error}`;
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
  if (f)
    void guarded(() => runFile(f)).finally(() => {
      bench.fileDone++;
    });
};

(window as unknown as { __benchApi: object }).__benchApi = { runMinutes };
void loadClip().then(() => {
  bench.ready = true;
  statusEl.textContent = '準備できました';
});

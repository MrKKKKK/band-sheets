/**
 * Bass bench page (spike 6 T7, after drumBench.ts): pick a file (and a repeat count that lengthens the signal for
 * time-per-minute figures), decode on the main thread (decodeAudioData at the file's own rate, mono mixdown), then run
 * the chord Worker (worker.ts) twice on the same signal: v1a only, then with the bass stage (RunRequest.bass). The
 * difference between the two rows is what the bass stage adds (plan section 5: time, memory; size is T12).
 * The mode select runs only one of the two (T12 bassPerf.spec.ts measures memory per run).
 * Nothing is sent anywhere (CSP connect-src 'self', network APIs removed in the Worker); chord and bass names are
 * never shown, only counts. Test hook: window.__bassBench.
 */
/// <reference lib="dom" />
import type { RunRequest, RunSummary, WorkerMessage } from './protocol';
import { readWavHeader } from './wav';

interface Row {
  label: string;
  bass: boolean;
  inputSec: number;
  inputSr: number;
  repeat: number;
  summary: RunSummary;
  workerHeap?: number;
  wallMs: number;
  maxTickGapMs: number;
}
const bench: { ready: boolean; runs: Row[]; fileDone: number; error?: { message: string; code?: string } } = { ready: false, runs: [], fileDone: 0 };
let clicks = 0;
(window as unknown as { __bassBench: typeof bench }).__bassBench = bench;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const errorEl = $('error');
const fileEl = $<HTMLInputElement>('file');
const runEl = $<HTMLButtonElement>('run');

// UI timer: keeps ticking while the Worker analyses (a stalled main thread shows as a big gap between ticks).
let maxGap = 0;
let lastTick = performance.now();
const t0 = lastTick;
setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - lastTick);
  lastTick = now;
  $('timer').textContent = ((now - t0) / 1000).toFixed(1);
}, 50);

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;

async function decode(bytes: ArrayBuffer): Promise<{ mono: Float32Array; sr: number }> {
  const rate = readWavHeader(new Uint8Array(bytes))?.sampleRate ?? 44100;
  const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes);
  const out = buf.getChannelData(0);
  const k = buf.numberOfChannels;
  for (let c = 1; c < k; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i];
  }
  if (k > 1) for (let i = 0; i < out.length; i++) out[i] /= k;
  return { mono: out, sr: buf.sampleRate };
}

function analyse(label: string, mono: Float32Array, sr: number, bass: boolean): Promise<{ summary: RunSummary; workerHeap?: number }> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'stage') statusEl.textContent = `${label}: ${m.stage.name} 済み (${(m.stage.ms / 1000).toFixed(2)} s)`;
      else if (m.type === 'error') reject(Object.assign(new Error(m.message), { code: m.code }));
      else resolve({ summary: m.summary, workerHeap: m.workerHeap });
    };
    const req: RunRequest = { type: 'run', id, sr, channels: [mono], ...(bass ? { bass: {} } : {}) };
    worker.postMessage(req, [mono.buffer as ArrayBuffer]); // transfer: mono is detached here
  });
}

function repeatSignal(x: Float32Array, n: number): Float32Array {
  const out = new Float32Array(x.length * n);
  for (let k = 0; k < n; k++) out.set(x, k * x.length);
  return out;
}

const s = (ms: number) => (ms / 1000).toFixed(2);
const mb = (b: number | undefined) => (b === undefined ? '–' : (b / 2 ** 20).toFixed(1));
const stageMs = (x: RunSummary, pick: (name: string) => boolean) => x.stages.filter((st) => pick(st.name)).reduce((a, st) => a + st.ms, 0);
const BASS = ['bassLowCqt', 'bass'];

function addRow(r: Row): void {
  bench.runs.push(r);
  const x = r.summary;
  const cells = [
    r.label,
    `${r.inputSec.toFixed(1)} s @ ${r.inputSr}${r.repeat > 1 ? ` (x${r.repeat})` : ''}`,
    r.bass ? 'あり' : 'なし',
    s(stageMs(x, (n) => !BASS.includes(n))),
    s(stageMs(x, (n) => n === 'bassLowCqt')),
    s(stageMs(x, (n) => n === 'bass')),
    s(x.totalMs),
    ((x.totalMs / 1000 / r.inputSec) * 60).toFixed(2),
    mb(x.memPeak),
    mb(r.workerHeap),
    String(x.chords),
    x.bass ? String(x.bass.marked) : '–',
    String(x.resultJsonBytes),
    x.bass?.configHash ?? '–',
  ];
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    tr.append(td);
  }
  $('rows').append(tr);
}

fileEl.addEventListener('change', () => {
  runEl.disabled = !fileEl.files?.length;
});

runEl.addEventListener('click', async () => {
  const file = fileEl.files?.[0];
  if (!file) return;
  errorEl.textContent = '';
  bench.error = undefined;
  const repeat = Math.max(1, Math.min(40, Math.floor(Number($<HTMLInputElement>('repeat').value) || 1)));
  runEl.disabled = true;
  try {
    statusEl.textContent = '読み込み中…';
    const dec = await decode(await file.arrayBuffer());
    const mono = repeat === 1 ? dec.mono : repeatSignal(dec.mono, repeat);
    const inputSec = mono.length / dec.sr;
    const n = ++clicks;
    const mode = $<HTMLSelectElement>('mode').value;
    for (const bass of mode === 'off' ? [false] : mode === 'on' ? [true] : [false, true]) {
      const tStart = performance.now();
      maxGap = 0;
      lastTick = tStart;
      const r = await analyse(`file ${n}`, mono.slice(), dec.sr, bass); // a copy per run: the Worker takes it
      addRow({ label: `file ${n}`, bass, inputSec, inputSr: dec.sr, repeat, ...r, wallMs: performance.now() - tStart, maxTickGapMs: maxGap });
    }
    statusEl.textContent = '完了';
  } catch (e) {
    const err = e as Error & { code?: string };
    errorEl.textContent = err.code ? `[${err.code}] ${err.message}` : err.message;
    bench.error = { message: err.message, code: err.code };
    statusEl.textContent = '失敗';
  } finally {
    runEl.disabled = false;
    bench.fileDone++;
  }
});

bench.ready = true;
statusEl.textContent = 'ファイルを選んでください。';

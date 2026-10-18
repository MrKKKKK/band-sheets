/**
 * Humming bench page (spike 4 T7): pick a file, give bpm / time signature / start second, decode on the main thread
 * (decodeAudioData at the file's own rate, mono mixdown), transfer to the Worker (humWorker.ts), show per-stage timings
 * and the note count. Nothing is sent anywhere (CSP connect-src 'self', network APIs removed in the Worker) and the
 * notes are never shown. Test hook: window.__humBench.
 */
import type { HumRunRequest, HumRunSummary, HumWorkerMessage } from './humProtocol';
import { readWavHeader } from './wav';

interface Row {
  label: string;
  inputSr: number;
  summary: HumRunSummary;
  /** click -> result (decode + transfer + analysis), main-thread clock */
  wallMs: number;
  decodeMs: number;
  ticks: number;
  maxTickGapMs: number;
}
const bench: { ready: boolean; runs: Row[]; fileDone: number; error?: { message: string; code?: string } } = {
  ready: false,
  runs: [],
  fileDone: 0,
};
(window as unknown as { __humBench: typeof bench }).__humBench = bench;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const errorEl = $('error');
const fileEl = $<HTMLInputElement>('file');
const runEl = $<HTMLButtonElement>('run');
const timerEl = $('timer');

// UI timer: keeps ticking while the Worker analyses (a stalled main thread shows as a big gap between ticks).
let ticks = 0;
let maxGap = 0;
let lastTick = performance.now();
const t0 = lastTick;
setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - lastTick);
  lastTick = now;
  ticks++;
  timerEl.textContent = ((now - t0) / 1000).toFixed(1);
}, 50);

const worker = new Worker(new URL('./humWorker.ts', import.meta.url), { type: 'module' });
let nextId = 1;

function sniffRate(bytes: Uint8Array): number {
  return readWavHeader(bytes)?.sampleRate ?? 44100;
}

/** Mono mixdown in place in channel 0. */
function mixdown(buf: AudioBuffer): Float32Array {
  const k = buf.numberOfChannels;
  const out = buf.getChannelData(0);
  for (let c = 1; c < k; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i];
  }
  if (k > 1) for (let i = 0; i < out.length; i++) out[i] /= k;
  return out;
}

async function decode(bytes: ArrayBuffer): Promise<{ mono: Float32Array; sr: number }> {
  const rate = sniffRate(new Uint8Array(bytes));
  const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes);
  return { mono: mixdown(buf), sr: buf.sampleRate };
}

function parseTs(s: string): [number, number] | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function analyse(
  label: string,
  mono: Float32Array,
  sr: number,
  info: HumRunRequest['info'],
): Promise<Pick<Row, 'label' | 'inputSr' | 'summary'>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<HumWorkerMessage>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'stage') statusEl.textContent = `${label}: ${m.name} 済み (${(m.ms / 1000).toFixed(2)} s)`;
      else if (m.type === 'error') reject(Object.assign(new Error(m.message), { code: m.code }));
      else resolve({ label, inputSr: sr, summary: m.summary });
    };
    const req: HumRunRequest = { type: 'run', id, sr, channels: [mono], info };
    worker.postMessage(req, [mono.buffer as ArrayBuffer]); // transfer: mono is detached here
  });
}

const s = (ms: number | undefined) => (ms === undefined ? '–' : (ms / 1000).toFixed(2));

function addRow(r: Row): void {
  bench.runs.push(r);
  const x = r.summary;
  const cells = [
    r.label,
    `${x.audioSec.toFixed(1)} s @ ${r.inputSr}`,
    ...['validate', 'resample', 'f0', 'level', 'notes', 'quantize'].map((k) => s(x.stagesMs[k])),
    s(x.totalMs),
    String(x.noteCount),
    String(x.warnings),
    x.configHash,
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
  const ts = parseTs($<HTMLInputElement>('ts').value);
  const info = { bpm: Number($<HTMLInputElement>('bpm').value), ts: ts ?? ([0, 0] as [number, number]), startSec: Number($<HTMLInputElement>('start').value) };
  runEl.disabled = true;
  try {
    statusEl.textContent = '読み込み中…';
    const tStart = performance.now();
    const ticks0 = ticks;
    maxGap = 0;
    lastTick = tStart;
    const { mono, sr } = await decode(await file.arrayBuffer());
    const decodeMs = performance.now() - tStart;
    const r = await analyse(`file ${bench.runs.length + 1}`, mono, sr, info);
    addRow({ ...r, decodeMs, wallMs: performance.now() - tStart, ticks: ticks - ticks0, maxTickGapMs: maxGap });
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

/**
 * Spike 4 T13 mic check page (main thread). Privacy: the mic samples stay in this page's memory only
 * (one run's blocks, dropped after detection); nothing is saved, uploaded or played back. The page
 * makes no requests besides its own module scripts (CSP in micCheck.html).
 *
 * Flow: 「マイクを使う」 (user gesture) -> new AudioContext() + getUserMedia with echo cancellation,
 * noise suppression and auto gain OFF (echo cancellation would erase the click) -> mic ->
 * MediaStreamSource -> capture AudioWorklet (inline module from a Blob URL) -> destination (silent).
 * The worklet posts each 128-frame block with `currentFrame` at its start, so a recorded sample maps to
 * a context frame. 「計測する」: N clicks at known context times (lead-in, fixed spacing), record until
 * the last click + tail, assembleBlocks -> detectClicks -> per-click delay and stats; a table of all
 * runs is kept (not persisted) and 「結果をコピー」 gives a text block to paste back.
 */
/// <reference lib="dom" />
import { assembleBlocks, clickSamples, detectClicks, stats, type CapturedBlock, type Stats } from './micCheck';

const CLICKS = 8;
const LEAD_IN_SEC = 0.8;
const SPACING_SEC = 0.5;
const TAIL_SEC = 0.6;

const WORKLET = `
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => { this.on = e.data === 'start'; };
  }
  process(inputs) {
    if (this.on) {
      const ch = inputs[0] && inputs[0][0];
      this.port.postMessage({ frame: currentFrame, data: ch ? ch.slice() : new Float32Array(128) });
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
`;

interface Session {
  ctx: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode;
  blocks: CapturedBlock[];
}

interface RunRow {
  n: number;
  mode: string;
  delays: (number | null)[];
  st: Stats | null;
  baseLatency: number | undefined;
  outputLatency: number | undefined;
  gapFrames: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startBtn = $<HTMLButtonElement>('start');
const runBtn = $<HTMLButtonElement>('run');
const stopBtn = $<HTMLButtonElement>('stop');
const copyBtn = $<HTMLButtonElement>('copy');
const modeSel = $<HTMLSelectElement>('mode');
const statusEl = $('status');
const envEl = $('env');
const lastEl = $('last');
const runsBody = $('runs');
const copyOut = $<HTMLTextAreaElement>('copyOut');

let session: Session | null = null;
const rows: RunRow[] = [];

const ms = (sec: number | undefined) =>
  sec === undefined || !Number.isFinite(sec) ? '（取得できない）' : `${(sec * 1000).toFixed(2)} ms`;
const fmt = (v: number | null) => (v === null ? '拾えず' : v.toFixed(2));

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function envText(s: Session): string {
  const track = s.stream.getAudioTracks()[0];
  const set = track?.getSettings() as MediaTrackSettings & { latency?: number };
  const keys = ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'sampleRate', 'channelCount', 'latency'];
  const applied = keys
    .map((k) => `${k}=${String((set as Record<string, unknown>)?.[k] ?? '（なし）')}`)
    .join(', ');
  return [
    `ブラウザ: ${navigator.userAgent}`,
    `マイク名（ブラウザの表示）: ${track?.label || '（不明）'}`,
    `AudioContext sampleRate: ${s.ctx.sampleRate} Hz`,
    `baseLatency: ${ms(s.ctx.baseLatency)}`,
    `outputLatency: ${ms((s.ctx as AudioContext & { outputLatency?: number }).outputLatency)}`,
    `トラックの設定（getSettings）: ${applied}`,
  ].join('\n');
}

async function start(): Promise<void> {
  startBtn.disabled = true;
  setStatus('マイクの許可を待っています…');
  try {
    const ctx = new AudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'mic-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    const s: Session = { ctx, stream, node, blocks: [] };
    node.port.onmessage = (e: MessageEvent<CapturedBlock>) => s.blocks.push(e.data);
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(ctx.destination); // pulls the worklet; it writes nothing, so it stays silent
    await ctx.resume();
    session = s;
    envEl.textContent = envText(s);
    runBtn.disabled = false;
    stopBtn.disabled = false;
    setStatus('準備ができました。「計測する」を押してください。');
  } catch (err) {
    startBtn.disabled = false;
    setStatus(`始められませんでした: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
}

function waitUntil(ctx: AudioContext, t: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (ctx.currentTime >= t ? resolve() : setTimeout(tick, 50));
    tick();
  });
}

async function run(): Promise<void> {
  const s = session;
  if (!s) return;
  runBtn.disabled = true;
  stopBtn.disabled = true;
  setStatus('計測中…（静かにしてください）');
  try {
    const { ctx, node } = s;
    s.blocks = [];
    const click = clickSamples(ctx.sampleRate);
    const clickBuf = ctx.createBuffer(1, click.length, ctx.sampleRate);
    clickBuf.copyToChannel(click, 0);
    node.port.postMessage('start');
    const t0 = ctx.currentTime + LEAD_IN_SEC;
    const times = Array.from({ length: CLICKS }, (_, i) => t0 + i * SPACING_SEC);
    for (const t of times) {
      const src = ctx.createBufferSource();
      src.buffer = clickBuf;
      src.connect(ctx.destination);
      src.start(t);
    }
    await waitUntil(ctx, times[times.length - 1] + TAIL_SEC);
    node.port.postMessage('stop');
    await new Promise((r) => setTimeout(r, 150)); // the last blocks still in flight
    const rec = assembleBlocks(s.blocks);
    s.blocks = []; // drop the samples right away
    const expected = times.map((t) => t * ctx.sampleRate - rec.startFrame);
    const det = detectClicks(rec.samples, ctx.sampleRate, expected, { afterMs: SPACING_SEC * 800 });
    const delays = det.map((d) => d.delayMs);
    const row: RunRow = {
      n: rows.length + 1,
      mode: modeSel.value,
      delays,
      st: stats(delays),
      baseLatency: ctx.baseLatency,
      outputLatency: (ctx as AudioContext & { outputLatency?: number }).outputLatency,
      gapFrames: rec.gapFrames,
    };
    rows.push(row);
    envEl.textContent = envText(s);
    render(row);
    setStatus(
      row.st
        ? `計測 ${row.n} が終わりました（${row.st.count}/${CLICKS} 個拾えました）。`
        : `計測 ${row.n}: クリックを 1 つも拾えませんでした。音量・マイクの位置を確かめてください。`,
    );
  } catch (err) {
    setStatus(`計測できませんでした: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    runBtn.disabled = false;
    stopBtn.disabled = false;
  }
}

function statsText(st: Stats | null): string {
  return st
    ? `平均 ${st.mean.toFixed(2)} ms / ばらつき（標準偏差） ${st.stdev.toFixed(2)} ms / 最小 ${st.min.toFixed(2)} / 最大 ${st.max.toFixed(2)} / ${st.count} 個`
    : '拾えたクリックがありません';
}

function render(row: RunRow): void {
  lastEl.textContent = [
    `計測 ${row.n}（${row.mode}）`,
    `クリックごとのずれ (ms): ${row.delays.map(fmt).join(', ')}`,
    statsText(row.st),
    `baseLatency ${ms(row.baseLatency)} / outputLatency ${ms(row.outputLatency)}`,
    row.st && row.outputLatency !== undefined && row.baseLatency !== undefined
      ? `ずれ − (baseLatency + outputLatency) = ${(row.st.mean - (row.baseLatency + row.outputLatency) * 1000).toFixed(2)} ms（入力側の遅れの目安）`
      : '',
    row.gapFrames ? `録音の抜け: ${row.gapFrames} フレーム` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const tr = document.createElement('tr');
  const cells = [
    String(row.n),
    row.mode,
    row.st ? row.st.mean.toFixed(2) : '—',
    row.st ? row.st.stdev.toFixed(2) : '—',
    row.st ? `${row.st.count}/${CLICKS}` : `0/${CLICKS}`,
    ms(row.baseLatency),
    ms(row.outputLatency),
    row.delays.map(fmt).join(', '),
  ];
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    tr.appendChild(td);
  }
  runsBody.appendChild(tr);
  copyBtn.disabled = false;
}

function copyText(): string {
  const lines = [
    '# band-sheets T13 マイクの確かめ',
    '出力の機器（スピーカー・ヘッドホンの名前）: （ここに書いてください）',
    '入力の機器（マイクの名前）: （ここに書いてください）',
    session ? envText(session) : '',
    `クリック ${CLICKS} 個、間隔 ${SPACING_SEC} s`,
    '計測\t方法\t平均ms\tばらつきms\t拾えた数\tbaseLatency\toutputLatency\tクリックごとms',
    ...rows.map((r) =>
      [
        r.n,
        r.mode,
        r.st ? r.st.mean.toFixed(2) : '-',
        r.st ? r.st.stdev.toFixed(2) : '-',
        `${r.st?.count ?? 0}/${CLICKS}`,
        ms(r.baseLatency),
        ms(r.outputLatency),
        r.delays.map(fmt).join(','),
      ].join('\t'),
    ),
  ];
  const all = stats(rows.flatMap((r) => r.delays));
  lines.push(`全計測のクリック: ${statsText(all)}`);
  return lines.filter((l) => l !== '').join('\n');
}

async function copy(): Promise<void> {
  const text = copyText();
  copyOut.value = text;
  copyOut.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('結果をコピーしました（下の枠にも出しています）。');
  } catch {
    copyOut.select();
    setStatus('自動でコピーできませんでした。下の枠の文字を選んでコピーしてください。');
  }
}

async function stopMic(): Promise<void> {
  const s = session;
  if (!s) return;
  session = null;
  s.stream.getTracks().forEach((t) => t.stop());
  await s.ctx.close();
  runBtn.disabled = true;
  stopBtn.disabled = true;
  startBtn.disabled = false;
  setStatus('マイクを止めました。計測の表は残っています。');
}

startBtn.addEventListener('click', () => void start());
runBtn.addEventListener('click', () => void run());
stopBtn.addEventListener('click', () => void stopMic());
copyBtn.addEventListener('click', () => void copy());

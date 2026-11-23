/**
 * LT3 of the live chord-check tool: the page (docs/live-chord-tool-plan.md section 4.2). Privacy: the input's samples
 * stay in memory (the Worker's 8 s ring); nothing is saved, uploaded or played back; the CSP in liveChords.html allows no
 * request but this origin's own scripts.
 *
 * Flow: 「開始」 (user gesture) -> getUserMedia (echo cancellation, noise suppression, auto gain OFF; the chosen device) ->
 * AudioContext at the device's rate -> MediaStreamSource -> capture AudioWorklet (inline module from a Blob URL), which
 * posts every 128-frame block {frame, data: one Float32Array per channel} to the Worker over a MessageChannel and a
 * peak / RMS meter reading to this page -> Worker (liveWorker.ts) -> results here.
 */
/// <reference lib="dom" />
import type { Candidate, WindowResult } from '../live/core';
import type { FromWorker, ToWorker } from '../live/protocol';
import { VARIANTS, type VariantId } from '../live/variants';

const WORKLET = `
class LiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.peak = 0; this.sumSq = 0; this.count = 0; this.blocks = 0;
    this.port.onmessage = (e) => { this.out = e.data.port; };
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const data = inp.map((c) => c.slice());
    if (this.out) this.out.postMessage({ frame: currentFrame, data }, data.map((c) => c.buffer));
    for (const c of inp) for (let i = 0; i < c.length; i++) { const v = c[i]; const a = v < 0 ? -v : v; if (a > this.peak) this.peak = a; this.sumSq += v * v; }
    this.count += inp.length * inp[0].length;
    if (++this.blocks === 8) {
      this.port.postMessage({ peak: this.peak, rms: Math.sqrt(this.sumSq / this.count) });
      this.peak = 0; this.sumSq = 0; this.count = 0; this.blocks = 0;
    }
    return true;
  }
}
registerProcessor('live-capture', LiveCapture);
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const deviceSel = $<HTMLSelectElement>('device');
const startBtn = $<HTMLButtonElement>('start');
const recalBtn = $<HTMLButtonElement>('recal');
const variantSel = $<HTMLSelectElement>('variant');
const keySel = $<HTMLSelectElement>('key');
const winInput = $<HTMLInputElement>('win');

interface Session {
  ctx: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode;
}
let session: Session | null = null;
const worker = new Worker(new URL('./liveWorker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

/* ------------------------------------------------------------ controls */

for (const v of VARIANTS) {
  const o = document.createElement('option');
  o.value = v.id;
  o.textContent = v.logic ? v.label : `${v.label}（使えない）`;
  o.disabled = !v.logic;
  variantSel.append(o);
}
variantSel.value = 'base';

const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
for (const [value, label] of [['', 'なし'], ...KEYS.map((k) => [k, k]), ...KEYS.map((k) => [`${k}m`, `${k}m`])]) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  keySel.append(o);
}

function variantNote(): void {
  const v = VARIANTS.find((x) => x.id === variantSel.value);
  const off = VARIANTS.filter((x) => !x.logic).map((x) => `${x.id} は使えない: ${x.unavailable ?? ''}`);
  $('variantNote').textContent = [v?.note ?? '', ...off].join(' ／ ');
}

function sendConfig(): void {
  $('winText').textContent = `${Number(winInput.value).toFixed(1)} 秒`;
  variantNote();
  send({ type: 'config', variantId: variantSel.value as VariantId, windowSec: Number(winInput.value), key: keySel.value || undefined });
}
for (const el of [variantSel, keySel, winInput]) el.addEventListener('input', sendConfig);
sendConfig();

/* ------------------------------------------------------------ capture */

async function fillDevices(selected: string): Promise<void> {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  deviceSel.replaceChildren(
    ...devs.map((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `入力 ${i + 1}`;
      return o;
    }),
  );
  if (devs.some((d) => d.deviceId === selected)) deviceSel.value = selected;
}

async function start(): Promise<void> {
  startBtn.disabled = true;
  setMsg('入力の許可を待っています…');
  try {
    const ctx = new AudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceSel.value ? { deviceId: { exact: deviceSel.value } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'live-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    const ch = new MessageChannel();
    node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    send({ type: 'start', port: ch.port2, deviceRate: ctx.sampleRate }, [ch.port2]);
    sendConfig();
    node.port.onmessage = (e: MessageEvent<{ peak: number; rms: number }>) => (meter = e.data);
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(ctx.destination); // pulls the worklet; it writes nothing, so it stays silent
    await ctx.resume();
    session = { ctx, stream, node };
    await fillDevices(stream.getAudioTracks()[0]?.getSettings().deviceId ?? '');
    startBtn.textContent = '停止';
    recalBtn.disabled = false;
    $('stats').dataset.rate = String(ctx.sampleRate);
    setMsg('入力が門を超えるのを待っています…');
  } catch (err) {
    setMsg(`始められませんでした: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  } finally {
    startBtn.disabled = false;
  }
}

function stop(): void {
  const s = session;
  if (!s) return;
  session = null;
  send({ type: 'stop' });
  s.node.port.onmessage = null;
  s.node.disconnect();
  for (const t of s.stream.getTracks()) t.stop();
  void s.ctx.close();
  startBtn.textContent = '開始';
  recalBtn.disabled = true;
  meter = { peak: 0, rms: 0 };
  setMsg('止めました。');
}

startBtn.addEventListener('click', () => (session ? stop() : void start()));
recalBtn.addEventListener('click', () => send({ type: 'recalibrate' }));
deviceSel.addEventListener('change', () => {
  if (session) {
    stop();
    void start();
  }
});

/* ------------------------------------------------------------ meter */

let meter = { peak: 0, rms: 0 };
const dB = (v: number) => (v > 1e-6 ? 20 * Math.log10(v) : -120);
const pos = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
function drawMeter(): void {
  $('meterRms').style.width = pos(dB(meter.rms));
  $('meterPeak').style.left = pos(dB(meter.peak));
  $('meterText').textContent = `${dB(meter.rms) > -120 ? dB(meter.rms).toFixed(0) : '—'} dBFS`;
  requestAnimationFrame(drawMeter);
}
requestAnimationFrame(drawMeter);

/* ------------------------------------------------------------ results */

let calibText = '調律 — ・ 利得 —';
let lastStats = '';

function setMsg(text: string): void {
  $('msg').textContent = text;
}

const f2 = (v: number) => v.toFixed(2).replace(/^(-?)0\./, '$1.');

function drawResult(r: WindowResult, variantId: VariantId): void {
  const cands = $('cands');
  const answer = $('answer');
  const extra = $('extra');
  extra.textContent = '';
  if (r.kind !== 'chord') {
    cands.replaceChildren();
    answer.textContent = '—';
    setMsg(r.kind === 'quiet' ? `音が小さい（${r.rmsDb.toFixed(0)} dBFS）` : r.kind === 'noChord' ? '和音が見つからない（N.C.）' : `${variantId}: ${r.reason}`);
    return;
  }
  setMsg(r.ruleChanged ? 'ルールが 1 位の名前を変えた' : '');
  answer.textContent = r.answer.split(' ').join(' → ');
  cands.replaceChildren(
    ...r.top.flatMap((c: Candidate, i: number) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="num"></td><td></td><td class="num"></td><td class="num"></td><td class="bar"><i></i></td>`;
      const [n, name, pct, s, bar] = Array.from(tr.children) as HTMLElement[];
      n.textContent = String(i + 1);
      name.textContent = c.name;
      pct.textContent = `${c.pct.toFixed(0)} %`;
      s.textContent = `s ${f2(c.s)}`;
      (bar.firstElementChild as HTMLElement).style.width = `${Math.max(1, c.pct)}%`;
      if (i !== 2) return [tr];
      const cut = document.createElement('tr');
      cut.className = 'cut';
      cut.innerHTML = '<td colspan="5">ここまでがアプリで見せる候補</td>';
      return [cut, tr];
    }),
  );
  const parts: string[] = [];
  if (r.bass) parts.push(`ベース ${r.bass.note}（${f2(r.bass.confidence)}${r.bass.kind === 'inversion' ? '・転回' : r.bass.kind ? `・${r.bass.kind}` : ''}）`);
  if (r.f1Notes) parts.push(`F1 の音: ${r.f1Notes.join(' ')}`);
  if (r.added) {
    const rho = Object.entries(r.added.rho)
      .map(([d, v]) => `ρ(${d}) ${f2(v)}`)
      .join(' ');
    parts.push(`added: ${rho}（θ ${f2(r.added.theta)}${r.added.candidate !== undefined ? `・候補 ${r.added.candidate ?? 'なし'}` : ''}）`);
  }
  extra.textContent = parts.join(' ・ ');
}

function drawStats(): void {
  $('stats').textContent = `${lastStats} ・ ${calibText}`;
}

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  if (m.type === 'calibration') {
    const c = m.calibration;
    calibText = c.state === 'fixed' ? `調律 ${c.tuning.toFixed(2)} ・ 利得 ${c.gainDb >= 0 ? '+' : ''}${c.gainDb.toFixed(1)} dB（固定）` : c.state === 'collecting' ? `調律・利得を測っています（${c.sec.toFixed(1)} / 3 秒）` : '調律・利得: 入力が門を超えるのを待っています';
    if (c.state !== 'fixed') {
      setMsg(c.state === 'collecting' ? '測っています。同じ音を鳴らし続けなくてもよいが、止めないでください。' : '入力が門を超えるのを待っています…');
      $('answer').textContent = '—';
      $('cands').replaceChildren();
      $('extra').textContent = '';
    }
    drawStats();
  } else if (m.type === 'result') {
    drawResult(m.result, m.variantId);
    const ms = m.result.kind === 'chord' || m.result.kind === 'noChord' ? `${m.result.ms.total.toFixed(0)} ms` : `${m.ms.toFixed(0)} ms`;
    lastStats = `計算 ${ms} ・ ${m.perSec.toFixed(1)} 回/秒 ・ ${m.lagSec.toFixed(1)} 秒前の音 ・ 抜け ${m.gapFrames}`;
    drawStats();
  } else setMsg(`エラー: ${m.message}`);
};

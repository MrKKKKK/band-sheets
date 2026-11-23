/**
 * LT0 of the live chord-check tool (docs/live-chord-tool-plan.md section 6): how long ONE window takes in Node for each
 * logic variant of section 2, before any worklet / Worker / UI exists. Each variant runs through LT1's core.ts
 * analyzeWindow (the existing functions the plan names, nothing reimplemented); tuning is passed in fixed (estimated once), the gain is fixed (the signal is made at
 * a fixed level). The signal is a self-made C major triad + bass note (deterministic, no recording).
 *
 *   npx tsx ts/live/timing.ts
 *
 * One window = colStart..colEnd as ONE column (perBeat 1, n 1); the analysed signal is the window + 0.8 s on each side
 * (section 1.2, the low-note wait). No network, no files written.
 */
import { appBassConfig, T7C_E1_CANDIDATE_THETA } from '../chords2/config';
import { DEFAULT_F1_CONFIG } from '../chords2/front/config';
import { octaveCqt } from '../chords2/front/f1';
import { lowCqt, LOW_HOP } from '../bass/lowCqt';
import { cqtPlan, kernelBank } from '../dsp/core/cqt';
import { resampleSinc } from '../dsp/core/resample';
import { hpss } from '../dsp/audio';
import { analyzeWindow, ANALYZER_SR, measureTuning, WAIT_SEC, type WindowCtx, type WindowResult } from './core';
import { chordSignal, C_CHORD } from './synth';
import { candidateConfig, VARIANTS, type Variant } from './variants';

const SR = ANALYZER_SR; // 22,050 Hz mono, what the chord functions take
const WAIT = WAIT_SEC; // low-note wait on each side (plan 1.2)
const WINDOWS = [0.5, 1, 3];
const CALLS = 20;
const WARMUP = 3;

/* ------------------------------------------------------------ the variants (plan section 2, core.ts) */

interface Ctx extends WindowCtx {
  /** window + 1.6 s of 22,050 Hz audio, the window at [WAIT, WAIT + w) */
  y: Float32Array;
}

const app = appBassConfig();
const candTheta = T7C_E1_CANDIDATE_THETA ?? 0.5; // null: timing only, theta_c .5 (T7c's tuning pick, docs/audio-spike8-t7c.md)
/** s8-cand is unavailable while T7C_E1_CANDIDATE_THETA is null: timed here with θ_c .5 only (config unchanged). */
const timed = (v: Variant): Variant => (v.logic ? v : { ...v, logic: { kind: 'chords2', cfg: candidateConfig(candTheta) } });
const RUNS: { id: string; run: (c: Ctx) => WindowResult }[] = VARIANTS.map((v0) => {
  const v = timed(v0);
  return { id: v.id, run: (c: Ctx) => analyzeWindow(v, c.y, c) };
});

/* ------------------------------------------------------------ timing */

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p90 = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.9) - 1];

function time(fn: () => unknown, calls = CALLS, warmup = WARMUP): { med: number; p90: number } {
  for (let i = 0; i < warmup; i++) fn();
  const ms: number[] = [];
  for (let i = 0; i < calls; i++) {
    const t = performance.now();
    fn();
    ms.push(performance.now() - t);
  }
  return { med: median(ms), p90: p90(ms) };
}

const f0 = (x: number): string => x.toFixed(0);
const pad = (s: string, n: number): string => s.padEnd(n);

function main(): void {
  const full = chordSignal(C_CHORD, SR, 3 + 2 * WAIT);
  const ctx = (w: number): Ctx => {
    const y = full.slice(0, Math.round((w + 2 * WAIT) * SR));
    return { y, colStart: WAIT, colEnd: WAIT + w, tuning, gainDb: 0 };
  };
  // fixed: the tuning is estimated once (plan 1.3) on the first 3 s; the gain is 0 (the signal is made at -22 dBFS)
  const tuning = measureTuning(full.slice(0, 3 * SR));

  console.log(`node ${process.version}; ${CALLS} calls after ${WARMUP} warm-up; the analysed signal = window + ${2 * WAIT} s; tuning ${tuning.toFixed(3)} (fixed)`);
  if (T7C_E1_CANDIDATE_THETA === null) console.log('NOTE: T7C_E1_CANDIDATE_THETA is null; s8-cand is timed with theta_c .5 for timing only (config unchanged)');

  console.log('\n== per call, median / p90 ms ==');
  console.log(pad('variant', 9) + WINDOWS.map((w) => pad(`${w} s`, 14)).join(''));
  const answers: Record<string, WindowResult> = {};
  for (const v of RUNS) {
    const cells = WINDOWS.map((w) => {
      const c = ctx(w);
      if (w === 1) answers[v.id] = v.run(c);
      const t = time(() => v.run(c));
      return pad(`${f0(t.med)} / ${f0(t.p90)}`, 14);
    });
    console.log(pad(v.id, 9) + cells.join(''));
  }

  console.log('\n== one stage on its own (per call, median / p90 ms) ==');
  console.log(pad('stage', 34) + WINDOWS.map((w) => pad(`${w} s`, 14)).join(''));
  const stages: [string, (c: Ctx) => unknown][] = [
    ['hpss', (c) => hpss(c.y)],
    ['lowCqt 5 oct (bass)', (c) => lowCqt(c.y, app.lowCqt, { tuning: c.tuning })],
    ['octaveCqt 7 oct (F1)', (c) => octaveCqt(c.y, DEFAULT_F1_CONFIG, { tuning: c.tuning })],
    ['resampleSinc 48k -> 22.05k', (c) => resampleSinc(new Float32Array(Math.round(c.y.length * (48000 / SR))), 48000, SR)],
  ];
  for (const [name, fn] of stages) {
    console.log(pad(name, 34) + WINDOWS.map((w) => { const c = ctx(w); const t = time(() => fn(c)); return pad(`${f0(t.med)} / ${f0(t.p90)}`, 14); }).join(''));
  }

  // kernelBank is rebuilt inside every CQT call (cqtMagnitudeStream, frozen, no cache): build the same banks on their own
  const banks = (octaves: number, w: number) => (): void => {
    const plan = cqtPlan(Math.round((w + 2 * WAIT) * SR), { sr: SR, hop: LOW_HOP, fmin: 32.7, nBins: octaves * 36, bpo: 36, tuning });
    const nf = 36;
    for (let o = 0; o < plan.nOctaves; o++) {
      const hi = octaves * 36 - nf * o;
      const lo = Math.max(0, hi - nf);
      kernelBank(plan.freqs.subarray(lo, hi), plan.alpha.subarray(lo, hi), plan.octaves[o].sr, plan.sr);
    }
  };
  console.log('\n== fixed / one-off costs (ms, median / p90) ==');
  for (const [label, octs] of [['kernelBank, 5-octave CQT (all octaves)', 5], ['kernelBank, 7-octave CQT (all octaves)', 7]] as const) {
    const t = time(banks(octs, 1));
    console.log(`${pad(label, 42)}${f0(t.med)} / ${f0(t.p90)}  (NOT cached: rebuilt inside every CQT call, so it is already in the per-call numbers)`);
  }
  const tt = time(() => measureTuning(full.slice(0, 3 * SR)), 10, 1);
  console.log(`${pad('estimateTuning, 3 s (once per start)', 42)}${f0(tt.med)} / ${f0(tt.p90)}`);

  console.log('\n== sanity: the synthetic C chord, window 1 s, top 5 (% of the posterior) ==');
  for (const v of RUNS) {
    const a = answers[v.id];
    if (a.kind !== 'chord') console.log(`${pad(v.id, 9)}${a.kind}`);
    else console.log(`${pad(v.id, 9)}answer ${pad(a.answer, 8)}${a.top.map((t) => `${t.name} ${t.pct.toFixed(1)}%`).join(', ')}`);
  }
}

main();

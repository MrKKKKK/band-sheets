/**
 * LT0 of the live chord-check tool (docs/live-chord-tool-plan.md section 6): how long ONE window takes in Node for each
 * logic variant of section 2, before any worklet / Worker / UI exists. Each variant calls the existing functions the plan
 * names (nothing is reimplemented); tuning is passed in fixed (estimated once), the gain is fixed (the signal is made at
 * a fixed level). The signal is a self-made C major triad + bass note (deterministic, no recording).
 *
 *   npx tsx ts/live/timing.ts
 *
 * One window = colStart..colEnd as ONE column (perBeat 1, n 1); the analysed signal is the window + 0.8 s on each side
 * (section 1.2, the low-note wait). No network, no files written.
 */
import { appBassConfig, resolveChords2Config, T10_V1_OVERRIDES, T7_E1_D2_VALUES, T7C_E1_CANDIDATE_THETA, type Chords2Config } from '../chords2/config';
import { analyze, chordName } from '../chords2/analyze';
import { toEvalChords } from '../chords2/eval/frontEnd';
import { foldF1 } from '../chords2/octaveChroma';
import { bassCqtFrom, f1Beats, octaveCqt } from '../chords2/front/f1';
import { marksOnV2, type TimedChord } from '../chords2/pipeline';
import { lowCqt, LOW_HOP, LOW_SR } from '../bass/lowCqt';
import { DEFAULT_CHORDS_CONFIG, estimateChords, mergeChords } from '../dsp/chords';
import { chordColumns } from '../dsp/chroma';
import { cqtPlan, estimateTuning, kernelBank } from '../dsp/core/cqt';
import { resampleSinc } from '../dsp/core/resample';
import { hpss } from '../dsp/audio';
import { states as v1aStates } from '../dsp/vocab';
import type { ChordState } from '../dsp/vocab';
import type { BarKey } from '../dsp/keytrack';

const SR = LOW_SR; // 22,050 Hz mono, what the chord functions take
const WAIT = 0.8; // low-note wait on each side (plan 1.2)
const WINDOWS = [0.5, 1, 3];
const CALLS = 20;
const WARMUP = 3;

/* ------------------------------------------------------------ the synthetic signal */

/** A piano-ish note: 8 partials (1/h), partial h decays faster, 5 ms attack. Deterministic. */
function addNote(y: Float32Array, sr: number, hz: number, amp: number): void {
  for (let h = 1; h <= 8; h++) {
    const f = hz * h * Math.sqrt(1 + 0.0004 * h * h); // slight inharmonicity
    if (f > sr / 2 - 100) break;
    const a = amp / h;
    const k = 0.4 + 0.15 * h;
    for (let i = 0; i < y.length; i++) {
      const t = i / sr;
      y[i] += a * Math.min(1, t / 0.005) * Math.exp(-k * t) * Math.sin(2 * Math.PI * f * t);
    }
  }
}

/** C major triad (C4 E4 G4) + bass C2, scaled to RMS -22 dBFS (the spike's level, so the gain is fixed). */
function cChord(sr: number, seconds: number): Float32Array {
  const y = new Float32Array(Math.round(sr * seconds));
  for (const [hz, a] of [[65.406, 1.0], [261.626, 1.0], [329.628, 1.0], [391.995, 1.0]]) addNote(y, sr, hz, a);
  let e = 0;
  for (const v of y) e += v * v;
  const g = (10 ** (-22 / 20)) / Math.sqrt(e / y.length);
  for (let i = 0; i < y.length; i++) y[i] *= g;
  return y;
}

/* ------------------------------------------------------------ the variants (plan section 2) */

interface Ctx {
  /** window + 1.6 s of 22,050 Hz audio, the window at [WAIT, WAIT + w) */
  y: Float32Array;
  colStart: number;
  colEnd: number;
  tuning: number;
}
interface Answer {
  name: string;
  top5: { name: string; pct: number }[];
}

const KEY: BarKey = { bar: 0, tonic: 0, mode: 'major', confidence: 0 }; // n = 1: FamilyPrior's row is never read (plan 1.1)
const app = appBassConfig();

const top5 = (post: Float64Array, sts: readonly ChordState[]): Answer['top5'] =>
  Array.from(post, (p, i) => ({ name: chordName(sts[i].root, sts[i].quality), pct: p * 100 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);

/** hpss -> chordColumns, the chroma every variant starts from (plan 1.1). */
function chroma(c: Ctx) {
  const { yHarm } = hpss(c.y);
  return chordColumns(yHarm, [c.colStart], c.colEnd, { perBeat: 1, tuningFull: c.tuning, tuningBass: c.tuning });
}

const withBass = (c: Ctx, low: ReturnType<typeof lowCqt>, evalChords: ReturnType<typeof toEvalChords>): string => {
  const chords: TimedChord[] = evalChords.map((x) => ({ ...x, bass: x.bass ?? null })); // as eval/s8dev1.ts does
  return marksOnV2(low, chords, [c.colStart, c.colEnd], app).map((x) => chordName(NOTE(x.root), x.quality, x.bass === null ? null : NOTE(x.bass))).join(' ') || 'N';
};
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE = (name: string): number => NOTES.indexOf(name);

function v1a(c: Ctx, base: boolean): Answer {
  const cols = chroma(c);
  const col = estimateChords(cols.cChroma, 1, DEFAULT_CHORDS_CONFIG, { perBeat: 1 });
  const sts = v1aStates(DEFAULT_CHORDS_CONFIG);
  const post = col[0].posterior as Float64Array;
  let name = col[0].root === null ? 'N' : chordName(col[0].root, col[0].quality);
  if (base) {
    const chords = toEvalChords(mergeChords(col, DEFAULT_CHORDS_CONFIG, 1), [c.colStart], c.colEnd);
    name = withBass(c, lowCqt(c.y, app.lowCqt, { tuning: c.tuning }), chords);
  }
  return { name, top5: top5(post, sts) };
}

const input = (cols: ReturnType<typeof chroma>) => ({ chroma: cols.cChroma, n: 1, perBeat: 1, barKeys: [KEY], barOfBeat: [0] });

/** s7-V1: chords2 analyze with the V1 overrides, then the marks. */
function s7V1(c: Ctx): Answer {
  const cfg = resolveChords2Config(T10_V1_OVERRIDES);
  const out = analyze(input(chroma(c)), cfg);
  const name = withBass(c, lowCqt(c.y, app.lowCqt, { tuning: c.tuning }), toEvalChords(out.segments, [c.colStart], c.colEnd));
  return { name, top5: top5(out.columns[0].posterior as Float64Array, out.states) };
}

/** s8 variants: F1 on the 7-octave CQT (tuning given), the bass CQT taken from it, then analyze (pipeline.ts chords2Inputs' own calls). */
function s8(c: Ctx, cfg: Chords2Config): Answer {
  const f1 = cfg.f1!;
  const wide = octaveCqt(c.y, f1, { tuning: c.tuning });
  const beats = f1Beats(wide, [c.colStart], c.colEnd, f1);
  const low = bassCqtFrom(c.y, wide, app.lowCqt);
  const base = input(chroma(c));
  const out = analyze({ ...base, f1Beats: beats, ...(cfg.octaveChroma ? { f1Chroma: foldF1(beats, 1, f1) } : {}) }, cfg);
  const name = withBass(c, low, toEvalChords(out.segments, [c.colStart], c.colEnd));
  return { name, top5: top5(out.columns[0].posterior as Float64Array, out.states) };
}

const candTheta = T7C_E1_CANDIDATE_THETA ?? 0.5; // null: timing only, theta_c .5 (T7c's tuning pick, docs/audio-spike8-t7c.md)
const CFG_D2 = resolveChords2Config({ d2: { range: 'E1', ...T7_E1_D2_VALUES } });
const CFG_D1 = resolveChords2Config({ octaveChroma: true });
const CFG_CAND = resolveChords2Config({ d2: { range: 'E1', theta: candTheta, thetaLow: 0.3, output: 'candidate' } });

const VARIANTS: { id: string; run: (c: Ctx) => Answer }[] = [
  { id: 'v1a', run: (c) => v1a(c, false) },
  { id: 'base', run: (c) => v1a(c, true) },
  { id: 's7-V1', run: s7V1 },
  { id: 's8-D2', run: (c) => s8(c, CFG_D2) },
  { id: 's8-D1', run: (c) => s8(c, CFG_D1) },
  { id: 's8-cand', run: (c) => s8(c, CFG_CAND) },
];

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
  const full = cChord(SR, 3 + 2 * WAIT);
  const ctx = (w: number): Ctx => {
    const y = full.slice(0, Math.round((w + 2 * WAIT) * SR));
    return { y, colStart: WAIT, colEnd: WAIT + w, tuning: tuning };
  };
  // fixed: the tuning is estimated once (plan 1.3) on the first 3 s
  const tuning = estimateTuning(full.slice(0, 3 * SR), { sr: SR, bpo: 36 });

  console.log(`node ${process.version}; ${CALLS} calls after ${WARMUP} warm-up; the analysed signal = window + ${2 * WAIT} s; tuning ${tuning.toFixed(3)} (fixed)`);
  if (T7C_E1_CANDIDATE_THETA === null) console.log('NOTE: T7C_E1_CANDIDATE_THETA is null; s8-cand is timed with theta_c .5 for timing only (config unchanged)');

  console.log('\n== per call, median / p90 ms ==');
  console.log(pad('variant', 9) + WINDOWS.map((w) => pad(`${w} s`, 14)).join(''));
  const answers: Record<string, Answer> = {};
  for (const v of VARIANTS) {
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
    ['octaveCqt 7 oct (F1)', (c) => octaveCqt(c.y, CFG_D2.f1, { tuning: c.tuning })],
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
  const tt = time(() => estimateTuning(full.slice(0, 3 * SR), { sr: SR, bpo: 36 }), 10, 1);
  console.log(`${pad('estimateTuning, 3 s (once per start)', 42)}${f0(tt.med)} / ${f0(tt.p90)}`);

  console.log('\n== sanity: the synthetic C chord, window 1 s, top 5 (% of the posterior) ==');
  for (const v of VARIANTS) {
    const a = answers[v.id];
    console.log(`${pad(v.id, 9)}answer ${pad(a.name, 8)}${a.top5.map((t) => `${t.name} ${t.pct.toFixed(1)}%`).join(', ')}`);
  }
}

main();

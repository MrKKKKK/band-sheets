/**
 * Spike 4 T9: config search on the synthetic TUNING split (docs/audio-spike4-plan.md section 7 T9).
 *
 *   npx tsx ts/hum/tune.ts [--split tuning] [--base base.json] [--params a.b,c.d] [--rounds 2] [--search cd|grid|eval] [-o out.json]
 *
 *   --split    tuning (default; the only split values are chosen on) or dev (confirm only: use --search eval).
 *              heldOut is refused, and so is anything that is not a manifest variant (recordings are never read).
 *   --base     JSON overrides the search starts from (resolveHumConfig), default {} = DEFAULT_HUM_CONFIG.
 *   --params   which SPACE entries to search (default: all).
 *   --search   cd   = coordinate descent: for each param, every value in SPACE with the others fixed; keep the best
 *                     if it beats the current one; repeat --rounds times (stops early when a round changes nothing).
 *              grid = full product of the chosen params (keep it small).
 *              eval = score the base config only (before/after tables, dev confirmation).
 *   --start-mode bar|first-note|first-note-only, --start-error-beats X: the start the analyzer gets (cli.ts variantStart;
 *              default bar = the exact bar-1 head; first-note = the first truth note's sung onset + X beats and its tick).
 *   --starts "bar,first-note:-0.7" (step 3): several start inputs at once (mode[:errorBeats]); J is the sum over them
 *              and the guard holds for each. Overrides --start-mode / --start-error-beats. Notes are extracted once per
 *              take (they do not depend on the start); only quantize runs per start.
 *   --objective "H2:1,H3:1.5" (default) level weights of J; --guard "H0,H1" (default) levels that must not drop.
 *   --key      give HumInput.key (for pitch.keyPrior) from the truth's pitch classes (keyOfTruth: what the user would
 *              write as the song's key). Without it the analyzer gets no key (keyPrior then has no effect).
 *   -o         JSON with the per-level summaries of the start and the result, and the step history
 *              (default out/hum/t9/tune-<split>.json).
 *
 * Objective (decision order of the plan: (1) H2/H3 improve, (2) H0/H1 do not drop):
 *   J = sum over the objective levels (weights) and starts of  F onset + quant exact - edits/keyboard,
 *   and a candidate is only accepted when, for each guarded level and start, F onset and quant exact do not drop by
 *   more than GUARD and edits/keyboard does not rise by more than GUARD against the START config.
 * Per-take means, as in report.ts. Audio is resampled once per take; f0 is cached per f0/voicing/audio config, so
 * segment / pitch / grid params cost ~1 s per evaluation and f0 params ~10 s. Prints only aggregate numbers.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeWav } from '../browser/wav';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { scoreTake, type Variant } from './baseline';
import { humConfigHash, humConfigSummary, resolveHumConfig, type HumConfig } from './config';
import { estimateF0 } from './f0';
import { extractNotes, frameLevelDb } from './notes';
import { resolveStart } from './analyze';
import { variantStart, type CliArgs } from './cli';
import { quantizeDetailed, type QuantizeInfo } from './quantize';
import type { FrameF0Track } from './types';

const OUT = join(import.meta.dirname, '..', '..', 'out', 'hum');
export const LEVELS = ['H0', 'H1', 'H2', 'H3', 'H4'] as const;
export const GUARD = 0.002;

type Val = number | boolean | string;

/** Search space: 'group.key' -> values (the default must be one of them). */
export const SPACE: Record<string, Val[]> = {
  'segment.dipDb': [3, 4, 4.5, 5, 5.5, 6, 7, 8],
  'segment.medianFrames': [3, 5, 7],
  'segment.moveSemitones': [0.5, 0.6, 0.7, 0.8],
  'segment.minMoveMs': [40, 50, 60, 80],
  'segment.glideSemitonesPerSec': [8, 12, 14, 16, 20],
  'segment.minNoteSixteenths': [0.25, 0.5, 0.75, 1],
  'segment.refFrames': [18, 24, 36, 48],
  'segment.settleFrames': [2, 3, 4, 6],
  'segment.joinGapMs': [40, 60, 80, 120],
  'segment.vibratoWindowMs': [150, 200, 250, 300],
  'segment.vibratoSwingSemitones': [0.1, 0.15, 0.2, 0.25],
  'segment.plateauFrames': [0, 4, 6, 8, 10, 12, 16],
  'segment.plateauSemitones': [0.15, 0.2, 0.3, 0.4, 0.5],
  'segment.plateauMaxSixteenths': [0.4, 0.5, 0.6, 0.75, 1],
  'segment.plateauWaitMs': [150, 250, 300, 400, 500, 600],
  'segment.scoopMaxSemitones': [1, 1.5, 2, 2.5, 3.5, 99],
  'segment.fragmentMs': [0, 100, 130, 150, 200, 250],
  'segment.fragmentGapMs': [0, 30, 50],
  'segment.fragmentSemitones': [0.8, 1.0, 1.3, 1.6, 2],
  'segment.noteHmm': [false, true],
  'segment.hmmSplitCost': [4, 6, 8, 10, 12, 16, 20, 24, 32],
  'segment.hmmSigmaSemitones': [0.25, 0.3, 0.35, 0.4, 0.5, 0.6],
  'segment.hmmOutlierCost': [2, 3, 4, 6, 8, 12],
  'segment.hmmRampSemitonesPerSec': [0, 2, 3, 4, 6, 8, 10, 12, 16],
  'grid.phaseSearch': [false, true],
  'grid.phasePriorBeats': [0.5, 0.75, 1],
  'grid.phaseAnchorWeight': [0, 0.5, 1, 2, 5, 10, 20],
  'grid.phaseAnchorBeats': [0.15, 0.25, 0.35, 0.5],
  'grid.phaseRangeBeats': [1, 1.5, 2],
  'grid.triplet': [false, true],
  'grid.tripletMargin': [0.3, 0.5, 0.7, 0.9],
  'pitch.trimFraction': [0.1, 0.2, 0.25, 0.3, 0.35],
  'pitch.octaveFixMaxSixteenths': [0, 1, 2, 4],
  'pitch.keyPrior': [false, true],
  'pitch.keyPriorCents': [10, 15, 20, 25, 30],
  'pitch.localTuning': [false, true],
  'pitch.localTuningSec': [4, 6, 8, 12, 16],
  'pitch.localTuningMinNotes': [4, 6, 8, 12],
  'grid.legatoGapEighths': [0.25, 0.5, 0.75, 1],
  'grid.endExtendFraction': [0, 0.15, 0.3, 0.5],
  'grid.maxBiasSec': [0.04, 0.08, 0.12],
  'grid.biasMethod': ['local', 'trunc'],
  'voicing.bridgeGapMs': [20, 30, 50],
  'voicing.noiseMarginDb': [6, 8, 10, 12],
  'voicing.minVoicedProb': [0.3, 0.4, 0.5, 0.6],
  'f0.yinThreshold': [0.1, 0.15, 0.2],
  'f0.octaveCheckRatio': [0, 0.35, 0.5],
  'f0.pyin': [false, true],
};

interface Take {
  v: Variant;
  /** One quantize input per start (--starts). */
  infos: QuantizeInfo[];
  key?: string;
  x: Float32Array;
  truth: Parameters<typeof scoreTake>[0];
}

export interface StartSpec {
  mode: CliArgs['startMode'];
  errBeats: number;
}

/** "bar,first-note:-0.7" -> start specs. */
export function parseStarts(s: string): StartSpec[] {
  return s
    .split(',')
    .filter(Boolean)
    .map((x) => {
      const [m, e] = x.split(':');
      if (m !== 'bar' && m !== 'first-note' && m !== 'first-note-only') throw new Error(`bad start ${x}`);
      return { mode: m, errBeats: Number(e ?? 0) };
    });
}

export const startLabel = (s: StartSpec) => (s.mode === 'bar' ? 'bar' : `${s.mode}${s.errBeats >= 0 ? '+' : ''}${s.errBeats}`);

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_PCS = [0, 2, 4, 5, 7, 9, 11];

/** The key a user would state for a synthetic take: the major key whose scale holds the most note time of the truth
 *  (ties: more time on the tonic + dominant). Only feeds HumInput.key (pitch.keyPrior); minor keys share the scale. */
export function keyOfTruth(notes: { midi: number; start: number; end: number }[]): string {
  const w = new Array<number>(12).fill(0);
  for (const n of notes) w[((n.midi % 12) + 12) % 12] += n.end - n.start;
  let best = 0;
  let bestScore = -Infinity;
  for (let t = 0; t < 12; t++) {
    const sc = MAJOR_PCS.reduce((a, d) => a + w[(t + d) % 12], 0) + 1e-3 * (w[t] + w[(t + 7) % 12]);
    if (sc > bestScore + 1e-12) {
      bestScore = sc;
      best = t;
    }
  }
  return NOTE_NAMES[best];
}

export interface LevelSummary {
  n: number;
  fOnset: number;
  fOnOff: number;
  quantExact: number;
  editsKbd: number;
  /** Pooled edits / keyboard steps. */
  editsKbdPooled: number;
  /** Beats written as 8th triplets (grid.triplet), total over the level's takes (synthetic truths have none). */
  tripletBeats: number;
  rpa?: number;
  /** Error-type counts (baseline.ts errorTypes) as % of truth notes, for the report. */
  err?: Record<string, number>;
}
export type Summary = Record<string, LevelSummary>;

function loadTakes(split: string, starts: StartSpec[], withKey = false): Take[] {
  if (split !== 'tuning' && split !== 'dev') throw new Error(`--split must be tuning or dev (held-out is never read), got ${split}`);
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: (Variant & { wav: string; bpm: number; ts: [number, number]; startSec: number })[] };
  const out: Take[] = [];
  for (const v of manifest.variants) {
    if (v.heldOut || v.split === 'heldOut' || v.split !== split) continue;
    const wav = decodeWav(new Uint8Array(readFileSync(join(OUT, v.wav))));
    const truth = JSON.parse(readFileSync(join(OUT, v.truth), 'utf8'));
    const infos = starts.map((sp) => {
      const st = resolveStart(variantStart(v, sp.mode, sp.errBeats, truth));
      return { bpm: v.bpm, ts: v.ts, startSec: st.startSec, firstNoteSec: st.firstNoteSec, firstNoteTick: st.firstNoteTick };
    });
    out.push({
      v,
      infos,
      ...(withKey ? { key: keyOfTruth(truth.melody.notes) } : {}),
      x: resampleSinc(toMono(wav.channels), wav.sampleRate, 22050),
      truth,
    });
  }
  return out;
}

const f0Cache = new Map<string, { track: FrameF0Track; level: number[] }[]>();

function f0For(takes: Take[], cfg: HumConfig) {
  if (cfg.audio.sr !== 22050) throw new Error('tune.ts resamples to 22050 once; audio.sr is not searched');
  const key = JSON.stringify([cfg.f0, cfg.voicing]);
  let c = f0Cache.get(key);
  if (!c) {
    c = takes.map((t) => {
      const f = estimateF0(t.x, 22050, cfg);
      return { track: f.track, level: frameLevelDb(t.x, 22050, f.track) };
    });
    f0Cache.set(key, c);
  }
  return c;
}

const ERR_KEYS = ['seg.missed', 'seg.extraSplit', 'seg.missedSplit', 'seg.spurious', 'pitch.octave', 'pitch.semitone', 'pitch.other', 'quant.onsetSlot', 'quant.duration', 'quant.restVsLegato.filledRest', 'quant.restVsLegato.cutLegato'];

/** Same steps as analyzeHum after the resample (f0 -> level -> notes -> quantize) and the T8 scoring; one Summary per start. */
export function evaluate(takes: Take[], cfg: HumConfig, withF0 = false): Summary[] {
  const f0 = f0For(takes, cfg);
  const nStarts = takes[0]?.infos.length ?? 0;
  const per: Record<string, { s: Record<string, number>; trip: number }[]>[] = Array.from({ length: nStarts }, () => ({}));
  takes.forEach((t, i) => {
    const nr = extractNotes(f0[i].track, f0[i].level, { ...t.infos[0], key: t.key }, cfg);
    t.infos.forEach((info, si) => {
      const qr = quantizeDetailed(nr.notes, info, cfg.grid);
      const s = scoreTake(t.truth, nr.notes, qr.melody, withF0 ? f0[i].track : undefined);
      (per[si][t.v.level] ??= []).push({ s, trip: qr.tripletBeats });
    });
  });
  return per.map((pp) => {
    const out: Summary = {};
    for (const L of LEVELS) {
      const g = pp[L] ?? [];
      const mean = (k: string) => g.reduce((a, r) => a + (r.s[k] ?? 0), 0) / g.length;
      const sum = (k: string) => g.reduce((a, r) => a + (r.s[k] ?? 0), 0);
      const nTruth = sum('nTruth');
      out[L] = {
        n: g.length,
        fOnset: mean('noteF.onset'),
        fOnOff: mean('noteF.onsetOffset'),
        quantExact: mean('quant.exactAcc'),
        editsKbd: mean('edit.ratioToKeyboard'),
        editsKbdPooled: sum('edit.count') / sum('edit.keyboardSteps'),
        tripletBeats: g.reduce((a, r) => a + r.trip, 0),
        ...(withF0 ? { rpa: mean('f0.rpa'), err: Object.fromEntries(ERR_KEYS.map((k) => [k, (100 * sum(k)) / nTruth])) } : {}),
      };
    }
    return out;
  });
}

/** Objective weights per level (--objective "H2:1,H3:1.5", the T9 default) and guarded levels (--guard "H0,H1"). */
export const DEFAULT_OBJECTIVE: Record<string, number> = { H2: 1, H3: 1.5 };
export const DEFAULT_GUARD = ['H0', 'H1'];

export function objective(s: Summary | Summary[], weights: Record<string, number> = DEFAULT_OBJECTIVE): number {
  const all = Array.isArray(s) ? s : [s];
  const part = (x: Summary, L: string) => x[L].fOnset + x[L].quantExact - x[L].editsKbd;
  return all.reduce((acc, x) => acc + Object.entries(weights).reduce((a, [L, w]) => a + w * part(x, L), 0), 0);
}

export function guardOk(s: Summary | Summary[], start: Summary | Summary[], levels: readonly string[] = DEFAULT_GUARD): boolean {
  const a = Array.isArray(s) ? s : [s];
  const b = Array.isArray(start) ? start : [start];
  return a.every((x, i) => levels.every((L) => x[L].fOnset >= b[i][L].fOnset - GUARD && x[L].quantExact >= b[i][L].quantExact - GUARD && x[L].editsKbd <= b[i][L].editsKbd + GUARD));
}

function setPath(ov: Record<string, Record<string, Val>>, path: string, v: Val) {
  const [g, k] = path.split('.');
  return { ...ov, [g]: { ...(ov[g] ?? {}), [k]: v } };
}

function getPath(cfg: HumConfig, path: string): Val {
  const [g, k] = path.split('.');
  return (cfg as unknown as Record<string, Record<string, Val>>)[g][k];
}

export function fmtSummary(s: Summary | Summary[], labels?: string[]): string {
  const all = Array.isArray(s) ? s : [s];
  const f = (x: number | undefined) => (x === undefined ? '-' : x.toFixed(3));
  return all
    .map(
      (x, i) =>
        `${labels?.[i] ?? ''}: ` +
        LEVELS.map((L) => `${L} Fon ${f(x[L].fOnset)} qex ${f(x[L].quantExact)} e/k ${f(x[L].editsKbd)}${x[L].tripletBeats ? ` trip ${x[L].tripletBeats}` : ''}${x[L].rpa !== undefined ? ` rpa ${f(x[L].rpa)}` : ''}`).join(' | '),
    )
    .join('\n  ');
}

function arg(argv: string[], name: string, def?: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}

function main(argv: string[]) {
  const split = arg(argv, '--split', 'tuning')!;
  const mode = arg(argv, '--search', split === 'tuning' ? 'cd' : 'eval')!;
  if (split !== 'tuning' && mode !== 'eval') throw new Error('values are chosen on the tuning split only; use --search eval on dev');
  const basePath = arg(argv, '--base');
  let ov = (basePath ? JSON.parse(readFileSync(basePath, 'utf8')) : {}) as Record<string, Record<string, Val>>;
  const params = (arg(argv, '--params') ?? Object.keys(SPACE).join(',')).split(',');
  for (const p of params) if (!SPACE[p]) throw new Error(`unknown param ${p}`);
  const rounds = Number(arg(argv, '--rounds', '2'));
  const outPath = resolve(arg(argv, '-o', join(OUT, 't9', `tune-${split}.json`))!);

  const objArg = arg(argv, '--objective');
  const objW: Record<string, number> = objArg ? Object.fromEntries(objArg.split(',').map((x) => [x.split(':')[0], Number(x.split(':')[1] ?? 1)])) : DEFAULT_OBJECTIVE;
  const guardL = (arg(argv, '--guard') ?? DEFAULT_GUARD.join(',')).split(',').filter(Boolean);
  const objective_ = (s: Summary[]) => objective(s, objW);
  const startsArg = arg(argv, '--starts');
  const starts: StartSpec[] = startsArg ? parseStarts(startsArg) : [{ mode: (arg(argv, '--start-mode', 'bar') as CliArgs['startMode']), errBeats: Number(arg(argv, '--start-error-beats', '0')) }];
  const labels = starts.map(startLabel);
  const t0 = performance.now();
  const takes = loadTakes(split, starts, argv.includes('--key'));
  process.stderr.write(`${split}: ${takes.length} takes loaded, starts ${labels.join(',')} (${((performance.now() - t0) / 1000).toFixed(1)} s)\n`);
  const startCfg = resolveHumConfig(ov);
  const start = evaluate(takes, startCfg);
  let cur = start;
  let curJ = objective_(cur);
  process.stderr.write(`start ${humConfigHash(startCfg)} J ${curJ.toFixed(4)}\n  ${fmtSummary(start, labels)}\n`);
  const history: { param: string; value: Val; J: number; guard: boolean; summary: Summary[] }[] = [];

  const tryCfg = (cand: Record<string, Record<string, Val>>, label: string, value: Val) => {
    const s = evaluate(takes, resolveHumConfig(cand));
    const J = objective_(s);
    const g = guardOk(s, start, guardL);
    history.push({ param: label, value, J, guard: g, summary: s });
    process.stderr.write(`  ${label}=${JSON.stringify(value)} J ${J.toFixed(4)}${g ? '' : ' (guard)'}\n`);
    return { s, J, g };
  };

  if (mode === 'cd') {
    for (let r = 0; r < rounds; r++) {
      let changed = false;
      for (const p of params) {
        const curV = getPath(resolveHumConfig(ov), p);
        let best: { v: Val; s: Summary[]; J: number } | null = null;
        for (const v of SPACE[p]) {
          if (v === curV) continue;
          const res = tryCfg(setPath(ov, p, v), p, v);
          if (res.g && res.J > curJ + 1e-6 && (!best || res.J > best.J)) best = { v, s: res.s, J: res.J };
        }
        if (best) {
          ov = setPath(ov, p, best.v);
          cur = best.s;
          curJ = best.J;
          changed = true;
          process.stderr.write(`round ${r + 1}: ${p} ${JSON.stringify(curV)} -> ${JSON.stringify(best.v)}, J ${curJ.toFixed(4)}\n  ${fmtSummary(cur, labels)}\n`);
        }
      }
      if (!changed) break;
    }
  } else if (mode === 'grid') {
    let all = [ov];
    for (const p of params) all = all.flatMap((o) => SPACE[p].map((v) => setPath(o, p, v)));
    for (const c of all) {
      const res = tryCfg(c, params.map((p) => `${p}=${JSON.stringify(getPath(resolveHumConfig(c), p))}`).join(','), '');
      if (res.g && res.J > curJ + 1e-6) {
        ov = c;
        cur = res.s;
        curJ = res.J;
      }
    }
  } else if (mode !== 'eval') throw new Error(`unknown --search ${mode}`);

  const endCfg = resolveHumConfig(ov);
  const withF0 = { start: evaluate(takes, startCfg, true), end: evaluate(takes, endCfg, true) };
  process.stderr.write(`end ${humConfigHash(endCfg)} J ${curJ.toFixed(4)} changed ${JSON.stringify(humConfigSummary(endCfg))}\n  ${fmtSummary(withF0.end, labels)}\n`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      { split, mode, params, starts: labels, key: argv.includes('--key'), start: { hash: humConfigHash(startCfg), summary: withF0.start }, end: { hash: humConfigHash(endCfg), overrides: ov, changed: humConfigSummary(endCfg), J: curJ, summary: withF0.end }, history },
      null,
      1,
    ) + '\n',
    'utf8',
  );
  process.stderr.write(`wrote ${outPath} (${((performance.now() - t0) / 1000).toFixed(0)} s)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));

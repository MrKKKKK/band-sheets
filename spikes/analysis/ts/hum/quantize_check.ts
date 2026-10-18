/**
 * Spike 4 T6: feeds the SUNG-time truth notes (melody.notes) of the synthetic humming variants through quantize()
 * and compares with the SCORE-time truth (melody.quantized); also checks the melodyRoundTrip of every result.
 * Tuning + dev variants only: held-out variants are never opened (filtered on the manifest before any read).
 *
 *   npx tsx ts/hum/quantize_check.ts [--out out/hum] [--triplet] [--split tuning|dev] [--json]
 *
 * Synthetic only; prints numbers and error-type counts, never a note sequence.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HUM_CONFIG, type HumConfig } from './config';
import { beatGrid, quantizeDetailed, type QuantizeOptions } from './quantize';
import { melodyRoundTrip } from './toMelody';
import type { HumInfo, QuantizedEvent, QuantizedMelody } from './types';

export interface ManifestVariant {
  name: string;
  level: string;
  split: string;
  heldOut: boolean;
  truth: string;
}

/** Non-held-out variants of the manifest (split tuning/dev and heldOut false). */
export function devVariants(outDir: string): ManifestVariant[] {
  const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as { variants: ManifestVariant[] };
  return m.variants.filter((v) => v.heldOut === false && (v.split === 'tuning' || v.split === 'dev'));
}

interface TruthFile {
  melody: { notes: { start: number; end: number; midi: number }[]; quantized: QuantizedMelody };
  hum: { info: HumInfo; variant: { heldOut: boolean } };
}

export type ErrorType = 'onsetFar' | 'onset' | 'nextOnset' | 'end' | 'legatoForRest' | 'restForLegato' | 'merged' | 'pitch';

export interface VariantResult {
  name: string;
  level: string;
  split: string;
  exact: boolean;
  /** Truth notes whose (startTick, ticks, midi) is reproduced. */
  notesOk: number;
  notes: number;
  /** Truth notes hit within [chosen, ...gridCandidates]. */
  notesTop: number;
  errors: Record<ErrorType, number>;
  biasErrMs: number;
  roundTripOk: boolean;
  roundTripProblem?: string;
  tripletBeats: number;
}

const notesOf = (ev: QuantizedEvent[]) => ev.filter((e) => e.kind === 'note');

export function checkVariant(outDir: string, v: ManifestVariant, grid: HumConfig['grid'], opts: Partial<QuantizeOptions> = {}): VariantResult {
  if (v.heldOut) throw new Error('held-out variant refused');
  const t = JSON.parse(readFileSync(join(outDir, v.truth), 'utf8')) as TruthFile & { hum: { synth?: { onsetBiasSec?: number } } };
  if (t.hum.variant.heldOut) throw new Error('held-out truth refused');
  // only the seconds-domain fields go in (the truth notes also carry score ticks: never passed on)
  const input = t.melody.notes.map((n) => ({ start: n.start, end: n.end, midi: n.midi }));
  const rep = quantizeDetailed(input, t.hum.info, grid, opts);
  const q = rep.melody;
  const truthQ = t.melody.quantized;
  const tn = notesOf(truthQ.events);
  const on = notesOf(q.events);
  const bySrc = new Map(on.map((n) => [n.src, n]));
  const errors: Record<ErrorType, number> = { onsetFar: 0, onset: 0, nextOnset: 0, end: 0, legatoForRest: 0, restForLegato: 0, merged: 0, pitch: 0 };
  let ok = 0;
  let top = 0;
  const { tickSec, stepTicks } = beatGrid(t.hum.info, grid);
  const truthNextStart = (i: number) => (i + 1 < tn.length ? tn[i + 1].startTick : Infinity);
  tn.forEach((x, i) => {
    const o = bySrc.get(x.src);
    if (!o) {
      errors.merged++;
      return;
    }
    const good = o.startTick === x.startTick && o.ticks === x.ticks && o.midi === x.midi;
    if (good) ok++;
    if ([{ startTick: o.startTick, ticks: o.ticks }, ...o.gridCandidates].some((c) => c.startTick === x.startTick && c.ticks === x.ticks)) top++;
    if (good) return;
    if (o.midi !== x.midi) errors.pitch++;
    if (o.startTick !== x.startTick) {
      // beyond half a step from the truth slot after the bias removal: nearest rounding cannot get it
      const n = input[x.src];
      const u = (n.start - q.onsetBiasSec - q.startSec) / tickSec;
      if (Math.abs(u - x.startTick) > stepTicks / 2) errors.onsetFar++;
      else errors.onset++;
    }
    else if (o.ticks !== x.ticks) {
      const tLegato = x.startTick + x.ticks === truthNextStart(i);
      const oNext = on.find((n) => n.startTick > o.startTick);
      const oLegato = oNext !== undefined && o.startTick + o.ticks === oNext.startTick;
      if (tLegato && !oLegato) errors.restForLegato++;
      else if (!tLegato && oLegato) errors.legatoForRest++;
      else if (tLegato && oLegato) errors.nextOnset++;
      else errors.end++;
    }
  });
  const sameEvents =
    q.events.length === truthQ.events.length &&
    q.events.every((e, i) => {
      const x = truthQ.events[i];
      return e.kind === x.kind && e.startTick === x.startTick && e.ticks === x.ticks && (e.kind !== 'note' || (x.kind === 'note' && e.midi === x.midi));
    });
  const rt = melodyRoundTrip(q);
  return {
    name: v.name,
    level: v.level,
    split: v.split,
    exact: sameEvents,
    notesOk: ok,
    notes: tn.length,
    notesTop: top,
    errors,
    biasErrMs: Math.round((q.onsetBiasSec - (t.hum.synth?.onsetBiasSec ?? 0)) * 1e4) / 10,
    roundTripOk: rt.parsed && rt.identical,
    roundTripProblem: rt.problem,
    tripletBeats: rep.tripletBeats,
  };
}

export interface LevelRow {
  level: string;
  variants: number;
  exact: number;
  noteAcc: number;
  noteTop2: number;
  errors: Record<ErrorType, number>;
  biasMaeMs: number;
  roundTripOk: number;
}

export function summarize(rs: VariantResult[]): LevelRow[] {
  const levels = [...new Set(rs.map((r) => r.level))].sort();
  return levels.map((level) => {
    const xs = rs.filter((r) => r.level === level);
    const errors: Record<ErrorType, number> = { onsetFar: 0, onset: 0, nextOnset: 0, end: 0, legatoForRest: 0, restForLegato: 0, merged: 0, pitch: 0 };
    for (const r of xs) for (const k of Object.keys(errors) as ErrorType[]) errors[k] += r.errors[k];
    const notes = xs.reduce((s, r) => s + r.notes, 0);
    return {
      level,
      variants: xs.length,
      exact: xs.filter((r) => r.exact).length,
      noteAcc: Math.round((xs.reduce((s, r) => s + r.notesOk, 0) / notes) * 1000) / 1000,
      noteTop2: Math.round((xs.reduce((s, r) => s + r.notesTop, 0) / notes) * 1000) / 1000,
      errors,
      biasMaeMs: Math.round((xs.reduce((s, r) => s + Math.abs(r.biasErrMs), 0) / xs.length) * 10) / 10,
      roundTripOk: xs.filter((r) => r.roundTripOk).length,
    };
  });
}

function main(argv: string[]) {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outDir = arg('--out') ?? 'out/hum';
  const split = arg('--split');
  const grid = { ...DEFAULT_HUM_CONFIG.grid, triplet: argv.includes('--triplet') };
  const opts: Partial<QuantizeOptions> = {};
  if (argv.includes('--no-bias')) grid.onsetBias = false;
  const ef = arg('--extend');
  if (ef !== undefined) opts.endExtendFraction = Number(ef);
  const bm = arg('--bias');
  if (bm !== undefined) opts.biasMethod = bm as 'local' | 'trunc';
  const vs = devVariants(outDir).filter((v) => !split || v.split === split);
  const rs = vs.map((v) => checkVariant(outDir, v, grid, opts));
  const rows = summarize(rs);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 1));
    return;
  }
  console.log('level variants exact  noteAcc top2   biasMAE(ms) roundTrip  errors(onsetFar/onset/nextOnset/end/legatoForRest/restForLegato/merged/pitch)');
  for (const r of rows)
    console.log(
      `${r.level}    ${String(r.variants).padStart(3)}   ${String(r.exact).padStart(3)}   ${r.noteAcc.toFixed(3)}   ${r.noteTop2.toFixed(3)}  ${r.biasMaeMs.toFixed(1).padStart(6)}      ${r.roundTripOk}/${r.variants}      ${Object.values(r.errors).join('/')}`,
    );
  const bad = rs.filter((r) => !r.roundTripOk);
  if (argv.includes('--per-variant')) for (const r of rs) console.log(r.name, r.exact ? 'exact' : '', `${r.notesOk}/${r.notes}`, `bias ${r.biasErrMs}ms`, Object.values(r.errors).join('/'));
  if (bad.length) console.log(`round-trip failures: ${bad.map((r) => `${r.name}: ${r.roundTripProblem}`).join(', ')}`);
  const trip = rs.reduce((s, r) => s + r.tripletBeats, 0);
  if (grid.triplet) console.log(`triplet beats chosen (all false positives): ${trip}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));

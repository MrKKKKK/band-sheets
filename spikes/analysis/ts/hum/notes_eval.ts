/**
 * Spike 4 T5: note segmentation evaluation on the synthetic humming (render/hum output in out/hum). Tuning + dev
 * variants ONLY: a variant with `heldOut: true` (or split 'heldOut') is never read; asking for one exits with an error.
 *
 *   npx tsx ts/hum/notes_eval.ts [--split tuning,dev] [--inputs yin,truth] [--set segment.dipDb=5 ...] [--only <name>...]
 *                                [--json out/hum/notes-eval.json]
 *
 * Inputs: 'yin' = the T4 f0 (estimateF0, default config), 'truth' = the frame f0 truth (hum.f0); both use the level
 * envelope notes.ts frameLevelDb(audio, YIN track). The estimate is scored against melody.notes (sung times) with the
 * absolute sung pitch midi + (cents + tuningCents) / 100 (the truth's cents include the tuning offset too).
 * Error types (onset matching with pitch ignored, +-50 ms, 1:1):
 *   pitch: matched onsets whose rounded pitch (midi + tuning) is off by 12 / 1 / other semitones vs truth midi
 *   missedRepeat: truth note not onset-matched whose previous truth note has the same midi and touches it (< 80 ms gap)
 *   missedOther: other truth notes not onset-matched (onset > 50 ms off, merged across a pitch change, dropped)
 *   extraVibrato / extraGlide / extraOther: estimated notes not onset-matched whose onset lies inside a truth note:
 *     within 150 ms after its onset (glide / scoop), in a note >= 0.45 s long at H1+ (vibrato), else other
 *   extraOutside: estimated notes not onset-matched outside every truth note (breath, reverb tail, click)
 * 'tuning err' = |estimated tuning - the same estimator on the truth notes' sung pitches| (tuning + drift + offsets).
 * Prints Markdown tables (numbers and variant names only).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../browser/wav';
import { toMono } from '../dsp/core/resample';
import { resolveHumConfig } from './config';
import { estimateF0 } from './f0';
import { estimateTuning, extractNotes, frameLevelDb } from './notes';
import { matchNotes, noteScores, type ScoreNote } from './score';
import type { FrameF0Track, HumInfo, HumNote } from './types';

interface ManifestVariant {
  name: string;
  level: string;
  split: string;
  heldOut: boolean;
  wav: string;
  truth: string;
  audioSec: number;
}

const OUT = join(import.meta.dirname, '..', '..', 'out', 'hum');

function arg(name: string): string[] {
  const out: string[] = [];
  const a = process.argv;
  for (let i = 2; i < a.length; i++) if (a[i] === name && i + 1 < a.length) out.push(a[++i]);
  return out;
}
function setPath(o: Record<string, unknown>, path: string, value: unknown) {
  const ks = path.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[ks[ks.length - 1]] = value;
}

const splits = (arg('--split')[0] ?? 'tuning,dev').split(',');
if (splits.includes('heldOut')) {
  console.error('notes_eval: held-out variants are never evaluated here');
  process.exit(2);
}
const inputs = (arg('--inputs')[0] ?? 'yin,truth').split(',') as ('yin' | 'truth')[];
const overrides: Record<string, unknown> = {};
for (const s of arg('--set')) {
  const [k, v] = s.split('=');
  setPath(overrides, k, JSON.parse(v));
}
const cfg = resolveHumConfig(overrides);
const only = arg('--only');
const jsonOut = arg('--json')[0];
const verbose = process.argv.includes('--verbose');

const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: ManifestVariant[] };
for (const name of only) {
  const v = manifest.variants.find((x) => x.name === name);
  if (!v) throw new Error(`unknown variant ${name}`);
  if (v.heldOut || v.split === 'heldOut') {
    console.error(`notes_eval: ${name} is held out; refusing`);
    process.exit(2);
  }
}
const variants = manifest.variants.filter((v) => !v.heldOut && v.split !== 'heldOut' && splits.includes(v.split) && (only.length === 0 || only.includes(v.name)));

const ERR_KEYS = ['octave', 'pitch1', 'pitchOther', 'missedRepeat', 'missedOther', 'extraVibrato', 'extraGlide', 'extraOther', 'extraOutside'] as const;
type ErrKey = (typeof ERR_KEYS)[number];

interface Row {
  name: string;
  level: string;
  split: string;
  input: string;
  nRef: number;
  nEst: number;
  fOnset: number;
  fOnsetOffset: number;
  errors: Record<ErrKey, number>;
  onsetBiasMs: number;
  tuningCents: number;
  truthTuning: number;
  ms: number;
}

interface TruthNote extends ScoreNote {
  cents: number;
}

function errorTypes(truth: TruthNote[], est: HumNote[], tuning: number, level: string): { e: Record<ErrKey, number>; bias: number[] } {
  const e = Object.fromEntries(ERR_KEYS.map((k) => [k, 0])) as Record<ErrKey, number>;
  const estAbs: ScoreNote[] = est.map((n) => ({ start: n.start, end: n.end, midi: n.midi, cents: n.cents + tuning }));
  const pairs = matchNotes(truth, estAbs, { offsetRatio: null, pitchMode: 'any' });
  const mT = new Set(pairs.map((p) => p[0]));
  const mE = new Set(pairs.map((p) => p[1]));
  const bias: number[] = [];
  for (const [i, j] of pairs) {
    bias.push(est[j].start - truth[i].start);
    const estMidi = Math.round(est[j].midi + (est[j].cents + tuning) / 100);
    const d = Math.abs(estMidi - truth[i].midi);
    const sungDiff = Math.abs(est[j].midi + (est[j].cents + tuning) / 100 - (truth[i].midi + truth[i].cents / 100));
    if (sungDiff <= 0.5) continue;
    if (d % 12 === 0 && d > 0) e.octave++;
    else if (d === 1 || d === 0) e.pitch1++;
    else e.pitchOther++;
  }
  truth.forEach((t, i) => {
    if (mT.has(i)) return;
    const pv = truth[i - 1];
    if (pv && pv.midi === t.midi && t.start - pv.end < 0.08) e.missedRepeat++;
    else e.missedOther++;
  });
  est.forEach((n, j) => {
    if (mE.has(j)) return;
    const host = truth.find((t) => n.start > t.start + 0.05 && n.start < t.end - 0.05);
    if (!host) e.extraOutside++;
    else if (n.start - host.start <= 0.15) e.extraGlide++;
    else if (host.end - host.start >= 0.45 && level !== 'H0') e.extraVibrato++;
    else e.extraOther++;
  });
  return { e, bias };
}

const rows: Row[] = [];
for (const v of variants) {
  const wav = decodeWav(new Uint8Array(readFileSync(join(OUT, v.wav))));
  const y = toMono(wav.channels);
  const truth = JSON.parse(readFileSync(join(OUT, v.truth), 'utf8')) as {
    melody: { notes: TruthNote[] };
    hum: { f0: FrameF0Track; info: HumInfo };
  };
  const f0 = estimateF0(y, wav.sampleRate, cfg);
  const ref = truth.melody.notes;
  // One level envelope per variant (window sized by the YIN f0), shared by both inputs.
  const level = frameLevelDb(y, wav.sampleRate, f0.track);
  for (const input of inputs) {
    const track = input === 'yin' ? f0.track : truth.hum.f0;
    const levelDb = level.slice(0, track.hz.length);
    while (levelDb.length < track.hz.length) levelDb.push(-100);
    const t0 = performance.now();
    const res = extractNotes(track, levelDb, truth.hum.info, cfg);
    const ms = performance.now() - t0;
    const estAbs: ScoreNote[] = res.notes.map((n) => ({ start: n.start, end: n.end, midi: n.midi, cents: n.cents + res.tuningCents }));
    const { e, bias } = errorTypes(ref, res.notes, res.tuningCents, v.level);
    bias.sort((a, b) => a - b);
    rows.push({
      name: v.name,
      level: v.level,
      split: v.split,
      input,
      nRef: ref.length,
      nEst: res.notes.length,
      fOnset: noteScores(ref, estAbs, { offsetRatio: null }).f,
      fOnsetOffset: noteScores(ref, estAbs).f,
      errors: e,
      onsetBiasMs: bias.length ? 1000 * bias[bias.length >> 1] : NaN,
      tuningCents: res.tuningCents,
      truthTuning: estimateTuning(ref.map((n) => n.midi + n.cents / 100), ref.map((n) => n.end - n.start)),
      ms,
    });
  }
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const lines: string[] = [`overrides: ${JSON.stringify(overrides)}`, ''];
lines.push('| level | split | input | n | notes | F onset | min | F on+off | min | onset bias ms | tuning err c |');
lines.push('|' + ' --- |'.repeat(11));
const levels = [...new Set(rows.map((r) => r.level))].sort();
for (const lv of levels)
  for (const sp of splits)
    for (const inp of inputs) {
      const g = rows.filter((r) => r.level === lv && r.split === sp && r.input === inp);
      if (!g.length) continue;
      lines.push(
        `| ${lv} | ${sp} | ${inp} | ${g.length} | ${sum(g.map((r) => r.nRef))} | ${f3(mean(g.map((r) => r.fOnset)))} | ${f3(Math.min(...g.map((r) => r.fOnset)))} | ${f3(mean(g.map((r) => r.fOnsetOffset)))} | ${f3(Math.min(...g.map((r) => r.fOnsetOffset)))} | ${mean(g.map((r) => r.onsetBiasMs)).toFixed(1)} | ${mean(g.map((r) => Math.abs(r.tuningCents - r.truthTuning))).toFixed(1)} |`,
      );
    }
lines.push('', 'error types (counts summed over variants; tuning + dev):', '');
lines.push('| level | input | truth notes | ' + ERR_KEYS.join(' | ') + ' |');
lines.push('|' + ' --- |'.repeat(3 + ERR_KEYS.length));
for (const lv of levels)
  for (const inp of inputs) {
    const g = rows.filter((r) => r.level === lv && r.input === inp);
    if (!g.length) continue;
    lines.push(`| ${lv} | ${inp} | ${sum(g.map((r) => r.nRef))} | ` + ERR_KEYS.map((k) => sum(g.map((r) => r.errors[k]))).join(' | ') + ' |');
  }
if (verbose) {
  lines.push('', '| variant | input | F onset | F on+off | ' + ERR_KEYS.join(' | ') + ' |', '|' + ' --- |'.repeat(4 + ERR_KEYS.length));
  for (const r of rows) lines.push(`| ${r.name} | ${r.input} | ${f3(r.fOnset)} | ${f3(r.fOnsetOffset)} | ` + ERR_KEYS.map((k) => r.errors[k]).join(' | ') + ' |');
}
lines.push('', `segmentation time: ${mean(rows.map((r) => r.ms)).toFixed(1)} ms per variant (mean)`);
console.log(lines.join('\n'));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ overrides, rows }, null, 1));

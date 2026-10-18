/**
 * Spike 4 T4: f0 evaluation on the synthetic humming (render/hum output in out/hum). Tuning + dev variants ONLY:
 * a variant with `heldOut: true` (or split 'heldOut') is never read; asking for one by name exits with an error.
 *
 *   npx tsx ts/hum/f0_eval.ts [--modes yin,pyin] [--split tuning,dev] [--set f0.maxJumpSemitones=5 ...] [--only <name>...] [--octave-check off]
 *                             [--json out/hum/f0-eval.json]
 *
 * Per variant and mode: the frame f0 scores (ts/hum/score.ts f0TrackScores: RPA, RCA, voicing recall / false
 * alarm, octave error rate = RCA - RPA) and the speed (ms of the f0 stage, resampling included, per audio second).
 * With librosa references (py/tools/pyin_ref.py -> out/hum/pyin-ref/<name>.json, dev only) also the agreement:
 * the share of frames voiced in both whose pitch is within +-50 cents, the voicing agreement, and librosa's own
 * scores against the truth. Prints Markdown tables (numbers and variant names only).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../browser/wav';
import { toMono } from '../dsp/core/resample';
import { resolveHumConfig } from './config';
import { DEFAULT_OCTAVE_CHECK, estimateF0, NO_OCTAVE_CHECK } from './f0';
import { f0Scores, f0TrackScores, trackTimes, type F0Scores } from './score';
import type { FrameF0Track } from './types';

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

const modes = (arg('--modes')[0] ?? 'yin,pyin').split(',') as ('yin' | 'pyin')[];
const splits = (arg('--split')[0] ?? 'tuning,dev').split(',');
if (splits.includes('heldOut')) {
  console.error('f0_eval: held-out variants are never evaluated here');
  process.exit(2);
}
const overrides: Record<string, unknown> = {};
for (const s of arg('--set')) {
  const [k, v] = s.split('=');
  setPath(overrides, k, JSON.parse(v));
}
const only = arg('--only');
const jsonOut = arg('--json')[0];
const oc = arg('--octave-check')[0] === 'off' ? NO_OCTAVE_CHECK : DEFAULT_OCTAVE_CHECK;

const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: ManifestVariant[] };
for (const name of only) {
  const v = manifest.variants.find((x) => x.name === name);
  if (!v) throw new Error(`unknown variant ${name}`);
  if (v.heldOut || v.split === 'heldOut') {
    console.error(`f0_eval: ${name} is held out; refusing`);
    process.exit(2);
  }
}
const variants = manifest.variants.filter((v) => !v.heldOut && v.split !== 'heldOut' && splits.includes(v.split) && (only.length === 0 || only.includes(v.name)));

interface Row {
  name: string;
  level: string;
  split: string;
  mode: string;
  scores: F0Scores;
  msPerSec: number;
  agree?: { pitch50: number; voicing: number; frames: number };
}
interface RefRow {
  name: string;
  level: string;
  split: string;
  scores: F0Scores;
}

/** Agreement with a reference track (same grid): pitch within 50 cents on frames voiced in both; voicing equality. */
function agreement(a: FrameF0Track, ref: { hz: number[]; voiced: number[] }) {
  const n = Math.min(a.hz.length, ref.hz.length);
  let both = 0;
  let ok = 0;
  let same = 0;
  for (let i = 0; i < n; i++) {
    const va = a.voiced[i] >= 0.5 && a.hz[i] > 0;
    const vr = ref.voiced[i] >= 0.5 && ref.hz[i] > 0;
    if (va === vr) same++;
    if (va && vr) {
      both++;
      if (Math.abs(1200 * Math.log2(a.hz[i] / ref.hz[i])) <= 50) ok++;
    }
  }
  return { pitch50: both ? ok / both : NaN, voicing: n ? same / n : NaN, frames: both };
}

const rows: Row[] = [];
const refRows: RefRow[] = [];
const cfgs = Object.fromEntries(modes.map((m) => [m, resolveHumConfig({ ...overrides, f0: { ...((overrides.f0 as object) ?? {}), pyin: m === 'pyin' } })]));
for (const v of variants) {
  const wav = decodeWav(new Uint8Array(readFileSync(join(OUT, v.wav))));
  const y = toMono(wav.channels);
  const truth = JSON.parse(readFileSync(join(OUT, v.truth), 'utf8')) as { hum: { f0: FrameF0Track } };
  const refPath = join(OUT, 'pyin-ref', `${v.name}.json`);
  const ref = existsSync(refPath) ? (JSON.parse(readFileSync(refPath, 'utf8')) as { hopSec: number; hz: number[]; voiced: number[] }) : null;
  if (ref) {
    const signed = ref.hz.map((f, i) => (f > 0 ? (ref.voiced[i] >= 0.5 ? f : -f) : 0));
    const rt = trackTimes({ t0: 0, hopSec: ref.hopSec, hz: ref.hz });
    refRows.push({ name: v.name, level: v.level, split: v.split, scores: f0Scores(trackTimes(truth.hum.f0), truth.hum.f0.hz, rt, signed) });
  }
  for (const m of modes) {
    const r = estimateF0(y, wav.sampleRate, cfgs[m], oc);
    rows.push({
      name: v.name,
      level: v.level,
      split: v.split,
      mode: m,
      scores: f0TrackScores(truth.hum.f0, r.track),
      msPerSec: r.ms / v.audioSec,
      agree: ref ? agreement(r.track, ref) : undefined,
    });
  }
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const keys: [string, keyof F0Scores][] = [
  ['RPA', 'rawPitchAccuracy'],
  ['RCA', 'rawChromaAccuracy'],
  ['vRecall', 'voicingRecall'],
  ['vFA', 'voicingFalseAlarm'],
  ['octErr', 'octaveErrorRate'],
];
const lines: string[] = [];
lines.push(`overrides: ${JSON.stringify(overrides)}, octave check: ${JSON.stringify(oc)}`, '');
lines.push('| level | split | mode | n | ' + keys.map((k) => k[0]).join(' | ') + ' | min RPA | ms/s |');
lines.push('|' + ' --- |'.repeat(keys.length + 6));
const levels = [...new Set(rows.map((r) => r.level))].sort();
for (const lv of levels)
  for (const sp of splits)
    for (const m of modes) {
      const g = rows.filter((r) => r.level === lv && r.split === sp && r.mode === m);
      if (!g.length) continue;
      lines.push(`| ${lv} | ${sp} | ${m} | ${g.length} | ` + keys.map(([, k]) => f3(mean(g.map((r) => r.scores[k])))).join(' | ') + ` | ${f3(Math.min(...g.map((r) => r.scores.rawPitchAccuracy)))} | ${mean(g.map((r) => r.msPerSec)).toFixed(1)} |`);
    }
if (refRows.length) {
  lines.push('', 'librosa pyin agreement (frames voiced in both, pitch within +-50 cents; voicing = same decision):', '');
  lines.push('| level | n | ' + modes.map((m) => `${m} pitch50 | ${m} voicing`).join(' | ') + ' | librosa RPA | librosa vRecall | librosa vFA | librosa octErr |');
  lines.push('|' + ' --- |'.repeat(2 + 2 * modes.length + 4));
  for (const lv of levels) {
    const rr = refRows.filter((r) => r.level === lv);
    if (!rr.length) continue;
    const cells = modes.map((m) => {
      const g = rows.filter((r) => r.level === lv && r.mode === m && r.agree);
      return `${f3(mean(g.map((r) => r.agree!.pitch50)))} | ${f3(mean(g.map((r) => r.agree!.voicing)))}`;
    });
    const s = (k: keyof F0Scores) => f3(mean(rr.map((r) => r.scores[k])));
    lines.push(`| ${lv} | ${rr.length} | ${cells.join(' | ')} | ${s('rawPitchAccuracy')} | ${s('voicingRecall')} | ${s('voicingFalseAlarm')} | ${s('octaveErrorRate')} |`);
  }
}
console.log(lines.join('\n'));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ overrides, octaveCheck: oc, rows, refRows }, null, 1));

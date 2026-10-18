/**
 * Spike 4 look point 3 (T11): the held-out evaluation, run ONCE with the frozen config hum-v3.
 *
 *   npx tsx ts/hum/heldout_eval.ts --final-heldout     the final run (refuses if a look-3 line already exists in the log)
 *   npx tsx ts/hum/heldout_eval.ts --selftest          same pipeline on the DEV synthetic variants + DEV recordings; no log line
 *   npx tsx ts/hum/heldout_eval.ts --rescore-m1 --final-heldout
 *        T15, once: re-score the SYNTHETIC held-out variants under the M1 definition (note F pitch = written note) with the
 *        frozen config. Refuses unless: config hash frozen, clean tree, the hum look-3 line exists, no hum rescore line
 *        yet. Never touches recordings. Aggregates per level to stdout and one appended log line (kind rescore-m1).
 *
 * Mirrors ts/hum/calibrate_eval.ts: recordings run through analyzeHum with firstNoteSec + firstNoteTick from the truth
 * info only, transposeInvariant scoring, "grid" time base (truth placed on the analyzer's quantized.startSec) and the
 * literal "given" start; synthetic takes get the bar head and the first-note -0.7 beat start (with its tick), averaged.
 * Output (aggregates, per-style error counts, shift classes) goes to out/hum/t11/ (gitignored) and one line to
 * out/results/heldout-log.jsonl. Notes, pitches, the transposition value never reach stdout / the log.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../browser/wav';
import { toMono } from '../dsp/core/resample';
import { analyzeHum } from './analyze';
import { firstNoteTickFromTruthInfo } from './cli';
import { aggregateByLevel, synScore, type SynVariant } from './syn_score';
import { RESCORE_KIND, heldOutRunBlock, parseHeldOutMode } from './heldout_log';
import { humConfigHash, resolveHumConfig, type HumConfig } from './config';
import { recScore, type RecTruth } from './rec_score';
import type { Scores } from './report';
import type { HumInput } from './types';

const SA = join(import.meta.dirname, '..', '..');
const HUM = join(SA, 'out', 'hum');
const OUTDIR = join(HUM, 't11');
const LOG = join(SA, 'out', 'results', 'heldout-log.jsonl');
const FROZEN = 'f7a35fb44ae5';
const METRICS = ['noteF.onset', 'noteF.onsetOffset', 'noteF.onsetPitchClass', 'noteF.onsetSemitone', 'noteF.onset100ms', 'quant.exactAcc', 'edit.perNote', 'edit.ratioToKeyboard', 'pitchCand.k2', 'gridCand.k2'];
const ERR = ['nTruth', 'nEst', 'seg.extraSplit', 'seg.missedSplit', 'seg.missedSplit.samePitch', 'seg.missed', 'seg.spurious', 'pitch.matched', 'pitch.ok', 'pitch.semitone', 'pitch.octave', 'pitch.other', 'quant.pairs', 'quant.onsetSlot', 'quant.duration', 'quant.restVsLegato.filledRest', 'quant.restVsLegato.cutLegato'];
const SHIFT_NAME = ['0', 'octave', 'other'];

const mean = (rows: Scores[], k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length;
const sum = (rows: Scores[], k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const r3 = (x: number) => +x.toFixed(3);
const agg = (rows: Scores[]) => Object.fromEntries(METRICS.map((k) => [k, r3(mean(rows, k))]));

function gitOut(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: SA, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ recordings */
interface RecVariant { name: string; heldOut: boolean; style: string; song: string; truth: string; wav: string; bpm: number; ts: [number, number] }
/** T15: the one-time synthetic re-score (see the file header). Synthetic only; dev synthetic runs alongside as the reference. */
function rescoreM1(cfg: HumConfig, hash: string): void {
  const block = heldOutRunBlock({ run: 'rescore-m1', configHash: hash, frozenHash: FROZEN, logText: existsSync(LOG) ? readFileSync(LOG, 'utf8') : null, porcelain: gitOut(['status', '--porcelain']) });
  if (block) throw new Error(block);
  const commit = gitOut(['rev-parse', 'HEAD']);
  const man = JSON.parse(readFileSync(join(HUM, 'manifest.json'), 'utf8')) as { variants: SynVariant[] };
  const KEYS = [...METRICS, 'noteF_sungPitch.onset', 'edit.appOps.ratioToKeyboard'];
  const run = (sel: SynVariant[]) => aggregateByLevel(sel, cfg, KEYS);
  const held = man.variants.filter((v) => v.heldOut && v.split === 'heldOut');
  const dev = man.variants.filter((v) => v.split === 'dev' && !v.heldOut);
  const heldRes = run(held);
  const devRes = run(dev);
  const line = {
    time: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    kind: RESCORE_KIND,
    input: 'hum',
    lookPoint: 3,
    variants: held.map((v) => v.name),
    commit,
    dirty: false,
    diffHash: null,
    configHash: hash,
    dspName: 'hum-v3',
    dspConfig: null,
    includeHeldOut: true,
    metrics: { synthetic: heldRes, syntheticDevReference: devRes },
    note: 'T15 one-time re-score of the SYNTHETIC held-out variants under the M1 definition (note F pitch = written note; noteF_sungPitch.onset is the old definition), frozen hum-v3, driver ts/hum/heldout_eval.ts --rescore-m1 --final-heldout. Recordings not run. Mean of bar-head start and first-note -0.7 beat start per level; aggregates only.',
  };
  for (const [name, res] of [['heldOut', heldRes], ['dev', devRes]] as const) for (const [L, m] of Object.entries(res)) process.stdout.write(`rescore-m1 ${name} ${L}: ${JSON.stringify(m)}\n`);
  appendFileSync(LOG, JSON.stringify(line) + '\n');
  process.stdout.write('log line written\n');
}

function main() {
  const mode = parseHeldOutMode(process.argv);
  const final = mode === 'final-heldout';
  const cfg = resolveHumConfig();
  const hash = humConfigHash(cfg);
  if (hash !== FROZEN) throw new Error(`not the frozen hum-v3 config: ${hash}`);
  if (mode === 'rescore-m1') return rescoreM1(cfg, hash);
  const commit = gitOut(['rev-parse', 'HEAD']);
  if (final) {
    const block = heldOutRunBlock({ run: 'final-heldout', configHash: hash, frozenHash: FROZEN, logText: existsSync(LOG) ? readFileSync(LOG, 'utf8') : null, porcelain: gitOut(['status', '--porcelain']) });
    if (block) throw new Error(block);
  }
  const heldOut = final;
  const outDir = final ? OUTDIR : join(OUTDIR, 'selftest');
  mkdirSync(join(outDir, 'rec'), { recursive: true });

  // 1. synthetic
  const man = JSON.parse(readFileSync(join(HUM, 'manifest.json'), 'utf8')) as { variants: SynVariant[] };
  const sel = man.variants.filter((v) => (heldOut ? v.heldOut && v.split === 'heldOut' : v.split === 'dev' && !v.heldOut));
  const levels = [...new Set(sel.map((v) => v.level))].sort();
  const syn: Record<string, unknown> = {};
  const synIds: string[] = [];
  for (const L of levels) {
    const vs = sel.filter((v) => v.level === L);
    const rs = vs.map((v) => synScore(v, cfg));
    synIds.push(...vs.map((v) => v.name));
    syn[L] = { n: vs.length, mean: agg(rs.map((r) => r.both)), bar: agg(rs.map((r) => r.bar)), firstNote: agg(rs.map((r) => r.first)) };
    const m = (syn[L] as { mean: Record<string, number> }).mean;
    process.stdout.write(`syn ${heldOut ? 'heldOut' : 'dev'} ${L} n=${vs.length}: F.onset ${m['noteF.onset']} quant ${m['quant.exactAcc']} edits/kbd ${m['edit.ratioToKeyboard']}\n`);
  }

  // 2. recordings
  const rman = JSON.parse(readFileSync(join(SA, 'out', 'rec', 'manifest.hum.json'), 'utf8')) as { variants: RecVariant[] };
  const wantNames = heldOut ? ['hum-02-c', 'hum-04-e'] : ['hum-01-a', 'hum-01-b', 'hum-03-d', 'hum-05-f'];
  const rows: { given: Scores; grid: Scores }[] = [];
  const perStyle: Record<string, unknown> = {};
  for (const name of wantNames) {
    const v = rman.variants.find((x) => x.name === name);
    if (!v || v.heldOut !== heldOut) throw new Error('recording flag mismatch');
    const truth = JSON.parse(readFileSync(join(SA, v.truth), 'utf8')) as RecTruth;
    if (truth.heldOut !== heldOut) throw new Error('recording truth flag mismatch');
    const info: HumInput = { bpm: v.bpm, ts: v.ts, firstNoteSec: truth.info.firstNoteSec, firstNoteTick: firstNoteTickFromTruthInfo(truth.info) };
    const wav = decodeWav(new Uint8Array(readFileSync(join(SA, v.wav))));
    const res = analyzeHum(toMono(wav.channels), wav.sampleRate, info, { commit: commit ?? undefined, sourceKind: 'recording' });
    writeFileSync(join(outDir, 'rec', `${v.name}.json`), JSON.stringify(res) + '\n');
    const notes = res.melody.notes;
    const q = res.melody.quantized;
    const row = { given: recScore(truth, notes, q, 'given'), grid: recScore(truth, notes, q, 'grid') };
    rows.push(row);
    perStyle[v.style] = Object.fromEntries((['grid', 'given'] as const).map((b) => [b, { shiftClass: SHIFT_NAME[row[b]['shift.class']], counts: Object.fromEntries(ERR.map((k) => [k, row[b][k] ?? 0])) }]));
  }
  const rec = {
    n: rows.length,
    asIs: agg(rows.map((r) => r.grid)),
    givenStartLiteral: agg(rows.map((r) => r.given)),
    countsGrid: Object.fromEntries(ERR.map((k) => [k, sum(rows.map((r) => r.grid), k)])),
    perStyle,
  };
  process.stdout.write(`rec ${heldOut ? 'heldOut' : 'dev'} n=${rec.n} asIs ${JSON.stringify(rec.asIs)}\n`);
  process.stdout.write(`rec given ${JSON.stringify(rec.givenStartLiteral)}\n`);
  process.stdout.write(`rec per style ${JSON.stringify(perStyle)}\n`);
  const result = { commit, configHash: hash, syn, rec };
  writeFileSync(join(outDir, 't11-summary.json'), JSON.stringify(result, null, 1) + '\n');

  if (final) {
    const line = {
      time: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
      kind: 'look',
      input: 'hum',
      lookPoint: 3,
      variants: [...synIds, ...wantNames],
      commit,
      dirty: false,
      diffHash: null,
      configHash: hash,
      dspName: 'hum-v3',
      dspConfig: null,
      includeHeldOut: true,
      metrics: { synthetic: Object.fromEntries(Object.entries(syn).map(([L, s]) => [L, { n: (s as { n: number }).n, ...(s as { mean: object }).mean }])), recordings: { n: rec.n, asIs: rec.asIs, givenStartLiteral: rec.givenStartLiteral } },
      note: 'T11 look point 3: held-out evaluation, run once with frozen hum-v3; driver ts/hum/heldout_eval.ts --final-heldout, results out/hum/t11. Synthetic = mean of bar-head start and first-note -0.7 beat start (with tick); recordings = firstNoteSec + firstNoteTick from truth info only, transposeInvariant, asIs = truth on the analyzer grid. Aggregate means only.',
    };
    appendFileSync(LOG, JSON.stringify(line) + '\n');
    process.stdout.write('log line written\n');
  }
}
main();

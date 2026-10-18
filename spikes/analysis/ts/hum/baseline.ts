/**
 * Spike 4 T8: synthetic baseline driver. Scores out/hum/results/<name>.json (cli.ts --all --f0-track) against the
 * synthetic truths and writes out/hum/baseline/{report.md,rows.json}. Tuning + dev only; held-out is never read.
 *
 *   npx tsx ts/hum/baseline.ts [--results out/hum/results] [--out out/hum/baseline] [--title "..."] [--transpose-invariant]
 * T9: the scoring is exported (scoreTake) for ts/hum/tune.ts; --results/--out score another result set the same way.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderReport, scoreRow, shiftFor, type ReportRow, type Scores } from './report';
import { dropShortTruth, editScript, matchNotes, notesToEvents, quantizedToEvents, unshiftNotes, unshiftQuantized, type ScoreNote, type TickNote } from './score';
import type { FrameF0Track, HumNote, QuantizedMelody } from './types';

const OUT = join(import.meta.dirname, '..', '..', 'out', 'hum');
const sung = (n: { midi: number; cents?: number }) => n.midi + (n.cents ?? 0) / 100;

export interface Variant { name: string; melody: string; level: string; seed: number; split: string; heldOut: boolean; audioSec: number; truth: string }
export interface TruthNote { start: number; end: number; midi: number; cents?: number; startTick: number; ticks: number }

/** Error-type counts for one take (all counts of truth notes unless noted). */
export function errorTypes(truth: TruthNote[], est: HumNote[], estQ: QuantizedMelody): Scores {
  const c: Scores = {};
  const add = (k: string, v = 1) => (c[k] = (c[k] ?? 0) + v);
  const T: ScoreNote[] = truth.map((n) => ({ start: n.start, end: n.end, midi: n.midi, cents: n.cents }));
  // segmentation: overlap structure
  const ov = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const minOv = 0.3; // fraction of the shorter note
  const hit = (a: { start: number; end: number }, b: { start: number; end: number }) => ov(a, b) > minOv * Math.min(a.end - a.start, b.end - b.start);
  for (const t of T) {
    const k = est.filter((e) => hit(t, e)).length;
    if (k === 0) add('seg.missed');
    if (k >= 2) add('seg.extraSplit', k - 1);
  }
  for (const e of est) {
    const k = T.filter((t) => hit(t, e)).length;
    if (k === 0) add('seg.spurious');
    if (k >= 2) add('seg.missedSplit', k - 1);
  }
  // pitch of onset-matched notes (pitch ignored in matching, onset +-100 ms)
  const pairs = matchNotes(T, est.map((e) => ({ start: e.start, end: e.end, midi: e.midi, cents: e.cents })), { onsetTol: 0.1, offsetRatio: null, pitchMode: 'any' });
  add('pitch.matched', pairs.length);
  for (const [i, j] of pairs) {
    // M1: written-note definition (integer MIDI difference); the old sung-pitch classes are counted as pitchSung.*
    const d = est[j].midi - T[i].midi;
    const r = Math.round(d);
    const ds = sung(est[j]) - sung(T[i]);
    if (Math.abs(ds) <= 0.5) add('pitchSung.ok');
    if (d === 0) add('pitch.ok');
    else if (r % 12 === 0) add('pitch.octave');
    else if (Math.abs(r) === 1) add('pitch.semitone');
    else add('pitch.other');
  }
  // quantization (tick domain) via the edit alignment
  const tk: TickNote[] = dropShortTruth(truth.map((n) => ({ startTick: n.startTick, ticks: n.ticks, midi: n.midi })));
  const outEv = quantizedToEvents(estQ);
  const e = editScript(notesToEvents(tk), outEv);
  for (const [op, v] of Object.entries(e.counts)) add(`edit.${op}`, v);
  const tt = [...tk].sort((a, b) => a.startTick - b.startTick);
  const oo = outEv.filter((x) => x.kind === 'note') as Extract<(typeof outEv)[number], { kind: 'note' }>[];
  for (const [ti, oi] of e.notePairs) {
    const t = tt[ti];
    const o = oo[oi];
    if (t.midi !== o.midi) continue; // pitch problems are counted above
    add('quant.pairs');
    if (o.startTick !== t.startTick) { add('quant.onsetSlot'); continue; }
    if (o.ticks === t.ticks) continue;
    const gapTo = (tt[ti + 1]?.startTick ?? t.startTick + t.ticks) - t.startTick; // length if legato to the next note
    if (o.ticks === gapTo && t.ticks < gapTo) add('quant.restVsLegato.filledRest');
    else if (t.ticks === gapTo && o.ticks < gapTo) add('quant.restVsLegato.cutLegato');
    else add('quant.duration');
  }
  return c;
}

export function sum(rows: { scores: Scores }[], k: string) {
  return rows.reduce((a, r) => a + (r.scores[k] ?? 0), 0);
}

/** All scores of one synthetic take (truth JSON of render/hum) for the analyzer's notes, quantized melody and f0. */
export function scoreTake(tr: { melody: { notes: TruthNote[] }; hum: { f0: unknown } }, estNotes: HumNote[], estQ: QuantizedMelody, estF0?: FrameF0Track, opts: { transposeInvariant?: boolean } = {}): Scores {
  const truthAll: TruthNote[] = tr.melody.notes;
  const truthNotes = truthAll.filter((n) => n.ticks >= 4); // TICKS_PER_16TH = 4
  const input = {
    truthNotes: truthNotes.map((n) => ({ start: n.start, end: n.end, midi: n.midi, cents: n.cents })),
    estNotes,
    ...(estF0 ? { truthF0: tr.hum.f0 as FrameF0Track, estF0 } : {}),
    truthTicks: truthAll.map((n) => ({ startTick: n.startTick, ticks: n.ticks, midi: n.midi })),
    estQuant: estQ,
    transposeInvariant: !!opts.transposeInvariant,
    exposeShift: true, // synthetic only
  };
  const scores = scoreRow(input);
  const shift = opts.transposeInvariant ? shiftFor(input) : 0;
  Object.assign(scores, errorTypes(truthNotes, unshiftNotes(estNotes, shift), unshiftQuantized(estQ, shift)));
  scores.nTruth = truthNotes.length;
  scores.nEst = estNotes.length;
  return scores;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function main() {
  const resultsDir = resolve(arg('--results', join(OUT, 'results')));
  const outDir = resolve(arg('--out', join(OUT, 'baseline')));
  const title = arg('--title', 'Spike 4 T8: synthetic baseline');
  const transposeInvariant = process.argv.includes('--transpose-invariant'); // default OFF for synthetic
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: Variant[] };
  const rows: (ReportRow & { split: string; melody: string; msPerSec: number; stagesMsPerSec: Record<string, number> })[] = [];
  let commit = '';
  let hash = '';
  for (const v of manifest.variants) {
    if (v.heldOut || v.split === 'heldOut') continue;
    const tr = JSON.parse(readFileSync(join(OUT, v.truth), 'utf8'));
    const res = JSON.parse(readFileSync(join(resultsDir, `${v.name}.json`), 'utf8'));
    commit = res.hum.meta.commit;
    hash = res.hum.meta.configHash;
    const scores = scoreTake(tr, res.melody.notes, res.melody.quantized, res.hum.f0 as FrameF0Track, { transposeInvariant });
    const tm = res.hum.meta.timings;
    const stagesMsPerSec: Record<string, number> = {};
    for (const [k, ms] of Object.entries(tm.stagesMs as Record<string, number>)) stagesMsPerSec[k] = ms / tm.audioSec;
    rows.push({ id: v.name, kind: 'synthetic', level: v.level, variant: v.name, scores, split: v.split, melody: v.melody, msPerSec: tm.totalMs / tm.audioSec, stagesMsPerSec });
  }

  const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '-');
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
  const md: string[] = [
    `# ${title}`,
    '',
    `- commit: \`${commit}\``,
    `- config hash: \`${hash}\` (default config, \`cli.ts --all --split tuning,dev --f0-track\`)`,
    `- variants: ${rows.length} (tuning ${rows.filter((r) => r.split === 'tuning').length}, dev ${rows.filter((r) => r.split === 'dev').length}); held-out not read`,
    '- truth: sung-time notes for note F / f0 / segmentation / pitch errors; score-time ticks for quantized accuracy and edits. Truth notes shorter than a 16th are dropped.',
    '',
  ];
  const levels = ['H0', 'H1', 'H2', 'H3', 'H4'].filter((L) => rows.some((r) => r.level === L));
  for (const split of ['tuning', 'dev']) {
    const sub = rows.filter((r) => r.split === split);
    md.push(`# ${split}`, '', renderReport(sub).split('## Synthetic: per variant')[0].replace('## Synthetic: mean per level', '## Mean per level (mean of per-take values)'));
    // pooled ratio + error breakdown
    const head = ['level', 'notes', 'edits', 'kbd steps', 'ratio (pooled)', 'edits/note (pooled)'];
    md.push('## Pooled edits vs keyboard', '', `| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    for (const L of levels) {
      const g = sub.filter((r) => r.level === L);
      const e = sum(g, 'edit.count');
      const kb = sum(g, 'edit.keyboardSteps');
      const n = sum(g, 'nTruth');
      md.push(`| ${L} | ${n} | ${e} | ${kb} | ${f3(e / kb)} | ${f3(e / n)} |`);
    }
    md.push('', '## Error breakdown (counts; % of truth notes)', '');
    const cols: [string, string][] = [
      ['missed note', 'seg.missed'], ['extra split (est)', 'seg.extraSplit'], ['missed split (est)', 'seg.missedSplit'], ['spurious est', 'seg.spurious'],
      ['pitch ok', 'pitch.ok'], ['octave', 'pitch.octave'], ['+-1 st', 'pitch.semitone'], ['pitch other', 'pitch.other'],
      ['onset slot', 'quant.onsetSlot'], ['duration', 'quant.duration'], ['filled rest (legato)', 'quant.restVsLegato.filledRest'], ['cut legato (rest)', 'quant.restVsLegato.cutLegato'],
      ['edit pitch', 'edit.pitch'], ['edit duration', 'edit.duration'], ['edit insert', 'edit.insert'], ['edit delete', 'edit.delete'], ['edit split', 'edit.split'], ['edit merge', 'edit.merge'],
    ];
    md.push(`| level | truth notes | est notes | ${cols.map((c) => c[0]).join(' | ')} |`, `| ${['---', '---', '---', ...cols.map(() => '---')].join(' | ')} |`);
    for (const L of levels) {
      const g = sub.filter((r) => r.level === L);
      const n = sum(g, 'nTruth');
      md.push(`| ${L} | ${n} | ${sum(g, 'nEst')} | ${cols.map(([, k]) => `${sum(g, k)} (${pct(sum(g, k), n)})`).join(' | ')} |`);
    }
    md.push('', '(pitch.* are over onset-matched notes (+-100 ms, pitch ignored); quant.* over edit-aligned pairs with the right pitch; seg.* use overlap > 30% of the shorter note.)', '');
  }

  // speed
  md.push('# Speed (node, ms per audio second)', '');
  const stageKeys = Object.keys(rows[0].stagesMsPerSec);
  md.push(`| group | audio s | total | ${stageKeys.join(' | ')} |`, `| ${['---', '---', '---', ...stageKeys.map(() => '---')].join(' | ')} |`);
  const speedGroup = (label: string, g: typeof rows) => {
    const aud = g.reduce((a, r) => a + (manifest.variants.find((v) => v.name === r.id)!.audioSec), 0);
    const w = (f: (r: (typeof rows)[number]) => number) => g.reduce((a, r) => a + f(r) * manifest.variants.find((v) => v.name === r.id)!.audioSec, 0) / aud;
    md.push(`| ${label} | ${aud.toFixed(0)} | ${w((r) => r.msPerSec).toFixed(1)} | ${stageKeys.map((k) => w((r) => r.stagesMsPerSec[k] ?? 0).toFixed(1)).join(' | ')} |`);
  };
  speedGroup('all', rows);
  for (const L of levels) speedGroup(L, rows.filter((r) => r.level === L));
  const worst = Math.max(...rows.map((r) => r.msPerSec));
  md.push('', `Slowest take: ${worst.toFixed(1)} ms per audio second (1 min = ${(worst * 60 / 1000).toFixed(2)} s on this Node, no browser/Worker overhead; resample dominates).`, '');

  const dir = outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), md.join('\n'), 'utf8');
  writeFileSync(join(dir, 'rows.json'), JSON.stringify({ commit, configHash: hash, rows }, null, 1) + '\n', 'utf8');
  process.stderr.write(`baseline: ${rows.length} rows, config ${hash}, commit ${commit}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

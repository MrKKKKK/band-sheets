/**
 * Spike 8 T4: tools of the front end F1 on the synthetic TUNING split only (c2-t-*; docs/audio-spike8-t4.md). No dev /
 * hold-out / recording file is opened (no look, no beginLook): the manifest's split / heldOut flags are checked before a
 * wav is read, and the truth file's own flags again before it is used. Output: counts, rates and timings only.
 * From spikes/analysis, in the devcontainer:
 *
 *   npx tsx ts/chords2/front/cli.ts eval [--grid '{"stopRatio":[0.1,0.2]}'] [--by variation] [--only GLOB]
 *        accuracy table (accuracy.ts) on the truth's beat grid; --grid = F1 values to compare (cartesian product)
 *   npx tsx ts/chords2/front/cli.ts dump <c2-t-name> [--dump FILE]
 *        per-beat octave-aware strengths on v1a's own beats (frontEnd), JSON (default out/chords2-front/<name>.json)
 *   npx tsx ts/chords2/front/cli.ts share [--only GLOB]
 *        the bass stage (appBassConfig) on its own 5-octave CQT vs on the lower 5 octaves of F1's 7-octave CQT
 *   npx tsx ts/chords2/front/cli.ts timing
 *        a 5-minute input (tuning clips joined): base (v1a + app bass) and the F1 additions, 3 runs, median (Node)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../../browser/wav';
import { applyBass } from '../../bass/analyze';
import { argOf, json } from '../../bass/evalCommon';
import { lowCqt } from '../../bass/lowCqt';
import { analyze as analyzeV1 } from '../../dsp/analyze';
import { MemTracker } from '../../dsp/core/mem';
import { toMono } from '../../dsp/core/resample';
import { NOTE_NAMES } from '../../dsp/chords';
import { appBassConfig } from '../config';
import { frontEnd } from '../eval/frontEnd';
import { prepareInput } from '../eval/input';
import { ACC_HEADER, accRow, addBeats, newFrontAcc, type FrontAcc, type TruthChordSpan, type TruthNote } from './accuracy';
import { DEFAULT_F1_CONFIG, f1ConfigHash, resolveF1Config, type F1Config } from './config';
import { bassCqtFrom, bassView, beatSpectra, f1Beats, f1FromSpectra, lowestNote, octaveCqt, strengthRow } from './f1';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const C2 = join(ROOT, 'out', 'chords2');

interface Variant {
  name: string;
  split: string;
  heldOut: boolean;
  wav: string;
  truth: string;
  set: string;
  variation?: string;
}
interface C2Truth {
  beats: { t: number }[];
  chords: { start: number; end: number; root: string; quality: string }[];
  chords2: { variant: { split: string; heldOut: boolean; variation: string }; segments: { start: number; end: number; pcs: number[] }[]; notes: TruthNote[] };
}

const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** Tuning variants of out/chords2 (flags checked before anything else is read). */
export function tuningVariants(only?: string): Variant[] {
  const all = json<{ variants: Variant[] }>(join(C2, 'manifest.json')).variants;
  return all.filter((v) => v.split === 'tuning' && !v.heldOut && v.name.startsWith('c2-t-') && (!only || globRe(only).test(v.name)));
}
function loadTruth(v: Variant): C2Truth {
  const t = json<C2Truth>(join(C2, v.truth));
  if (t.chords2.variant.split !== 'tuning' || t.chords2.variant.heldOut) throw new Error(`${v.name}: truth is not tuning`);
  return t;
}
function loadY(v: Variant): Float32Array {
  const w = decodeWav(new Uint8Array(readFileSync(join(C2, v.wav))));
  return prepareInput(toMono(w.channels), w.sampleRate, true).y;
}
const pcOf = (name: string): number => (NOTE_NAMES as readonly string[]).indexOf(name);

/** Truth chord spans with the segments' pitch classes (segments and chords share the grid; equal neighbours merged in chords). */
function chordSpans(t: C2Truth): TruthChordSpan[] {
  return t.chords2.segments.map((s) => {
    const mid = (s.start + s.end) / 2;
    const c = t.chords.find((x) => x.start <= mid && mid < x.end);
    return { start: s.start, end: s.end, root: c ? pcOf(c.root) : null, quality: c?.quality ?? 'N', pcs: s.pcs };
  });
}

function grid(spec: string | undefined): F1Config[] {
  if (!spec) return [DEFAULT_F1_CONFIG];
  let out: Partial<F1Config>[] = [{}];
  for (const [k, vals] of Object.entries(JSON.parse(spec) as Record<string, unknown[]>)) out = out.flatMap((o) => vals.map((v) => ({ ...o, [k]: v })));
  return out.map((o) => resolveF1Config(o));
}

function cmdEval(argv: string[]): void {
  const cfgs = grid(argOf(argv, '--grid'));
  const by = argOf(argv, '--by');
  const acc = new Map<string, FrontAcc>();
  const add = (k: string) => acc.get(k) ?? acc.set(k, newFrontAcc()).get(k)!;
  const vs = tuningVariants(argOf(argv, '--only'));
  for (const v of vs) {
    const t = loadTruth(v);
    const low = octaveCqt(loadY(v));
    const beats = t.beats.map((b) => b.t);
    const end = t.chords[t.chords.length - 1].end;
    const spec = beatSpectra(low, beats, end);
    const spans = chordSpans(t);
    cfgs.forEach((cfg, i) => {
      const fb = f1FromSpectra(spec, low.nSemis, low.midi0, beats, end, cfg);
      addBeats(add(`${i}|ALL`), fb, t.chords2.notes, spans, cfg);
      if (by === 'variation') addBeats(add(`${i}|${t.chords2.variant.variation}`), fb, t.chords2.notes, spans, cfg);
      if (by === 'set') addBeats(add(`${i}|${v.set}`), fb, t.chords2.notes, spans, cfg);
    });
  }
  console.log(`# F1 accuracy: ${vs.length} tuning files (c2-t-*), truth beat grid`);
  cfgs.forEach((cfg, i) => {
    const diff = Object.entries(cfg).filter(([k, x]) => JSON.stringify(x) !== JSON.stringify((DEFAULT_F1_CONFIG as unknown as Record<string, unknown>)[k]));
    console.log(`\n## config ${i} (${f1ConfigHash(cfg)}) ${diff.length ? diff.map(([k, x]) => `${k}=${JSON.stringify(x)}`).join(' ') : 'default'}\n`);
    console.log(ACC_HEADER);
    for (const [k, a] of acc) if (k.startsWith(`${i}|`)) console.log(`| ${accRow(k.slice(k.indexOf('|') + 1), a)} |`);
  });
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

function cmdDump(argv: string[]): void {
  const name = argv.find((a) => !a.startsWith('--'));
  const v = tuningVariants().find((x) => x.name === name);
  if (!v) throw new Error(`dump: ${name ?? '(none)'} is not a tuning variant of out/chords2 (only c2-t-* are allowed)`);
  const y = loadY(v);
  const fe = frontEnd(y.slice());
  const cfg = DEFAULT_F1_CONFIG;
  const beats = Array.from(fe.times);
  const fb = f1Beats(octaveCqt(y, cfg), beats, fe.duration, cfg);
  const out = {
    name: v.name,
    f1: { config: cfg.name, hash: f1ConfigHash(cfg) },
    /** strength[k] = semitone outLo + k (C2..B5), 0 = not picked */
    range: { lo: cfg.outLo, hi: cfg.candHi },
    beats: fb.map((b) => {
      const low = lowestNote(b.notes);
      const strength = Array.from(strengthRow(b.notes, cfg), r4);
      return { start: r4(b.start), end: r4(b.end), notes: b.notes.map((n) => ({ midi: n.midi, s: r4(n.s) })), lowest: low ? low.midi : null, strength };
    }),
  };
  const file = argOf(argv, '--dump') ?? join(ROOT, 'out', 'chords2-front', `${v.name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  console.log(`wrote ${file}: ${out.beats.length} beats`);
}

function cmdShare(argv: string[]): void {
  const bcfg = appBassConfig();
  let same = 0;
  let colsSame = 0;
  let maxRel = 0;
  let fallback = 0;
  const vs = tuningVariants(argOf(argv, '--only'));
  for (const v of vs) {
    loadTruth(v); // flag check only
    const y = loadY(v);
    const own = lowCqt(y, bcfg.lowCqt);
    const wide = octaveCqt(y);
    const view = bassView(wide, bcfg.lowCqt);
    if (own.cols === view.cols && own.tuning === view.tuning) colsSame++;
    if (bassCqtFrom(y, wide, bcfg.lowCqt).semi.buffer !== wide.semi.buffer) fallback++;
    const n = Math.min(own.semi.length, view.semi.length);
    let peak = 0;
    for (let i = 0; i < own.semi.length; i++) peak = Math.max(peak, own.semi[i]);
    if (own.cols === view.cols) for (let i = 0; i < n; i++) maxRel = Math.max(maxRel, Math.abs(own.semi[i] - view.semi[i]) / peak);
    const v1 = analyzeV1(y.slice()).result;
    const a = JSON.stringify(applyBass(own, v1, bcfg).chords);
    const b = JSON.stringify(applyBass(view, v1, bcfg).chords); // the plain view, also where bassCqtFrom would fall back
    if (a === b) same++;
  }
  console.log(`# share: ${vs.length} tuning files; same cols + tuning ${colsSame} (bassCqtFrom computes its own CQT for ${fallback}); bass output on the plain view identical ${same} / ${vs.length}; max |diff| / file peak (same cols) ${maxRel.toExponential(2)}`);
}

function cmdTiming(): void {
  const pool = tuningVariants('c2-t-b-*').map(loadY);
  const need = 5 * 60 * 22050;
  const y = new Float32Array(need);
  for (let o = 0, i = 0; o < need; i++) {
    const c = pool[i % pool.length];
    y.set(c.subarray(0, Math.min(c.length, need - o)), o);
    o += c.length;
  }
  const bcfg = appBassConfig();
  const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1];
  const rows: Record<string, number[]> = {};
  const mems: Record<string, number> = {};
  const rec = (k: string, ms: number) => (rows[k] ??= []).push(ms);
  for (let run = 0; run < 3; run++) {
    let t = performance.now();
    const v1 = analyzeV1(y.slice());
    rec('v1a analyze', performance.now() - t);
    const memB = new MemTracker();
    t = performance.now();
    const own = lowCqt(y, bcfg.lowCqt, { mem: memB });
    memB.adopt(own.semi);
    rec('bass lowCqt (5 oct)', performance.now() - t);
    t = performance.now();
    applyBass(own, v1.result, bcfg);
    rec('bass marks', performance.now() - t);
    const memF = new MemTracker();
    t = performance.now();
    const wide = octaveCqt(y, DEFAULT_F1_CONFIG, { mem: memF });
    memF.adopt(wide.semi);
    rec('F1 CQT (7 oct)', performance.now() - t);
    t = performance.now();
    f1Beats(wide, v1.result.beats.map((b) => b.t), v1.result.source.durationSec);
    rec('F1 per beat', performance.now() - t);
    mems['bass lowCqt peak MB'] = memB.peak / 2 ** 20;
    mems['F1 CQT peak MB'] = memF.peak / 2 ** 20;
    mems['F1 semis MB'] = wide.semi.byteLength / 2 ** 20;
    mems['bass semis MB'] = own.semi.byteLength / 2 ** 20;
  }
  console.log('# Node timing, 5-minute input (tuning clips c2-t-b-* joined), median of 3 runs');
  console.log('| 段 | ms |\n|---|---|');
  for (const [k, a] of Object.entries(rows)) console.log(`| ${k} | ${median(a).toFixed(0)} |`);
  console.log('\n| メモリ（MemTracker） | MB |\n|---|---|');
  for (const [k, m] of Object.entries(mems)) console.log(`| ${k} | ${m.toFixed(1)} |`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'eval') cmdEval(rest);
  else if (cmd === 'dump') cmdDump(rest);
  else if (cmd === 'share') cmdShare(rest);
  else if (cmd === 'timing') cmdTiming();
  else {
    console.error('usage: cli.ts eval [--grid JSON] [--by variation|set] [--only GLOB] | dump <c2-t-name> [--dump FILE] | share [--only GLOB] | timing');
    process.exit(2);
  }
}

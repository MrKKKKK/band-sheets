/**
 * Spike 6 T8: root regression check (docs/audio-spike6-plan.md section 5 "ルートの後戻り", docs/audio-spike6-t8.md).
 * Run from spikes/analysis (devcontainer), after rendering the spike 0/2 variants (`npx tsx render/cli.ts --out out/spike0`):
 *
 *   npx tsx ts/bass/root_regression.ts [--manifest out/spike0/manifest.json] [--out out/bass-results/regression]
 *        [--levels 0,1,2,3,LR] [--commit SHA] [--config x.json]
 *
 * Per non-held-out variant of the levels: ts/dsp analyze (v1a) and analyzeWithBass with the bass stage ON, on the same
 * signal. Checks that everything but the bass fields is identical (beats, keys, sections, every chord's start / end /
 * root / quality / confidence / candidates; `text` equal or the v1a text with `/X` inserted before a trailing `?`; T10:
 * a B-3 piece of a v1a chord counts as that chord, and with `cliche.redecideRoot` in --config (bass-on overrides, as
 * cli.ts) root / quality changes are counted per file instead of failing) and
 * writes both results (<name>.v1a.json, <name>.bass.json) plus pairs.json for py/tools/bass_root_regression.py, which
 * scores them with py/score.py. Held-out variants (spike 2) are skipped by their manifest flag, never opened.
 * Output: counts only. Exit 1 when any difference outside the bass fields is found.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../browser/wav';
import { analyze } from '../dsp/analyze';
import { chordName, NOTE_NAMES } from '../dsp/chords';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { analyzeWithBass } from './analyze';
import { bassConfigHash, enabledBassConfig } from './config';
import { argOf } from './evalCommon';
import { LOW_SR } from './lowCqt';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASS_FIELDS = ['bass', 'bassConfidence', 'bassKind', 'bassCandidates', 'text'] as const;


type Obj = Record<string, unknown>;
const without = (o: Obj, keys: readonly string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const EPS = 1e-6;
const pcOf = (name: unknown): number => (NOTE_NAMES as readonly string[]).indexOf(String(name));

/** Index of the v1a chord that holds [d.start, d.end), or -1. */
const holder = (a: Obj[], d: Obj): number => a.findIndex((c) => Number(c.start) - EPS <= Number(d.start) && Number(d.end) <= Number(c.end) + EPS);

/**
 * Differences outside the bass fields between the v1a result and the bass result (empty = none). Exported for tests.
 * A bass chord may be a piece of a v1a chord (B-3 split, T10): the pieces must tile their v1a chord and carry its other
 * fields. `roots` (T10 root re-decision on): root, quality and the name part of `text` may differ (counted by
 * rootChanges instead).
 */
export function nonBassDiffs(v1a: Obj, bass: Obj, opts: { roots?: boolean } = {}): string[] {
  const out: string[] = [];
  const top = (o: Obj) => without(o, ['chords', 'bassAnalyzer', 'analyzer', 'stats']);
  if (JSON.stringify(top(v1a)) !== JSON.stringify(top(bass))) out.push('top-level fields');
  const a = v1a.chords as Obj[];
  const b = bass.chords as Obj[];
  const ignore = [...BASS_FIELDS, 'start', 'end', ...(opts.roots ? ['root', 'quality'] : [])];
  const pieces = a.map((): Obj[] => []);
  b.forEach((d, k) => {
    const j = holder(a, d);
    if (j < 0) return out.push(`chord ${k}: outside the v1a chords`);
    pieces[j].push(d);
    const c = a[j];
    if (JSON.stringify(without(c, ignore)) !== JSON.stringify(without(d, ignore))) out.push(`chord ${k}: non-bass field`);
    const t = String(c.text);
    const q = t.endsWith('?') ? '?' : '';
    const name = c.root === d.root && c.quality === d.quality ? t.slice(0, t.length - q.length) : chordName(pcOf(d.root), String(d.quality));
    if (d.text !== (d.bass ? `${name}/${String(d.bass)}${q}` : `${name}${q}`)) out.push(`chord ${k}: text`);
  });
  pieces.forEach((ps, j) => {
    const tiled = ps.length > 0 && ps.every((p, i) => Math.abs(Number(p.start) - Number(i ? ps[i - 1].end : a[j].start)) < EPS) && Math.abs(Number(ps[ps.length - 1].end) - Number(a[j].end)) < EPS;
    if (!tiled) out.push(`v1a chord ${j}: pieces do not tile it`);
  });
  return out;
}

/** Bass chords whose root or quality differs from the v1a chord holding them (T10 root re-decision). */
export function rootChanges(v1a: Obj, bass: Obj): number {
  const a = v1a.chords as Obj[];
  return (bass.chords as Obj[]).filter((d) => {
    const c = a[holder(a, d)];
    return c && (c.root !== d.root || c.quality !== d.quality);
  }).length;
}

function main(argv: string[]): void {
  const manifest = resolve(ROOT, argOf(argv, '--manifest') ?? 'out/spike0/manifest.json');
  const outDir = resolve(ROOT, argOf(argv, '--out') ?? 'out/bass-results/regression');
  const levels = (argOf(argv, '--levels') ?? '0,1,2,3,LR').split(',');
  const commit = argOf(argv, '--commit') ?? process.env.BAND_SHEETS_COMMIT;
  const cfgPath = argOf(argv, '--config');
  const cfg = enabledBassConfig(cfgPath ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as unknown) : {});
  const roots = cfg.cliche.redecideRoot;
  const base = dirname(manifest);
  const vs = (JSON.parse(readFileSync(manifest, 'utf8')) as { variants: { name: string; level: unknown; heldOut?: boolean; wav: string; truth: string }[] }).variants;
  const picked = vs.filter((v) => !v.heldOut && levels.includes(String(v.level)));
  mkdirSync(outDir, { recursive: true });
  const pairs: { name: string; level: string; truth: string; v1a: string; bass: string; marked: number; diffs: number; rootChanges: number }[] = [];
  let bad = 0;
  for (const v of picked) {
    const wav = decodeWav(new Uint8Array(readFileSync(join(base, v.wav))));
    const y = resampleSinc(toMono(wav.channels), wav.sampleRate, LOW_SR);
    const r0 = analyze(y.slice(), { timings: false }).result as unknown as Obj;
    const r1 = analyzeWithBass(y.slice(), { timings: false, bass: cfg, commit }).result as unknown as Obj;
    const diffs = nonBassDiffs(r0, r1, { roots });
    const changed = rootChanges(r0, r1);
    if (diffs.length) bad++;
    const marked = (r1.chords as Obj[]).filter((c) => c.bass).length;
    const p0 = join(outDir, `${v.name}.v1a.json`);
    const p1 = join(outDir, `${v.name}.bass.json`);
    writeFileSync(p0, JSON.stringify(r0));
    writeFileSync(p1, JSON.stringify(r1));
    const rel = (p: string) => relative(ROOT, p); // relative to spikes/analysis (= /work in the Python image)
    pairs.push({ name: v.name, level: String(v.level), truth: rel(join(base, v.truth)), v1a: rel(p0), bass: rel(p1), marked, diffs: diffs.length, rootChanges: changed });
    console.log(`${v.name}\tlevel ${String(v.level)}\tchords ${(r0.chords as Obj[]).length} -> ${(r1.chords as Obj[]).length}\t/X ${marked}\troot changes ${changed}\tnon-bass diffs ${diffs.length}`);
  }
  writeFileSync(join(outDir, 'pairs.json'), JSON.stringify({ configHash: bassConfigHash(cfg), commit: commit ?? null, pairs }, null, 1));
  console.log(`\n${picked.length} variants (held-out skipped: ${vs.filter((v) => v.heldOut && levels.includes(String(v.level))).length}), bass config ${bassConfigHash(cfg)}; files with non-bass differences: ${bad}`);
  if (bad) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

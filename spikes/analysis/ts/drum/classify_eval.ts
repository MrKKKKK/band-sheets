/**
 * Spike 5 T6: S-3 instrument evaluation on the synthetic tuning + dev splits (docs/audio-spike5-plan.md T6).
 *
 * Run from spikes/analysis (devcontainer):
 *   npx tsx ts/drum/classify_eval.ts [--split tuning,dev] [--only GLOB] [--config '<json overrides>']
 *        [--sweep sweep.json] [--detail] [--templates-program N] [--json out/drum-results/classify/summary.json]
 *   sweep.json = [{ "name": "...", "config": { classify: {...} } }, ...]: every entry is scored on the same onsets
 *   (onset values must not differ between entries; they come from --config).
 * Truth: render/drum truth hits mapped to S-3 (score.ts mapInst: HO -> HH, the rest dropped); estimates the same.
 * Scores: score.ts instrumentOnsets (per instrument 1:1 matching, mir_eval) at 50 and 25 ms, micro-summed per group
 * (split x level x kit x instrument), confusion (truth x est, 'none' = missed / extra) per split x level.
 * --ceiling adds a row where every onset is labelled BD + SD + HH: its recall is what the onsets allow.
 * HELD-OUT: onset_eval.ts selectVariants / assertNoHeldOut (refuses before any file is opened). Output: aggregates only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAudioFile, toMono } from '../../render/drum/audioFile';
import { classifyOnsets, specParams, type TemplateTable } from './classify';
import { drumConfigHash, resolveDrumConfig, type DrumConfig } from './config';
import { detectOnsets } from './onset';
import { assertNoHeldOut, selectVariants, type EvalVariant } from './onset_eval';
import { instrumentOnsets, mapInst, type TimedHit } from './score';
import { DRUM_TEMPLATES } from './templates';
import { buildTemplates } from './templates_build';

const INSTS = ['BD', 'SD', 'HH'] as const;

interface Count {
  m50: number;
  m25: number;
  nRef: number;
  nEst: number;
}
const zero = (): Count => ({ m50: 0, m25: 0, nRef: 0, nEst: 0 });
const f = (m: number, r: number, e: number) => (r + e ? (2 * m) / (r + e) : 0);

export interface SweepEntry {
  name: string;
  config: Record<string, unknown>;
}

export interface EvalState {
  counts: Map<string, Count>;
  confusion: Map<string, Record<string, Record<string, number>>>;
  ms: { onset: number; classify: number; audioSec: number };
}

function toS3(hs: readonly TimedHit[]): TimedHit[] {
  const out: TimedHit[] = [];
  for (const h of hs) {
    const i = mapInst(h.inst, 'S-3');
    if (i) out.push({ t: h.t, inst: i });
  }
  return out;
}

export function addTake(st: EvalState, v: Pick<EvalVariant, 'split' | 'level' | 'kit'>, ref: TimedHit[], est: TimedHit[]): void {
  const s50 = instrumentOnsets(ref, est, 0.05);
  const s25 = instrumentOnsets(ref, est, 0.025);
  for (const inst of [...INSTS, 'all']) {
    const a = inst === 'all' ? s50.all : s50.perInst[inst];
    const b = inst === 'all' ? s25.all : s25.perInst[inst];
    for (const key of [`${v.split}|${v.level}|k${v.kit}|${inst}`, `${v.split}|${v.level}|all|${inst}`, `${v.split}|ALL|all|${inst}`]) {
      const c = st.counts.get(key) ?? zero();
      c.m50 += a?.matched ?? 0;
      c.m25 += b?.matched ?? 0;
      c.nRef += a?.nRef ?? ref.filter((h) => h.inst === inst).length;
      c.nEst += a?.nEst ?? est.filter((h) => h.inst === inst).length;
      st.counts.set(key, c);
    }
  }
  for (const key of [`${v.split}|${v.level}`, `${v.split}|ALL`]) {
    const cm = st.confusion.get(key) ?? {};
    for (const [r, row] of Object.entries(s50.confusion)) for (const [e, n] of Object.entries(row)) ((cm[r] ??= {})[e] = (cm[r][e] ?? 0) + n);
    st.confusion.set(key, cm);
  }
}

export function summaryLine(st: EvalState, split: string): string {
  return [...INSTS, 'all']
    .map((i) => {
      const c = st.counts.get(`${split}|ALL|all|${i}`) ?? zero();
      return `${i} ${f(c.m50, c.nRef, c.nEst).toFixed(3)}`;
    })
    .join('  ');
}

export function levelTable(st: EvalState, split: string): string {
  const keys = [...new Set([...st.counts.keys()].filter((k) => k.startsWith(`${split}|`)).map((k) => k.split('|').slice(1, 3).join('|')))].sort((a, b) =>
    a.replace('ALL', 'Z').localeCompare(b.replace('ALL', 'Z')),
  );
  const lines = [`| ${split} level | kit | ${INSTS.map((i) => `${i} F50 | ${i} F25 | ${i} P/R`).join(' | ')} | all F50 | all F25 |`, `|${'---|'.repeat(4 + INSTS.length * 3)}`];
  for (const k of keys) {
    const [level, kit] = k.split('|');
    const cell = (i: string) => {
      const c = st.counts.get(`${split}|${k}|${i}`) ?? zero();
      return { f50: f(c.m50, c.nRef, c.nEst).toFixed(3), f25: f(c.m25, c.nRef, c.nEst).toFixed(3), pr: `${(c.nEst ? c.m50 / c.nEst : 0).toFixed(2)}/${(c.nRef ? c.m50 / c.nRef : 0).toFixed(2)}` };
    };
    const a = cell('all');
    lines.push(`| ${level} | ${kit} | ${INSTS.map((i) => { const c = cell(i); return `${c.f50} | ${c.f25} | ${c.pr}`; }).join(' | ')} | ${a.f50} | ${a.f25} |`);
  }
  return lines.join('\n');
}

export function confusionTable(st: EvalState, key: string): string {
  const cm = st.confusion.get(key) ?? {};
  const cols = [...INSTS, 'none'];
  const rows = [...INSTS, 'none'];
  const lines = [`| ${key} truth \\ est | ${cols.join(' | ')} |`, `|${'---|'.repeat(cols.length + 1)}`];
  for (const r of rows) lines.push(`| ${r} | ${cols.map((c) => (r === 'none' && c === 'none' ? '-' : String(cm[r]?.[c] ?? 0))).join(' | ')} |`);
  return lines.join('\n');
}

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function run(argv: string[]): void {
  const root = resolve(fileURLToPath(new URL('../../out/drum/', import.meta.url)));
  const splits = (argOf(argv, '--split') ?? 'tuning,dev').split(',');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { variants: EvalVariant[] };
  const vs = selectVariants(manifest.variants, splits, argOf(argv, '--only'));
  const base = JSON.parse(argOf(argv, '--config') ?? '{}') as Record<string, unknown>;
  const sweepPath = argOf(argv, '--sweep');
  const sweep: SweepEntry[] = sweepPath ? JSON.parse(readFileSync(sweepPath, 'utf8')) : [{ name: 'config', config: {} }];
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? merge(a[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
    return out;
  };
  const baseCfg = resolveDrumConfig(base);
  const cfgs: DrumConfig[] = sweep.map((s) => resolveDrumConfig(merge(base, s.config)));
  for (const c of cfgs) if (JSON.stringify(c.onset) !== JSON.stringify(baseCfg.onset) || JSON.stringify(c.audio) !== JSON.stringify(baseCfg.audio)) throw new Error('sweep entries may not change onset / audio');
  // --templates-program N (T10 leave-one-preset-out): templates from another kit A preset, so the tuning takes act as an unknown kit.
  const program = Number(argOf(argv, '--templates-program') ?? 0);
  const tables = new Map<string, TemplateTable>(program === 0 ? [[JSON.stringify(DRUM_TEMPLATES.params), DRUM_TEMPLATES]] : []);
  const tableOf = (c: DrumConfig) => {
    const k = JSON.stringify(specParams(c));
    if (!tables.has(k)) tables.set(k, buildTemplates(specParams(c), program));
    return tables.get(k)!;
  };
  const ceiling = argv.includes('--ceiling');
  if (ceiling) {
    // recall ceiling of the onsets: every onset labelled BD + SD + HH (only R is meaningful)
    sweep.push({ name: 'ceiling (every onset = BD+SD+HH; read R only)', config: {} });
    cfgs.push(baseCfg);
  }
  const states: EvalState[] = cfgs.map(() => ({ counts: new Map(), confusion: new Map(), ms: { onset: 0, classify: 0, audioSec: 0 } }));
  for (const v of vs) {
    const truth = JSON.parse(readFileSync(join(root, v.truth), 'utf8')) as { drum: { truth: { hits: TimedHit[] }; variant: { heldOut: boolean; split: string } } };
    assertNoHeldOut([{ name: v.name, ...truth.drum.variant }]);
    const ref = toS3(truth.drum.truth.hits);
    const a = readAudioFile(join(root, v.wav));
    const t0 = performance.now();
    const det = detectOnsets(toMono(a), a.sampleRate, baseCfg);
    const onsetMs = performance.now() - t0;
    cfgs.forEach((c, i) => {
      if (ceiling && i === cfgs.length - 1) {
        addTake(states[i], v, ref, det.onsets.flatMap((o) => INSTS.map((inst) => ({ t: o.t, inst }))));
        states[i].ms.audioSec += v.audioSec;
        return;
      }
      const tb = c.classify.nmf || program !== 0 ? tableOf(c) : DRUM_TEMPLATES;
      const t1 = performance.now();
      const r = classifyOnsets(det, c, tb);
      states[i].ms.classify += performance.now() - t1;
      states[i].ms.onset += onsetMs;
      states[i].ms.audioSec += v.audioSec;
      addTake(states[i], v, ref, toS3(r.hits));
    });
  }
  const out: unknown[] = [];
  cfgs.forEach((c, i) => {
    const st = states[i];
    const min = st.ms.audioSec / 60;
    console.log(`\n### ${sweep[i].name} (config ${drumConfigHash(c)}; ${vs.length} files, ${min.toFixed(1)} audio min; onset ${(st.ms.onset / min).toFixed(0)} + classify ${(st.ms.classify / min).toFixed(0)} ms per audio min)`);
    for (const s of splits) console.log(`${s.padEnd(6)} F50: ${summaryLine(st, s)}`);
    if (argv.includes('--detail')) {
      for (const s of splits) {
        console.log(`\n${levelTable(st, s)}`);
        console.log(`\n${confusionTable(st, `${s}|ALL`)}`);
        for (const l of ['D0', 'D1', 'D2', 'D3']) if (st.confusion.has(`${s}|${l}`)) console.log(`\n${confusionTable(st, `${s}|${l}`)}`);
      }
    }
    out.push({ name: sweep[i].name, config: drumConfigHash(c), counts: Object.fromEntries(st.counts), confusion: Object.fromEntries(st.confusion), msPerAudioMin: { onset: st.ms.onset / min, classify: st.ms.classify / min } });
  });
  const jp = argOf(argv, '--json');
  if (jp) {
    mkdirSync(dirname(resolve(jp)), { recursive: true });
    writeFileSync(jp, JSON.stringify(out));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && existsSync(resolve(fileURLToPath(new URL('../../out/drum/', import.meta.url))))) {
  run(process.argv.slice(2));
}

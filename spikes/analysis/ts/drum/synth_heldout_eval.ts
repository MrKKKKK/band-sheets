/**
 * Spike 5 T16: the ONE run of the synthetic held-out (kit C, seeds 6-7, held-out room), user decision G2-11 (t11.md).
 *
 *   npx tsx ts/drum/synth_heldout_eval.ts --final-synth
 *
 * Guard (checked once, before any audio is read): clean working tree, git HEAD readable, config hash = FROZEN_CONFIG_HASH,
 * no 'drum-synth' look-3 held-out line in out/results/heldout-log.jsonl (its own guard; the recordings' T14 line does not
 * count). Then TWO lines are written before the analysis: the dev-synthetic look (kit B at the frozen config, the 5th look
 * at dev synthetic material, needed for the section 5 difference) and the held-out line. Then kit B (dev) and kit C
 * (held-out) are analyzed at S-9 / S-3 / S-ext and pooled per kit x D-level (synthetic truth is exact: no alignment).
 *
 * Output: pooled numbers only, to stdout and out/heldout-eval/synth/summary.md (gitignored). No per-variant results.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drumConfigHash } from './config';
import { UsageError, gitCommit, gitPorcelain, loadConfig, runFile } from './cli';
import { FROZEN_CONFIG_HASH, hasDrumSynthLook3, isHeld, parseLog } from './heldout_guard';
import { countF, poolNumbers, renderPool, type PoolItem, type PoolNumbers } from './pool';
import type { DrumTruth } from './score';
import type { DrumLevel } from './types';

export const SYNTH_LEVELS: DrumLevel[] = ['S-9', 'S-3', 'S-ext'];
const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'out', 'drum');
const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');

export interface SynEntry {
  name: string;
  kit: string;
  level: string;
  split: string;
  heldOut?: boolean;
}

export interface SynthDeps {
  variants: SynEntry[];
  readLog(): string | null;
  appendLog(line: string): void;
  porcelain(): string | null;
  now(): string;
  configHash: string;
  commit?: string;
  frozenConfigHash?: string;
  /** Analyzes ONE variant at one level, then reads its truth; called only after the guard has passed and the lines are written. */
  analyze(name: string, level: DrumLevel): PoolItem;
}

export function synthLogLines(o: { time: string; dev: string[]; held: string[]; levels: DrumLevel[]; configHash: string; commit: string }): [string, string] {
  const base = { time: o.time, kind: 'look', input: 'drum-synth', lookPoint: 3, levels: o.levels, configHash: o.configHash, commit: o.commit, task: 'T16' };
  return [
    JSON.stringify({ ...base, take: 'dev', heldOut: false, kits: ['B'], nVariants: o.dev.length, note: 'dev-synthetic look #5 (T9 + 3 in T10 before): kit B at the frozen config, only for the section 5 held-out difference (G2-11)' }),
    JSON.stringify({ ...base, take: 'heldout', heldOut: true, kits: ['C'], variants: o.held }),
  ];
}

/** Reason to refuse, or null. Pure (tested with fake logs). */
export function synthBlock(d: Pick<SynthDeps, 'configHash' | 'commit' | 'frozenConfigHash'> & { logText: string | null; porcelain: string | null }): string | null {
  if (d.configHash !== (d.frozenConfigHash ?? FROZEN_CONFIG_HASH)) return `config ${d.configHash} is not the frozen ${d.frozenConfigHash ?? FROZEN_CONFIG_HASH}`;
  if (!d.commit) return 'the commit could not be read from git';
  if (d.porcelain === null || d.porcelain !== '') return 'working tree must be clean (and git must work) for a held-out run';
  if (hasDrumSynthLook3(parseLog(d.logText))) return 'a drum-synth look-3 line already exists in the heldout log: refusing to run again';
  return null;
}

export interface SynthOutcome {
  /** kit -> S-level -> D-level -> pooled numbers. */
  pools: Record<string, Record<string, Record<string, PoolNumbers>>>;
  report: string;
}

const D_LEVELS = ['D0', 'D1', 'D2', 'D3'];

export function runSynthEval(d: SynthDeps): SynthOutcome {
  const held = d.variants.filter(isHeld);
  const dev = d.variants.filter((v) => !isHeld(v) && v.split === 'dev' && v.kit === 'B');
  if (held.length === 0 || dev.length === 0) throw new UsageError('manifest has no kit C held-out or no kit B dev variants');
  if (held.some((v) => v.kit !== 'C')) throw new UsageError('a held-out variant is not kit C: refusing');
  const block = synthBlock({ configHash: d.configHash, commit: d.commit, frozenConfigHash: d.frozenConfigHash, logText: d.readLog(), porcelain: d.porcelain() });
  if (block) throw new UsageError(block);
  for (const line of synthLogLines({ time: d.now(), dev: dev.map((v) => v.name), held: held.map((v) => v.name), levels: SYNTH_LEVELS, configHash: d.configHash, commit: d.commit! })) d.appendLog(line);
  const pools: SynthOutcome['pools'] = {};
  for (const [kit, vs] of [['B', dev], ['C', held]] as const) {
    for (const level of SYNTH_LEVELS) {
      const items = vs.map((v) => ({ v, item: d.analyze(v.name, level) }));
      for (const dl of D_LEVELS) {
        const sel = items.filter((x) => x.v.level === dl).map((x) => x.item);
        if (sel.length) ((pools[kit] ??= {})[level] ??= {})[dl] = poolNumbers(sel, level, { align: false });
      }
    }
  }
  return { pools, report: synthReport(pools, d.configHash, d.commit) };
}

const fx = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const sx = (x: number) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(3) : '-');

/** Main table: pooled F50 all / per instrument, grid, edits ratio for kit B (dev) vs kit C (held-out), difference C - B. */
export function synthReport(pools: SynthOutcome['pools'], configHash: string, commit?: string): string {
  const out = [`# Drum synthetic held-out (kit C) vs dev (kit B), config ${configHash}, commit ${commit ?? '-'}; main level S-9`, ''];
  for (const level of SYNTH_LEVELS) {
    out.push(`## ${level}`, '', '| D | item | dev B | held-out C | C - B |', '| --- | --- | --- | --- | --- |');
    for (const dl of D_LEVELS) {
      const b = pools.B?.[level]?.[dl];
      const c = pools.C?.[level]?.[dl];
      if (!b || !c) continue;
      const row = (item: string, x: number, y: number) => out.push(`| ${dl} | ${item} | ${fx(x)} | ${fx(y)} | ${sx(y - x)} |`);
      row('all', countF(b.all), countF(c.all));
      for (const inst of [...new Set([...Object.keys(b.perInst), ...Object.keys(c.perInst)])].sort()) {
        const nb = b.perInst[inst];
        const nc = c.perInst[inst];
        if ((nb?.nRef ?? 0) + (nc?.nRef ?? 0) === 0) continue;
        row(`${inst} (n ${nb?.nRef ?? 0}/${nc?.nRef ?? 0})`, nb ? countF(nb) : NaN, nc ? countF(nc) : NaN);
      }
      row('grid', countF(b.grid), countF(c.grid));
      row('edits/kbd', b.edits / b.keyboard, c.edits / c.keyboard);
    }
    out.push('');
  }
  out.push('## Detail (pooled, all D-levels per kit)', '');
  for (const kit of ['B', 'C']) for (const level of SYNTH_LEVELS) for (const dl of D_LEVELS) {
    const p = pools[kit]?.[level]?.[dl];
    if (p) out.push(`### kit ${kit} ${dl}`, '', renderPool(p, { perTakeRows: false }));
  }
  return out.join('\n') + '\n';
}

function realDeps(): SynthDeps {
  const man = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')).variants as (SynEntry & { wav: string; truth: string; bpm: number; ts: [number, number]; startSec: number })[];
  const cfg = loadConfig();
  const commit = gitCommit();
  return {
    variants: man,
    readLog: () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : null),
    appendLog: (line) => {
      mkdirSync(join(ROOT, 'out', 'results'), { recursive: true });
      appendFileSync(LOG, line + '\n', 'utf8');
    },
    porcelain: gitPorcelain,
    now: () => new Date().toISOString(),
    configHash: drumConfigHash(cfg),
    commit,
    analyze: (name, level) => {
      const v = man.find((x) => x.name === name)!;
      const run = runFile(join(OUT, v.wav), { bpm: v.bpm, ts: v.ts, startSec: v.startSec }, cfg, commit, 'synthetic', level);
      // the truth is read only now, after the analysis
      const truth = JSON.parse(readFileSync(join(OUT, v.truth), 'utf8')) as { drum: { truth: DrumTruth } };
      return { id: name, truth: truth.drum.truth, result: run.result };
    },
  };
}

function main(argv: string[]): number {
  if (argv.length !== 1 || argv[0] !== '--final-synth') throw new UsageError('usage: synth_heldout_eval.ts --final-synth (no other options; runs once)');
  const out = runSynthEval(realDeps());
  const dir = join(ROOT, 'out', 'heldout-eval', 'synth');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.md'), out.report, 'utf8');
  process.stdout.write(out.report);
  process.stderr.write(`done: ${resolve(dir, 'summary.md')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}

/**
 * End-to-end parity (plan section 4 "通し", T14): Python's 22050 Hz y (y.f32, resampling taken out) -> TS
 * analyze -> result JSON, compared with Python's result.json for every dumped dev variant.
 * Exact: structure, strings, integers (beat count, bars, downbeat phase, time signature, section bars /
 * labels, chord segment labels and '?', key and per-bar key runs). Floats: beat / section / chord times within 1e-6 s
 * (Python's y in; the beat stage is exact with Python's inputs; measured 0), confidences / probs within 1e-4
 * (they pass through the CQT, which matches only to cosine .9999; measured max 9.4e-6). analyzer.timingsSec
 * is the only field allowed to differ.
 * Prints one row per variant (beats max ms, chord segments, '?' agreement, phase, sections, keys).
 * Network is stubbed out (stubNoNetwork) for every run. Skips cleanly without out/parity (CI). Dev synthetic variants only (dump_stages.py refuses the others).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { readMeta, readStage } from '../parity/stageFile';
import { analyze } from './analyze';
import { DEFAULT_CONFIG } from './config';
import type { TsAnalysisResult } from './result';

const PARITY = join(import.meta.dirname, '../../out/parity');
const variants = existsSync(PARITY)
  ? readdirSync(PARITY)
      .filter((v) => existsSync(join(PARITY, v, 'result.json')) && existsSync(join(PARITY, v, 'y.f32')))
      .sort()
  : [];

// Times: the beat stage is exact with Python's y in. Other floats (confidences, probs, key / downbeat
// confidence) pass through the CQT, which matches to cosine .9999 only (plan section 4), so 1e-4 here.
const TIME_TOL = 1e-6;
const FLOAT_TOL = 1e-4;

export interface ResultDiff {
  /** paths where structure / strings / integers differ */
  exact: string[];
  /** max |diff| per float group */
  /** beat / chord / section times and durationSec */
  maxTimeSec: number;
  maxFloat: number;
  maxFloatPath: string;
  chordSegs: [number, number];
  labelsEqual: boolean;
  qAgree: number;
  phase: [number, number];
  sections: string;
  keys: string;
}

/** Deep compare; floats (non-integers or under key lists) within tolerance, everything else exact. */
export function diffResults(ts: TsAnalysisResult, py: Record<string, unknown>): ResultDiff {
  const exact: string[] = [];
  let maxFloat = 0;
  let maxFloatPath = '';
  let maxTimeSec = 0;
  const walk = (a: unknown, b: unknown, path: string) => {
    if (path === '.analyzer.timingsSec') return;
    if (typeof a === 'number' && typeof b === 'number') {
      const isFloat = !Number.isInteger(a) || !Number.isInteger(b);
      if (!isFloat) {
        if (a !== b && !/\.(t|start|end|durationSec|confidence|prob)$/.test(path)) exact.push(`${path}: ${a} != ${b}`);
        else if (a !== b && /\.(t|start|end|durationSec)$/.test(path)) maxTimeSec = Math.max(maxTimeSec, Math.abs(a - b));
        else if (a !== b) maxFloat = Math.max(maxFloat, Math.abs(a - b));
        return;
      }
      const d = Math.abs(a - b);
      if (/\.(t|start|end|durationSec)$/.test(path)) {
        maxTimeSec = Math.max(maxTimeSec, d);
        return;
      }
      if (d > maxFloat) {
        maxFloat = d;
        maxFloatPath = path;
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) exact.push(`${path}: length ${a.length} != ${b.length}`);
      for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.join() !== kb.join()) exact.push(`${path}: keys [${ka}] != [${kb}]`);
      for (const k of ka) if (k in (b as object)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      return;
    }
    if (a !== b) exact.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  walk(ts, py, '');
  const pyc = py.chords as { text: string }[];
  const n = Math.min(ts.chords.length, pyc.length);
  let q = 0;
  for (let i = 0; i < n; i++) if (ts.chords[i].text.endsWith('?') === pyc[i].text.endsWith('?')) q++;
  const pyBeats = py.beats as { downbeat: boolean }[];
  const ph = (bs: { downbeat: boolean }[]) => bs.findIndex((b) => b.downbeat);
  const pySecs = py.sections as { label: string }[];
  const pyKeys = (py.keys ?? []) as { startBar: number; tonic: string; mode: string }[];
  const keyStr = (ks: { startBar: number; tonic: string; mode: string }[]) =>
    ks.map((k) => `${k.startBar}:${k.tonic}${k.mode === 'minor' ? 'm' : ''}`).join(' ');
  return {
    exact,
    maxTimeSec,
    maxFloat,
    maxFloatPath,
    chordSegs: [ts.chords.length, pyc.length],
    labelsEqual: ts.chords.length === pyc.length && ts.chords.every((c, i) => c.text === pyc[i].text),
    qAgree: n ? q / n : 1,
    phase: [ph(ts.beats), ph(pyBeats)],
    sections:
      ts.sections.map((s) => s.label).join('') === pySecs.map((s) => s.label).join('')
        ? `= ${ts.sections.map((s) => s.label).join('')}`
        : `${ts.sections.map((s) => s.label).join('')} / ${pySecs.map((s) => s.label).join('')}`,
    keys: keyStr(ts.keys ?? []) === keyStr(pyKeys) ? `= ${keyStr(pyKeys)}` : `${keyStr(ts.keys ?? [])} / ${keyStr(pyKeys)}`,
  };
}

describe.skipIf(variants.length === 0)('analyze end to end vs Python result.json (Python y in)', () => {
  // files are read before analyze; the analysis itself must not touch the network
  beforeEach(() => stubNoNetwork());
  afterEach(() => vi.unstubAllGlobals());
  it.each(variants)('%s', (v) => {
    const dir = join(PARITY, v);
    const meta = readMeta(dir);
    const y = readStage(dir, 'y', meta).data;
    const py = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Record<string, unknown>;
    const cfgPy = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as unknown;
    expect(cfgPy).toEqual(DEFAULT_CONFIG);
    const out = analyze(y);
    const d = diffResults(out.result, py);
    const t = out.result.analyzer.timingsSec ?? {};
    console.log(
      `[T14] ${v}: beats ${out.result.beats.length} maxΔt ${(d.maxTimeSec * 1000).toExponential(1)} ms | chords ${d.chordSegs[0]}/${d.chordSegs[1]} labels ${d.labelsEqual ? '=' : '≠'} ?agree ${(d.qAgree * 100).toFixed(1)}% | phase ${d.phase[0]}/${d.phase[1]} | sections ${d.sections} | keys ${d.keys} | maxFloat ${d.maxFloat.toExponential(1)} ${d.maxFloatPath} | exact diffs ${d.exact.length}${d.exact.length ? ' ' + d.exact.slice(0, 5).join('; ') : ''} | total ${t.total}s peak ${(out.mem.peak / 2 ** 20).toFixed(0)} MB`,
    );
    expect(d.exact).toEqual([]);
    expect(d.maxTimeSec).toBeLessThanOrEqual(TIME_TOL);
    expect(d.maxFloat).toBeLessThanOrEqual(FLOAT_TOL);
  }, 300_000);
});

/**
 * CI parity check (T19): the committed fixture (a trimmed dev synthetic variant, Python's 22050 Hz y plus
 * Python's result.json, see fixtures/) goes through the TS analyze() and the whole result JSON is compared with
 * Python's, same rules as py/tools/parity_report.py: every field except analyzer.timingsSec; structure, strings,
 * booleans and integers exact; times (t / start / end / durationSec) within 1e-6 s; other floats within 1e-4.
 * Unlike the *.parity.test.ts files that read gitignored out/parity, this one always runs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../dsp/analyze';
import { DEFAULT_CONFIG } from '../dsp/config';
import { readMeta, readStage } from './stageFile';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const TIME_TOL = 1e-6;
const FLOAT_TOL = 1e-4;
const TIME_KEYS = new Set(['t', 'start', 'end', 'durationSec']);

export function compareResults(a: unknown, b: unknown): { diffs: string[]; maxTime: number; maxFloat: number } {
  const diffs: string[] = [];
  let maxTime = 0;
  let maxFloat = 0;
  const walk = (x: unknown, y: unknown, path: string, key: string | null) => {
    if (path === '.analyzer.timingsSec') return;
    if (typeof x === 'number' && typeof y === 'number') {
      if (Number.isInteger(x) && Number.isInteger(y) && !(key !== null && TIME_KEYS.has(key))) {
        if (x !== y) diffs.push(`${path}: ${x} != ${y}`);
        return;
      }
      const d = Math.abs(x - y);
      if (key !== null && TIME_KEYS.has(key)) {
        maxTime = Math.max(maxTime, d);
        if (!(d <= TIME_TOL)) diffs.push(`${path}: time ${x} vs ${y}`);
      } else {
        maxFloat = Math.max(maxFloat, d);
        if (!(d <= FLOAT_TOL)) diffs.push(`${path}: float ${x} vs ${y}`);
      }
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) {
        diffs.push(`${path}: length ${x.length} != ${y.length}`);
        return;
      }
      x.forEach((v, i) => walk(v, y[i], `${path}[${i}]`, key));
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const kx = Object.keys(x).sort();
      const ky = Object.keys(y).sort();
      if (kx.join() !== ky.join()) diffs.push(`${path}: keys [${kx}] != [${ky}]`);
      for (const k of kx) if (k in y) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`, k);
      return;
    }
    if (x !== y) diffs.push(`${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
  };
  walk(a, b, '', null);
  return { diffs, maxTime, maxFloat };
}

describe('compareResults (helper)', () => {
  const base = () => ({ beats: [{ t: 1, downbeat: true }], chords: [{ text: 'C', confidence: 0.9 }], n: 3, analyzer: { timingsSec: { total: 1 } } });
  it('ignores timingsSec, accepts tolerances, reports the first differing path', () => {
    const b = base();
    b.analyzer.timingsSec.total = 50;
    b.beats[0].t = 1 + 5e-7;
    b.chords[0].confidence += 5e-5;
    expect(compareResults(base(), b).diffs).toEqual([]);
    b.beats[0].t = 1 + 2e-6;
    b.n = 4;
    b.chords[0].text = 'D';
    expect(compareResults(base(), b).diffs.map((d) => d.split(':')[0])).toEqual(['.beats[0].t', '.chords[0].text', '.n']);
  });
});

const fixtures = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((v) => existsSync(join(FIXTURES, v, 'result.json'))) : [];

describe('committed fixture: analyze(Python y) equals Python result.json', () => {
  it('has at least one fixture (CI must not pass vacuously)', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });
  it.each(fixtures)('%s', (v) => {
    const dir = join(FIXTURES, v);
    const meta = readMeta(dir);
    const y = readStage(dir, 'y', meta).data;
    const py = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as unknown;
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual(DEFAULT_CONFIG);
    const out = analyze(y);
    const d = compareResults(JSON.parse(JSON.stringify(out.result)), py);
    expect(d.diffs).toEqual([]);
    console.log(`[T19] ${v}: maxTime ${d.maxTime.toExponential(1)} s, maxFloat ${d.maxFloat.toExponential(1)}`);
  }, 120_000);
});

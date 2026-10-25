import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { UsageError, gate, parseArgs, roundTripOk, runAll, runFile } from './cli';
import { resolveDrumConfig } from './config';
import { selectVariants, type EvalVariant } from './onset_eval';

const OUT = join(import.meta.dirname, '..', '..', 'out', 'drum');
const have = existsSync(join(OUT, 'manifest.json'));
type V = EvalVariant & { bpm: number; ts: [number, number]; startSec: number };
const manifest = have ? (JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: V[] }) : { variants: [] as V[] };

describe('parseArgs', () => {
  it('reads the options', () => {
    const a = parseArgs(['x.wav', '--bpm', '100', '--ts', '3/4', '--start', '-0.2', '--look-point', '3', '--take', 'drm-01-a', '--take', 'drm-02-b']);
    expect(a).toMatchObject({ input: 'x.wav', bpm: 100, ts: [3, 4], start: -0.2, lookPoint: 3, takes: ['drm-01-a', 'drm-02-b'] });
    expect(parseArgs(['--all']).splits).toEqual(['tuning', 'dev']);
  });
  it('rejects unknown options and a bad look point', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--look-point', '4'])).toThrow(UsageError);
    expect(() => parseArgs(['--ts', '44'])).toThrow(UsageError);
  });
});

describe.skipIf(!have)('held-out guard in the CLI (needs out/drum)', () => {
  const held = manifest.variants.filter((v) => v.heldOut);
  it('--all refuses a held-out split, and --only a held-out name never selects it', () => {
    expect(() => runAll({ splits: ['heldOut'] }, undefined, () => {})).toThrow(/held-out/);
    expect(() => runAll({ splits: ['tuning', 'dev'], only: held[0].name }, undefined, () => {})).toThrow(/held-out/);
    expect(selectVariants(manifest.variants, ['tuning', 'dev']).some((v) => v.heldOut)).toBe(false);
  });
  it('single-file mode refuses held-out files (kit C) without a look point, and with look point 2', () => {
    expect(held.length).toBeGreaterThan(0);
    for (const v of held.slice(0, 5)) {
      expect(() => gate(join(OUT, v.wav), {}, 'h', undefined)).toThrow(/held-out/);
      expect(() => gate(v.name, { lookPoint: 2 }, 'h', undefined)).toThrow(/once/);
    }
    expect(manifest.variants.filter((v) => v.kit === 'C').every((v) => v.heldOut)).toBe(true);
  });
  it('lets tuning / dev files through', () => {
    const dev = manifest.variants.find((v) => !v.heldOut)!;
    expect(gate(join(OUT, dev.wav), {}, 'h', undefined)).toBe(false);
  });
});

describe.skipIf(!have)('end to end on tuning + dev synthetic (needs out/drum)', () => {
  beforeEach(() => stubNoNetwork());
  afterEach(() => vi.unstubAllGlobals());
  const all = selectVariants(manifest.variants, ['tuning', 'dev']) as V[];

  it('every 9th tuning/dev file analyzes without network and its DrumEvent[] round-trips through parseDrums', () => {
    const cfg = resolveDrumConfig({});
    const sample = all.filter((_, i) => i % 9 === 0);
    expect(sample.length).toBeGreaterThan(20);
    const bad: string[] = [];
    for (const v of sample) {
      const run = runFile(join(OUT, v.wav), { bpm: v.bpm, ts: v.ts, startSec: v.startSec }, cfg, undefined, 'synthetic');
      if (!roundTripOk(run.text)) bad.push(v.name);
    }
    expect(bad).toEqual([]);
  }, 180_000);

  it('--all writes results, scores, tex, summary and run.json for a small selection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drum-cli-'));
    const s = runAll({ splits: ['tuning', 'dev'], only: 'syn-d0-rock8-kA-s*', results: dir }, 'abc1234', () => {});
    expect(s.files).toBeGreaterThan(0);
    expect(s.failures).toEqual([]);
    expect(s.roundTrip).toEqual({ ok: s.files, failed: 0 });
    expect(s.commit).toBe('abc1234');
    const files = readdirSync(dir);
    for (const f of ['summary.md', 'run.json', 'syn-d0-rock8-kA-s1.json', 'syn-d0-rock8-kA-s1.tex', 'syn-d0-rock8-kA-s1.score.json']) expect(files).toContain(f);
    const md = readFileSync(join(dir, 'summary.md'), 'utf8');
    expect(md).toContain('a3e68494763b');
    expect(md).toMatch(/tuning D0 kA/);
    const r = JSON.parse(readFileSync(join(dir, 'syn-d0-rock8-kA-s1.json'), 'utf8'));
    expect(r.drum.meta.commit).toBe('abc1234');
  }, 120_000);
});

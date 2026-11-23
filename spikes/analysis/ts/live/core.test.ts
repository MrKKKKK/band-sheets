/**
 * LT1 tests (docs/live-chord-tool-plan.md section 6): self-made synthetic chords only (synth.ts; no recording, no tuning
 * material). The 7th cases assert what each row DOES on these signals (observed, deterministic), not that it is right.
 */
import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyze, type Chords2Input } from '../chords2/analyze';
import { resolveChords2Config, T7C_E1_CANDIDATE_THETA, type Chords2Config } from '../chords2/config';
import { f1Beats, octaveCqt } from '../chords2/front/f1';
import { foldF1 } from '../chords2/octaveChroma';
import { hpss } from '../dsp/audio';
import { chordName, DEFAULT_CHORDS_CONFIG, estimateChords } from '../dsp/chords';
import { chordColumns } from '../dsp/chroma';
import type { BarKey } from '../dsp/keytrack';
import { segmentCandidates } from '../dsp/posterior';
import { states as v1aStates } from '../dsp/vocab';
import { analyzeWindow, ANALYZER_SR, calibrate, GATE_DBFS, measureGainDb, measureTuning, WAIT_SEC, type WindowCtx, type WindowResult } from './core';
import { chordSignal } from './synth';
import { candidateConfig, VARIANTS, variantById, type Variant, type VariantId } from './variants';

const SR = ANALYZER_SR;
const W = 1;
const CTX: WindowCtx = { tuning: 0, gainDb: 0, colStart: WAIT_SEC, colEnd: WAIT_SEC + W };
const SIGNALS = {
  C: [36, 60, 64, 67],
  Am: [45, 57, 60, 64],
  C7: [36, 60, 64, 67, 70],
  G7: [43, 55, 59, 62, 65],
  Cmaj7: [36, 60, 64, 67, 71],
  'C/E': [40, 60, 64, 67],
  'C#': [37, 61, 65, 68],
} as const;
type Sig = keyof typeof SIGNALS;
const signal = (s: Sig, db = -22): Float32Array => chordSignal(SIGNALS[s], SR, W + 2 * WAIT_SEC, db);

/** s8-cand with θ_c .5 (test only: the wiring; the real row is unavailable while T7C_E1_CANDIDATE_THETA is null). */
const CAND_TEST: Variant = { ...variantById('s8-cand'), logic: { kind: 'chords2', cfg: candidateConfig(0.5) } };
const RUNNABLE: Variant[] = VARIANTS.map((v) => (v.logic ? v : CAND_TEST));

const cache = new Map<string, Extract<WindowResult, { kind: 'chord' }>>();
function chord(id: VariantId, s: Sig, ctx: Partial<WindowCtx> = {}): Extract<WindowResult, { kind: 'chord' }> {
  const k = `${id}|${s}|${JSON.stringify(ctx)}`;
  let r = cache.get(k);
  if (!r) {
    const out = analyzeWindow(RUNNABLE.find((v) => v.id === id)!, signal(s), { ...CTX, ...ctx });
    if (out.kind !== 'chord') throw new Error(`${id} on ${s}: ${out.kind}`);
    cache.set(k, (r = out));
  }
  return r;
}

describe('variants', () => {
  it('has the six rows of plan section 2, in order, with Japanese labels', () => {
    expect(VARIANTS.map((v) => v.id)).toEqual(['v1a', 'base', 's7-V1', 's8-D2', 's8-D1', 's8-cand']);
    for (const v of VARIANTS) expect(v.label + v.note).toMatch(/[぀-ヿ一-鿿]/);
  });

  it('s8-cand is unavailable (greyed, with the reason) exactly while T7C_E1_CANDIDATE_THETA is null', () => {
    const v = variantById('s8-cand');
    expect(v.logic === null).toBe(T7C_E1_CANDIDATE_THETA === null);
    if (v.logic === null) {
      const r = analyzeWindow(v, signal('C'), CTX);
      expect(r.kind).toBe('unavailable');
      expect(r.kind === 'unavailable' && r.reason).toContain('T7C_E1_CANDIDATE_THETA');
    }
  });
});

describe('every row on the synthetic triads', () => {
  for (const v of RUNNABLE) {
    it(`${v.id}: C -> C, Am -> Am (answer and the top state)`, () => {
      for (const s of ['C', 'Am'] as const) {
        const r = chord(v.id, s);
        expect(r.answer).toBe(s);
        expect(r.top[0].name).toBe(s);
        expect(r.ruleChanged).toBe(false);
      }
    });

    it(`${v.id}: at most 5, pct sums to <= 100, ordered by pct and by s`, () => {
      for (const s of ['C', 'Am', 'G7'] as const) {
        const { top } = chord(v.id, s);
        expect(top.length).toBeLessThanOrEqual(5);
        expect(top.reduce((a, t) => a + t.pct, 0)).toBeLessThanOrEqual(100 + 1e-9);
        for (let i = 1; i < top.length; i++) {
          expect(top[i].pct).toBeLessThanOrEqual(top[i - 1].pct);
          expect(top[i].s).toBeLessThanOrEqual(top[i - 1].s + 1e-12);
        }
      }
    });
  }

  it('F1 rows list F1 notes (the bass C2 first on C) and the others none; every row but v1a reads the bass', () => {
    for (const v of RUNNABLE) {
      const r = chord(v.id, 'C');
      const f1 = v.logic?.kind === 'chords2' && v.logic.cfg.f1 !== undefined;
      expect(r.f1Notes?.[0]).toBe(f1 ? 'C2' : undefined);
      expect(r.bass?.note).toBe(v.id === 'v1a' ? undefined : 'C');
    }
  });
});

describe('v1a is the existing functions called directly (no reimplementation)', () => {
  it('names and % equal hpss -> chordColumns -> estimateChords -> segmentCandidates', () => {
    for (const s of ['C', 'Am', 'G7', 'C/E'] as const) {
      const y = signal(s);
      const cols = chordColumns(hpss(y).yHarm, [CTX.colStart], CTX.colEnd, { perBeat: 1, tuningFull: 0, tuningBass: 0 });
      const [col] = estimateChords(cols.cChroma, 1, DEFAULT_CHORDS_CONFIG, { perBeat: 1 });
      const want = segmentCandidates(col.posterior as Float64Array, v1aStates(DEFAULT_CHORDS_CONFIG), 1, 0, 1, 5);
      const r = chord('v1a', s);
      expect(r.answer).toBe(chordName(col.root, col.quality));
      expect(r.top.map((t) => [t.name, t.pct])).toEqual(want.map((c) => [chordName(c.root, c.quality), c.prob * 100]));
    }
  });

  it('s is the gated cosine: G = plain cosine, G7 = seventh_weight x cosine (computed here from the chroma)', () => {
    const cols = chordColumns(hpss(signal('G7')).yHarm, [CTX.colStart], CTX.colEnd, { perBeat: 1, tuningFull: 0, tuningBass: 0 });
    const c = Array.from(cols.cChroma);
    const norm = Math.hypot(...c);
    const cos = (pcs: number[]) => pcs.reduce((a, j) => a + c[j] / norm, 0) / Math.sqrt(pcs.length);
    const s = Object.fromEntries(chord('v1a', 'G7').top.map((t) => [t.name, t.s]));
    expect(s.G).toBeCloseTo(cos([7, 11, 2]), 9);
    expect(s.G7).toBeCloseTo(DEFAULT_CHORDS_CONFIG.seventh_weight * cos([7, 11, 2, 5]), 9);
  });
});

describe('7th and slash signals: what each row does (observed on these signals, asserted exactly)', () => {
  it('C7: only s8-D1 names the 7th; D2 keeps C (ρ(10) below θ .8); s8-cand (θ .5) gives no candidate', () => {
    for (const v of RUNNABLE) expect([v.id, chord(v.id, 'C7').answer]).toEqual([v.id, v.id === 's8-D1' ? 'C7' : 'C']);
    const d2 = chord('s8-D2', 'C7').added!;
    expect(d2.theta).toBe(0.8);
    expect(d2.rho[10]).toBeLessThan(d2.theta);
    expect(chord('s8-cand', 'C7').added?.candidate).toBeNull();
  });

  it('G7: v1a reads G7; s8-D2 drops the 7th (G, "replaced by a rule", ρ(10) below θ)', () => {
    expect(chord('v1a', 'G7').answer).toBe('G7');
    const r = chord('s8-D2', 'G7');
    expect([r.top[0].name, r.answer, r.ruleChanged]).toEqual(['G7', 'G', true]);
    expect(r.added!.rho[10]).toBeLessThan(r.added!.theta);
  });

  it('Cmaj7: s8-D1 names Cmaj7; s8-cand (θ .5) shows Cmaj7 as the candidate, the answer stays C', () => {
    expect(chord('s8-D1', 'Cmaj7').answer).toBe('Cmaj7');
    const r = chord('s8-cand', 'Cmaj7');
    expect([r.answer, r.added?.candidate]).toEqual(['C', 'Cmaj7']);
  });

  it('C/E: v1a says C; base writes C/E (bass E, an inversion, "replaced by a rule")', () => {
    expect(chord('v1a', 'C/E').answer).toBe('C');
    const r = chord('base', 'C/E');
    expect([r.answer, r.ruleChanged, r.bass?.note, r.bass?.kind]).toEqual(['C/E', true, 'E', 'inversion']);
  });
});

describe('key and bars never change a score at n = 1 (plan section 3)', () => {
  it("the user's key changes only the spelling", () => {
    for (const v of RUNNABLE) {
      const plain = chord(v.id, 'C#');
      const db = chord(v.id, 'C#', { key: 'Db' });
      expect(plain.answer).toBe('C#');
      expect(db.answer).toBe('Db');
      expect(db.top.map((t) => [t.pct, t.s])).toEqual(plain.top.map((t) => [t.pct, t.s]));
    }
  });

  // the chords2 configs of the rows (+ the default V0) on columns and F1 beats of the synthetic signals
  const cfgs: [string, Chords2Config][] = [
    ['V0', resolveChords2Config()],
    ...RUNNABLE.flatMap((v): [string, Chords2Config][] => (v.logic?.kind === 'chords2' ? [[v.id, v.logic.cfg]] : [])),
  ];
  const inputs: Chords2Input[] = [];
  beforeAll(() => {
    const f1cfg = resolveChords2Config({ octaveChroma: true }).f1!;
    for (const s of ['C', 'Am', 'G7', 'Cmaj7'] as const) {
      const y = signal(s);
      const cols = chordColumns(hpss(y).yHarm, [CTX.colStart], CTX.colEnd, { perBeat: 1, tuningFull: 0, tuningBass: 0 });
      const beats = f1Beats(octaveCqt(y, f1cfg, { tuning: 0 }), [CTX.colStart], CTX.colEnd, f1cfg);
      inputs.push({ chroma: cols.cChroma, n: 1, perBeat: 1, barKeys: [], barOfBeat: [0], f1Beats: beats, f1Chroma: foldF1(beats, 1, f1cfg) });
    }
  });
  const keys: BarKey[] = [];
  for (let tonic = 0; tonic < 12; tonic++) for (const mode of ['major', 'minor'] as const) keys.push({ bar: 0, tonic, mode, confidence: 0.9 });

  for (const [name, cfg] of cfgs) {
    it(`chords2 ${name}: columns, posterior and segments are the same for every key and bar`, () => {
      for (const inp of inputs) {
        const ref = analyze({ ...inp, barKeys: [{ bar: 0, tonic: 0, mode: 'major', confidence: 0 }], barOfBeat: [0] }, cfg);
        for (const k of keys) for (const bar of [0, 7]) expect(analyze({ ...inp, barKeys: [{ ...k, bar }], barOfBeat: [bar] }, cfg)).toEqual(ref);
      }
    });
  }
});

describe('gate, gain, calibration', () => {
  it('a window below the gate is "quiet" (not analysed)', () => {
    const r = analyzeWindow(variantById('v1a'), signal('C', -70), CTX);
    expect(r.kind).toBe('quiet');
    expect(r.kind === 'quiet' && r.rmsDb).toBeLessThan(GATE_DBFS);
  });

  it('the session gain is applied after the gate: -50 dBFS is no chord without it, C with +28 dB', () => {
    const y = signal('C', -50);
    expect(analyzeWindow(variantById('v1a'), y, CTX).kind).toBe('noChord');
    const r = analyzeWindow(variantById('v1a'), y, { ...CTX, gainDb: 28 });
    expect(r.kind === 'chord' && r.answer).toBe('C');
  });

  it('calibrate = measureGainDb, then measureTuning on the gained copy; the input is not changed', () => {
    const y = signal('C', -40);
    const copy = y.slice();
    const g = measureGainDb(y);
    expect(g).toBeCloseTo(18, 1);
    const k = 10 ** (g / 20);
    expect(calibrate(y)).toEqual({ gainDb: g, tuning: measureTuning(y.map((v) => v * k)) });
    expect(y).toEqual(copy);
  });

  it('a window that does not fit the samples throws', () => {
    expect(() => analyzeWindow(variantById('v1a'), signal('C'), { ...CTX, colEnd: 10 })).toThrow(/does not fit/);
  });
});

describe('browser-safe', () => {
  /** Files and bare specifiers of the value-import graph of `entry` (`import type` / `export type` are erased). */
  const graph = (entry: string): { files: Set<string>; bare: string[] } => {
    const files = new Set<string>();
    const bare: string[] = [];
    const visit = (file: string): void => {
      if (files.has(file)) return;
      files.add(file);
      for (const m of readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (!spec.startsWith('.')) {
          bare.push(spec);
          continue;
        }
        const base = resolve(dirname(file), spec);
        if (/\.json$/.test(base) && existsSync(base)) continue; // data (tables), no imports
        const target = [base, `${base}.ts`, join(base, 'index.ts')].find((p) => p.endsWith('.ts') && existsSync(p));
        if (!target) throw new Error(`unresolved ${spec} from ${file}`);
        visit(target);
      }
    };
    visit(entry);
    return { files, bare };
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const nodeOnly = (specs: string[]): string[] => specs.filter((s) => s.startsWith('node:') || builtinModules.includes(s.split('/')[0]));

  it("no module in core.ts's import graph imports a Node built-in", () => {
    const { files, bare } = graph(join(here, 'core.ts'));
    expect(files.size).toBeGreaterThan(20);
    expect([...files].some((f) => f.endsWith('src/lib/transpose.ts'))).toBe(true);
    expect(nodeOnly(bare)).toEqual([]);
  });

  it('the walk does find Node imports (control: chords2/recScores.ts reads files)', () => {
    expect(nodeOnly(graph(join(here, '../chords2/recScores.ts')).bare)).toContain('node:fs');
  });
});

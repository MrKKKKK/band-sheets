/**
 * Parity of the theory prior and the 2nd chord pass against the Python dumps (plan section 4: exact with
 * Python's inputs; posterior within 1e-6, G1).
 * Inputs: Python's col_chroma, per_beat, bar_of_col, and the per-bar keys from keytrack.estimate on Python's
 * chords1 (float64 confidences, equal to the dumped bar_keys after float32 rounding -- checked here; the
 * dumped bar_keys themselves are float32-rounded, Python used float64).
 * Checks: every beat row of TheoryPrior vs chord_prior [nb, S, S] (float32 dump: diff <= half a float32 ulp
 * of the value), chords2_{root,quality,bass} exact, chords2_confidence / chords2_posterior within 1e-6.
 * Also: tier matrices and one hand-made key sequence vs Python float64 (out/t13/s3_tiers.json from
 * out/t13/s3_tiers.py), bit for bit. Skips cleanly without out/parity (CI).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMeta, readStage } from '../parity/stageFile';
import { beatLevel, DEFAULT_CHORDS_CONFIG } from './chords';
import { estimateChordsPass2, TheoryPrior, tierMatrix } from './harmony';
import { estimate, type BarKey, type KeyChord } from './keytrack';
import * as vocab from './vocab';

const OUT = join(import.meta.dirname, '../../out');
const PARITY = join(OUT, 'parity');
const NEEDED = ['col_chroma', 'per_beat', 'bar_of_col', 'bar_keys', 'sections', 'chords1_root', 'chords1_quality', 'chord_prior', 'chords2_root', 'chords2_quality', 'chords2_confidence', 'chords2_posterior'];
const variants = existsSync(PARITY)
  ? readdirSync(PARITY).filter((v) => {
      if (!existsSync(join(PARITY, v, 'meta.json'))) return false;
      const m = readMeta(join(PARITY, v));
      return NEEDED.every((s) => s in m.stages);
    })
  : [];
const cfg = DEFAULT_CHORDS_CONFIG;
const states = vocab.states(cfg);
const S = states.length;

/** Half a float32 ulp of |v| (the most a correct float64 value can differ from its float32 rounding). */
function halfUlp32(v: number): number {
  const a = Math.abs(v);
  if (a < 1.1754943508222875e-38) return 2 ** -150;
  return 2 ** (Math.floor(Math.log2(a)) - 24);
}

const REF = join(OUT, 't13', 's3_tiers.json');
describe.skipIf(!existsSync(REF))('harmony vs Python float64 (out/t13/s3_tiers.json)', () => {
  it('tier matrices and a key-change sequence are bit-identical', () => {
    const ref = JSON.parse(readFileSync(REF, 'utf8')) as {
      major: number[];
      minor: number[];
      case: { keys: [number, number, 'major' | 'minor', number][]; barOfCol: number[]; prior: number[]; shape: number[] };
    };
    for (const m of ['major', 'minor'] as const) expect(Array.from(tierMatrix(m))).toEqual(ref[m]);
    const keys: BarKey[] = ref.case.keys.map(([bar, tonic, mode, confidence]) => ({ bar, tonic, mode, confidence }));
    const p = new TheoryPrior(states, keys, ref.case.barOfCol);
    let maxD = 0;
    for (let t = 0; t < ref.case.shape[0]; t++) {
      const row = p.row(t);
      for (let i = 0; i < S * S; i++) maxD = Math.max(maxD, Math.abs(row[i] - ref.case.prior[t * S * S + i]));
    }
    console.log(`[T13] python float64 hand case: rows=${ref.case.shape[0]} maxAbsDiff=${maxD.toExponential(2)}`);
    expect(maxD).toBeLessThan(1e-15);
  });
});

describe.skipIf(variants.length === 0)('harmony / pass 2 parity (Python dumps)', () => {
  for (const v of variants) {
    it(`${v}: prior rows, pass-2 labels exact, posterior within 1e-6`, () => {
      const dir = join(PARITY, v);
      const meta = readMeta(dir);
      const st = (name: string) => readStage(dir, name, meta);
      const qualities = meta.qualities as string[];
      expect(states.map((s) => [s.root, s.quality])).toEqual(meta.states);

      // per-bar keys: keytrack on Python's chords1 (float64 confidences)
      const perBeat = st('per_beat').data[0];
      const r1 = st('chords1_root').data;
      const q1 = st('chords1_quality').data;
      const cols: KeyChord[] = Array.from(r1, (r, i) => ({ root: r < 0 ? null : r, quality: qualities[q1[i]] }));
      const barOfBeat = Array.from(st('bar_of_col').data);
      const secs = st('sections').data;
      const sectionBars = Array.from({ length: secs.length / 2 }, (_, i) => secs[2 * i]);
      const keys = estimate(beatLevel(cols, perBeat), barOfBeat, sectionBars).keys;
      const bk = st('bar_keys');
      expect(keys.length).toBe(bk.shape[0]);
      keys.forEach((k, b) => {
        expect([k.bar, k.tonic, k.mode === 'major' ? 0 : 1, Math.fround(k.confidence)]).toEqual(Array.from(bk.data.subarray(4 * b, 4 * b + 4)));
      });

      // prior rows vs chord_prior [nb, S, S]
      const cp = st('chord_prior');
      const nb = barOfBeat.length;
      expect(cp.shape).toEqual([nb, S, S]);
      const p = new TheoryPrior(states, keys, barOfBeat);
      let priorMax = 0;
      let overUlp = 0;
      for (let t = 0; t < nb; t++) {
        const row = p.row(t);
        const off = t * S * S;
        for (let i = 0; i < S * S; i++) {
          const d = Math.abs(row[i] - cp.data[off + i]);
          priorMax = Math.max(priorMax, d);
          if (d > halfUlp32(row[i]) && Math.fround(row[i]) !== cp.data[off + i]) overUlp++;
        }
      }

      // pass 2
      const chroma = st('col_chroma');
      const n = chroma.shape[1];
      const t0 = performance.now();
      const got = estimateChordsPass2(chroma.data, n, cfg, { perBeat, barKeys: keys, barOfBeat });
      const ms = performance.now() - t0;
      const root = st('chords2_root').data;
      const qual = st('chords2_quality').data;
      const bass = st('chords2_bass').data;
      const conf = st('chords2_confidence').data;
      const post = st('chords2_posterior').data;
      let labelMismatch = 0;
      let confMax = 0;
      let postMax = 0;
      got.forEach((c, t) => {
        const r = root[t] < 0 ? null : root[t];
        const b = bass[t] < 0 ? null : bass[t];
        if (c.root !== r || (r !== null && c.quality !== qualities[qual[t]]) || c.bass !== b) labelMismatch++;
        confMax = Math.max(confMax, Math.abs(c.confidence - conf[t]));
        for (let i = 0; i < S; i++) postMax = Math.max(postMax, Math.abs(c.posterior![i] - post[i * n + t]));
      });
      let changed = 0; // columns where the prior changed the label vs pass 1 (shows the test has teeth)
      for (let t = 0; t < n; t++) if (r1[t] !== root[t] || q1[t] !== qual[t]) changed++;
      console.log(
        `[T13] ${v} nb=${nb} n=${n} priorMaxDiff=${priorMax.toExponential(2)} priorOverHalfUlp=${overUlp} rowsComputed=${p.computed} ` +
          `labelMismatch=${labelMismatch} pass1->2 changed=${changed} confMaxDiff=${confMax.toExponential(2)} postMaxDiff=${postMax.toExponential(2)} ${ms.toFixed(0)}ms`,
      );
      expect(overUlp).toBe(0);
      expect(labelMismatch).toBe(0);
      expect(confMax).toBeLessThan(1e-6);
      expect(postMax).toBeLessThan(1e-6);
    }, 60_000);
  }
});

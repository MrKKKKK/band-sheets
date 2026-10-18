/**
 * Parity of the key stages against the Python dumps (plan section 4: exact with Python's inputs).
 * keyest: beat_chroma -> key_tonic / key_mode exact, confidence vs result.json's float64 value (the dumped
 * beat_chroma is float32-rounded; Python on that same rounded input differs from its own float64 result by
 * <= 3.1e-8 on every dev variant, out/t12/ref.py), so 1e-7.
 * keytrack: chords1_{root,quality} at beat level (per_beat), bar_of_col, sections start bars ->
 * bar_keys [K, 4] exact in bar / tonic / mode, confidence equal after float32 rounding (inputs are exact
 * integers, so only the dump's rounding separates them); the keytrack-not-converged flag vs result.json.
 * Skips cleanly without out/parity (CI).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMeta, readStage } from '../parity/stageFile';
import { beatLevel, NOTE_NAMES } from './chords';
import { estimateKey } from './keyest';
import { estimate, NOT_CONVERGED_WARNING, type KeyChord } from './keytrack';

const PARITY = join(import.meta.dirname, '../../out/parity');
const NEEDED = ['beat_chroma', 'chords1_root', 'chords1_quality', 'per_beat', 'bar_of_col', 'sections', 'bar_keys', 'key_tonic', 'key_mode', 'key_confidence', 'downbeat_phase', 'downbeat_beats_per_bar'];
const variants = existsSync(PARITY)
  ? readdirSync(PARITY).filter((v) => {
      if (!existsSync(join(PARITY, v, 'meta.json')) || !existsSync(join(PARITY, v, 'result.json'))) return false;
      const m = readMeta(join(PARITY, v));
      return NEEDED.every((s) => s in m.stages);
    })
  : [];

interface ResultJson {
  key: { tonic: string; mode: string; confidence: number } | null;
  analyzer: { warnings?: string[] };
}

describe.skipIf(variants.length === 0)('key parity (Python dumps)', () => {
  for (const v of variants) {
    it(`${v}: global key, bar keys, not-converged flag`, () => {
      const dir = join(PARITY, v);
      const meta = readMeta(dir);
      const qualities = meta.qualities as string[];
      const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as ResultJson;
      const st = (name: string) => readStage(dir, name, meta);

      // global key
      const chroma = st('beat_chroma');
      const g = estimateKey(chroma.data, chroma.shape[1]);
      expect(NOTE_NAMES.indexOf(g.tonic as (typeof NOTE_NAMES)[number])).toBe(st('key_tonic').data[0]);
      expect(g.mode).toBe(st('key_mode').data[0] === 0 ? 'major' : 'minor');
      expect(result.key && [result.key.tonic, result.key.mode]).toEqual([g.tonic, g.mode]);
      const gDiff = Math.abs(g.confidence - result.key!.confidence);
      expect(gDiff).toBeLessThan(1e-7);

      // per-bar keys
      const root = st('chords1_root').data;
      const qual = st('chords1_quality').data;
      const cols: KeyChord[] = Array.from(root, (r, i) => ({ root: r < 0 ? null : r, quality: qualities[qual[i]] }));
      const perBeat = st('per_beat').data[0];
      const chords = beatLevel(cols, perBeat);
      const nBeats = chroma.shape[1];
      const phase = st('downbeat_phase').data[0];
      const bpb = st('downbeat_beats_per_bar').data[0];
      const barOfCol = Array.from({ length: nBeats }, (_, i) => Math.floor((i - phase) / bpb));
      expect(barOfCol).toEqual(Array.from(st('bar_of_col').data));
      const secs = st('sections').data;
      const sectionBars = Array.from({ length: secs.length / 2 }, (_, i) => secs[2 * i]);
      const t0 = performance.now();
      const got = estimate(chords, barOfCol, sectionBars);
      const ms = performance.now() - t0;

      const want = st('bar_keys');
      const K = want.shape[0];
      expect(got.keys.length).toBe(K);
      let confDiff = 0;
      let keyMismatch = 0;
      for (let b = 0; b < K; b++) {
        const w = want.data.subarray(b * 4, b * 4 + 4);
        const k = got.keys[b];
        if (k.bar !== w[0] || k.tonic !== w[1] || (k.mode === 'major' ? 0 : 1) !== w[2]) keyMismatch++;
        confDiff = Math.max(confDiff, Math.abs(Math.fround(k.confidence) - w[3]));
      }
      const flag = (result.analyzer.warnings ?? []).includes(NOT_CONVERGED_WARNING);
      console.log(
        `[T12] ${v} global=${g.tonic}${g.mode === 'minor' ? 'm' : ''} dConf=${gDiff.toExponential(2)} bars=${K} keyMismatch=${keyMismatch} ` +
          `barConfF32Diff=${confDiff.toExponential(2)} passes=${got.passes} converged=${got.converged} pyFlag=${flag} ${ms.toFixed(1)}ms`,
      );
      expect(keyMismatch).toBe(0);
      expect(confDiff).toBe(0);
      expect(!got.converged).toBe(flag);
    });
  }
});

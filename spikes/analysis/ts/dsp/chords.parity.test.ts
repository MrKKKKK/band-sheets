/**
 * Parity of the chord stage against the Python dumps (plan section 4: labels identical, posterior within
 * 1e-9). Input = Python's col_chroma (+ per_beat); pass 2 additionally gets Python's chord_prior.
 * Skips cleanly when out/parity is absent (CI).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMeta, readStage } from '../parity/stageFile';
import { DEFAULT_CHORDS_CONFIG, chordText, estimateChords, mergeSegments, NOTE_NAMES, type ColumnChord } from './chords';
import * as vocab from './vocab';

const PARITY = join(import.meta.dirname, '../../out/parity');
const variants = existsSync(PARITY)
  ? readdirSync(PARITY).filter((v) => existsSync(join(PARITY, v, 'meta.json')))
  : [];
const cfg = DEFAULT_CHORDS_CONFIG;

interface Expected {
  root: Float32Array;
  quality: Float32Array;
  confidence: Float32Array;
  posterior: Float32Array;
}

function maxAbs(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function compare(dir: string, pass: 'chords1' | 'chords2'): { labelMatch: number; postMax: number; confMax: number } {
  const meta = readMeta(dir);
  const qualities = meta.qualities as string[];
  const states = meta.states as [number, string][];
  const sts = vocab.states(cfg);
  expect(sts.map((s) => [s.root, s.quality])).toEqual(states);
  const chroma = readStage(dir, 'col_chroma', meta);
  const n = chroma.shape[1];
  const perBeat = readStage(dir, 'per_beat', meta).data[0];
  const prior = pass === 'chords2' ? readStage(dir, 'chord_prior', meta).data : null;
  const chords = estimateChords(chroma.data, n, cfg, { perBeat, prior });
  const exp: Expected = {
    root: readStage(dir, `${pass}_root`, meta).data,
    quality: readStage(dir, `${pass}_quality`, meta).data,
    confidence: readStage(dir, `${pass}_confidence`, meta).data,
    posterior: readStage(dir, `${pass}_posterior`, meta).data,
  };
  let same = 0;
  let postMax = 0;
  const conf = new Float64Array(n);
  chords.forEach((c, t) => {
    const r = exp.root[t] < 0 ? null : exp.root[t];
    if (c.root === r && (r === null || c.quality === qualities[exp.quality[t]])) same++;
    conf[t] = c.confidence;
    for (let i = 0; i < sts.length; i++) {
      postMax = Math.max(postMax, Math.abs((c.posterior as Float64Array)[i] - exp.posterior[i * n + t]));
    }
  });
  return { labelMatch: same / n, postMax, confMax: maxAbs(conf, exp.confidence) };
}

describe.skipIf(variants.length === 0)('chords parity (Python dumps)', () => {
  for (const v of variants) {
    const dir = join(PARITY, v);
    it(`${v}: pass 1 labels identical, posterior within 1e-6 (f32 dump)`, () => {
      const r = compare(dir, 'chords1');
      console.log(`[T7] ${v} pass1 labels=${(r.labelMatch * 100).toFixed(2)}% postMaxDiff=${r.postMax.toExponential(2)} confMaxDiff=${r.confMax.toExponential(2)}`);
      expect(r.labelMatch).toBe(1);
      // Python's posterior is float64 in memory but stored as float32: the dump itself rounds by up to 6e-8.
      expect(r.postMax).toBeLessThan(1e-6);
    });
    it(`${v}: pass 2 (given prior) labels identical`, () => {
      const meta = readMeta(dir);
      if (!meta.stages.chord_prior || !meta.stages.chords2_root) return;
      const r = compare(dir, 'chords2');
      console.log(`[T7] ${v} pass2 labels=${(r.labelMatch * 100).toFixed(2)}% postMaxDiff=${r.postMax.toExponential(2)}`);
      expect(r.labelMatch).toBe(1);
    });
    it(`${v}: pass 2 segments, '?' marks and candidates match result.json`, () => {
      const meta = readMeta(dir);
      if (!meta.stages.chord_prior || !existsSync(join(dir, 'result.json'))) return;
      const chroma = readStage(dir, 'col_chroma', meta);
      const n = chroma.shape[1];
      const perBeat = readStage(dir, 'per_beat', meta).data[0];
      const prior = readStage(dir, 'chord_prior', meta).data;
      const chords: ColumnChord[] = estimateChords(chroma.data, n, cfg, { perBeat, prior });
      const segs = mergeSegments(chords, cfg, perBeat).filter((s) => s.root !== null); // result.json omits no-chord gaps
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const result = JSON.parse(require('node:fs').readFileSync(join(dir, 'result.json'), 'utf8')) as {
        chords: { text: string; confidence: number; candidates: { root: string; quality: string; prob: number }[] }[];
      };
      expect(segs.length).toBe(result.chords.length);
      let maxP = 0;
      segs.forEach((s, i) => {
        const e = result.chords[i];
        const text = chordText({ root: s.root, quality: s.quality, bass: s.bass, confidence: s.confidence }, cfg);
        expect(text).toBe(e.text);
        expect(s.candidates.length).toBe(e.candidates.length);
        s.candidates.forEach((c, j) => {
          expect(NOTE_NAMES[c.root]).toBe(e.candidates[j].root);
          expect(c.quality).toBe(e.candidates[j].quality);
          maxP = Math.max(maxP, Math.abs(c.prob - e.candidates[j].prob));
        });
        maxP = Math.max(maxP, Math.abs(s.confidence - e.confidence));
      });
      console.log(`[T7] ${v} segments=${segs.length} max|conf/cand prob diff| vs result.json = ${maxP.toExponential(2)}`);
      expect(maxP).toBeLessThan(1e-6);
    });
  }
});

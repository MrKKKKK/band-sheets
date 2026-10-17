/**
 * Parity of the section rule against the Python dumps (plan section 4: boundaries and labels exactly
 * equal with Python's inputs). Inputs = beat_chroma, beat_bass, downbeat_phase / _beats_per_bar,
 * y, y_perc (len(y) / sr = duration) and the final beat times. Skips cleanly without out/parity (CI).
 *
 * Beat times: Python's are float64 and the dump rounds them to float32, which can move
 * round(t * sr) by a sample. Every tracked beat is an integer sample / sr (_refine: (j - w/2) / sr
 * with w even; unrefined beats: frame * hop / sr), so the test recovers the exact float64 values
 * from beat_times_tracked and re-applies the chosen tempo candidate (beats.ts `candidates`), checking
 * that both round back to the dumped float32 values.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMeta, readStage, type ParityMeta } from '../parity/stageFile';
import { candidates } from './beats';
import { findSections } from './sections';

const PARITY = join(import.meta.dirname, '../../out/parity');
const NEEDED = ['beat_chroma', 'beat_bass', 'beat_times', 'beat_times_tracked', 'downbeat_phase', 'downbeat_beats_per_bar', 'y', 'y_perc', 'sections'];
const variants = existsSync(PARITY)
  ? readdirSync(PARITY).filter((v) => {
      if (!existsSync(join(PARITY, v, 'meta.json'))) return false;
      const m = readMeta(join(PARITY, v));
      return NEEDED.every((s) => s in m.stages) && Array.isArray(m.sectionLabels);
    })
  : [];

/** Exact float64 beat times (see the header). */
function exactBeatTimes(dir: string, meta: ParityMeta, sr: number): Float64Array {
  const tracked32 = readStage(dir, 'beat_times_tracked', meta).data;
  const final32 = readStage(dir, 'beat_times', meta).data;
  const tracked = Float64Array.from(tracked32, (t) => Math.round(t * sr) / sr);
  tracked.forEach((t, i) => {
    if (Math.fround(t) !== tracked32[i]) throw new Error(`beat ${i}: ${tracked32[i]} is not an integer sample / sr`);
  });
  const same = (a: Float64Array) => a.length === final32.length && a.every((t, i) => Math.fround(t) === final32[i]);
  const hit = candidates(tracked).find(([, t]) => same(t));
  if (!hit) throw new Error('no tempo candidate reproduces beat_times');
  return hit[1];
}

describe.skipIf(variants.length === 0)('sections parity (Python dumps)', () => {
  for (const v of variants) {
    it(`${v}: boundaries and labels exact`, () => {
      const dir = join(PARITY, v);
      const meta = readMeta(dir);
      const sr = meta.sr as number;
      const chroma = readStage(dir, 'beat_chroma', meta);
      const y = readStage(dir, 'y', meta).data;
      const t0 = performance.now();
      const got = findSections({
        chroma: chroma.data,
        bass: readStage(dir, 'beat_bass', meta).data,
        nBeats: chroma.shape[1],
        beatTimes: exactBeatTimes(dir, meta, sr),
        phase: readStage(dir, 'downbeat_phase', meta).data[0],
        beatsPerBar: readStage(dir, 'downbeat_beats_per_bar', meta).data[0],
        y,
        yPerc: readStage(dir, 'y_perc', meta).data,
        sr,
        duration: y.length / sr,
      });
      const ms = performance.now() - t0;
      const eSecs = Array.from(readStage(dir, 'sections', meta).data);
      const gSecs = got.flatMap((s) => [s.startBar, s.endBar]);
      const gLab = got.map((s) => s.label);
      const eLab = meta.sectionLabels as string[];
      console.log(`[T11] ${v} got=${JSON.stringify(gSecs)} ${gLab.join('')} want=${JSON.stringify(eSecs)} ${eLab.join('')} ${ms.toFixed(1)}ms`);
      expect(gSecs).toEqual(eSecs);
      expect(gLab).toEqual(eLab);
    });
  }
});

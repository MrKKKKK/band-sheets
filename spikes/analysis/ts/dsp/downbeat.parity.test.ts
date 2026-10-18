/**
 * Parity of the downbeat rule against the Python dumps (plan section 4: phase / beats per bar exactly
 * equal; confidence and scores within float32 rounding of the dump). Input = Python's
 * downbeat_chords_*, beat_bass, onset_env, beat_times. Skips cleanly without out/parity (CI).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMeta, readStage } from '../parity/stageFile';
import { chooseDownbeats } from './downbeat';

const PARITY = join(import.meta.dirname, '../../out/parity');
const NEEDED = ['downbeat_chords_root', 'downbeat_chords_quality', 'downbeat_chords_confidence', 'beat_bass', 'onset_env', 'beat_times', 'downbeat_phase', 'downbeat_scores'];
const variants = existsSync(PARITY)
  ? readdirSync(PARITY).filter((v) => {
      if (!existsSync(join(PARITY, v, 'meta.json'))) return false;
      const m = readMeta(join(PARITY, v));
      return NEEDED.every((s) => s in m.stages);
    })
  : [];

describe.skipIf(variants.length === 0)('downbeat parity (Python dumps)', () => {
  for (const v of variants) {
    it(`${v}: phase, beats/bar exact; confidence, scores within f32 rounding`, () => {
      const dir = join(PARITY, v);
      const meta = readMeta(dir);
      const qualities = meta.qualities as string[];
      const root = readStage(dir, 'downbeat_chords_root', meta).data;
      const qual = readStage(dir, 'downbeat_chords_quality', meta).data;
      const conf = readStage(dir, 'downbeat_chords_confidence', meta).data;
      const chords = Array.from(root, (r, i) => ({ root: r < 0 ? null : r, quality: qualities[qual[i]], confidence: conf[i] }));
      const got = chooseDownbeats({
        chords,
        bass: readStage(dir, 'beat_bass', meta).data,
        onsetEnv: readStage(dir, 'onset_env', meta).data,
        beatTimes: readStage(dir, 'beat_times', meta).data,
        sr: meta.sr as number,
        hop: meta.hop as number,
      });
      const ePhase = readStage(dir, 'downbeat_phase', meta).data[0];
      const eBpb = readStage(dir, 'downbeat_beats_per_bar', meta).data[0];
      const eConf = readStage(dir, 'downbeat_confidence', meta).data[0];
      const eScores = readStage(dir, 'downbeat_scores', meta).data;
      const sDiff = Math.max(...got.scores.map((s, i) => Math.abs(s - eScores[i])));
      console.log(`[T10] ${v} phase=${got.phase}/${ePhase} bpb=${got.beatsPerBar}/${eBpb} confDiff=${Math.abs(got.confidence - eConf).toExponential(2)} scoresDiff=${sDiff.toExponential(2)} conf=${got.confidence.toFixed(4)}`);
      expect(got.phase).toBe(ePhase);
      expect(got.beatsPerBar).toBe(eBpb);
      expect(Math.abs(got.confidence - eConf)).toBeLessThan(1e-5);
      expect(sDiff).toBeLessThan(1e-5);
    });
  }
});

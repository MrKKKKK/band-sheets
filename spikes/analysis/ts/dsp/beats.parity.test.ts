/**
 * Parity of the beat stage against the Python dumps (plan section 4 / librosa notes section 15):
 * given Python's onset_env the tempo bin is identical; given Python's env and tempo the DP frames are
 * identical; given Python's frames and y_perc, _refine is within 1e-9 s (the dump stores float32, so
 * we require float32-identical times and report the float64 gap); given Python's tracked beats and
 * tempo.event_times, the tempo rule picks the same candidate. Skips cleanly when out/parity is absent.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMeta, readStage, type ParityMeta } from '../parity/stageFile';
import {
  beatTrackFrames,
  chooseOctave,
  estimateTempo,
  framesToTime,
  gridBpm,
  refine,
  tempoFrequencies,
  trackBeats,
} from './beats';

const PARITY = join(import.meta.dirname, '../../out/parity');
const NEEDED = ['onset_env', 'y_perc', 'tempo_top2_bin', 'tempo_score', 'beat_frames_raw', 'beat_times_tracked', 'beat_times'];
const variants = existsSync(PARITY)
  ? readdirSync(PARITY).filter((v) => {
      if (!existsSync(join(PARITY, v, 'meta.json'))) return false;
      const m = readMeta(join(PARITY, v));
      return NEEDED.every((s) => s in m.stages);
    })
  : [];

/** tempo_event_times are frame times stored as float32: recover the exact (f * hop) / sr. */
function eventsOf(dir: string, meta: ParityMeta, sr: number, hop: number): Float64Array {
  if (!('tempo_event_times' in meta.stages)) return new Float64Array(0);
  const t = readStage(dir, 'tempo_event_times', meta).data;
  const out = framesToTime(Array.from(t, (v) => Math.round((v * sr) / hop)), sr, hop);
  for (let i = 0; i < t.length; i++) expect(Math.abs(out[i] - t[i])).toBeLessThan(1e-5);
  return out;
}

const rows: string[] = [];

describe.skipIf(variants.length === 0)('beats parity (Python dumps)', () => {
  it.each(variants)('%s', (v) => {
    const dir = join(PARITY, v);
    const meta = readMeta(dir);
    const sr = (meta.sr as number) ?? 22050;
    const hop = (meta.hop as number) ?? 512;
    const env = readStage(dir, 'onset_env', meta).data;
    const yPerc = readStage(dir, 'y_perc', meta).data;
    const pyTop2 = readStage(dir, 'tempo_top2_bin', meta).data;
    const pyScore = readStage(dir, 'tempo_score', meta).data;
    const pyFrames = readStage(dir, 'beat_frames_raw', meta).data;
    const pyTracked = readStage(dir, 'beat_times_tracked', meta).data;
    const pyFinal = readStage(dir, 'beat_times', meta).data;
    const pyTempo = readStage(dir, 'beat_tempo', meta).data[0];

    // 1. tempo bin
    const est = estimateTempo(env, sr, hop);
    let scoreDiff = 0;
    for (let k = 0; k < pyScore.length; k++) {
      if (Number.isFinite(pyScore[k])) scoreDiff = Math.max(scoreDiff, Math.abs(est.score[k] - pyScore[k]));
      else expect(est.score[k]).toBe(pyScore[k]);
    }
    const gap = est.score[pyTop2[0]] - est.score[pyTop2[1]];
    expect(est.bin).toBe(pyTop2[0]);

    // 2. DP frames with Python's tempo
    const pyBpm = tempoFrequencies(344, sr, hop)[pyTop2[0]];
    const frames = beatTrackFrames(env, pyBpm, sr, hop);
    expect(Array.from(frames)).toEqual(Array.from(pyFrames));

    // 3. _refine with Python's frames and y_perc
    const tracked = refine(framesToTime(pyFrames, sr, hop), yPerc, sr, hop);
    expect(tracked.length).toBe(pyTracked.length);
    let refineDiff = 0;
    let f32Same = 0;
    for (let i = 0; i < tracked.length; i++) {
      refineDiff = Math.max(refineDiff, Math.abs(tracked[i] - pyTracked[i]));
      if (Math.fround(tracked[i]) === pyTracked[i]) f32Same++;
    }
    expect(f32Same).toBe(tracked.length);

    // 4. tempo rule with Python's events
    const events = eventsOf(dir, meta, sr, hop);
    const chosenPy = meta.tempoChosen as string | null | undefined;
    const choice = chooseOctave(tracked, gridBpm(tracked), events);
    if (chosenPy != null) expect(choice.chosen).toBe(chosenPy);
    expect(Array.from(choice.times, Math.fround)).toEqual(Array.from(pyFinal));
    expect(Math.fround(choice.tempo)).toBe(pyTempo);

    // 5. whole stage from Python's env / y_perc / events
    const grid = trackBeats({ onsetEnv: env, yPerc, sr, hop }, () => events);
    expect(Array.from(grid.times, Math.fround)).toEqual(Array.from(pyFinal));

    rows.push(
      `${v.padEnd(46)} bin ${est.bin}/${pyTop2[0]} gap ${gap.toFixed(3)} scoreΔ ${scoreDiff.toExponential(1)}` +
        ` | frames ${frames.length} exact | refine f32 ${f32Same}/${tracked.length} Δ ${refineDiff.toExponential(1)}` +
        ` | rule ${choice.chosen}/${chosenPy} | ${choice.times.length} beats ${choice.tempo.toFixed(2)} BPM`,
    );
  });

  it('summary', () => {
    console.log(['beats parity:', ...rows].join('\n'));
  });
});

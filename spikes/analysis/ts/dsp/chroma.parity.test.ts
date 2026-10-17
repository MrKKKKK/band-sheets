/**
 * Parity of the chroma stage against the Python dumps (plan section 4, chroma row): with Python's
 * y_harm and beat times injected,
 *   - Python's tuning injected: cosine >= .9999 on 99.9 % of the columns, column-sum ratio within
 *     +-0.5 %;
 *   - TS's own tuning: cosine >= .999 (all columns), column sums within +-1 %;
 * for the frame chroma (full, bass), the beat columns (full, bass) and the chord columns; columns
 * where both sums are below no_chord_energy / 10 are left out. The tuning itself must equal
 * Python's or differ by <= 0.02 (recorded). Also reports the chord-label differences when T7's
 * estimateChords runs on TS chroma instead of Python's. Skips cleanly when out/parity is absent.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { columnCosines } from '../parity/compare';
import { readMeta, readStage } from '../parity/stageFile';
import { DEFAULT_CHORDS_CONFIG, chordName, estimateChords } from './chords';
import { aggregate, columns, columnTimes, frameChroma, timeToFrames } from './chroma';
import { estimateTuning } from './core/cqt';

const PARITY = join(import.meta.dirname, '../../out/parity');
const NEEDED = ['y_harm', 'tuning_full', 'tuning_bass', 'frame_chroma', 'frame_bass', 'beat_times', 'beat_chroma', 'beat_bass', 'beat_bounds', 'col_chroma', 'col_bounds', 'per_beat'];
const variants = existsSync(PARITY)
  ? readdirSync(PARITY).filter((v) => {
      if (!existsSync(join(PARITY, v, 'meta.json'))) return false;
      const m = readMeta(join(PARITY, v));
      return NEEDED.every((s) => s in m.stages);
    })
  : [];

const SILENT = DEFAULT_CHORDS_CONFIG.no_chord_energy / 10;

interface Cmp {
  /** Share of non-silent columns with cosine >= threshold. */
  share: number;
  minCos: number;
  /** max |sum_ts / sum_py - 1| over non-silent columns. */
  sumDiff: number;
  n: number;
}

function compare(ts: ArrayLike<number>, py: ArrayLike<number>, cols: number, thr: number): Cmp {
  const cos = columnCosines(ts, py, 12, cols);
  let n = 0;
  let ok = 0;
  let minCos = 1;
  let sumDiff = 0;
  for (let c = 0; c < cols; c++) {
    let sa = 0;
    let sb = 0;
    for (let r = 0; r < 12; r++) {
      sa += ts[r * cols + c];
      sb += py[r * cols + c];
    }
    if (sa < SILENT && sb < SILENT) continue;
    n++;
    if (cos[c] >= thr) ok++;
    minCos = Math.min(minCos, cos[c]);
    sumDiff = Math.max(sumDiff, Math.abs(sa / sb - 1));
  }
  return { share: n ? ok / n : 1, minCos, sumDiff, n };
}

function labels(chroma: ArrayLike<number>, n: number, perBeat: number): string[] {
  const cfg = { ...DEFAULT_CHORDS_CONFIG, candidates: false };
  return estimateChords(chroma, n, cfg, { perBeat }).map((c) => chordName(c.root, c.quality));
}

const fmt = (c: Cmp) => `${(100 * c.share).toFixed(2)}% min ${c.minCos.toFixed(6)} Σ ${(100 * c.sumDiff).toFixed(3)}%`;

/** Number of mismatching bounds; throws unless each one is a float32 rounding of its time. */
function checkBounds(ts: Int32Array, py: Int32Array, times: ArrayLike<number>, sr: number, hop: number): number {
  expect(ts.length).toBe(py.length);
  let miss = 0;
  for (let i = 0; i < times.length; i++) {
    if (ts[i] === py[i]) continue;
    miss++;
    const t = times[i];
    const ulp = Math.max(Math.abs(t) * 2 ** -23, 2 ** -149);
    const alt = [timeToFrames(t - ulp, sr, hop), timeToFrames(t + ulp, sr, hop)];
    expect(alt).toContain(py[i]);
  }
  return miss;
}

const rows: string[] = [];

describe.skipIf(variants.length === 0)('chroma parity (Python dumps)', () => {
  it.each(variants)('%s', (v) => {
    const dir = join(PARITY, v);
    const meta = readMeta(dir);
    const sr = (meta.sr as number) ?? 22050;
    const hop = (meta.hop as number) ?? 512;
    const get = (s: string) => readStage(dir, s, meta).data;
    const yHarm = get('y_harm');
    const pyTf = get('tuning_full')[0];
    const pyTb = get('tuning_bass')[0];
    const times = Float64Array.from(get('beat_times'));
    const perBeat = get('per_beat')[0];
    const duration = yHarm.length / sr;
    const pyFrame = get('frame_chroma');
    const pyFrameBass = get('frame_bass');
    const F = readStage(dir, 'frame_chroma', meta).shape[1];
    const nb = times.length;

    // tuning
    const tsTuning = estimateTuning(yHarm, { sr, bpo: 36 });
    const tunDiff = Math.max(Math.abs(tsTuning - pyTf), Math.abs(tsTuning - pyTb));
    expect(tunDiff).toBeLessThanOrEqual(0.02 + 1e-6);

    const out: string[] = [];
    const modes: [string, number, number, number, number][] = [
      ['py-tuning', pyTf, pyTb, 0.9999, 0.005],
      ['ts-tuning', tsTuning, tsTuning, 0.999, 0.01],
    ];
    let labelDiff = '';
    let boundMiss = 0;
    const cache = new Map<string, ReturnType<typeof frameChroma>>();
    for (const [mode, tf, tb, cosThr, sumThr] of modes) {
      const key = `${tf}/${tb}`;
      const fc = cache.get(key) ?? frameChroma(yHarm, undefined, { tuningFull: tf, tuningBass: tb, sr, hop });
      cache.set(key, fc);
      expect(fc.frames).toBe(F);
      expect(fc.bassFrames).toBe(readStage(dir, 'frame_bass', meta).shape[1]);
      // Bounds from the (float32-dumped) beat times: a beat exactly on a frame time can round to
      // one frame earlier, so every mismatch must be explained by +-1 float32 ulp of that time;
      // the chroma comparison then uses Python's bounds.
      const cols = columns(fc.full, fc.bass, fc.frames, times, duration, perBeat, 'median', sr, hop, fc.bassFrames);
      const pyBounds = Int32Array.from(get('beat_bounds'));
      const pyCBounds = Int32Array.from(get('col_bounds'));
      const ct = columnTimes(times, duration, perBeat);
      boundMiss = checkBounds(cols.bounds, pyBounds, times, sr, hop) + checkBounds(cols.cBounds, pyCBounds, ct, sr, hop);
      cols.chroma = aggregate(fc.full, fc.frames, pyBounds);
      cols.bass = aggregate(fc.bass, fc.bassFrames, pyBounds);
      cols.cChroma = aggregate(fc.full, fc.frames, pyCBounds);
      cols.cBounds = pyCBounds;
      const nc = cols.cBounds.length - 1;
      const cmp = {
        frame: compare(fc.full, pyFrame, F, cosThr),
        frameBass: compare(fc.bass, pyFrameBass, fc.bassFrames, cosThr),
        beat: compare(cols.chroma, get('beat_chroma'), nb, cosThr),
        beatBass: compare(cols.bass, get('beat_bass'), nb, cosThr),
        col: compare(cols.cChroma, get('col_chroma'), nc, cosThr),
      };
      const minShare = mode === 'py-tuning' ? 0.999 : 1;
      for (const c of Object.values(cmp)) {
        expect(c.share).toBeGreaterThanOrEqual(minShare);
        expect(c.sumDiff).toBeLessThanOrEqual(sumThr);
      }
      out.push(
        `  ${mode}: frame ${fmt(cmp.frame)} | bass ${fmt(cmp.frameBass)} | beat ${fmt(cmp.beat)} | beatBass ${fmt(cmp.beatBass)} | col ${fmt(cmp.col)}`,
      );
      // chord labels on TS vs Python chord columns (first pass, no prior)
      const a = labels(cols.cChroma, nc, perBeat);
      const b = labels(get('col_chroma'), nc, perBeat);
      let d = 0;
      for (let i = 0; i < nc; i++) if (a[i] !== b[i]) d++;
      labelDiff += ` ${mode} ${d}/${nc}`;
    }
    rows.push(`${v.padEnd(46)} tuning ts ${tsTuning.toFixed(2)} py ${pyTf.toFixed(2)}/${pyTb.toFixed(2)} | bounds off by f32 ${boundMiss} | label diffs${labelDiff}\n${out.join('\n')}`);
  }, 120_000);

  it('summary', () => {
    console.log(['chroma parity:', ...rows].join('\n'));
  });
});

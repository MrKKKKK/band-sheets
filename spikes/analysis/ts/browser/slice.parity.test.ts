/**
 * T8 end-to-end preview (plan T15 in small): the TS vertical slice from the 44.1 kHz dev synthetic wav
 * (our resampler) and from Python's own 22050 Hz y (resampler bypassed), scored against the Python dumps:
 * beats within +-5 ms of result.json's beats, and the pass-1 chord label per eighth column
 * (chords1_root / chords1_quality at Python's column start times). Numbers are logged ([T8]); the
 * asserts are loose sanity bounds, the tolerances proper belong to T15. Skips when out/ is absent (CI).
 * Dev synthetic variants only (never held-out / recordings).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chordName } from '../dsp/chords';
import { stubNoNetwork } from '../parity/noNetwork';
import { readMeta, readStage } from '../parity/stageFile';
import { beatShare, columnAgreement } from './score';
import { runSlice, type SliceResult } from './slice';
import { decodeWav } from './wav';

const OUT = join(import.meta.dirname, '../../out');
const VARIANTS: [string, string][] = [
  ['full-t116-straight', 'saints/full-t116-straight.wav'],
  ['full-t116-shuffle', 'saints/full-t116-shuffle.wav'],
  ['etude-full-t90-straight', 'etude/etude-full-t90-straight.wav'],
  // Python's tempo rule picks T/2a here; the slice skips the rule (T9), so beats are expected to differ.
  ['etude-full-t90-straight-drift', 'etude/etude-full-t90-straight-drift.wav'],
];
const available = VARIANTS.filter(([v, w]) => existsSync(join(OUT, 'parity', v, 'meta.json')) && existsSync(join(OUT, w)));

function score(dir: string, r: SliceResult) {
  const meta = readMeta(dir);
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as { beats: { t: number }[] };
  const pyBeats = result.beats.map((b) => b.t);
  const qualities = meta.qualities as string[];
  const root = readStage(dir, 'chords1_root', meta).data;
  const qual = readStage(dir, 'chords1_quality', meta).data;
  const bounds = readStage(dir, 'col_bounds', meta).data; // frames, nc + 1
  const nc = root.length;
  const mids: number[] = [];
  const labels: string[] = [];
  for (let c = 0; c < nc; c++) {
    mids.push(((bounds[c] + bounds[c + 1]) / 2) * (512 / 22050)); // column midpoint (s)
    labels.push(root[c] < 0 ? 'N' : chordName(root[c], qualities[qual[c]]));
  }
  return {
    beats: beatShare(r.beats, pyBeats),
    nBeats: [r.beats.length, pyBeats.length],
    chords: columnAgreement(r, mids, labels),
    tempoTs: r.tempo,
    tempoChosenPy: meta.tempoChosen as string,
  };
}

describe.skipIf(available.length === 0)('T8 vertical slice vs Python (end-to-end preview)', () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const [v, wav] of available) {
    const dir = join(OUT, 'parity', v);
    it(`${v}: wav -> our resampler -> slice; and Python y -> slice`, () => {
      stubNoNetwork();
      const w = decodeWav(readFileSync(join(OUT, wav)));
      const a = runSlice({ channels: w.channels, sr: w.sampleRate });
      const sa = score(dir, a);
      const y = readStage(dir, 'y').data;
      const b = runSlice({ channels: [y], sr: 22050 });
      const sb = score(dir, b);
      const fmt = (s: ReturnType<typeof score>) =>
        `beats±5ms=${(s.beats * 100).toFixed(1)}% (n ts/py ${s.nBeats.join('/')}) chords1/col=${(s.chords * 100).toFixed(1)}% tempo=${s.tempoTs.toFixed(2)} (py rule chose ${s.tempoChosenPy})`;
      const st = a.stages.map((s) => `${s.name} ${s.ms.toFixed(0)}`).join(', ');
      console.log(`[T8] ${v} wav+resample: ${fmt(sa)} | total ${a.totalMs.toFixed(0)} ms (${st}) peak ${(a.mem.peak / 2 ** 20).toFixed(0)} MB`);
      console.log(`[T8] ${v} python y   : ${fmt(sb)}`);
      if (sa.tempoChosenPy !== 'T') return; // tempo rule not ported yet: numbers are logged only
      expect(sa.beats).toBeGreaterThan(0.9);
      expect(sb.beats).toBeGreaterThan(0.9);
      expect(sa.chords).toBeGreaterThan(0.9);
      expect(sb.chords).toBeGreaterThan(0.9);
    }, 300_000);
  }
});

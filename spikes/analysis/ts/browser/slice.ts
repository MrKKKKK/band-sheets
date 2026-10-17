/**
 * Spike 3 T8: the vertical slice (plan decision 1 (b)) as one function that runs the same in a Worker
 * and in Node: resample -> HPSS / onset -> beats -> chroma (full + bass, eighth columns) -> chords
 * pass 1 (no theory prior) -> a result object. Mirrors py/analyze.py up to `merge` on the default
 * config, with these documented gaps (vertical slice only):
 *   - tempo rule (tempo-octave re-choice, beats.tempo 'rule') is NOT run: it needs
 *     tempo.event_times from STFT chroma (task T9). The tracked grid T is taken as is.
 *     (Of the 17 dev parity variants Python keeps T on 16; etude-full-t90-straight-drift picks T/2a.)
 *   - no downbeat / sections / key / pass 2: chords are pass 1, so '?' marks and labels can differ
 *     from result.json (which is pass 2).
 *   - chroma: ts/dsp/chroma.ts frameChroma throws when the full (6-octave) and bass (3-octave) CQTs
 *     have different frame counts (e.g. exactly 60 s at 22050 Hz: 2584 vs 2585). Python does not
 *     require equal counts (chroma._columns clips the bounds to the full count and _aggregate clamps
 *     to each array's own count), so sliceColumns below follows Python with T6's exported pieces.
 * No network: this module and everything it imports only compute.
 */
import { HOP, hpss, onsetStrength, SR } from '../dsp/audio';
import { beatTrackFrames, estimateTempo, framesToTime, gridBpm, refine } from '../dsp/beats';
import {
  chordName,
  chordText,
  DEFAULT_CHORDS_CONFIG,
  estimateChords,
  mergeSegments,
  NOTE_NAMES,
} from '../dsp/chords';
import { aggregate, chromaCqt, columns, columnTimes, DEFAULT_CHROMA_CONFIG, SCALE, type Columns } from '../dsp/chroma';
import { estimateTuning } from '../dsp/core/cqt';
import { MemTracker } from '../dsp/core/mem';
import { resampleSinc, toMono } from '../dsp/core/resample';

export interface StageStat {
  name: string;
  ms: number;
  /** MemTracker (typed arrays held by the analyzer), bytes, right after the stage. */
  memLive: number;
  /** MemTracker peak so far, bytes. */
  memPeak: number;
  /** performance.memory.usedJSHeapSize after the stage when the engine exposes it (Chromium), bytes. */
  heapUsed?: number;
}

export interface SliceChord {
  start: number;
  end: number;
  root: string;
  quality: string;
  text: string;
  confidence: number;
  lowConfidence: boolean;
  candidates: { name: string; root: string; quality: string; prob: number }[];
}

export interface SliceResult {
  durationSec: number;
  sr: number;
  tempo: number;
  tempoRule: 'skipped';
  beats: number[];
  /** chord segments (pass 1), no-chord gaps omitted like result.json */
  chords: SliceChord[];
  /** per eighth column label (pass 1), 'N' = no chord; columnTimes[i] is its start (s) */
  columnLabels: string[];
  columnTimes: number[];
  stages: StageStat[];
  totalMs: number;
  mem: { peak: number; live: number; total: number };
}

export interface SliceInput {
  /** mono (or channels to mix down) at `sr` */
  channels: readonly Float32Array[];
  sr: number;
}

export interface SliceHooks {
  onStage?: (s: StageStat) => void;
  now?: () => number;
  heapUsed?: () => number | undefined;
}

function defaultHeap(): number | undefined {
  const m = (globalThis.performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? m.usedJSHeapSize : undefined;
}

function scaled(c: Float32Array, mem: MemTracker): Float64Array {
  const out = mem.f64(c.length);
  for (let i = 0; i < c.length; i++) out[i] = c[i] * SCALE;
  mem.release(c);
  return out;
}

/**
 * py chroma.chord_columns (default config, per_beat 2) = ts chroma.chordColumns, except that the full
 * and bass frame counts may differ (see the header): bounds come from the full chroma's count and the
 * bass columns are aggregated over the bass's own count, as in Python.
 */
export function sliceColumns(yHarm: Float32Array, times: Float64Array, duration: number, mem: MemTracker): Columns {
  const cfg = DEFAULT_CHROMA_CONFIG;
  const perBeat = 2;
  if (times.length === 0) {
    const z = new Float64Array(0);
    const b0 = new Int32Array(1);
    return { chroma: z, bass: z, bounds: b0, cChroma: z, cBounds: b0, perBeat };
  }
  const base = { sr: SR, hop: HOP, bpo: cfg.bins_per_octave };
  const tuning = estimateTuning(yHarm, { sr: SR, bpo: cfg.bins_per_octave }, mem); // once, as frameChroma
  const f = chromaCqt(yHarm, { ...base, fmin: cfg.fmin_hz, nOctaves: cfg.n_octaves, tuning }, mem);
  const full = scaled(f.chroma, mem);
  const b = chromaCqt(yHarm, { ...base, fmin: cfg.bass_fmin_hz, nOctaves: cfg.bass_octaves, tuning }, mem);
  const bass = scaled(b.chroma, mem);
  let cols: Columns;
  if (f.cols === b.cols) {
    cols = columns(full, bass, f.cols, times, duration, perBeat, cfg.aggregate, SR, HOP);
  } else {
    cols = columns(full, full, f.cols, times, duration, perBeat, cfg.aggregate, SR, HOP);
    cols = { ...cols, bass: aggregate(bass, b.cols, cols.bounds, cfg.aggregate) };
  }
  mem.release(full, bass);
  return cols;
}

export function runSlice(input: SliceInput, hooks: SliceHooks = {}): SliceResult {
  const now = hooks.now ?? (() => performance.now());
  const heap = hooks.heapUsed ?? defaultHeap;
  const mem = new MemTracker();
  const stages: StageStat[] = [];
  const t0 = now();
  let t = t0;
  const mark = (name: string) => {
    const e = now();
    const s: StageStat = { name, ms: e - t, memLive: mem.live, memPeak: mem.peak };
    const h = heap();
    if (h !== undefined) s.heapUsed = h;
    stages.push(s);
    hooks.onStage?.(s);
    t = now();
  };

  // load: mono (librosa.to_mono) + our resampler to 22050 (plan decision 2)
  for (const c of input.channels) mem.adopt(c);
  const mono = toMono(input.channels);
  if (mono !== input.channels[0]) mem.adopt(mono);
  let y: Float32Array | null = resampleSinc(mono, input.sr, SR, {}, mem);
  if (y !== mono) mem.release(...input.channels, ...(mono !== input.channels[0] ? [mono] : []));
  mark('resample');
  const duration = y.length / SR;

  // HPSS + onset strength (py audio.load_features, default config)
  let yHarm: Float32Array | null;
  let yPerc: Float32Array | null;
  let onsetEnv: Float32Array;
  if (y.length > 0) {
    ({ yHarm, yPerc } = hpss(y, mem));
    mem.release(y);
    y = null;
    mark('hpss');
    onsetEnv = onsetStrength(yPerc, mem);
    mark('onset');
  } else {
    yHarm = y;
    yPerc = y;
    onsetEnv = new Float32Array(0);
    mark('hpss');
    mark('onset');
  }

  // beats (beats.track_beats without the tempo rule, see the header)
  let times: Float64Array = new Float64Array(0);
  if (onsetEnv.length > 0 && onsetEnv.some((v) => v > 0)) {
    const est = estimateTempo(onsetEnv, SR, HOP);
    const frames = beatTrackFrames(onsetEnv, est.bpm, SR, HOP);
    times = refine(framesToTime(frames, SR, HOP), yPerc as Float32Array, SR, HOP);
  }
  const tempo = times.length > 0 ? gridBpm(times) : 0;
  mem.release(onsetEnv);
  if (yPerc !== yHarm) mem.release(yPerc);
  yPerc = null;
  mark('beats');

  // chroma: frame chroma (CQT, full + bass) -> beat / eighth columns
  const cols = sliceColumns(yHarm as Float32Array, times, duration, mem);
  mem.release(yHarm);
  yHarm = null;
  mark('chroma');

  // chords pass 1 + merge + candidates (analyze._merge on the default path)
  const cfg = DEFAULT_CHORDS_CONFIG;
  const nc = cols.cChroma.length / 12;
  const colChords = estimateChords(cols.cChroma, nc, cfg, { perBeat: cols.perBeat });
  const segs = mergeSegments(colChords, cfg, cols.perBeat);
  const ct = columnTimes(times, duration, cols.perBeat);
  const colTime = (c: number) => (c >= 0 && c < ct.length ? ct[c] : duration);
  const chords: SliceChord[] = segs
    .filter((s) => s.root !== null)
    .map((s) => ({
      start: colTime(s.startBeat),
      end: colTime(s.endBeat),
      root: NOTE_NAMES[(s.root as number) % 12],
      quality: s.quality,
      text: chordText({ root: s.root, quality: s.quality, bass: s.bass, confidence: s.confidence }, cfg),
      confidence: s.confidence,
      lowConfidence: s.lowConfidence,
      candidates: s.candidates.map((c) => ({
        name: chordName(c.root, c.quality),
        root: NOTE_NAMES[c.root % 12],
        quality: c.quality,
        prob: c.prob,
      })),
    }));
  const columnLabels = colChords.map((c) => chordName(c.root, c.quality));
  mark('chords');

  return {
    durationSec: duration,
    sr: SR,
    tempo,
    tempoRule: 'skipped',
    beats: Array.from(times),
    chords,
    columnLabels,
    columnTimes: Array.from(ct),
    stages,
    totalMs: now() - t0,
    mem: { peak: mem.peak, live: mem.live, total: mem.total },
  };
}

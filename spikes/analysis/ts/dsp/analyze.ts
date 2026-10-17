/**
 * Spike 3 T14: the whole analyzer (py/analyze.py analyze) on the default config, from 22050 Hz mono float32.
 *
 * Stage order and timing names as in analyze.py: load (HPSS + onset strength; the audio is already
 * decoded / resampled by the caller) -> beats (with the tempo rule, tempo.event_times) -> chroma (CQT, beat
 * and eighth columns) -> chords (1st pass) -> downbeat (beat-level margin chords, downbeat_chords) -> merge
 * -> sections -> key (global) -> keytrack (per-bar keys, key.track 'sections') -> chords2 (theory prior)
 * -> merge2 -> total. Downbeat and sections use the 1st pass; keytrack the 1st pass's on-beat columns.
 *
 * Only the default config runs (non-default -> Error, config.ts). Memory: one MemTracker for all stages;
 * arrays are released as soon as no later stage needs them (y_harm after chroma, frame chroma after the
 * columns, y / y_perc / onset after sections), both in the tracker and by dropping every reference so
 * the GC can take them (pass the input as `{ y }` to let analyze drop the caller's reference too).
 * `stats` has ms + MemTracker live / peak per stage.
 *
 * Input validation (T19, user decision 2026-10-17 option a; Python crashes or returns odd results here,
 * the TS port rejects instead and never returns a "0 beats, C major confidence 0" result):
 * validateInput() -> AnalysisInputError with a code and a Japanese message for the user:
 *   empty       0 samples
 *   too-short   < MIN_INPUT_SEC (1 s): two beats at the slowest preferred tempo (70 BPM, IBI 0.86 s)
 *               must fit, and HPSS's 31-frame median (0.72 s) needs that much context
 *   non-finite  any NaN / +-Infinity sample
 *   silent      max |y| <= SILENCE_PEAK (2^-15 = one 16-bit LSB, about -90 dBFS; covers all-zero and denormals)
 *   no-beats    the beat tracker found fewer than 2 beats (checked after the beats stage): with 0 there is
 *               nothing to analyse, with 1 there is no beat interval, so no tempo, bars or chord columns
 *               worth showing (seen for DC, a steady sine or a single click)
 * The CLI and the bench Worker call validateInput() on the decoded signal before resampling too.
 * No network: this module and everything it imports only compute.
 */
import { loadFeatures, type Features } from './audio';
import { trackBeats } from './beats';
import { beatLevel, DEFAULT_CHORDS_CONFIG, downbeatChords, estimateChords, mergeSegments } from './chords';
import { chordColumns } from './chroma';
import { checkDefaultConfig, DEFAULT_CONFIG, type AnalyzerConfig } from './config';
import { MemTracker } from './core/mem';
import { chooseDownbeats, DEFAULT_DOWNBEAT_CONFIG } from './downbeat';
import { estimateChordsPass2 } from './harmony';
import { estimateKey, type GlobalKey } from './keyest';
import { DEFAULT_KEY_CONFIG, estimate as keytrackEstimate, NOT_CONVERGED_WARNING, type BarKey } from './keytrack';
import { buildResult, type TsAnalysisResult } from './result';
import { DEFAULT_SECTIONS_CONFIG, findSections } from './sections';
import { tempoEventTimes } from './tempo';

export const MIN_INPUT_SEC = 1.0;
export const SILENCE_PEAK = 2 ** -15;

export type InputErrorCode = 'empty' | 'too-short' | 'non-finite' | 'silent' | 'no-beats';

/** A rejected input: `code` for programs, `message` (Japanese) to show the user. */
export class AnalysisInputError extends Error {
  readonly code: InputErrorCode;
  constructor(code: InputErrorCode, message: string) {
    super(message);
    this.name = 'AnalysisInputError';
    this.code = code;
  }
}

/** Throws AnalysisInputError unless `y` (mono, at `sr`) can be analysed. One pass over the samples. */
export function validateInput(y: Float32Array, sr: number): void {
  const n = y.length;
  if (n === 0) throw new AnalysisInputError('empty', '音声が空です（長さ 0）。音の入ったファイルを選んでください。');
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    if (!Number.isFinite(v)) {
      throw new AnalysisInputError(
        'non-finite',
        `音声に壊れた値（NaN または無限大）が含まれています（${(i / sr).toFixed(2)} 秒の位置）。ファイルが壊れていないか確かめてください。`,
      );
    }
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const sec = n / sr;
  if (sec < MIN_INPUT_SEC) {
    throw new AnalysisInputError(
      'too-short',
      `音声が短すぎます（${sec.toFixed(2)} 秒）。解析には ${MIN_INPUT_SEC} 秒以上の音声が必要です。`,
    );
  }
  if (peak <= SILENCE_PEAK) {
    throw new AnalysisInputError('silent', '音声が無音です（いちばん大きい音でも約 -90 dBFS 以下）。音の入ったファイルを選んでください。');
  }
}

export const NO_BEATS_MESSAGE = '拍が見つかりませんでした。リズムのはっきりした音（1 秒以上）で試してください。';

export const STAGES = [
  'load',
  'beats',
  'chroma',
  'chords',
  'downbeat',
  'merge',
  'sections',
  'key',
  'keytrack',
  'chords2',
  'merge2',
] as const;

export interface StageStat {
  name: string;
  ms: number;
  /** MemTracker bytes held right after the stage. */
  memLive: number;
  /** MemTracker peak so far (bytes). */
  memPeak: number;
}

export interface AnalyzeOptions {
  cfg?: AnalyzerConfig;
  /** Timings (s) measured before analyze (e.g. read / resample in the CLI); written first into timingsSec. */
  preTimings?: Record<string, number>;
  /** Write analyzer.timingsSec (default true; Python always writes it). */
  timings?: boolean;
  onStage?: (s: StageStat) => void;
  now?: () => number;
  mem?: MemTracker;
}

export interface AnalyzeOutput {
  result: TsAnalysisResult;
  stats: StageStat[];
  mem: { peak: number; live: number; total: number };
}

/**
 * analyze.py analyze(): `y` = 22050 Hz mono float32 (what librosa.load returns). With `{ y }`, analyze
 * clears `.y` so only the analyzer holds the signal (released after sections).
 */
export function analyze(input: Float32Array | { y: Float32Array | null }, opts: AnalyzeOptions = {}): AnalyzeOutput {
  const cfg = opts.cfg ?? DEFAULT_CONFIG;
  checkDefaultConfig(cfg);
  let y: Float32Array | null;
  if (input instanceof Float32Array) y = input;
  else {
    y = input.y;
    input.y = null;
    if (!y) throw new Error('analyze: input.y is null');
  }
  validateInput(y, 22050);
  const now = opts.now ?? (() => performance.now());
  const mem = opts.mem ?? new MemTracker();
  const tm: Record<string, number> = { ...(opts.preTimings ?? {}) };
  const stats: StageStat[] = [];
  const stage = <T>(name: string, fn: () => T): T => {
    const t0 = now();
    const out = fn();
    const ms = now() - t0;
    tm[name] = ms / 1000;
    const s: StageStat = { name, ms, memLive: mem.live, memPeak: mem.peak };
    stats.push(s);
    opts.onStage?.(s);
    return out;
  };
  const ccfg = DEFAULT_CHORDS_CONFIG;

  let feat: Features | null = stage('load', () => loadFeatures(y as Float32Array, mem));
  const { sr, hop, duration } = feat;
  // Own references only (feat is dropped), so each array can be collected once released below.
  y = feat.y;
  let yHarm: Float32Array | null = feat.yHarm;
  let yPerc: Float32Array | null = feat.yPerc;
  let onsetEnv: Float32Array | null = feat.onsetEnv;
  feat = null;
  const grid = stage('beats', () =>
    trackBeats({ onsetEnv: onsetEnv as Float32Array, yPerc: yPerc as Float32Array, sr, hop, mem }, () =>
      tempoEventTimes({ onsetEnv: onsetEnv as Float32Array, yHarm: yHarm as Float32Array, sr, hop }, mem),
    ),
  );
  const times = grid.times;
  const nb = times.length;
  if (nb < 2) throw new AnalysisInputError('no-beats', NO_BEATS_MESSAGE);
  const cols = stage('chroma', () => {
    const c = chordColumns(yHarm as Float32Array, times, duration, {}, mem);
    mem.release(c.frames.full, c.frames.bass);
    // frame chroma is not needed after the columns: keep only the scalar fields
    c.frames = { ...c.frames, full: new Float64Array(0), bass: new Float64Array(0) };
    return c;
  });
  if (yHarm !== y) mem.release(yHarm);
  yHarm = null;
  const pb = cols.perBeat;
  const nc = cols.cChroma.length / 12;
  let colChords = stage('chords', () => estimateChords(cols.cChroma, nc, ccfg, { perBeat: pb }));
  const beatChords = beatLevel(colChords, pb);
  const downbeats = stage('downbeat', () =>
    chooseDownbeats(
      {
        chords: downbeatChords(cols.chroma, nb, ccfg),
        bass: cols.bass,
        onsetEnv: onsetEnv as Float32Array,
        beatTimes: times,
        sr,
        hop,
      },
      DEFAULT_DOWNBEAT_CONFIG,
    ),
  );
  let segments = stage('merge', () => mergeSegments(colChords, ccfg, pb));
  const sections = stage('sections', () =>
    findSections(
      {
        chroma: cols.chroma,
        bass: cols.bass,
        nBeats: nb,
        beatTimes: times,
        phase: downbeats.phase,
        beatsPerBar: downbeats.beatsPerBar,
        y: y as Float32Array,
        yPerc: yPerc as Float32Array,
        sr,
        duration,
      },
      DEFAULT_SECTIONS_CONFIG,
    ),
  );
  mem.release(y, onsetEnv, ...(yPerc !== y ? [yPerc] : []));
  y = yPerc = onsetEnv = null;
  const key: GlobalKey | null = cfg.key.enabled ? stage('key', () => estimateKey(cols.chroma, nb)) : null;

  // bar_of_col = (arange(n_beats) - phase) // beats_per_bar (per beat; negative = pickup)
  const barOfBeat = new Int32Array(nb);
  for (let i = 0; i < nb; i++) barOfBeat[i] = Math.floor((i - downbeats.phase) / downbeats.beatsPerBar);
  const warnings: string[] = [];
  let barKeys: BarKey[] | null = null;
  if (cfg.key.track !== 'sections') throw new Error(`key.track=${cfg.key.track} is not supported by the TS port`);
  {
    const sectionBars = sections.map((s) => s.startBar);
    const kt = stage('keytrack', () => keytrackEstimate(beatChords, barOfBeat, sectionBars, DEFAULT_KEY_CONFIG));
    barKeys = kt.keys;
    if (!kt.converged) warnings.push(NOT_CONVERGED_WARNING);
  }
  if (cfg.chords.theory_prior > 0) {
    const bk = barKeys;
    colChords = stage('chords2', () =>
      estimateChordsPass2(cols.cChroma, nc, ccfg, {
        perBeat: pb,
        barKeys: bk,
        barOfBeat,
        strength: cfg.chords.theory_prior,
        mem,
      }),
    );
    segments = stage('merge2', () => mergeSegments(colChords, ccfg, pb));
  }
  let total = 0;
  for (const [k, v] of Object.entries(tm)) if (k !== 'total') total += v;
  tm.total = total;
  const result = buildResult({
    times,
    duration,
    segments,
    downbeats,
    sections,
    key,
    cfg,
    timings: opts.timings === false ? undefined : tm,
    barKeys,
    warnings,
  });
  return { result, stats, mem: { peak: mem.peak, live: mem.live, total: mem.total } };
}

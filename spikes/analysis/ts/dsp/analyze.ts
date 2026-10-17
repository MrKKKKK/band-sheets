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
 * columns, y / y_perc / onset after sections). `stats` has ms + MemTracker live / peak per stage.
 * No network: this module and everything it imports only compute.
 */
import { loadFeatures } from './audio';
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

/** analyze.py analyze(): `y` = 22050 Hz mono float32 (what librosa.load returns). */
export function analyze(y: Float32Array, opts: AnalyzeOptions = {}): AnalyzeOutput {
  const cfg = opts.cfg ?? DEFAULT_CONFIG;
  checkDefaultConfig(cfg);
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

  const feat = stage('load', () => loadFeatures(y, mem));
  const { sr, hop, duration } = feat;
  const grid = stage('beats', () =>
    trackBeats({ onsetEnv: feat.onsetEnv, yPerc: feat.yPerc, sr, hop }, () =>
      tempoEventTimes({ onsetEnv: feat.onsetEnv, yHarm: feat.yHarm, sr, hop }, mem),
    ),
  );
  const times = grid.times;
  const nb = times.length;
  const cols = stage('chroma', () => {
    const c = chordColumns(feat.yHarm, times, duration, {}, mem);
    mem.release(c.frames.full, c.frames.bass);
    return c;
  });
  if (feat.yHarm !== feat.y) mem.release(feat.yHarm);
  const pb = cols.perBeat;
  const nc = cols.cChroma.length / 12;
  let colChords = stage('chords', () => estimateChords(cols.cChroma, nc, ccfg, { perBeat: pb }));
  const beatChords = beatLevel(colChords, pb);
  const downbeats = stage('downbeat', () =>
    chooseDownbeats(
      {
        chords: downbeatChords(cols.chroma, nb, ccfg),
        bass: cols.bass,
        onsetEnv: feat.onsetEnv,
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
        y: feat.y,
        yPerc: feat.yPerc,
        sr,
        duration,
      },
      DEFAULT_SECTIONS_CONFIG,
    ),
  );
  mem.release(feat.y, feat.onsetEnv, ...(feat.yPerc !== feat.y ? [feat.yPerc] : []));
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

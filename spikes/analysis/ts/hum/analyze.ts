/**
 * Spike 4 T7: the humming analyzer end to end (plan section 2).
 *
 *   mono samples (any rate) + HumInput (what the user knows: bpm, time signature, and EITHER the bar-1 head `startSec`
 *   (may be negative: the recording starts inside a rest-led pickup bar) OR the approximate second of the first sung
 *   note `firstNoteSec` (+ its bar position `firstNoteTick` when known); resolveStart() turns it into a bar-1 head,
 *   which quantize's grid phase search (grid.phaseSearch) treats as approximate)
 *   -> validate (spike-3 validateInput: same error codes / messages) -> resample to cfg.audio.sr (our sinc)
 *   -> f0 (f0.ts) -> level envelope (notes.ts frameLevelDb, NOT f0.ts's levelDb) -> extractNotes -> quantize
 *   -> HumAnalysisResult { melody.notes, melody.quantized, hum.meta{configHash, configName, commit?, timings, ...} }
 *
 * No ground truth is read here (plan design decision 4). No network, no DOM: runs in Node, tests and the Worker.
 * The result never holds more than counts in warnings; callers (CLI, Worker) must not print notes.
 */
import { AnalysisInputError, validateInput } from '../dsp/analyze';
import { resampleSinc } from '../dsp/core/resample';
import { humConfigHash, resolveHumConfig, type HumConfig } from './config';
import { estimateF0 } from './f0';
import { extractNotes, frameLevelDb } from './notes';
import { quantize } from './quantize';
import { beatGrid } from './quantize';
import type { FrameF0Track, GridPhaseMeta, HumAnalysisResult, HumInput } from './types';

export { AnalysisInputError };

export interface HumAnalyzeOptions {
  /** Partial config overrides (resolveHumConfig), or an already resolved config. */
  config?: unknown;
  /** Git commit of the analyzer; goes to hum.meta.commit. */
  commit?: string;
  /** Include the frame f0 track in `hum.f0` (charts, f0 scoring). */
  f0Track?: boolean;
  /** 'recording' (default) or 'synthetic' for source.kind. */
  sourceKind?: 'recording' | 'synthetic';
  /** Called after each stage with its name and wall time (ms). */
  onStage?: (name: string, ms: number) => void;
}

export const HUM_STAGES = ['validate', 'resample', 'f0', 'level', 'notes', 'quantize'] as const;

export const ANALYZER_VERSION = 'spike4-s2';

/** Checks the info the user gave; throws Error with a Japanese message (not an audio problem, so not AnalysisInputError). */
export function validateHumInfo(info: HumInput): void {
  if (!Number.isFinite(info.bpm) || info.bpm < 30 || info.bpm > 300) throw new Error('bpm は 30〜300 で指定してください。');
  const [n, d] = info.ts ?? [];
  if (!Number.isInteger(n) || n < 1 || n > 16 || ![2, 4, 8].includes(d)) throw new Error('拍子は 4/4 のように指定してください（分母は 2・4・8）。');
  const hasStart = info.startSec !== undefined;
  const hasFirst = info.firstNoteSec !== undefined;
  if (hasStart === hasFirst) throw new Error('開始（1 音目のだいたいの秒）か小節頭（1 小節目の頭の秒）のどちらか 1 つを指定してください。');
  if (hasStart && !Number.isFinite(info.startSec)) throw new Error('小節頭（1 小節目の頭の秒）は数で指定してください（負でもよい）。');
  if (hasFirst && !(Number.isFinite(info.firstNoteSec) && info.firstNoteSec! >= 0)) throw new Error('開始（1 音目のだいたいの秒）は 0 以上の数で指定してください。');
  if (info.firstNoteTick !== undefined && !(Number.isFinite(info.firstNoteTick) && info.firstNoteTick >= 0)) throw new Error('開始の音の位置（tick）は 0 以上の数で指定してください。');
  if (info.firstNoteTick !== undefined && !hasFirst) throw new Error('開始の音の位置（tick）は開始（1 音目の秒）と一緒に指定してください。');
}

/** The bar-1 head implied by the input (before the phase search) and the anchor quantize() gets. */
export function resolveStart(info: HumInput): { startSec: number; firstNoteSec?: number; firstNoteTick?: number; startMode: GridPhaseMeta['startMode'] } {
  if (info.startSec !== undefined) return { startSec: info.startSec, startMode: 'barStart' };
  const tickSec = beatGrid({ bpm: info.bpm, ts: info.ts, startSec: 0 }).tickSec;
  const known = info.firstNoteTick !== undefined;
  const tick = info.firstNoteTick ?? 0;
  return {
    startSec: info.firstNoteSec! - tick * tickSec,
    firstNoteSec: info.firstNoteSec,
    ...(known ? { firstNoteTick: tick } : {}),
    startMode: known ? 'firstNote' : 'firstNoteOnly',
  };
}

function isConfig(c: unknown): c is HumConfig {
  return typeof c === 'object' && c !== null && 'audio' in c && 'grid' in c && 'name' in c && Object.isFrozen(c);
}

/** y: mono samples at `sr` (not modified). Throws AnalysisInputError for unusable audio. */
export function analyzeHum(y: Float32Array, sr: number, info: HumInput, opts: HumAnalyzeOptions = {}): HumAnalysisResult {
  const cfg = isConfig(opts.config) ? opts.config : resolveHumConfig(opts.config ?? {});
  const stagesMs: Record<string, number> = {};
  const t00 = performance.now();
  let t = t00;
  const mark = (name: string) => {
    const now = performance.now();
    stagesMs[name] = now - t;
    t = now;
    opts.onStage?.(name, stagesMs[name]);
  };

  validateHumInfo(info);
  validateInput(y, sr); // before the long resample; positions in the file's own time
  mark('validate');
  const audioSec = y.length / sr;
  const x = resampleSinc(y, sr, cfg.audio.sr);
  y = null as unknown as Float32Array; // S5: drop this reference (the caller may drop its own via onStage 'resample')
  mark('resample');
  const f0 = estimateF0(x, cfg.audio.sr, cfg);
  mark('f0');
  const level = frameLevelDb(x, cfg.audio.sr, f0.track);
  mark('level');
  const nr = extractNotes(f0.track, level, info, cfg);
  mark('notes');
  const st = resolveStart(info);
  const quantized = quantize(nr.notes, { bpm: info.bpm, ts: info.ts, startSec: st.startSec, firstNoteSec: st.firstNoteSec, firstNoteTick: st.firstNoteTick }, cfg.grid);
  mark('quantize');
  const grid: GridPhaseMeta = {
    startMode: st.startMode,
    givenStartSec: st.startSec,
    startSec: quantized.startSec,
    phaseOffsetSec: quantized.phaseOffsetSec ?? 0,
    phaseSteps: Math.round((quantized.phaseOffsetSec ?? 0) / ((64 / cfg.grid.subdivision) * beatGrid({ bpm: info.bpm, ts: info.ts, startSec: 0 }).tickSec)),
    onsetBiasSec: quantized.onsetBiasSec,
    barPositionKnown: st.startMode !== 'firstNoteOnly',
  };

  const warnings = [...nr.warnings];
  if (f0.track.voiced.every((v) => v < 0.5)) warnings.push('no voiced frames');
  const track: FrameF0Track | undefined = opts.f0Track ? f0.track : undefined;
  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: opts.sourceKind ?? 'recording', durationSec: audioSec, click: true, audioSec },
    analyzer: {
      name: 'hum-ts',
      version: ANALYZER_VERSION,
      methods: [
        cfg.f0.pyin ? 'pyin' : 'yin',
        cfg.segment.noteHmm ? 'note-hmm' : 'rule-segmentation',
        ...(cfg.pitch.localTuning ? ['local-tuning'] : []),
        ...(cfg.pitch.keyPrior && info.key ? ['key-prior'] : []),
        `grid-${quantized.grid}`,
      ],
    },
    melody: { notes: nr.notes, quantized },
    hum: {
      meta: {
        configHash: humConfigHash(cfg),
        configName: cfg.name,
        ...(opts.commit ? { commit: opts.commit } : {}),
        timings: { stagesMs, totalMs: performance.now() - t00, audioSec },
        warnings,
        tuningCents: nr.tuningCents,
        info: { ...info, ts: [info.ts[0], info.ts[1]] },
        grid,
      },
      ...(track ? { f0: track } : {}),
    },
  };
}

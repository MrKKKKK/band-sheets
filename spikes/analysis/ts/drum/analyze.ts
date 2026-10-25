/**
 * Spike 5 T8: the drum analyzer end to end (docs/audio-spike5-plan.md sections 2, 6).
 *
 *   DrumInput (mono samples at any rate + what the user knows: bpm, time signature, bar-1 head `startSec`)
 *   -> validate -> detectOnsets (onset.ts: resample to cfg.audio.sr, band flux, peaks, refinement)
 *   -> classifyOnsets (classify.ts: fixed-template NMF, S-3) -> quantizeDrums (quantize.ts: grid, marks, shuffle)
 *   -> DrumAnalysisResult { drums (seconds, with bar / tick / mark filled from the grid), swing, swingBars, drum.meta, drum.quantized }.
 *   drumScore() then turns the result into the app's DrumEvent[] + alphaTex section text (toDrums.ts) and checks the
 *   serializeDrums -> parseDrums round trip.
 *
 * No ground truth is read here (plan design decision 4): the only inputs are the audio and DrumInfo. No network, no DOM,
 * no Node APIs: runs in Node, tests and the Worker. Only templates.ts is imported (templates_build.ts needs alphaTab: Node only).
 * Level: only S-3 exists until T11; another level is analyzed as S-3 and says so in `warnings`.
 */
import type { DrumEvent, Shuffle } from '../../../../src/lib/drum';
import { serializeDrums } from '../../../../src/lib/drumTex';
import { classifyOnsets } from './classify';
import { DEFAULT_DRUM_CONFIG, drumConfigHash, type DrumConfig } from './config';
import { detectOnsets } from './onset';
import { quantizeDrums } from './quantize';
import { drumRoundTrip, timeSigOf, toDrumEvents } from './toDrums';
import type { AnalysisDrumHit, DrumAnalysisResult, DrumInfo, DrumInput, DrumStageInfo } from './types';

export const DRUM_ANALYZER_VERSION = 'spike5-s3';
export const DRUM_STAGES = ['validate', 'onset', 'classify', 'quantize'] as const;
export const MIN_DRUM_INPUT_SEC = 1;
export const SILENCE_PEAK = 2 ** -15;

export type DrumInputErrorCode = 'empty' | 'too-short' | 'non-finite' | 'silent';

/** Unusable audio (same codes as the other spikes' AnalysisInputError; kept apart so the Worker does not import ts/dsp/analyze). */
export class DrumInputError extends Error {
  readonly code: DrumInputErrorCode;
  constructor(code: DrumInputErrorCode, message: string) {
    super(message);
    this.name = 'DrumInputError';
    this.code = code;
  }
}

/** Checks what the user gave; throws Error with a Japanese message (not an audio problem, so not DrumInputError). */
export function validateDrumInfo(info: DrumInfo): void {
  if (!Number.isFinite(info.bpm) || info.bpm < 30 || info.bpm > 300) throw new Error('bpm は 30〜300 で指定してください。');
  const [n, d] = info.ts ?? [];
  if (!Number.isInteger(n) || n < 1 || n > 16 || ![2, 4, 8].includes(d)) throw new Error('拍子は 4/4 のように指定してください（分母は 2・4・8）。');
  if (!Number.isFinite(info.startSec)) throw new Error('小節頭（1 小節目の頭の秒）は数で指定してください（負でもよい）。');
}

export function validateDrumAudio(y: Float32Array, sr: number): void {
  const n = y.length;
  if (n === 0) throw new DrumInputError('empty', '音声が空です（長さ 0）。音の入ったファイルを選んでください。');
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    if (!Number.isFinite(v)) throw new DrumInputError('non-finite', `音声に壊れた値（NaN または無限大）が含まれています（${(i / sr).toFixed(2)} 秒の位置）。`);
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (n / sr < MIN_DRUM_INPUT_SEC) throw new DrumInputError('too-short', `音声が短すぎます（${(n / sr).toFixed(2)} 秒）。解析には ${MIN_DRUM_INPUT_SEC} 秒以上の音声が必要です。`);
  if (peak <= SILENCE_PEAK) throw new DrumInputError('silent', '音声が無音です（いちばん大きい音でも約 -90 dBFS 以下）。音の入ったファイルを選んでください。');
}

export interface DrumAnalyzeOptions {
  /** Git commit of the analyzer; goes to drum.meta.commit. */
  commit?: string;
  /** 'recording' (default) or 'synthetic' for source.kind. */
  sourceKind?: 'recording' | 'synthetic';
  /** Called after each stage with its name and wall time (ms). */
  onStage?: (name: string, ms: number) => void;
}

/** input.samples is not modified. Throws DrumInputError for unusable audio, Error (Japanese) for a bad DrumInfo. */
export function analyzeDrums(input: DrumInput, cfg: DrumConfig = DEFAULT_DRUM_CONFIG, opts: DrumAnalyzeOptions = {}): DrumAnalysisResult {
  const { samples, sampleRate } = input;
  const info: DrumInfo = { bpm: input.bpm, ts: [input.ts[0], input.ts[1]], startSec: input.startSec };
  const level = input.level ?? 'S-3';
  const stagesMs: Record<string, number> = {};
  const stages: DrumStageInfo[] = [];
  const t00 = performance.now();
  let t = t00;
  const mark = (name: string, count?: number, note?: string) => {
    const now = performance.now();
    stagesMs[name] = now - t;
    t = now;
    stages.push({ name, ms: stagesMs[name], ...(count !== undefined ? { count } : {}), ...(note ? { note } : {}) });
    opts.onStage?.(name, stagesMs[name]);
  };

  validateDrumInfo(info);
  validateDrumAudio(samples, sampleRate);
  mark('validate');
  const audioSec = samples.length / sampleRate;
  const det = detectOnsets(samples, sampleRate, cfg);
  mark('onset', det.onsets.length);
  const cls = classifyOnsets(det, cfg);
  mark('classify', cls.hits.length, `${cls.columns} template columns`);
  const q = quantizeDrums(cls.hits, info, { cfg });
  mark('quantize', q.quantized.hits.length);

  const warnings: string[] = [];
  if (level !== 'S-3') warnings.push(`level ${level} is not implemented yet: analyzed as S-3`);
  if (cls.hits.length === 0) warnings.push('no drum hits found');
  if (q.dropped.length) warnings.push(`${q.dropped.length} hits dropped by the quantizer`);

  // drums[]: seconds-domain hits (classifier order), grid fields filled from the quantizer through `src`.
  const bySrc = new Map(q.quantized.hits.map((h) => [h.src, h]));
  const drums: AnalysisDrumHit[] = cls.hits.map((h, i) => {
    const g = bySrc.get(i);
    return g ? { ...h, bar: g.bar, tick: g.tick, ...(g.mark ? { mark: g.mark } : {}) } : { ...h };
  });
  const methods = ['onset-superflux', cfg.classify.nmf ? 'nmf-fixed-templates' : 'band-rules', ...(cfg.classify.refit ? ['refit'] : []), ...(cfg.classify.hpss ? ['hpss'] : []), `grid-${q.quantized.grid}`];

  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: opts.sourceKind ?? 'recording', durationSec: audioSec, click: false, audioSec },
    analyzer: { name: 'drum-ts', version: DRUM_ANALYZER_VERSION, methods },
    timeSignature: { num: info.ts[0], den: info.ts[1], confidence: 1 },
    drums,
    ...(q.swing ? { swing: q.swing } : {}),
    swingBars: q.swingBars,
    drum: {
      meta: {
        configHash: drumConfigHash(cfg),
        configName: cfg.name,
        ...(opts.commit ? { commit: opts.commit } : {}),
        level,
        timings: { stagesMs, totalMs: performance.now() - t00, audioSec },
        warnings,
        info,
        grid: { givenStartSec: info.startSec, startSec: q.quantized.startSec, phaseOffsetSec: q.quantized.startSec - info.startSec, onsetBiasSec: q.onsetBiasSec },
        stages,
      },
      quantized: q.quantized,
    },
  };
}

export interface DrumScoreText {
  events: DrumEvent[];
  shuffle: Shuffle;
  /** The section body the app's serializeDrums writes (alphaTex). */
  tex: string;
  droppedExt: number;
  roundTrip: { parsed: boolean; identical: boolean; problem?: string };
}

/** The result as the app's drum model + text, with the serializeDrums -> parseDrums check. Throws RangeError on a broken quantized grid. */
export function drumScore(r: DrumAnalysisResult): DrumScoreText {
  const q = r.drum.quantized;
  if (!q) throw new Error('drumScore: result has no quantized hits');
  const { events, shuffle, droppedExt } = toDrumEvents(q, r.swingBars ?? []);
  const rt = drumRoundTrip(events, shuffle, timeSigOf(q.ts));
  return { events, shuffle, tex: serializeDrums(events, shuffle, timeSigOf(q.ts)), droppedExt, roundTrip: { parsed: rt.parsed, identical: rt.identical, ...(rt.problem ? { problem: rt.problem } : {}) } };
}

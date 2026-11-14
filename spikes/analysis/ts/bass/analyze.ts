/**
 * Spike 6 T7: the bass stage end to end, after the frozen v1a analyzer (docs/audio-spike6-plan.md sections 2, 6
 * decisions 2-5; docs/audio-spike6-t7.md).
 *
 *   22050 Hz mono y -> [bass on] validateInput, lowCqt (lowCqt.ts, before analyze drops y)
 *   -> ts/dsp analyze (frozen, unchanged) -> [bass on] applyBass: segmentBass (B-1) on v1a's chord segments and beats
 *   -> slashMarks (B-2) -> withSlash -> result with `chords[].bass` / bassConfidence / bassKind / bassCandidates (also
 *   on an unmarked chord whose 5th was held back, T9) and `bassAnalyzer` (config name, hash, commit).
 *   T10 switches (bassChords, both OFF by default): `cliche.split` (B-3, cliche.ts: pieces of a segment where the bass
 *   steps, kept only where a piece gets a `/X`; plus the line-end 6th in slash.ts) and `cliche.redecideRoot`
 *   (redecide.ts: root and quality may change, v1a's `candidates` stay).
 * With the bass stage off (`enabled: false`, the default) this is exactly `analyze()`: same call, same output object.
 * Ground truth is never read: the only inputs are the audio, the v1a result and the config (a test checks the imports).
 * No network, no DOM, no Node APIs: runs in Node, tests and the Worker. B-4 is not built yet (T11).
 */
import { analyze, validateInput, type AnalyzeOptions, type AnalyzeOutput, type StageStat } from '../dsp/analyze';
import { NOTE_NAMES } from '../dsp/chords';
import type { ResultChord, TsAnalysisResult } from '../dsp/result';
import { MemTracker } from '../dsp/core/mem';
import { bassConfigHash, DEFAULT_BASS_CONFIG, type BassConfig } from './config';
import { splitByBass } from './cliche';
import { LOW_SR, lowCqt, type LowCqt } from './lowCqt';
import { redecideRoots } from './redecide';
import { segmentBass } from './segmentBass';
import { heldWeak, slashChordsOf, slashMarks, withSlash, type SlashFields } from './slash';
import type { AnalysisResult } from './types';

/** Stage names the bass path adds to `stats` / `analyzer.timingsSec` (after the v1a stages). */
export const BASS_STAGES = ['bassLowCqt', 'bass'] as const;

/** The v1a result with the bass fields (chords keep the v1a shape plus the optional spike 6 fields). */
export type BassAnalysisResult = Omit<TsAnalysisResult, 'chords'> & { chords: (ResultChord & SlashFields)[] } & Pick<AnalysisResult, 'bassAnalyzer'>;

export interface BassAnalyzeOptions extends AnalyzeOptions {
  /** Bass config (default DEFAULT_BASS_CONFIG = off). */
  bass?: BassConfig;
  /** Written into `bassAnalyzer.commit` when given. */
  commit?: string;
}
export interface BassAnalyzeOutput extends AnalyzeOutput {
  result: BassAnalysisResult;
}

const round3 = (s: number): number => Math.round(s * 1000) / 1000;

function pcOf(name: string): number {
  const pc = (NOTE_NAMES as readonly string[]).indexOf(name);
  if (pc < 0) throw new Error(`bass: unexpected chord root ${JSON.stringify(name)}`);
  return pc;
}

/** A v1a chord as bassChords needs it (ts/dsp/result.ts ResultChord and score.ts ScoreChord both fit). */
export interface V1aChord {
  start: number;
  end: number;
  root: string;
  quality: string;
  bass: string | null;
  text?: string;
}

/** B-1 (+ root re-decision) + B-2 on one segmentation. */
function markChords<C extends V1aChord>(low: LowCqt, chords: readonly C[], beats: readonly number[], cfg: BassConfig): (C & SlashFields)[] {
  const sb = segmentBass(low, chords, beats, cfg.segment);
  const segs = cfg.cliche.redecideRoot ? redecideRoots(low, chords, sb, cfg) : chords;
  const inp = slashChordsOf(segs, beats, pcOf);
  const marks = slashMarks(inp, sb, cfg.slash, cfg.cliche.split);
  return withSlash(segs, marks, heldWeak(inp, sb, marks, cfg.slash));
}

const sameLabel = (a: V1aChord, b: V1aChord): boolean => a.root === b.root && a.quality === b.quality && a.bass === b.bass;

/**
 * The bass stage on v1a chords (pure; `beats` = beat times). Without `cliche.split` = markChords. With it, every chord
 * is also cut into pieces (cliche.ts) and marked as pieces; a chord keeps its pieces only when one of them gets a `/X`
 * (adjacent pieces with the same label merged), otherwise it is the unsplit chord's result.
 */
export function bassChords<C extends V1aChord>(low: LowCqt, chords: readonly C[], beats: readonly number[], cfg: BassConfig): (C & SlashFields)[] {
  const whole = markChords(low, chords, beats, cfg);
  if (!cfg.cliche.split) return whole;
  const pieces = splitByBass(low, chords, beats, cfg);
  if (pieces.length === chords.length) return whole;
  const split = markChords(
    low,
    pieces.map((p) => ({ ...chords[p.src], start: p.start, end: p.end })),
    beats,
    cfg,
  );
  const out: (C & SlashFields)[] = [];
  let k = 0;
  chords.forEach((_, i) => {
    const mine: (C & SlashFields)[] = [];
    while (k < pieces.length && pieces[k].src === i) mine.push(split[k++]);
    if (mine.length < 2 || !mine.some((m) => m.bass)) {
      out.push(whole[i]);
      return;
    }
    let last: (C & SlashFields) | null = null;
    for (const m of mine) {
      if (last && sameLabel(last, m)) last.end = m.end;
      else out.push((last = { ...m }));
    }
  });
  return out;
}

/** B-1 + B-2 (+ the T10 switches) on a finished v1a result. Returns a new result; unchanged v1a chords stay the same objects. */
export function applyBass(low: LowCqt, result: TsAnalysisResult, cfg: BassConfig, commit?: string): BassAnalysisResult {
  if (cfg.notes.enabled) throw new Error('bass: notes are not built yet (T11)');
  const chords = bassChords(low, result.chords, result.beats.map((b) => b.t), cfg);
  return { ...result, chords, bassAnalyzer: { config: cfg.name, configHash: bassConfigHash(cfg), ...(commit ? { commit } : {}) } };
}

/**
 * analyze() plus the bass stage. `input` as analyze(): with `{ y }` the signal is handed over (analyze drops it). The low
 * CQT is computed first because analyze releases y; it is held (about 6 MB for 5 min) until the bass stage ends.
 */
export function analyzeWithBass(input: Float32Array | { y: Float32Array | null }, opts: BassAnalyzeOptions = {}): BassAnalyzeOutput {
  const cfg = opts.bass ?? DEFAULT_BASS_CONFIG;
  if (!cfg.enabled) return analyze(input, opts);
  const y = input instanceof Float32Array ? input : input.y;
  if (!y) throw new Error('analyze: input.y is null');
  validateInput(y, LOW_SR); // the frozen analyzer's own checks, before the low CQT
  const now = opts.now ?? (() => performance.now());
  const mem = opts.mem ?? new MemTracker();
  const extra: StageStat[] = [];
  const stage = <T>(name: (typeof BASS_STAGES)[number], fn: () => T): T => {
    const t0 = now();
    const out = fn();
    const s: StageStat = { name, ms: now() - t0, memLive: mem.live, memPeak: mem.peak };
    extra.push(s);
    opts.onStage?.(s);
    return out;
  };
  const low = stage('bassLowCqt', () => {
    const l = lowCqt(y, cfg.lowCqt, { mem });
    mem.adopt(l.semi);
    return l;
  });
  const out = analyze(input, { ...opts, mem });
  const result = stage('bass', () => applyBass(low, out.result, cfg, opts.commit));
  mem.release(low.semi);
  const tm = result.analyzer.timingsSec;
  if (tm) {
    // same rounding and total as ts/dsp/result.ts (the v1a stages' total plus the bass stages)
    const timingsSec = { ...tm };
    for (const s of extra) timingsSec[s.name] = round3(s.ms / 1000);
    timingsSec.total = round3((tm.total ?? 0) + extra.reduce((a, s) => a + s.ms / 1000, 0));
    result.analyzer = { ...result.analyzer, timingsSec };
  }
  return { result, stats: [...out.stats, ...extra], mem: { peak: mem.peak, live: mem.live, total: mem.total } };
}

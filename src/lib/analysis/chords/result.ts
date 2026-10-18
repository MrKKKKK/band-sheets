/**
 * Spike 3 T14: py/dsp/result.py build_result / key_runs for the default config.
 *
 * Same keys, same order and same values as Python's result.json (render/types.ts AnalysisResult plus the
 * analyzer extras configHash / config / timingsSec / warnings and the per-chord `candidates`):
 *   - root names with sharps; chord segments with no chord (root null) are omitted (gaps = no chord);
 *   - bass is always null on the default path (chords.slash off), text carries '?' below low_confidence;
 *   - beats carry bar / beat only from the first downbeat on;
 *   - chord times: columns of `perBeat` per beat (chroma.column_times), a bound past the last column is the
 *     audio end; section times: beat times at phase + bar * beatsPerBar (past the last beat = audio end);
 *   - `keys` (per-bar key runs) only when barKeys is given (key.track 'sections', the default).
 * Differences from Python (documented): `analyzer.timingsSec` holds the TS stage timings (rounded to ms like
 * Python). JSON.stringify writes integral floats without '.0' (1.0 -> 1) and exponents as 1e-7 (Python
 * 1e-07): the parsed values are the same.
 */
import {
  chordName,
  chordText,
  DEFAULT_CHORDS_CONFIG,
  NOTE_NAMES,
  type ChordSegment,
} from './chords';
import { columnTimes } from './chroma';
import { configHash, configSummary, type AnalyzerConfig } from './config';
import type { Downbeats } from './downbeat';
import { pairwiseSum } from '../core/npmath';
import type { GlobalKey } from './keyest';
import type { BarKey } from './keytrack';
import type { Section } from './sections';

export interface ResultBeat {
  t: number;
  downbeat: boolean;
  bar?: number;
  beat?: number;
}

export interface ResultCandidate {
  name: string;
  root: string;
  quality: string;
  prob: number;
}

export interface ResultChord {
  start: number;
  end: number;
  root: string;
  quality: string;
  bass: string | null;
  text: string;
  confidence: number;
  candidates?: ResultCandidate[];
}

export interface KeyRun {
  startBar: number;
  tonic: string;
  mode: 'major' | 'minor';
  confidence: number;
}

/** The result JSON (render/types.ts AnalysisResult with the analyzer extras Python writes). */
export interface TsAnalysisResult {
  format: 'band-sheets-analysis';
  version: 1;
  source: { kind: 'recording'; durationSec: number; click: false };
  analyzer: {
    name: string;
    version: string;
    methods: string[];
    configHash: string;
    config: Record<string, unknown>;
    timingsSec?: Record<string, number>;
    warnings?: string[];
  };
  beats: ResultBeat[];
  timeSignature: { num: number; den: number; confidence: number };
  sections: { start: number; end: number; label: string }[];
  chords: ResultChord[];
  key?: { tonic: string; mode: 'major' | 'minor'; confidence: number };
  keys?: KeyRun[];
}

export interface ResultInputs {
  /** Final beat times (s). */
  times: ArrayLike<number>;
  /** len(y) / sr. */
  duration: number;
  segments: readonly ChordSegment[];
  downbeats: Downbeats;
  sections: readonly Section[];
  key: GlobalKey | null;
  cfg: AnalyzerConfig;
  timings?: Record<string, number>;
  barKeys?: readonly BarKey[] | null;
  warnings?: readonly string[];
}

/** py result._methods */
export function methods(cfg: AnalyzerConfig): string[] {
  return [
    `beats:${cfg.beats.method}`,
    `chroma:${cfg.chroma.kind}`,
    `chords:template+${cfg.chords.smoothing}`,
    'downbeat:chord+bass+onset',
    cfg.sections.enabled ? 'sections:novelty' : 'sections:off',
    cfg.key.enabled ? 'key:krumhansl-schmuckler' : 'key:off',
    `config:${configHash(cfg)}`,
  ];
}

/** Python round(x, 3) for the timings (half-even on the float; enough for display values). */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** py result.build_result */
export function buildResult(inp: ResultInputs): TsAnalysisResult {
  const times = Array.from(inp.times);
  const n = times.length;
  const dur = inp.duration;
  const bpb = inp.downbeats.beatsPerBar;
  const phase = inp.downbeats.phase;
  const beatTime = (i: number) => (i >= 0 && i < n ? times[i] : dur);

  const beats: ResultBeat[] = times.map((t, i) => {
    const b: ResultBeat = {
      t,
      downbeat: i >= phase && (i - phase) % bpb === 0,
    };
    if (i >= phase) {
      b.bar = Math.floor((i - phase) / bpb);
      b.beat = (i - phase) % bpb;
    }
    return b;
  });

  const colTimes = new Map<number, Float64Array>();
  const colTime = (c: number, pb: number) => {
    let ct = colTimes.get(pb);
    if (!ct) {
      ct = columnTimes(times, dur, pb);
      colTimes.set(pb, ct);
    }
    return c >= 0 && c < ct.length ? ct[c] : dur;
  };

  const ccfg = DEFAULT_CHORDS_CONFIG; // the chord settings of inp.cfg (default path, checked by configSummary)
  const chords: ResultChord[] = [];
  for (const s of inp.segments) {
    if (s.root === null) continue;
    const entry: ResultChord = {
      start:
        s.perBeat === 1
          ? beatTime(s.startBeat)
          : colTime(s.startBeat, s.perBeat),
      end:
        s.perBeat === 1 ? beatTime(s.endBeat) : colTime(s.endBeat, s.perBeat),
      root: NOTE_NAMES[s.root % 12],
      quality: s.quality,
      bass: s.bass !== null ? NOTE_NAMES[s.bass % 12] : null,
      text: chordText(
        {
          root: s.root,
          quality: s.quality,
          confidence: s.confidence,
          bass: s.bass,
        },
        ccfg,
      ),
      confidence: s.confidence,
    };
    if (inp.cfg.chords.candidates) {
      entry.candidates = s.candidates.map((c) => ({
        name: chordName(c.root, c.quality),
        root: NOTE_NAMES[c.root % 12],
        quality: c.quality,
        prob: c.prob,
      }));
    }
    chords.push(entry);
  }

  const sections = inp.sections.map((s) => ({
    start: beatTime(phase + s.startBar * bpb),
    end: beatTime(phase + s.endBar * bpb),
    label: s.label,
  }));

  const hash = configHash(inp.cfg);
  const analyzer: TsAnalysisResult['analyzer'] = {
    name: inp.cfg.name,
    version: hash,
    methods: methods(inp.cfg),
    configHash: hash,
    config: configSummary(inp.cfg),
  };
  if (inp.timings) {
    analyzer.timingsSec = Object.fromEntries(
      Object.entries(inp.timings).map(([k, v]) => [k, round3(v)]),
    );
  }
  if (inp.warnings && inp.warnings.length)
    analyzer.warnings = [...inp.warnings];

  const result: TsAnalysisResult = {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: 'recording', durationSec: dur, click: false },
    analyzer,
    beats,
    timeSignature: { num: bpb, den: 4, confidence: inp.downbeats.confidence },
    sections,
    chords,
  };
  if (inp.key)
    result.key = {
      tonic: inp.key.tonic,
      mode: inp.key.mode,
      confidence: inp.key.confidence,
    };
  if (inp.barKeys) result.keys = keyRuns(inp.barKeys);
  return result;
}

/** py result.key_runs: consecutive bars with the same key -> {startBar, tonic, mode, confidence (mean)}. */
export function keyRuns(barKeys: readonly BarKey[]): KeyRun[] {
  const runs: KeyRun[] = [];
  const confs: number[][] = [];
  const sorted = [...barKeys].sort((a, b) => a.bar - b.bar);
  for (const bk of sorted) {
    const tonic = NOTE_NAMES[bk.tonic % 12];
    const last = runs[runs.length - 1];
    if (last && last.tonic === tonic && last.mode === bk.mode) {
      confs[confs.length - 1].push(bk.confidence);
      continue;
    }
    runs.push({ startBar: bk.bar, tonic, mode: bk.mode, confidence: 0.0 });
    confs.push([bk.confidence]);
  }
  runs.forEach(
    (r, i) => (r.confidence = pairwiseSum(confs[i]) / confs[i].length),
  ); // np.mean
  return runs;
}

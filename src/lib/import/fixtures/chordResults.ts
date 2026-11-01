/**
 * Hand-made chord-analysis results for tests and stories (no audio, no analyzer run).
 * Shapes follow `TsAnalysisResult` (src/lib/analysis/chords/result.ts).
 */
import type { TsAnalysisResult } from '../../analysis/chords/result';

export interface MadeChord {
  /** Start / end in beats. */
  from: number;
  to: number;
  name: string;
  /** Below 0.93 the analyzer's text carries `?`. Default 0.99. */
  confidence?: number;
  /** Other candidates (name, prob), after the chord itself. */
  others?: [string, number][];
}

export interface MadeOptions {
  /** Beat interval in seconds (default 0.5 = 120 BPM). */
  beatSec?: number;
  /** Index of the first downbeat (default 0). */
  phase?: number;
  /** Seconds before beat 0 (default 0). */
  offset?: number;
  beatsPerBar?: number;
  /** [start beat, label]. Default one section 'A'. */
  sections?: [number, string][];
  key?: TsAnalysisResult['key'];
  keys?: TsAnalysisResult['keys'];
}

function quality(name: string): string {
  return /^[A-G][#b]?m(?!aj)/.test(name) ? 'min' : 'maj';
}

/** A result with `nBeats` evenly spaced beats and the given chords. */
export function madeResult(
  nBeats: number,
  chords: MadeChord[],
  opts: MadeOptions = {},
): TsAnalysisResult {
  const phase = opts.phase ?? 0;
  const bpb = opts.beatsPerBar ?? 4;
  const step = opts.beatSec ?? 0.5;
  const off = opts.offset ?? 0;
  const t = (b: number) => b * step + off;
  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: 'recording', durationSec: t(nBeats), click: false },
    analyzer: {
      name: 'dsp-v1',
      version: 'adec583eb3c6',
      methods: [],
      configHash: 'adec583eb3c6',
      config: {},
    },
    beats: Array.from({ length: nBeats }, (_, i) => ({
      t: t(i),
      downbeat: i >= phase && (i - phase) % bpb === 0,
    })),
    timeSignature: { num: bpb, den: 4, confidence: 1 },
    sections: (opts.sections ?? [[0, 'A']]).map(([b, label], i, a) => ({
      start: t(b),
      end: t(a[i + 1]?.[0] ?? nBeats),
      label,
    })),
    chords: chords.map((c) => {
      const conf = c.confidence ?? 0.99;
      return {
        start: t(c.from),
        end: t(c.to),
        root: c.name.replace(/^([A-G][#b]?).*$/, '$1'),
        quality: quality(c.name),
        bass: null,
        text: conf < 0.93 ? `${c.name}?` : c.name,
        confidence: conf,
        candidates: [
          [c.name, conf] as [string, number],
          ...(c.others ?? []),
        ].map(([name, prob]) => ({
          name,
          root: name.replace(/^([A-G][#b]?).*$/, '$1'),
          quality: quality(name),
          prob,
        })),
      };
    }),
    ...(opts.key ? { key: opts.key } : {}),
    ...(opts.keys ? { keys: opts.keys } : {}),
  };
}

type Piece = [
  name: string,
  beats: number,
  confidence?: number,
  others?: [string, number][],
];

/**
 * The sketch's song (S3): 20 bars of 4/4 at 96 BPM in G, sections A(8) B(8) A(4),
 * 4 low-confidence chords, an N.C. bar (no chord), ~0.7 s before the first downbeat.
 */
export function reviewSampleResult(): TsAnalysisResult {
  const pieces: Piece[] = [
    ['G', 8],
    ['C', 4],
    ['G', 2],
    ['D', 2],
    ['Em', 4],
    [
      'Am',
      4,
      0.49,
      [
        ['Am7', 0.21],
        ['C', 0.14],
      ],
    ],
    ['D', 4],
    ['G', 4],
    ['C', 4],
    ['G', 4],
    [
      'Am7',
      2,
      0.55,
      [
        ['Am', 0.3],
        ['C6', 0.1],
      ],
    ],
    ['D', 2],
    ['G', 4],
    ['C', 4],
    ['', 4],
    ['D', 2],
    [
      'D7',
      1,
      0.6,
      [
        ['D', 0.25],
        ['F#m', 0.1],
      ],
    ],
    ['D', 1],
    ['G', 8],
    [
      'G',
      4,
      0.62,
      [
        ['Em', 0.2],
        ['G6', 0.1],
      ],
    ],
    ['C', 4],
    ['G', 2],
    ['D', 2],
  ];
  const chords: MadeChord[] = [];
  let beat = 1; // beat 0 is before the first downbeat
  for (const [name, beats, confidence, others] of pieces) {
    if (name !== '')
      chords.push({ from: beat, to: beat + beats, name, confidence, others });
    beat += beats;
  }
  return madeResult(beat + 1, chords, {
    beatSec: 60 / 96,
    phase: 1,
    offset: 0.05,
    sections: [
      [1, 'A'],
      [33, 'B'],
      [65, 'A'],
    ],
    key: { tonic: 'G', mode: 'major', confidence: 0.8 },
    keys: [
      { startBar: 0, tonic: 'G', mode: 'major', confidence: 0.8 },
      { startBar: 8, tonic: 'D', mode: 'major', confidence: 0.4 },
    ],
  });
}

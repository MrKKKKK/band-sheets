import type {
  HumAnalysisResult,
  QuantizedEvent,
} from '../../analysis/hum/types';

/**
 * A hand-made humming result for tests and stories (S4): 4 bars of 4/4 at ♩= 96, bar 1 at 1.0 s, the singing
 * starting on beat 2. Notes 3 and 7 (event ids) are unsure and have pitch / position alternatives. Not from any
 * recording.
 */
export function humSampleResult(): HumAnalysisResult {
  const n = (
    startTick: number,
    ticks: number,
    midi: number,
    confidence: number,
    candidates: [number, number][] = [],
    grid: [number, number, number][] = [],
  ): QuantizedEvent => ({
    kind: 'note',
    startTick,
    ticks,
    midi,
    src: 0,
    confidence,
    candidates: candidates.map(([m, c]) => ({ midi: m, confidence: c })),
    gridCandidates: grid.map(([s, t, c]) => ({
      startTick: s,
      ticks: t,
      confidence: c,
    })),
  });
  const r = (startTick: number, ticks: number): QuantizedEvent => ({
    kind: 'rest',
    startTick,
    ticks,
  });
  const events: QuantizedEvent[] = [
    r(0, 16),
    n(16, 16, 64, 0.95),
    n(32, 16, 67, 0.95),
    n(
      48,
      16,
      69,
      0.42,
      [
        [68, 0.31],
        [70, 0.12],
      ],
      [[48, 8, 0.28]],
    ),
    n(64, 64, 71, 0.9, [[72, 0.2]]),
    r(128, 16),
    n(144, 16, 64, 0.9),
    n(
      160,
      16,
      67,
      0.3,
      [
        [66, 0.4],
        [68, 0.18],
      ],
      [[164, 12, 0.3]],
    ),
    n(176, 16, 69, 0.9),
    n(192, 48, 71, 0.85, [], [[192, 32, 0.25]]),
    r(240, 16),
  ];
  const sec = (tick: number) => 1 + (tick * 60) / (96 * 16);
  const notes = events.flatMap((e) =>
    e.kind === 'note'
      ? [
          {
            start: sec(e.startTick),
            end: sec(e.startTick + e.ticks),
            midi: e.midi,
            cents: 0,
            confidence: e.confidence,
            candidates: e.candidates,
          },
        ]
      : [],
  );
  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: 'synthetic', durationSec: 12, click: true, audioSec: 12 },
    analyzer: { name: 'hum-ts', version: 'fixture', methods: [] },
    melody: {
      notes,
      quantized: {
        bpm: 96,
        ts: [4, 4],
        startSec: 1,
        onsetBiasSec: 0,
        grid: 'sixteenth',
        events,
      },
    },
    hum: {
      meta: {
        configHash: 'fixture',
        configName: 'hum-v0',
        timings: { stagesMs: {}, totalMs: 0, audioSec: 12 },
        warnings: [],
        tuningCents: 0,
        info: { bpm: 96, ts: [4, 4], firstNoteSec: 1.6, firstNoteTick: 16 },
        grid: {
          startMode: 'firstNote',
          givenStartSec: 1,
          startSec: 1,
          phaseOffsetSec: 0,
          phaseSteps: 0,
          onsetBiasSec: 0,
          barPositionKnown: true,
        },
      },
    },
  };
}

/** The same with no sung note (S2: 「歌の声が見つかりませんでした」). */
export function humSilentResult(): HumAnalysisResult {
  const r = humSampleResult();
  r.melody.notes = [];
  r.melody.quantized.events = [{ kind: 'rest', startTick: 0, ticks: 64 }];
  return r;
}

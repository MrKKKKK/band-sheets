import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  HumAnalysisResult,
  PitchCandidate,
  QuantCandidate,
  QuantizedEvent,
} from '../analysis/hum/types';
import type { MelodyEvent, TimeSig } from '../melody';
import { ensureMelodyPart, readSection, writeSection } from '../melodyPart';
import { serializeMelody } from '../melodyTex';
import { parseSong } from '../parseSong';
import { serializeSong } from '../serializeSong';
import type { Song } from '../song';
import {
  humBpmFromSongTempo,
  humCandidates,
  humDraftEvents,
  proposeOctave,
  type HumDraftOk,
  type HumDraftOptions,
} from './humDraft';

const golden = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../analysis/fixtures/hum.expected.json'),
      'utf8',
    ),
  ) as { result: HumAnalysisResult }
).result;

type Ev = QuantizedEvent & { tuplet?: { n: 3; slot: number } };

const note = (
  startTick: number,
  ticks: number,
  midi: number,
  more: {
    candidates?: PitchCandidate[];
    gridCandidates?: QuantCandidate[];
    confidence?: number;
    tuplet?: { n: 3; slot: number };
  } = {},
): Ev => ({
  kind: 'note',
  startTick,
  ticks,
  midi,
  src: 0,
  candidates: more.candidates ?? [],
  gridCandidates: more.gridCandidates ?? [],
  confidence: more.confidence ?? 1,
  ...(more.tuplet ? { tuplet: more.tuplet } : {}),
});
const rest = (
  startTick: number,
  ticks: number,
  tuplet?: { n: 3; slot: number },
): Ev => ({ kind: 'rest', startTick, ticks, ...(tuplet ? { tuplet } : {}) });

/** A hum result holding just the quantized events (bpm 120 unless given, bar 1 at 1.0 s). */
function made(
  events: Ev[],
  opts: { ts?: [number, number]; bpm?: number; startSec?: number } = {},
): HumAnalysisResult {
  const ts = opts.ts ?? [4, 4];
  const bpm = opts.bpm ?? 120;
  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: 'synthetic', durationSec: 10, click: true },
    analyzer: { name: 'hum-ts', version: 'x', methods: [] },
    melody: {
      notes: [],
      quantized: {
        bpm,
        ts,
        startSec: opts.startSec ?? 1,
        onsetBiasSec: 0,
        grid: 'sixteenth',
        events,
      },
    },
    hum: {
      meta: {
        configHash: 'x',
        configName: 'x',
        timings: { stagesMs: {}, totalMs: 0, audioSec: 10 },
        warnings: [],
        tuningCents: 0,
        info: { bpm, ts, startSec: 1 },
        grid: {
          startMode: 'barStart',
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

const OPTS: HumDraftOptions = {
  octave: 0,
  transpose: 0,
  shiftTicks: 0,
  chosen: {},
};

function ok(
  result: HumAnalysisResult,
  opts: Partial<HumDraftOptions> = {},
): HumDraftOk {
  const d = humDraftEvents(result, { ...OPTS, ...opts });
  if (!d.ok) throw new Error(`draft failed: ${d.reason}`);
  return d;
}

const short = (events: MelodyEvent[]) =>
  events.map((e) =>
    e.kind === 'rest'
      ? `r${e.ticks}${e.tuplet ? `/${e.tuplet.slot}` : ''}`
      : `${e.pitch}:${e.ticks}${e.tuplet ? `/${e.tuplet.slot}` : ''}`,
  );

/** Required check (plan §3.2): one section of a song, written, serialized, parsed and read back. */
function roundTrip(events: MelodyEvent[], ts: TimeSig): MelodyEvent[] {
  const base: Song = {
    meta: { title: 't', time: `${ts.num}/${ts.den}` },
    chart: [{ kind: 'verse', label: 'A', lines: [] }],
    parts: [],
  };
  const { song, partIndex } = ensureMelodyPart(base);
  const body = writeSection(song.parts[partIndex].body, 'A', events, ts, ['A']);
  const parts = song.parts.map((p, i) =>
    i === partIndex ? { ...p, body } : p,
  );
  const back = parseSong(serializeSong({ ...song, parts }));
  const read = readSection(back.parts[partIndex].body, 'A', ts);
  if (read.status !== 'ok') throw new Error(JSON.stringify(read));
  return read.events;
}

describe('humDraftEvents', () => {
  it('lays notes from the bar-1 head, rests in gaps, pads the last bar', () => {
    const d = ok(
      made([
        rest(0, 16),
        note(16, 8, 60),
        note(24, 8, 62),
        rest(32, 16),
        note(48, 4, 64),
        rest(52, 12),
      ]),
    );
    expect(d.ts).toEqual({ num: 4, den: 4 });
    expect(short(d.events)).toEqual([
      'r16',
      'C4:8',
      'D4:8',
      'r16',
      'E4:4',
      'r12',
    ]);
    // ids: index of the source event in melody.quantized.events (rests: null)
    expect(d.ids).toEqual([null, 1, 2, null, 4, null]);
    expect(d.dropped).toBe(0);
    expect(d.startSec).toBe(1);
  });

  it('re-derives rests and pads even when the analyzer left no final rest', () => {
    const d = ok(made([note(0, 20, 60)]));
    expect(short(d.events)).toEqual(['C4:20', 'r44']);
  });

  it('empty result: no events (and an empty section round-trips)', () => {
    const d = ok(made([]));
    expect(d.events).toEqual([]);
    expect(d.ids).toEqual([]);
    expect(roundTrip(d.events, d.ts)).toEqual([]);
    expect(ok(made([rest(0, 64)])).events).toEqual([]);
  });

  it('single note', () => {
    const d = ok(made([note(0, 64, 67)]));
    expect(short(d.events)).toEqual(['G4:64']);
    expect(roundTrip(d.events, d.ts)).toEqual(d.events);
  });

  it('a note crossing a barline stays ONE event (the writer ties it)', () => {
    const d = ok(made([rest(0, 48), note(48, 32, 65), rest(80, 48)]));
    expect(short(d.events)).toEqual(['r48', 'F4:32', 'r48']);
    const tex = serializeMelody(d.events, d.ts, 'A');
    expect(tex).toContain('{t}');
    expect(roundTrip(d.events, d.ts)).toEqual(d.events);
  });

  it('very short notes (one 16th, the analyzer grid step) survive', () => {
    const d = ok(made([note(0, 4, 60), note(4, 4, 62), rest(8, 56)]));
    expect(short(d.events)).toEqual(['C4:4', 'D4:4', 'r56']);
    expect(serializeMelody(d.events, d.ts)).toMatch(/^:16 C4 D4/);
    expect(roundTrip(d.events, d.ts)).toEqual(d.events);
  });

  describe('pitch spelling by key', () => {
    const r = made([note(0, 16, 61), note(16, 16, 70), rest(32, 32)]);
    it('sharps without a key / in a sharp key', () => {
      expect(short(ok(r).events).slice(0, 2)).toEqual(['C#4:16', 'A#4:16']);
      expect(short(ok(r, { key: 'D' }).events).slice(0, 2)).toEqual([
        'C#4:16',
        'A#4:16',
      ]);
    });
    it('flats in a flat key (major or minor)', () => {
      expect(short(ok(r, { key: 'F' }).events).slice(0, 2)).toEqual([
        'Db4:16',
        'Bb4:16',
      ]);
      expect(short(ok(r, { key: 'Dm' }).events).slice(0, 2)).toEqual([
        'Db4:16',
        'Bb4:16',
      ]);
    });
  });

  describe('octave and transpose', () => {
    const r = made([note(0, 32, 60), note(32, 32, 64)]);
    it('octave adds whole octaves, transpose semitones (respelled by key)', () => {
      expect(short(ok(r, { octave: 1 }).events)).toEqual(['C5:32', 'E5:32']);
      expect(short(ok(r, { octave: -1 }).events)).toEqual(['C3:32', 'E3:32']);
      expect(short(ok(r, { transpose: 3, key: 'Eb' }).events)).toEqual([
        'Eb4:32',
        'G4:32',
      ]);
    });
    it('pitches outside C3–C7 are folded into it by octaves', () => {
      const low = made([note(0, 32, 40), note(32, 32, 100)]);
      expect(short(ok(low).events)).toEqual(['E3:32', 'E6:32']);
      // C3 and C7 themselves stay
      expect(
        short(ok(made([note(0, 32, 48), note(32, 32, 96)])).events),
      ).toEqual(['C3:32', 'C7:32']);
      // extreme octave values still give a valid draft
      expect(short(ok(r, { octave: 9 }).events)).toEqual(['C7:32', 'E6:32']);
      expect(short(ok(r, { octave: -9 }).events)).toEqual(['C3:32', 'E3:32']);
    });
    it('non-integer octave / transpose -> invalidOptions', () => {
      expect(humDraftEvents(r, { ...OPTS, octave: 0.5 })).toEqual({
        ok: false,
        reason: 'invalidOptions',
      });
      expect(humDraftEvents(r, { ...OPTS, transpose: NaN })).toEqual({
        ok: false,
        reason: 'invalidOptions',
      });
    });
  });

  describe('shift (歌い始めのずらし)', () => {
    const r = made([
      rest(0, 16),
      note(16, 16, 60),
      note(32, 16, 62),
      rest(48, 16),
    ]);
    it('later: notes move right, the bar-1 head second moves earlier', () => {
      const d = ok(r, { shiftTicks: 16 });
      expect(short(d.events)).toEqual(['r32', 'C4:16', 'D4:16']);
      // 120 bpm quarter: a 16-tick beat is 0.5 s
      expect(d.startSec).toBeCloseTo(0.5, 9);
    });
    it('earlier: notes starting before the bar-1 head are dropped (counted)', () => {
      const d = ok(r, { shiftTicks: -20 });
      // C4 would start at -4: dropped whole; D4 now at 12
      expect(short(d.events)).toEqual(['r12', 'D4:16', 'r36']);
      expect(d.ids).toEqual([null, 2, null]);
      expect(d.dropped).toBe(1);
      expect(d.startSec).toBeCloseTo(1 + 20 * (0.5 / 16), 9);
    });
    it('must be a whole number of 16ths', () => {
      for (const shiftTicks of [2, 0.5, NaN])
        expect(humDraftEvents(r, { ...OPTS, shiftTicks })).toEqual({
          ok: false,
          reason: 'invalidOptions',
        });
    });
  });

  it('a note before the bar-1 head in the result itself is dropped', () => {
    const d = ok(made([note(-8, 16, 60), note(8, 8, 62), rest(16, 48)]));
    expect(short(d.events)).toEqual(['r8', 'D4:8', 'r48']);
    expect(d.dropped).toBe(1);
  });

  it('malformed result (odd ticks) -> invalidResult, not a throw', () => {
    expect(humDraftEvents(made([note(0, 3, 60)]), OPTS)).toEqual({
      ok: false,
      reason: 'invalidResult',
    });
    expect(
      humDraftEvents(
        made([note(0, 8, 60, { tuplet: { n: 3, slot: 0 } })]),
        OPTS,
      ),
    ).toEqual({ ok: false, reason: 'invalidResult' });
  });

  describe('chosen candidates', () => {
    const r = made([
      note(0, 16, 60, {
        candidates: [{ midi: 61, confidence: 0.4 }],
        gridCandidates: [{ startTick: 4, ticks: 12, confidence: 0.3 }],
      }),
      note(16, 16, 64, {
        gridCandidates: [{ startTick: 12, ticks: 20, confidence: 0.4 }],
      }),
      rest(32, 32),
    ]);
    it('pitch: the chosen midi (before octave/transpose)', () => {
      const d = ok(r, { chosen: { 0: { midi: 61 } }, octave: 1 });
      expect(short(d.events)).toEqual(['C#5:16', 'E5:16', 'r32']);
    });
    it('position: start and length replaced; the gap becomes a rest', () => {
      const d = ok(r, {
        chosen: { 0: { position: { startTick: 4, ticks: 12 } } },
      });
      expect(short(d.events)).toEqual(['r4', 'C4:12', 'E4:16', 'r32']);
      expect(d.ids).toEqual([null, 0, 1, null]);
    });
    it('position moved earlier into the previous note: the previous is cut', () => {
      const d = ok(r, {
        chosen: { 1: { position: { startTick: 12, ticks: 20 } } },
      });
      expect(short(d.events)).toEqual(['C4:12', 'E4:20', 'r32']);
      expect(roundTrip(d.events, d.ts)).toEqual(d.events);
    });
    it('position onto another note’s start: the chosen note wins, the other is dropped', () => {
      const d = ok(r, {
        chosen: { 1: { position: { startTick: 0, ticks: 16 } } },
      });
      expect(short(d.events)).toEqual(['E4:16', 'r48']);
      expect(d.ids).toEqual([1, null]);
      expect(d.dropped).toBe(1);
    });
    it('invalid chosen values -> invalidOptions; choices on rests are ignored', () => {
      expect(
        humDraftEvents(r, { ...OPTS, chosen: { 0: { midi: 60.5 } } }),
      ).toEqual({ ok: false, reason: 'invalidOptions' });
      expect(
        humDraftEvents(r, {
          ...OPTS,
          chosen: { 0: { position: { startTick: 0, ticks: 3 } } },
        }),
      ).toEqual({ ok: false, reason: 'invalidOptions' });
      expect(short(ok(r, { chosen: { 2: { midi: 70 } } }).events)).toEqual([
        'C4:16',
        'E4:16',
        'r32',
      ]);
    });
  });

  describe('triplets (the analyzer’s triplet switch)', () => {
    const t = (slot: number) => ({ n: 3 as const, slot });
    const r = made([
      note(0, 16, 60),
      note(16, 8, 62, { tuplet: t(0) }),
      rest(16 + 16 / 3, 8, t(1)),
      note(16 + 32 / 3, 8, 64, { tuplet: t(2) }),
      rest(32, 16),
      note(48, 8, 65, { tuplet: t(0) }),
      note(48 + 16 / 3, 8, 67, { tuplet: t(1) }),
      note(48 + 32 / 3, 8, 69, { tuplet: t(2) }),
    ]);
    it('keeps the group (rest slots included) and round-trips', () => {
      const d = ok(r);
      expect(short(d.events)).toEqual([
        'C4:16',
        'D4:8/0',
        'r8/1',
        'E4:8/2',
        'r16',
        'F4:8/0',
        'G4:8/1',
        'A4:8/2',
      ]);
      expect(d.ids).toEqual([0, 1, null, 3, null, 5, 6, 7]);
      expect(roundTrip(d.events, d.ts)).toEqual(d.events);
    });
    it('a shift that pushes a group across a barline -> tupletCrossesBar', () => {
      expect(humDraftEvents(r, { ...OPTS, shiftTicks: 4 })).toEqual({
        ok: false,
        reason: 'tupletCrossesBar',
      });
      expect(ok(r, { shiftTicks: 16 }).events).toHaveLength(10);
    });
    it('a chosen position on a triplet note is ignored', () => {
      expect(
        ok(r, { chosen: { 1: { position: { startTick: 20, ticks: 4 } } } })
          .events,
      ).toEqual(ok(r).events);
    });
  });

  it('golden fixture: valid draft that round-trips through the song text', () => {
    const d = ok(golden, { octave: proposeOctave(golden), key: 'Eb' });
    expect(d.events.filter((e) => e.kind === 'note')).toHaveLength(
      golden.melody.quantized.events.filter((e) => e.kind === 'note').length,
    );
    expect(roundTrip(d.events, d.ts)).toEqual(d.events);
    expect(d.startSec).toBe(golden.melody.quantized.startSec);
  });

  it('round trip in 3/4 and 6/8', () => {
    const r34 = made([note(0, 24, 60), note(24, 24, 62), rest(48, 48)], {
      ts: [3, 4],
    });
    const d34 = ok(r34);
    expect(d34.ts).toEqual({ num: 3, den: 4 });
    expect(short(d34.events)).toEqual(['C4:24', 'D4:24']);
    expect(roundTrip(d34.events, d34.ts)).toEqual(d34.events);

    const r68 = made([note(0, 12, 60), note(12, 36, 62)], {
      ts: [6, 8],
      bpm: 180,
    });
    const d68 = ok(r68);
    expect(short(d68.events)).toEqual(['C4:12', 'D4:36']);
    expect(roundTrip(d68.events, d68.ts)).toEqual(d68.events);
  });
});

describe('tempo: hum bpm counts the time signature’s beat, {tempo} counts quarters', () => {
  it('draft.tempo is the song tempo of the analysis bpm', () => {
    expect(ok(made([], { ts: [4, 4], bpm: 100 })).tempo).toBe(100);
    expect(ok(made([], { ts: [3, 4], bpm: 90 })).tempo).toBe(90);
    // 6/8: the analyzer counted eighths; 180 eighths/min = 90 quarters/min
    expect(ok(made([], { ts: [6, 8], bpm: 180 })).tempo).toBe(90);
    // 2/2: halves
    expect(ok(made([], { ts: [2, 2], bpm: 60 })).tempo).toBe(120);
  });
  it('humBpmFromSongTempo is the inverse (what S2 gives the analyzer)', () => {
    expect(humBpmFromSongTempo(100, { num: 4, den: 4 })).toBe(100);
    expect(humBpmFromSongTempo(90, { num: 6, den: 8 })).toBe(180);
    expect(humBpmFromSongTempo(120, { num: 2, den: 2 })).toBe(60);
  });
  it('the shift seconds use the analyzer grid (6/8 at 180 eighths: a tick is 1/24 s)', () => {
    const d = ok(made([note(0, 8, 60)], { ts: [6, 8], bpm: 180 }), {
      shiftTicks: 24,
    });
    expect(d.startSec).toBeCloseTo(1 - 24 / 24, 9);
  });
});

describe('proposeOctave', () => {
  const mk = (midis: number[]) => made(midis.map((m, i) => note(i * 8, 8, m)));
  it('0 when the notes already fit C3–C7 (or there are none)', () => {
    expect(proposeOctave(mk([57, 64, 76]))).toBe(0);
    expect(proposeOctave(mk([48, 96]))).toBe(0);
    expect(proposeOctave(mk([]))).toBe(0);
  });
  it('up for a low voice, down for a too high one', () => {
    expect(proposeOctave(mk([43, 50, 62]))).toBe(1); // G2..D4
    expect(proposeOctave(mk([30, 40]))).toBe(2);
    expect(proposeOctave(mk([90, 100]))).toBe(-1);
  });
  it('no octave fits all: most notes in range, then the smaller move, then the median nearer C5', () => {
    // 47..100 is wider than C3–C7: 0 keeps 3 notes, +1 and -1 keep 4 each;
    // +1 puts the median at D5 (near C5), -1 at D3
    expect(proposeOctave(mk([47, 60, 62, 64, 100]))).toBe(1);
    // a single wild note does not move a voice that otherwise fits
    expect(proposeOctave(mk([60, 62, 64, 65, 67, 110]))).toBe(0);
  });
  it('uses the analyzer midi, not the chosen candidate', () => {
    expect(proposeOctave(made([note(0, 8, 43), note(8, 8, 45)]))).toBe(1);
  });
});

describe('humCandidates', () => {
  const r = made([
    rest(0, 16),
    note(16, 40, 60, {
      confidence: 0.3,
      candidates: [
        { midi: 61, confidence: 0.4 },
        { midi: 59, confidence: 0.2 },
        { midi: 72, confidence: 0.1, octaveFixed: true },
        { midi: 48, confidence: 0.05 },
      ],
      gridCandidates: [
        { startTick: 12, ticks: 44, confidence: 0.3 },
        { startTick: 16, ticks: 36, confidence: 0.2 },
        { startTick: 20, ticks: 36, confidence: 0.1 },
      ],
    }),
    note(56, 8, 64, { confidence: 0.9 }),
    rest(64, 64),
  ]);

  it('aligned with draft.events: rests null, notes keyed by their source id', () => {
    const d = ok(r);
    const c = humCandidates(r, d, OPTS);
    expect(c).toHaveLength(d.events.length);
    expect(c.map((x) => x?.id ?? null)).toEqual(d.ids);
  });

  it('pitch: original first + at most 3 alternatives, spelled as written now', () => {
    const opts = { ...OPTS, key: 'F', octave: 1 };
    const d = ok(r, opts);
    const c = humCandidates(r, d, opts)[1]!;
    expect(c.pitch).toEqual([
      { midi: 60, pitch: 'C5', original: true, selected: true },
      {
        midi: 61,
        pitch: 'Db5',
        confidence: 0.4,
        original: false,
        selected: false,
      },
      {
        midi: 59,
        pitch: 'B4',
        confidence: 0.2,
        original: false,
        selected: false,
      },
      {
        midi: 72,
        pitch: 'C6',
        confidence: 0.1,
        original: false,
        selected: false,
      },
    ]);
  });

  it('position: original first + at most 2 alternatives (analyzer ticks, before the shift)', () => {
    const d = ok(r, { shiftTicks: 16 });
    const c = humCandidates(r, d, { ...OPTS, shiftTicks: 16 })[1]!;
    expect(c.position).toEqual([
      { startTick: 16, ticks: 40, original: true, selected: true },
      {
        startTick: 12,
        ticks: 44,
        confidence: 0.3,
        original: false,
        selected: false,
      },
      {
        startTick: 16,
        ticks: 36,
        confidence: 0.2,
        original: false,
        selected: false,
      },
    ]);
  });

  it('low-confidence mark: below LOW_CONFIDENCE and not chosen; folded notes too', () => {
    const d = ok(r);
    const c = humCandidates(r, d, OPTS);
    expect(c[1]!.low).toBe(true);
    expect(c[2]!.low).toBe(false);
    const chosen = { 1: { midi: 61 } };
    const d2 = ok(r, { chosen });
    const c2 = humCandidates(r, d2, { ...OPTS, chosen });
    expect(c2[1]!.low).toBe(false);
    expect(c2[1]!.pitch.map((p) => p.selected)).toEqual([
      false,
      true,
      false,
      false,
    ]);

    const far = made([note(0, 16, 100, { confidence: 1 }), rest(16, 48)]);
    const cf = humCandidates(far, ok(far), OPTS)[0]!;
    expect(cf.folded).toBe(true);
    expect(cf.low).toBe(true);
    expect(cf.pitch[0].pitch).toBe('E6');
  });

  it('a chosen position is selected and the note keeps its id', () => {
    const chosen = { 1: { position: { startTick: 12, ticks: 44 } } };
    const d = ok(r, { chosen });
    expect(short(d.events)).toEqual(['r12', 'C4:44', 'E4:8']);
    const c = humCandidates(r, d, { ...OPTS, chosen });
    expect(c[1]!.id).toBe(1);
    expect(c[1]!.position.map((p) => p.selected)).toEqual([false, true, false]);
  });

  it('a note across a barline is one event with one candidate entry, also after the round trip', () => {
    const x = made([
      rest(0, 48),
      note(48, 32, 65, { candidates: [{ midi: 66, confidence: 0.4 }] }),
      rest(80, 48),
    ]);
    const d = ok(x);
    const c = humCandidates(x, d, OPTS);
    expect(c.filter(Boolean)).toHaveLength(1);
    expect(c[1]!.pitch.map((p) => p.pitch)).toEqual(['F4', 'F#4']);
    expect(roundTrip(d.events, d.ts)).toHaveLength(d.events.length);
  });

  it('triplet notes: pitch alternatives only, no position alternatives', () => {
    const x = made([
      note(0, 8, 60, {
        tuplet: { n: 3, slot: 0 },
        candidates: [{ midi: 62, confidence: 0.3 }],
        gridCandidates: [{ startTick: 4, ticks: 4, confidence: 0.3 }],
      }),
      note(16 / 3, 8, 62, { tuplet: { n: 3, slot: 1 } }),
      note(32 / 3, 8, 64, { tuplet: { n: 3, slot: 2 } }),
      rest(16, 48),
    ]);
    const c = humCandidates(x, ok(x), OPTS)[0]!;
    expect(c.pitch).toHaveLength(2);
    expect(c.position).toEqual([
      { startTick: 0, ticks: 8, original: true, selected: true },
    ]);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TsAnalysisResult } from '../analysis/chords/result';
import { lineBarCount } from '../autoScroll';
import { isDashLine, meterOf, validateDashLine } from '../dashChart';
import { parseSong } from '../parseSong';
import { serializeSong } from '../serializeSong';
import { isRawLine } from '../song';
import {
  barChords,
  chordCandidates,
  chordDraftSong,
  draftMeter,
  draftTempo,
  droppedSeconds,
  titleFromFileName,
} from './chordDraft';
import {
  draftComment,
  draftTitle,
  formatDraftDate,
  markChordDraft,
} from './draftMarks';

const golden = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../analysis/fixtures/chords.expected.json'),
    'utf8',
  ),
) as TsAnalysisResult;

/** 120 BPM, beat i at 0.5 * i + offset, downbeat at `phase`; chords given in beats. */
function made(
  nBeats: number,
  chords: [number, number, string, number?][],
  opts: { phase?: number; offset?: number; sections?: [number, string][] } = {},
): TsAnalysisResult {
  const phase = opts.phase ?? 0;
  const off = opts.offset ?? 0;
  const t = (b: number) => b * 0.5 + off;
  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: 'recording', durationSec: t(nBeats), click: false },
    analyzer: {
      name: 'dsp-v1',
      version: 'x',
      methods: [],
      configHash: 'adec583eb3c6',
      config: {},
    },
    beats: Array.from({ length: nBeats }, (_, i) => ({
      t: t(i),
      downbeat: i >= phase && (i - phase) % 4 === 0,
    })),
    timeSignature: { num: 4, den: 4, confidence: 1 },
    sections: (opts.sections ?? [[0, 'A']]).map(([b, label], i, a) => ({
      start: t(b),
      end: t(a[i + 1]?.[0] ?? nBeats),
      label,
    })),
    chords: chords.map(([s, e, name, conf = 0.99]) => ({
      start: t(s),
      end: t(e),
      root: name[0],
      quality: 'maj',
      bass: null,
      text: conf < 0.93 ? name + '?' : name,
      confidence: conf,
      candidates: [
        { name, root: name[0], quality: 'maj', prob: conf },
        { name: 'Am', root: 'A', quality: 'min', prob: 0.05 },
        { name: 'F', root: 'F', quality: 'maj', prob: 0.02 },
        { name: 'D', root: 'D', quality: 'maj', prob: 0.01 },
      ],
    })),
  };
}

function lines(song: ReturnType<typeof chordDraftSong>['song']): string[] {
  return song.chart.flatMap((s) =>
    s.lines.map((l) =>
      isRawLine(l)
        ? l.raw
        : l.segments
            .map((x) => (x.chord ? `[${x.chord}]` : '') + x.lyrics)
            .join(''),
    ),
  );
}

describe('barChords', () => {
  it('splits chords into 4-beat bars in sixteenths', () => {
    const r = made(9, [
      [0, 6, 'C'],
      [6, 8, 'G'],
    ]);
    const bars = barChords(r, 0);
    expect(bars).toHaveLength(2); // beats 0-3, 4-7 (bar from beat 8 has 1 beat: not made)
    expect(bars[0].chords.map((c) => [c.chord, c.start, c.length])).toEqual([
      ['C', 0, 16],
    ]);
    expect(bars[1].chords.map((c) => [c.chord, c.start, c.length])).toEqual([
      ['C', 0, 8],
      ['G', 8, 8],
    ]);
    expect(bars[1].chords.map((c) => c.id)).toEqual([0, 1]);
  });

  it('interpolates inside uneven beats and keeps real values', () => {
    const r = made(8, [[0, 1.5, 'C']]);
    expect(barChords(r, 0)[0].chords[0].length).toBeCloseTo(6);
  });

  it('shifts the downbeat by whole beats and drops earlier audio', () => {
    const r = made(13, [
      [0, 4, 'C'],
      [4, 8, 'F'],
      [8, 13, 'G'],
    ]);
    const s1 = barChords(r, 1);
    expect(s1[0].startSec).toBe(0.5);
    expect(s1[0].chords.map((c) => [c.chord, c.start])).toEqual([
      ['C', 0],
      ['F', 12],
    ]);
    expect(droppedSeconds(r, 0)).toBe(0);
    expect(droppedSeconds(r, 1)).toBe(0.5);
    // shift -1 with the downbeat at beat 0: the first whole bar starts at beat 3
    expect(barChords(r, -1)[0].startSec).toBe(1.5);
    expect(droppedSeconds(r, -1)).toBe(1.5);
  });

  it('uses the analyzer phase (pickup beats are dropped)', () => {
    const r = made(14, [[0, 14, 'C']], { phase: 2 });
    expect(barChords(r, 0)[0].startSec).toBe(1);
    expect(droppedSeconds(r, 0)).toBe(1);
  });

  it('keeps ids stable across shifts', () => {
    const r = made(20, [
      [0, 6, 'C'],
      [6, 12, 'F'],
      [12, 20, 'G'],
    ]);
    const ids = (shift: number) => [
      ...new Set(barChords(r, shift).flatMap((b) => b.chords.map((c) => c.id))),
    ];
    expect(ids(0)).toEqual([0, 1, 2]);
    expect(ids(1)).toEqual([0, 1, 2]);
  });

  it('applies chosen candidates (drops the ?) and keeps ? otherwise', () => {
    const r = made(8, [
      [0, 4, 'C', 0.5],
      [4, 8, 'F', 0.5],
    ]);
    const bars = barChords(r, 0, { 0: 'Am' });
    expect(bars[0].chords[0]).toMatchObject({
      chord: 'Am',
      lowConfidence: false,
    });
    expect(bars[1].chords[0]).toMatchObject({
      chord: 'F?',
      lowConfidence: true,
    });
  });

  it('handles results with no beats', () => {
    expect(barChords(made(0, []), 0)).toEqual([]);
  });
});

describe('chordCandidates', () => {
  it('lists top-k with the analyzer confidences', () => {
    const r = made(8, [[0, 4, 'C', 0.5]]);
    const [c] = chordCandidates(r, 2);
    expect(c.text).toBe('C?');
    expect(c.lowConfidence).toBe(true);
    expect(c.candidates).toEqual([
      { name: 'C', confidence: 0.5 },
      { name: 'Am', confidence: 0.05 },
    ]);
  });

  it('adds the analyzer chord when candidates are missing', () => {
    const r = made(8, [[0, 4, 'C', 0.5]]);
    delete r.chords[0].candidates;
    expect(chordCandidates(r)[0].candidates).toEqual([
      { name: 'C', confidence: 0.5 },
    ]);
  });
});

describe('chordDraftSong', () => {
  const r = made(
    33,
    [
      [0, 6, 'C'],
      [6, 8, 'G', 0.6],
      [8, 16, 'Am'],
      // bars 4-5 (beats 16-23): silence
      [24, 32, 'F'],
    ],
    {
      sections: [
        [0, 'A'],
        [16.3, 'B'],
      ],
    },
  );

  it('writes meta, sections aligned to bars, dash lines', () => {
    const { song, tempo, droppedSec } = chordDraftSong(r, {
      title: 'テスト',
      downbeatShift: 0,
    });
    expect(tempo).toBe(120);
    expect(droppedSec).toBe(0);
    expect(song.meta).toMatchObject({
      title: 'テスト',
      tempo: 120,
      time: '4/4',
    });
    expect(song.chart.map((s) => s.label)).toEqual(['A', 'B']);
    expect(lines(song)).toEqual([
      '|[C]--------|[C]----[G?]----|[Am]--------|[Am]--------|',
      '|[N.C.]--------|[N.C.]--------|[F]--------|[F]--------|',
    ]);
  });

  it('drops ? for chosen chords and reports dropped audio', () => {
    const d = chordDraftSong(r, {
      title: 't',
      downbeatShift: 1,
      chosen: { 1: 'F' },
      tempo: 90,
    });
    expect(d.tempo).toBe(90);
    expect(d.droppedSec).toBe(0.5);
    expect(lines(d.song).join('\n')).not.toContain('?');
  });

  it('makes one A section when the analyzer found none, and N.C. bars', () => {
    const x = made(9, []);
    x.sections = [];
    const { song } = chordDraftSong(x, { title: 't', downbeatShift: 0 });
    expect(song.chart).toHaveLength(1);
    expect(song.chart[0].label).toBe('A');
    expect(lines(song)).toEqual(['|[N.C.]--------|[N.C.]--------|']);
  });

  it('collapses sections that land on the same bar', () => {
    const x = made(32, [[0, 32, 'C']], {
      sections: [
        [0, 'A'],
        [0.5, 'B'],
        [16, 'C'],
      ],
    });
    const { song } = chordDraftSong(x, { title: 't', downbeatShift: 0 });
    expect(song.chart.map((s) => s.label)).toEqual(['A', 'C']);
  });

  it('uses the global key and median-interval tempo', () => {
    expect(draftTempo(golden)).toBe(Math.round(60 / 0.4283));
    const { song } = chordDraftSong(golden, { title: 'g', downbeatShift: 0 });
    expect(song.meta.key).toBe('Gm');
  });

  it('title from file name', () => {
    expect(titleFromFileName('My Song.final.mp3')).toBe('My Song.final');
    expect(titleFromFileName('C:\\a\\b.wav')).toBe('b');
    expect(titleFromFileName('noext')).toBe('noext');
  });
});

describe('round trip (serializeSong -> parseSong)', () => {
  const cases: [string, TsAnalysisResult, number][] = [
    ['golden fixture', golden, 0],
    ['golden fixture, shifted', golden, 1],
    [
      'hand-made, 2 sections, 6 bars of 4/4 + low confidence',
      made(
        49,
        [
          [0, 5, 'C', 0.5],
          [5, 9, 'G7'],
          [9, 14, 'Am'],
          [14, 30, 'F'],
          [36, 48, 'C/E'],
        ],
        {
          sections: [
            [0, 'A'],
            [20, 'B'],
          ],
          offset: 0.37,
        },
      ),
      0,
    ],
  ];
  it.each(cases)('%s', (_n, result, shift) => {
    const draft = chordDraftSong(result, { title: 't', downbeatShift: shift });
    const marked = markChordDraft(draft.song, {
      date: '2026-10-19',
      configHash: result.analyzer.configHash,
    });
    const text = serializeSong(marked);
    const back = parseSong(text);
    expect(serializeSong(back)).toBe(text);
    expect(back.parts).toEqual([]);
    expect(back.meta.title).toBe('t（下書き）');

    const ts = meterOf(back.meta.time);
    let barCount = 0;
    for (const s of back.chart) {
      for (const l of s.lines) {
        if (isRawLine(l)) continue;
        expect(isDashLine(l)).toBe(true);
        expect(validateDashLine(l, ts)).toEqual([]);
        barCount += lineBarCount(l);
      }
    }
    expect(barCount).toBe(draft.bars.length);
    expect(draft.bars.length).toBeGreaterThan(0);
  });
});

describe('draftMarks', () => {
  it('marks the title once and writes the comment first', () => {
    expect(draftTitle('A')).toBe('A（下書き）');
    expect(draftTitle('A（下書き）')).toBe('A（下書き）');
    expect(draftComment('2026-10-18', 'adec583eb3c6')).toBe(
      '{comment: 自動解析の下書き 2026-10-18 コード adec583eb3c6}',
    );
    expect(formatDraftDate(new Date(2026, 9, 5))).toBe('2026-10-05');
    const { song } = chordDraftSong(golden, { title: 'g', downbeatShift: 0 });
    const info = { date: '2026-10-19', configHash: 'h' };
    const once = markChordDraft(song, info);
    const twice = markChordDraft(once, info);
    expect(serializeSong(twice)).toBe(serializeSong(once));
    expect(serializeSong(once).split('\n').slice(0, 5)).toEqual([
      '{title: g（下書き）}',
      '{key: Gm}',
      expect.stringMatching(/^\{tempo: \d+\}$/),
      '{time: 4/4}',
      '',
    ]);
    expect(serializeSong(once)).toContain(
      '\n\n{comment: 自動解析の下書き 2026-10-19 コード h}\n\n{start_of_verse: A}',
    );
  });
});

/** `made` with `bpb` beats per bar (downbeat flags and time signature). */
function madeMeter(
  bpb: number,
  nBeats: number,
  chords: [number, number, string][],
): TsAnalysisResult {
  const r = made(nBeats, chords);
  r.beats = r.beats.map((b, i) => ({ ...b, downbeat: i % bpb === 0 }));
  r.timeSignature = { num: bpb, den: 4, confidence: 0.8 };
  return r;
}

describe('meter from the analyzer', () => {
  it('3/4: bars of 3 beats, 6 dashes, valid dash lines, round trip', () => {
    const r = madeMeter(3, 12, [
      [0, 3, 'C'],
      [3, 4.5, 'F'],
      [4.5, 6, 'G'],
      [6, 12, 'Am'],
    ]);
    const bars = barChords(r, 0);
    expect(bars).toHaveLength(4);
    expect(bars[1].chords.map((c) => [c.chord, c.start, c.length])).toEqual([
      ['F', 0, 6],
      ['G', 6, 6],
    ]);
    const { song } = chordDraftSong(r, { title: 't', downbeatShift: 0 });
    expect(song.meta.time).toBe('3/4');
    const meter = meterOf('3/4');
    let total = 0;
    for (const sec of song.chart)
      for (const l of sec.lines) {
        expect(isRawLine(l)).toBe(false);
        if (isRawLine(l)) continue;
        expect(isDashLine(l)).toBe(true);
        expect(validateDashLine(l, meter)).toEqual([]);
        total += lineBarCount(l);
      }
    expect(total).toBe(bars.length);
    expect(lines(song)[0]).toMatch(/^\|\[C\]-{6}\|/);
    expect(parseSong(serializeSong(song))).toEqual(song);
  });

  it('falls back to 4/4 for an unusable time signature', () => {
    for (const ts of [
      { num: 0, den: 4, confidence: 0 },
      { num: 3.5, den: 4, confidence: 0 },
      { num: 6, den: 8, confidence: 0 },
      { num: 13, den: 4, confidence: 0 },
      undefined,
    ]) {
      const r = made(8, [[0, 8, 'C']]);
      (r as { timeSignature: unknown }).timeSignature = ts;
      expect(draftMeter(r)).toEqual({ num: 4, den: 4 });
      const { song, bars } = chordDraftSong(r, {
        title: 't',
        downbeatShift: 0,
      });
      expect(song.meta.time).toBe('4/4');
      expect(bars).toHaveLength(2);
    }
  });
});

describe('tempoFactor (half / double tempo rebuilt from the beats)', () => {
  const r = made(
    33,
    [
      [0, 6, 'C'],
      [6, 8, 'G', 0.6],
      [8, 16, 'Am'],
      [16, 24, 'F'],
      [24, 32, 'C'],
    ],
    {
      sections: [
        [0, 'A'],
        [16, 'B'],
      ],
    },
  );
  const meter = { num: 4, den: 4 };

  it('halves / doubles the bar count', () => {
    expect(barChords(r, 0)).toHaveLength(8);
    expect(barChords(r, 0, undefined, 0.5)).toHaveLength(4);
    expect(barChords(r, 0, undefined, 2)).toHaveLength(16);
    expect(barChords(r, 0, undefined, 1)).toEqual(barChords(r, 0));
  });

  it('half tempo: a bar holds twice the music, every other beat is used', () => {
    const bars = barChords(r, 0, undefined, 0.5);
    expect(bars[0].endSec).toBe(4); // 8 original beats at 0.5 s
    expect(bars[0].chords.map((c) => [c.chord, c.start, c.length])).toEqual([
      ['C', 0, 12],
      ['G?', 12, 4],
    ]);
  });

  it('half tempo keeps the downbeat beat (parity of the downbeat)', () => {
    const odd = made(20, [[0, 20, 'C']], { phase: 1 });
    expect(barChords(odd, 0, undefined, 0.5)[0].startSec).toBe(0.5);
    const even = made(20, [[0, 20, 'C']], { phase: 2 });
    expect(barChords(even, 0, undefined, 0.5)[0].startSec).toBe(1);
  });

  it('double tempo inserts midpoints (first bar covers 2 original beats)', () => {
    const bars = barChords(r, 0, undefined, 2);
    expect(bars[0].endSec).toBe(1);
    expect(bars[1].startSec).toBe(1);
    const odd = made(20, [[0, 20, 'C']], { phase: 1 });
    expect(barChords(odd, 0, undefined, 2)[0].startSec).toBe(0.5);
  });

  it('chosen candidates survive every factor', () => {
    for (const f of [0.5, 1, 2] as const) {
      const bars = barChords(r, 0, { 1: 'Am' }, f);
      const g = bars.flatMap((b) => b.chords).filter((c) => c.id === 1);
      expect(g.length).toBeGreaterThan(0);
      for (const c of g) {
        expect(c.chord).toBe('Am');
        expect(c.lowConfidence).toBe(false);
      }
    }
  });

  it('tempo follows the factor', () => {
    expect(draftTempo(r, 0.5)).toBe(60);
    expect(draftTempo(r, 2)).toBe(240);
    expect(
      chordDraftSong(r, { title: 't', downbeatShift: 0, tempoFactor: 0.5 })
        .tempo,
    ).toBe(60);
    expect(
      chordDraftSong(r, {
        title: 't',
        downbeatShift: 0,
        tempo: 90,
        tempoFactor: 2,
      }).tempo,
    ).toBe(90);
  });

  it.each([0.5, 1, 2] as const)(
    'factor %s: valid dash lines, bar counts match, round trip',
    (f) => {
      const { song, bars } = chordDraftSong(r, {
        title: 't',
        downbeatShift: 0,
        tempoFactor: f,
        chosen: { 1: 'Am' },
      });
      expect(bars).toHaveLength(8 * f);
      let total = 0;
      for (const s of song.chart)
        for (const l of s.lines) {
          expect(isRawLine(l)).toBe(false);
          if (isRawLine(l)) continue;
          expect(isDashLine(l)).toBe(true);
          expect(validateDashLine(l, meter)).toEqual([]);
          total += lineBarCount(l);
        }
      expect(total).toBe(bars.length);
      const text = serializeSong(song);
      expect(serializeSong(parseSong(text))).toBe(text);
    },
  );
});

describe('key option (respelling)', () => {
  const r = made(9, [
    [0, 4, 'G#'],
    [4, 8, 'C#m', 0.5],
  ]);

  it('sets {key:} and respells the chords (and the returned bars)', () => {
    const { song, bars } = chordDraftSong(r, {
      title: 't',
      downbeatShift: 0,
      key: 'Ab',
    });
    expect(song.meta.key).toBe('Ab');
    expect(lines(song)).toEqual(['|[Ab]--------|[Dbm?]--------|']);
    expect(bars.flatMap((b) => b.chords.map((c) => c.chord))).toEqual([
      'Ab',
      'Dbm?',
    ]);
  });

  it('leaves everything as is without the option', () => {
    const { song } = chordDraftSong(r, { title: 't', downbeatShift: 0 });
    expect(lines(song)).toEqual(['|[G#]--------|[C#m?]--------|']);
  });

  it('respells chosen candidates too', () => {
    const { song } = chordDraftSong(r, {
      title: 't',
      downbeatShift: 0,
      key: 'Ab',
      chosen: { 1: 'C#m7/G#' },
    });
    expect(lines(song)[0]).toContain('[Dbm7/Ab]');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_STAGES } from '../../analysis/types';
import type { TsAnalysisResult } from '../analysis/chords/result';
import { CHORDS_CONFIG_HASH } from '../analysis/origin';
import { meterOf } from '../dashChart';
import { parseSong } from '../parseSong';
import { serializeLine } from '../serializeSong';
import { isRawLine } from '../song';
import { draftMeter, draftTempo } from './chordDraft';
import {
  barAtTime,
  dashText,
  draftSongText,
  formatClock,
  formatDurationJa,
  formatFileSize,
  IMPORT_STEPS,
  importProgressView,
  initialReviewState,
  keyCandidates,
  lowConfidenceCount,
  reviewChanged,
  reviewDraft,
  reviewLineText,
  reviewSections,
  shiftLimit,
  tempoCandidates,
  type ReviewState,
} from './chordReview';
import { madeResult, reviewSampleResult } from './fixtures/chordResults';

const golden = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../analysis/fixtures/chords.expected.json'),
    'utf8',
  ),
) as TsAnalysisResult;

const sample = reviewSampleResult();

function sectionsOf(result: TsAnalysisResult, s: ReviewState) {
  return reviewSections(reviewDraft(result, s), draftMeter(result));
}

describe('importProgressView', () => {
  it('covers exactly the chords stages, in order', () => {
    expect(IMPORT_STEPS.flatMap((s) => s.stages)).toEqual([
      ...ANALYSIS_STAGES.chords,
    ]);
  });

  it('starts with the first step running', () => {
    const v = importProgressView(null);
    expect(v.current).toBe(1);
    expect(v.fraction).toBe(0);
    expect(v.steps.map((s) => s.state)).toEqual([
      'now',
      'wait',
      'wait',
      'wait',
      'wait',
      'wait',
    ]);
  });

  it('marks finished steps and the running one', () => {
    // decode, resample, load, beats, chroma done -> step 4 (chords) running
    const v = importProgressView({ done: 5, total: 13 });
    expect(v.steps.map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'now',
      'wait',
      'wait',
    ]);
    expect(v.current).toBe(4);
    expect(v.fraction).toBeCloseTo(5 / 13);
  });

  it('is all done at the end', () => {
    const v = importProgressView({ done: 13, total: 13 });
    expect(v.steps.every((s) => s.state === 'done')).toBe(true);
    expect(v.current).toBe(6);
    expect(v.fraction).toBe(1);
  });
});

describe('formatting', () => {
  it('formats clock times', () => {
    expect(formatClock(222.4)).toBe('3:42');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(-3)).toBe('0:00');
  });
  it('formats durations in Japanese', () => {
    expect(formatDurationJa(222.4)).toBe('3 分 42 秒');
    expect(formatDurationJa(42)).toBe('42 秒');
    expect(formatDurationJa(750)).toBe('12 分 30 秒');
  });
  it('formats file sizes', () => {
    expect(formatFileSize(38_200_000)).toBe('38.2 MB');
    expect(formatFileSize(512_000)).toBe('512 KB');
    expect(formatFileSize(10)).toBe('1 KB');
  });
  it('writes dashes like the dash writer', () => {
    expect(dashText(16)).toBe('--------');
    expect(dashText(8)).toBe('----');
    expect(dashText(3)).toBe('-=');
    expect(dashText(0)).toBe('');
  });
});

describe('tempoCandidates', () => {
  it('offers half, as analysed and double tempo', () => {
    expect(tempoCandidates(sample)).toEqual([
      { factor: 0.5, tempo: 48 },
      { factor: 1, tempo: 96 },
      { factor: 2, tempo: 192 },
    ]);
  });
});

describe('keyCandidates', () => {
  it('global key first, then its relative key, then other bar keys', () => {
    expect(keyCandidates(sample)).toEqual([
      { key: 'G', note: 'best' },
      { key: 'Em', note: 'relative' },
      { key: 'D', note: 'section' },
    ]);
  });

  it('relative major of a minor key, spelled with fewest accidentals', () => {
    const r = madeResult(8, [], {
      key: { tonic: 'A#', mode: 'minor', confidence: 0.5 },
    });
    expect(keyCandidates(r)).toEqual([
      { key: 'Bbm', note: 'best' },
      { key: 'Db', note: 'relative' },
    ]);
  });

  it('is empty without a key', () => {
    expect(keyCandidates(madeResult(8, []))).toEqual([]);
  });
});

describe('initialReviewState / reviewChanged', () => {
  it('starts from the analyzer', () => {
    const s = initialReviewState(sample, 'my-demo-take3');
    expect(s).toEqual({
      title: 'my-demo-take3',
      tempoFactor: 1,
      tempo: 96,
      key: 'G',
      downbeatShift: 0,
      sectionNames: {},
      chosen: {},
    });
    expect(reviewChanged(s, { ...s })).toBe(false);
  });

  it('notices every kind of change', () => {
    const s = initialReviewState(sample, 't');
    const changes: Partial<ReviewState>[] = [
      { title: 'u' },
      { tempoFactor: 2 },
      { tempo: 97 },
      { key: 'Em' },
      { downbeatShift: 1 },
      { sectionNames: { 0: 'イントロ' } },
      { chosen: { 5: 'Am7' } },
    ];
    for (const c of changes)
      expect(reviewChanged(s, { ...s, ...c })).toBe(true);
  });

  it('shift limit is one beat less than a bar', () => {
    expect(shiftLimit(sample)).toBe(3);
  });
});

describe('reviewSections', () => {
  const s0 = initialReviewState(sample, 'demo');

  it('lists sections with bar counts and start times', () => {
    const secs = sectionsOf(sample, s0);
    expect(secs.map((s) => [s.label, s.startBar, s.barCount])).toEqual([
      ['A', 0, 8],
      ['B', 8, 8],
      ['A', 16, 4],
    ]);
    expect(secs[1].startSec).toBeCloseTo(0.05 + 33 * (60 / 96));
    expect(secs.map((s) => s.lines.map((l) => l.length))).toEqual([
      [4, 4],
      [4, 4],
      [4],
    ]);
  });

  it('shows exactly the lines the song text will hold', () => {
    const draft = reviewDraft(sample, s0);
    const secs = reviewSections(draft, draftMeter(sample));
    const written = draft.song.chart.flatMap((c) =>
      c.lines.filter((l) => !isRawLine(l)).map(serializeLine),
    );
    expect(secs.flatMap((s) => s.lines.map(reviewLineText))).toEqual(written);
    expect(written[1]).toBe(
      '|[Em]--------|[Am?]--------|[D]--------|[G]--------|',
    );
  });

  it('links every written chord to its analyzer chord, low confidence marked', () => {
    const secs = sectionsOf(sample, s0);
    const bar5 = secs[0].lines[1][1];
    expect(bar5.index).toBe(5);
    expect(bar5.tokens).toEqual([
      {
        chord: 'Am?',
        start: 0,
        length: 16,
        dashes: '--------',
        id: 5,
        lowConfidence: true,
      },
    ]);
    expect(sample.chords[5].text).toBe('Am?');
    expect(lowConfidenceCount(secs)).toBe(4);
  });

  it('a bar without a chord is N.C. and has no analyzer chord', () => {
    const secs = sectionsOf(sample, s0);
    const nc = secs[1].lines[1][1];
    expect(nc.tokens.map((t) => [t.chord, t.id])).toEqual([['N.C.', null]]);
  });

  it('a chosen candidate drops the ? and keeps its link', () => {
    const secs = sectionsOf(sample, { ...s0, chosen: { 5: 'Am7' } });
    const t = secs[0].lines[1][1].tokens[0];
    expect(t).toMatchObject({ chord: 'Am7', id: 5, lowConfidence: false });
    expect(lowConfidenceCount(secs)).toBe(3);
  });

  it('N.C. can be chosen for a chord and stays linked to it', () => {
    const secs = sectionsOf(sample, { ...s0, chosen: { 5: 'N.C.' } });
    expect(secs[0].lines[1][1].tokens[0]).toMatchObject({
      chord: 'N.C.',
      id: 5,
    });
  });

  it('a chord carried over into the next bar links to the chord before', () => {
    // G for 6 beats: bar 2 starts inside it
    const r = madeResult(9, [
      { from: 0, to: 6, name: 'G' },
      { from: 6, to: 8, name: 'C' },
    ]);
    const secs = sectionsOf(r, initialReviewState(r, 't'));
    const [b0, b1] = secs[0].lines[0];
    expect(b0.tokens.map((t) => [t.chord, t.id])).toEqual([['G', 0]]);
    expect(b1.tokens.map((t) => [t.chord, t.id])).toEqual([
      ['G', 0],
      ['C', 1],
    ]);
  });

  it('an empty bar stays unlinked even when an earlier chord was set to N.C.', () => {
    // C 0-4 beats, G 8-16 beats: bar 1 (beats 4-8) has no chord at all
    const r = madeResult(17, [
      { from: 0, to: 4, name: 'C' },
      { from: 8, to: 16, name: 'G' },
    ]);
    const secs = sectionsOf(r, {
      ...initialReviewState(r, 't'),
      chosen: { 0: 'N.C.' },
    });
    const bars = secs[0].lines[0];
    expect(bars[0].tokens.map((t) => [t.chord, t.id])).toEqual([['N.C.', 0]]);
    expect(bars[1].tokens.map((t) => [t.chord, t.id])).toEqual([
      ['N.C.', null],
    ]);
    expect(bars[2].tokens[0]).toMatchObject({ chord: 'G', id: 1 });
  });

  it('×2 tempo rebuilds the bars (twice as many), chosen chords survive', () => {
    const chosen = { 5: 'Am7' };
    const one = sectionsOf(sample, { ...s0, chosen });
    const two = sectionsOf(sample, {
      ...s0,
      chosen,
      tempoFactor: 2,
      tempo: draftTempo(sample, 2),
    });
    const bars = (x: typeof one) => x.reduce((n, s) => n + s.barCount, 0);
    expect(bars(one)).toBe(20);
    expect(bars(two)).toBe(40);
    const tokens = two.flatMap((s) =>
      s.lines.flatMap((l) => l.flatMap((b) => b.tokens)),
    );
    expect(tokens.filter((t) => t.id === 5).map((t) => t.chord)).toEqual([
      'Am7',
      'Am7',
    ]);
  });

  it('÷2 tempo halves the bars', () => {
    const half = sectionsOf(sample, { ...s0, tempoFactor: 0.5, tempo: 48 });
    expect(half.reduce((n, s) => n + s.barCount, 0)).toBe(10);
  });

  it('a key respells the chord names', () => {
    const r = madeResult(9, [{ from: 0, to: 8, name: 'A#' }], {
      key: { tonic: 'F', mode: 'major', confidence: 1 },
    });
    const s = initialReviewState(r, 't');
    expect(s.key).toBe('F');
    expect(sectionsOf(r, s)[0].lines[0][0].tokens[0].chord).toBe('Bb');
    expect(
      sectionsOf(r, { ...s, key: 'E' })[0].lines[0][0].tokens[0].chord,
    ).toBe('A#');
  });

  it('a downbeat shift moves the bars', () => {
    const a = sectionsOf(sample, s0);
    const b = sectionsOf(sample, { ...s0, downbeatShift: 1 });
    expect(b[0].lines[0][0].startSec).toBeGreaterThan(
      a[0].lines[0][0].startSec,
    );
  });

  it('works on the golden analyzer result', () => {
    const secs = sectionsOf(golden, initialReviewState(golden, 'g'));
    expect(secs.length).toBeGreaterThan(0);
    expect(secs[0].lines[0][0].tokens.length).toBeGreaterThan(0);
  });
});

describe('draftSongText', () => {
  it('writes the reviewed song with the draft marks, readable again', () => {
    const s: ReviewState = {
      ...initialReviewState(sample, 'my-demo-take3'),
      sectionNames: { 1: 'サビ', 2: '  ' },
      chosen: { 5: 'Am7' },
      key: 'Em',
    };
    const text = draftSongText(sample, s, {
      date: '2026-10-24',
      configHash: CHORDS_CONFIG_HASH,
    });
    const lines = text.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      '{title: my-demo-take3（下書き）}',
      '{key: Em}',
      '{tempo: 96}',
      '{time: 4/4}',
    ]);
    expect(text).toContain(
      '{comment: 自動解析の下書き 2026-10-24 コード adec583eb3c6}',
    );
    expect(text).toContain('{start_of_verse: サビ}');
    expect(text).toContain(
      '|[Em]--------|[Am7]--------|[D]--------|[G]--------|',
    );
    const song = parseSong(text);
    expect(
      song.chart.filter((c) => c.kind === 'verse').map((c) => c.label),
    ).toEqual(['A', 'サビ', 'A']);
    expect(meterOf(song.meta.time)).toEqual({ num: 4, den: 4 });
  });

  it('keeps directives intact and falls back to 無題の曲', () => {
    const s: ReviewState = {
      ...initialReviewState(sample, ' {x} '),
      sectionNames: { 0: 'A}{' },
    };
    const text = draftSongText(sample, s, { date: 'd', configHash: 'h' });
    expect(text.split('\n')[0]).toBe('{title: x（下書き）}');
    expect(text).toContain('{start_of_verse: A}');
    const empty = draftSongText(
      sample,
      { ...s, title: '  ' },
      { date: 'd', configHash: 'h' },
    );
    expect(empty.split('\n')[0]).toBe('{title: 無題の曲（下書き）}');
  });
});

describe('barAtTime', () => {
  const bars = reviewDraft(sample, initialReviewState(sample, 't')).bars;
  it('finds the bar playing at a time', () => {
    expect(barAtTime(bars, 0)).toBeNull(); // before the first downbeat
    expect(barAtTime(bars, bars[0].startSec)).toBe(0);
    expect(barAtTime(bars, (bars[5].startSec + bars[5].endSec) / 2)).toBe(5);
    expect(barAtTime(bars, bars[19].endSec + 1)).toBeNull();
  });
});

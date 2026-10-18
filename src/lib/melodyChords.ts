import { graphemes, lineLyrics } from './chartEdit';
import { isDashLine } from './dashChart';
import { isValidChordText } from './chordText';
import { cleanTexText, type MelodyEvent } from './melody';
import { isRawLine, type Song } from './song';
import { splitSyllables, syllableSpans } from './syllables';

/**
 * Chords on melody notes (issue #6): copying the chord chart's chords onto
 * a melody section, and per-note chord edits.
 *
 * ## Copy rule
 *
 * A chart chord sits before one character of a lyric line. It belongs to
 * the syllable (`splitSyllables`) that contains that character, or — on
 * whitespace — to the next syllable of the same line. A chord at the end of
 * a line, or on a line with no lyrics (chord-only lines), belongs to no
 * syllable. The syllable stream is exactly `chartSyllables(song, label)`.
 *
 * The chart syllables are then aligned with the melody's syllable stream
 * (every note's lyric split the same way, rests and lyric-less notes
 * contributing nothing) by a longest common subsequence, so a few edited
 * syllables don't shift every later chord. A chord whose syllable is
 * matched goes onto the note carrying that syllable — the FIRST note of a
 * melisma, since the continuation notes carry no lyric. A note holds one
 * chord: when several chart chords land on the same note (two chords on
 * one syllable, or two syllables merged onto one note) the first wins.
 * Everything that finds no note is counted as `skipped` (「写せなかった」).
 *
 * Chords are copied as written (no simplification); only the characters
 * alphaTex cannot hold are dropped (`cleanTexText`). The chart itself is
 * never changed: chart and parts stay independent (M1).
 */

export interface ChartChord {
  chord: string;
  /** Index into `ChartChords.syllables`, or null when on no syllable. */
  syllable: number | null;
}

export interface ChartChords {
  /** Same as `chartSyllables(song, label)`. */
  syllables: string[];
  /** Every chord of the section's lyric lines, in text order. */
  chords: ChartChord[];
}

interface Mark {
  chord: string;
  /** Grapheme index (in the joined section text) the chord sits before. */
  at: number;
  /** First grapheme of its line, and one past its last. */
  lineStart: number;
  lineEnd: number;
  /** On a line that contributes no syllables at all. */
  orphan: boolean;
}

/** Chords of the first chart section labelled `label`, mapped to syllables. */
export function chartChords(song: Song, label: string): ChartChords {
  const section = song.chart.find((s) => s.label === label);
  if (!section) return { syllables: [], chords: [] };
  const chars: string[] = [];
  const marks: Mark[] = [];
  for (const line of section.lines) {
    if (isRawLine(line)) continue;
    // Same lines as chartSyllables: blank / chord-only / dash lines carry no
    // lyrics (their chords are not copied in v1).
    const orphan = lineLyrics(line).trim() === '' || isDashLine(line);
    const start = chars.length;
    let pos = start;
    const own: Mark[] = [];
    for (const seg of line.segments) {
      if (seg.chord !== undefined) {
        own.push({
          chord: seg.chord,
          at: pos,
          lineStart: start,
          lineEnd: 0,
          orphan,
        });
      }
      const g = orphan ? [] : graphemes(seg.lyrics);
      if (!orphan) chars.push(...g);
      pos += g.length;
    }
    for (const m of own) marks.push({ ...m, lineEnd: chars.length });
    if (!orphan) chars.push('\n');
  }
  const spans = syllableSpans(chars);
  const chords = marks.map(({ chord, at, lineStart, lineEnd, orphan }) => {
    if (orphan) return { chord, syllable: null };
    let i = spans.findIndex((s) => s.end > at);
    // A line-leading symbol attaches to the previous line's last syllable
    // (splitSyllables runs over the joined text); a chord there means this
    // line's first syllable.
    if (i >= 0 && spans[i].start < lineStart) i++;
    const ok =
      i >= 0 &&
      i < spans.length &&
      (spans[i].start <= at || spans[i].start < lineEnd);
    return { chord, syllable: ok ? i : null };
  });
  return { syllables: spans.map((s) => s.text), chords };
}

export type CopyMode = 'overwrite' | 'fillEmpty';

export interface CopyResult {
  /** `events` itself when no chord changed. */
  events: MelodyEvent[];
  /** Chart chords now on a note (incl. ones that were already the same). */
  copied: number;
  /** Chart chords that found no note (「写せなかった」). */
  skipped: number;
  /** `fillEmpty`: chart chords not copied because the note had a chord. */
  kept: number;
}

/** Pairs (a index, b index) of a longest common subsequence of a and b. */
function lcsPairs(
  a: readonly string[],
  b: readonly string[],
): Map<number, number> {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[i..], b[j..]
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.set(j, i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

function withChord(e: MelodyEvent, chord: string | undefined): MelodyEvent {
  const { chord: _drop, ...rest } = e;
  return chord === undefined ? rest : { ...rest, chord };
}

function sameChords(a: readonly MelodyEvent[], b: readonly MelodyEvent[]) {
  return a.every((e, i) => e.chord === b[i].chord);
}

/**
 * Copies the chart chords onto the melody notes (see the module comment).
 * `overwrite` first removes every chord of the section (rests included);
 * `fillEmpty` keeps existing chords and only fills chordless notes.
 */
export function copyChordsFromChart(
  events: MelodyEvent[],
  chart: ChartChords,
  mode: CopyMode,
): CopyResult {
  // Melody syllable stream and the note owning each stream position.
  const stream: string[] = [];
  const owner: number[] = [];
  events.forEach((e, i) => {
    if (e.kind !== 'note' || !e.lyric) return;
    for (const s of splitSyllables(e.lyric)) {
      stream.push(s);
      owner.push(i);
    }
  });
  const align = lcsPairs(stream, chart.syllables);

  const next = new Map<number, string>();
  let copied = 0;
  let skipped = 0;
  let kept = 0;
  for (const { chord, syllable } of chart.chords) {
    const clean = cleanTexText(chord)?.trim();
    const at = syllable === null ? undefined : align.get(syllable);
    const target = at === undefined ? undefined : owner[at];
    if (target === undefined || clean === undefined || next.has(target)) {
      skipped++;
      continue;
    }
    if (mode === 'fillEmpty' && events[target].chord !== undefined) {
      kept++;
      // Taken: a later chord on the same note must not count as copied.
      next.set(target, events[target].chord!);
      continue;
    }
    next.set(target, clean);
    copied++;
  }

  const out = events.map((e, i) => {
    if (next.has(i)) return withChord(e, next.get(i));
    return mode === 'overwrite' ? withChord(e, undefined) : e;
  });
  return {
    events: sameChords(out, events) ? events : out,
    copied,
    skipped,
    kept,
  };
}

/**
 * Sets the chord of event `index` (note or rest) to `chord` (trimmed).
 * Invalid chord text (`isValidChordText`, or nothing left for alphaTex), a
 * bad index or the same chord → `events` itself.
 */
export function setChord(
  events: MelodyEvent[],
  index: number,
  chord: string,
): MelodyEvent[] {
  if (!Number.isInteger(index) || index < 0 || index >= events.length) {
    return events;
  }
  if (!isValidChordText(chord)) return events;
  const clean = cleanTexText(chord.trim())?.trim();
  if (clean === undefined || clean === events[index].chord) return events;
  return events.map((e, i) => (i === index ? withChord(e, clean) : e));
}

/** Removes the chord of event `index`; none there → `events` itself. */
export function removeChord(
  events: MelodyEvent[],
  index: number,
): MelodyEvent[] {
  if (events[index]?.chord === undefined) return events;
  return events.map((e, i) => (i === index ? withChord(e, undefined) : e));
}

/** Removes every chord; none → `events` itself. */
export function clearChords(events: MelodyEvent[]): MelodyEvent[] {
  if (events.every((e) => e.chord === undefined)) return events;
  return events.map((e) => withChord(e, undefined));
}

export interface ChordSummary {
  /** Distinct chords in order of first appearance, with how many events carry each. */
  chords: { chord: string; count: number }[];
  /** Notes (not rests) with a chord. */
  notesWithChord: number;
  noteCount: number;
  /** Events (notes and rests) with a chord. */
  total: number;
}

export function chordSummary(events: readonly MelodyEvent[]): ChordSummary {
  const counts = new Map<string, number>();
  let notesWithChord = 0;
  let noteCount = 0;
  let total = 0;
  for (const e of events) {
    if (e.kind === 'note') noteCount++;
    if (e.chord === undefined) continue;
    total++;
    if (e.kind === 'note') notesWithChord++;
    counts.set(e.chord, (counts.get(e.chord) ?? 0) + 1);
  }
  return {
    chords: [...counts].map(([chord, count]) => ({ chord, count })),
    notesWithChord,
    noteCount,
    total,
  };
}

/** What one 「コード譜からコードを写す」 did (`CopyResult` without the events). */
export type CopySummary = Omit<CopyResult, 'events'>;

/**
 * The result as Japanese lines: what was copied, then what was left alone
 * or could not be placed. Shown in the chord panel; joined with 「。」 for
 * the editor's live region.
 */
export function copyResultLines(r: CopySummary): string[] {
  const lines = [
    r.copied > 0
      ? `コードを ${r.copied} 個、音符に写しました`
      : '写せるコードがありませんでした',
  ];
  if (r.kept > 0) {
    lines.push(`コードが付いていた音符 ${r.kept} 個はそのままにしました`);
  }
  if (r.skipped > 0) {
    lines.push(`コード譜の ${r.skipped} 個は、合う音符が無く写せませんでした`);
  }
  return lines;
}

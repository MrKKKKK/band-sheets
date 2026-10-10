import { isRawLine } from './song';
import type { LyricLine, Segment, Song } from './song';

/** The lyrics of a line without its chords. */
export function lineLyrics(line: LyricLine): string {
  return line.segments.map((s) => s.lyrics).join('');
}

/**
 * Shared grapheme segmenter: Japanese locale, extended grapheme clusters.
 * This groups a base character with trailing combining marks (NFD dakuten:
 * 'か' + U+3099 → one cluster, same as precomposed 'が') and emoji sequences
 * (skin-tone modifiers, ZWJ sequences like family emoji) into one
 * user-perceived character, unlike `Array.from` which only splits on code
 * points (surrogate pairs become one unit, but combining marks and ZWJ
 * sequences do not).
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter('ja', {
  granularity: 'grapheme',
});

/** Splits `s` into grapheme clusters (user-perceived characters). */
export function graphemes(s: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(s), (seg) => seg.segment);
}

function seg(chord: string | undefined, lyrics: string): Segment {
  return chord === undefined ? { lyrics } : { chord, lyrics };
}

/**
 * Places `chord` before the character at `charIndex` (grapheme clusters, see
 * `graphemes`; `charIndex === length` = end of line, giving a segment with
 * empty lyrics). A chord already starting at that position is overwritten
 * (with several chord-only segments at the same position, the last one).
 * Out-of-range indexes are clamped.
 */
export function setChordAt(
  line: LyricLine,
  charIndex: number,
  chord: string,
): LyricLine {
  const segments = line.segments;
  const total = segments.reduce((n, s) => n + graphemes(s.lyrics).length, 0);
  const index = Math.max(0, Math.min(charIndex, total));

  // Overwrite: the last chorded segment starting exactly at `index`.
  let start = 0;
  let overwrite = -1;
  for (let i = 0; i < segments.length; i++) {
    if (start === index && segments[i].chord !== undefined) overwrite = i;
    start += graphemes(segments[i].lyrics).length;
  }
  if (overwrite >= 0) {
    return {
      segments: segments.map((s, i) =>
        i === overwrite ? { chord, lyrics: s.lyrics } : s,
      ),
    };
  }

  if (index === total) {
    return { segments: [...segments, { chord, lyrics: '' }] };
  }

  // Split the segment containing `index`.
  const out: Segment[] = [];
  start = 0;
  for (const s of segments) {
    const chars = graphemes(s.lyrics);
    const end = start + chars.length;
    if (index >= start && index < end) {
      const before = chars.slice(0, index - start).join('');
      const after = chars.slice(index - start).join('');
      if (before !== '' || s.chord !== undefined)
        out.push(seg(s.chord, before));
      out.push({ chord, lyrics: after });
    } else {
      out.push(s);
    }
    start = end;
  }
  return { segments: out };
}

/**
 * Edits (string) or deletes (null) the chord of segment `segIndex`. On
 * delete the segment's lyrics are merged into the previous segment; the
 * first segment instead becomes a chordless leading segment (dropped when
 * its lyrics are empty). Invalid targets return the line unchanged.
 */
export function updateChord(
  line: LyricLine,
  segIndex: number,
  chord: string | null,
): LyricLine {
  const target = line.segments[segIndex];
  if (!target) return line;
  if (chord !== null) {
    return {
      segments: line.segments.map((s, i) =>
        i === segIndex ? { chord, lyrics: s.lyrics } : s,
      ),
    };
  }
  if (target.chord === undefined) return line;

  const out = line.segments.slice();
  if (segIndex === 0) {
    if (target.lyrics === '') out.splice(0, 1);
    else out[0] = { lyrics: target.lyrics };
  } else {
    const prev = out[segIndex - 1];
    out[segIndex - 1] = seg(prev.chord, prev.lyrics + target.lyrics);
    out.splice(segIndex, 1);
  }
  return { segments: out };
}

/**
 * Returns a new Song with chart line [sectionIdx][lineIdx] replaced by
 * `fn(line)`. Raw lines and out-of-range targets leave the song unchanged.
 */
export function updateLyricLine(
  song: Song,
  sectionIdx: number,
  lineIdx: number,
  fn: (line: LyricLine) => LyricLine,
): Song {
  const section = song.chart[sectionIdx];
  const target = section?.lines[lineIdx];
  if (!target || isRawLine(target)) return song;
  const lines = section.lines.slice();
  lines[lineIdx] = fn(target);
  const chart = song.chart.slice();
  chart[sectionIdx] = { ...section, lines };
  return { ...song, chart };
}

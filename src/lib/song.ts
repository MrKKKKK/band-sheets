/**
 * In-memory model of one song file (ChordPro container + alphaTex part blocks).
 * See docs/format-decision.md and docs/m2-plan.md.
 */
export interface Song {
  meta: SongMeta;
  /** Chord chart, in file order. */
  chart: ChartSection[];
  /** Instrument parts, in file order. */
  parts: Part[];
}

export interface SongMeta {
  /** '' when the file has no {title:}. */
  title: string;
  key?: string;
  tempo?: number;
  /** Raw text such as "4/4"; validated by consumers before rendering. */
  time?: string;
  /**
   * User-added palette chords from the first top-level {x_palette: …}
   * (whitespace-separated, kept as written).
   */
  palette?: string[];
}

/**
 * One {start_of_<kind>: <label>} … {end_of_<kind>} block.
 *
 * Implicit section: chart lines written outside any block (and top-level
 * unknown directives / comments) are collected into sections with
 * `kind: ''` and `label: ''`. One implicit section = one run of
 * consecutive non-blank top-level lines; it is written back without a
 * wrapper.
 */
export interface ChartSection {
  /** verse / chorus / bridge / … ('' = implicit section). */
  kind: string;
  /** "A", "サビ", … Used to match parts' \section markers. May be ''. */
  label: string;
  lines: ChartLine[];
}

export type ChartLine = LyricLine | RawLine;

/** A chart line with inline [Chord] markers. Blank line = `segments: []`. */
export interface LyricLine {
  segments: Segment[];
}

/**
 * A line kept verbatim for lossless round-trip: `# comments` and directives
 * the app does not understand (e.g. {comment: …}, {artist: …}).
 */
export interface RawLine {
  raw: string;
}

export interface Segment {
  /** Opaque chord text, e.g. "C7(9,13)", "(C)", "N.C.". Absent = no chord. */
  chord?: string;
  lyrics: string;
}

/** {start_of_part: <name>} … {end_of_part}. */
export interface Part {
  name: string;
  /** alphaTex body, verbatim, lines joined with '\n' (no trailing newline). */
  body: string;
}

export function isRawLine(line: ChartLine): line is RawLine {
  return 'raw' in line;
}

/** Part kind is not stored: a part is a drum part iff its body says so. */
export function isDrumPart(part: Part): boolean {
  return /\\instrument\s+percussion\b/i.test(part.body);
}

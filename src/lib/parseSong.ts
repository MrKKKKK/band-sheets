import type {
  ChartLine,
  ChartSection,
  Part,
  Segment,
  Song,
  SongMeta,
} from './song';

interface Directive {
  name: string;
  /** undefined when the directive has no ':' part. */
  value?: string;
}

const DIRECTIVE = /^\s*\{\s*([A-Za-z][\w-]*)\s*(?::(.*?))?\s*\}\s*$/;

/** Directive name (lowercased) → the SongMeta field it sets. Exported so
 * serializeSong can recognize a RawLine that would re-parse into a given
 * meta field (N5/N6: dropping stale duplicate meta directives). */
export const META_ALIASES: Record<string, keyof SongMeta> = {
  title: 'title',
  t: 'title',
  key: 'key',
  k: 'key',
  tempo: 'tempo',
  time: 'time',
  x_palette: 'palette',
};

const SHORT_START: Record<string, string> = {
  sov: 'verse',
  soc: 'chorus',
  sob: 'bridge',
};
const SHORT_END: Record<string, string> = {
  eov: 'verse',
  eoc: 'chorus',
  eob: 'bridge',
};

export function parseDirective(line: string): Directive | undefined {
  const m = DIRECTIVE.exec(line);
  if (!m) return undefined;
  return { name: m[1].toLowerCase(), value: m[2]?.trim() };
}

/** Kind of a section start directive ('part' for part blocks). */
function startKind(d: Directive): string | undefined {
  if (d.name.startsWith('start_of_') && d.name.length > 9) {
    return d.name.slice(9);
  }
  return SHORT_START[d.name];
}

function endKind(d: Directive): string | undefined {
  if (d.name.startsWith('end_of_') && d.name.length > 7) {
    return d.name.slice(7);
  }
  return SHORT_END[d.name];
}

/** Splits a chart line at inline [Chord] markers. */
export function parseChordLine(line: string): Segment[] {
  if (line.trim() === '') return [];
  const segments: Segment[] = [];
  let pos = 0;
  let current: Segment | undefined;
  while (pos < line.length) {
    const open = line.indexOf('[', pos);
    const close = open < 0 ? -1 : line.indexOf(']', open + 1);
    if (open < 0 || close < 0) {
      const rest = line.slice(pos);
      if (current) current.lyrics += rest;
      else segments.push((current = { lyrics: rest }));
      break;
    }
    const before = line.slice(pos, open);
    if (current) current.lyrics += before;
    else if (before !== '') segments.push({ lyrics: before });
    current = { chord: line.slice(open + 1, close), lyrics: '' };
    segments.push(current);
    pos = close + 1;
  }
  return segments;
}

/**
 * Parses a song file. Never throws: unclosed blocks are closed at EOF (or
 * at the next block start), and anything not understood is kept as a raw
 * line so that serializeSong writes it back.
 */
export function parseSong(text: string): Song {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();

  const meta: SongMeta = { title: '' };
  const seenMeta = new Set<keyof SongMeta>();
  const chart: ChartSection[] = [];
  const parts: Part[] = [];

  let section: ChartSection | undefined; // explicit section being read
  let implicit: ChartSection | undefined; // current implicit section
  let part: { name: string; lines: string[] } | undefined;

  const closePart = () => {
    if (part) parts.push({ name: part.name, body: part.lines.join('\n') });
    part = undefined;
  };
  const addTopLevel = (line: ChartLine) => {
    if (!implicit) {
      implicit = { kind: '', label: '', lines: [] };
      chart.push(implicit);
    }
    implicit.lines.push(line);
  };
  const applyMeta = (d: Directive): boolean => {
    const field = META_ALIASES[d.name];
    if (!field || d.value === undefined || seenMeta.has(field)) return false;
    // An empty value (e.g. "{title:}") is treated as "not seen": it stays a
    // RawLine so a later directive for the same field can still become the
    // meta, and serializing an emptied field twice stays stable (R13).
    // Generalizes the pre-existing {x_palette:} rule to every meta field.
    if (d.value === '') return false;
    if (field === 'tempo') {
      if (!/^\d+(\.\d+)?$/.test(d.value)) return false;
      meta.tempo = Number(d.value);
    } else if (field === 'palette') {
      meta.palette = d.value.split(/\s+/);
    } else {
      meta[field] = d.value;
    }
    seenMeta.add(field);
    return true;
  };

  for (const line of lines) {
    const d = parseDirective(line);
    const kind = d && startKind(d);

    if (part) {
      if (kind === 'part') {
        closePart();
      } else {
        if (d && endKind(d) === 'part') closePart();
        else part.lines.push(line);
        continue;
      }
    }

    if (kind === 'part') {
      section = undefined;
      implicit = undefined;
      part = { name: d?.value ?? '', lines: [] };
      continue;
    }
    if (kind) {
      section = { kind, label: d?.value ?? '', lines: [] };
      implicit = undefined;
      chart.push(section);
      continue;
    }

    if (section) {
      if (d && endKind(d)) section = undefined;
      else section.lines.push(toChartLine(line, d));
      continue;
    }

    // Top level.
    if (line.trim() === '') {
      implicit = undefined;
      continue;
    }
    if (d && applyMeta(d)) continue;
    addTopLevel(toChartLine(line, d));
  }
  closePart();

  return { meta, chart, parts };
}

function toChartLine(line: string, d: Directive | undefined): ChartLine {
  if (d || line.trimStart().startsWith('#')) return { raw: line };
  return { segments: parseChordLine(line) };
}

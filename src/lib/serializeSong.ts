import { META_ALIASES, parseDirective } from './parseSong';
import type { ChartLine, ChartSection, Part, Song } from './song';

/**
 * Writes a song in canonical form: meta, then chart sections, then parts,
 * blocks separated by one blank line, '\n' line endings, trailing newline
 * (empty string for an empty song).
 */
export function serializeSong(song: Song): string {
  const blocks: string[] = [];

  const { title, key, tempo, time, palette } = song.meta;
  const meta: string[] = [];
  if (title !== '') meta.push(`{title: ${title}}`);
  if (key !== undefined) meta.push(`{key: ${key}}`);
  if (tempo !== undefined) meta.push(`{tempo: ${tempo}}`);
  if (time !== undefined) meta.push(`{time: ${time}}`);
  if (palette !== undefined && palette.length > 0) {
    meta.push(`{x_palette: ${palette.join(' ')}}`);
  }
  if (meta.length > 0) blocks.push(meta.join('\n'));

  // N6: only an EXPLICIT palette clear (`meta.palette === []`, a state only
  // `removeFromPalette` in palette.ts produces — parseSong itself never
  // yields `[]`, only `undefined`) drops a stale top-level `{x_palette: …}`
  // RawLine that would otherwise be promoted into `meta.palette` on the next
  // parse (the second, never-consumed `x_palette` in e.g.
  // `{x_palette: C}\n{x_palette: D}`, once the first is no longer written).
  //
  // Scalar fields (title/key/tempo/time) do NOT get the equivalent
  // treatment here, on purpose (m3-review.md F1): serializeSong has no way
  // to tell "the user just cleared this field in 曲情報" from "a top-level
  // directive for this field showed up some other way while the field
  // itself happens to be undefined" — e.g. applyLyrics (lyrics.ts) can move
  // a section's mid-song `{key: D}` into the implicit section when two
  // blocks merge, with nobody having cleared anything. Dropping on that
  // ambiguous signal silently deleted real chart data. Clearing a scalar
  // field's stale duplicate is instead done explicitly, only by the UI
  // action that actually clears a field: `clearStaleMetaLines` (meta.ts),
  // called from App's song-info change handler before this function runs.
  const dropStalePalette = palette !== undefined && palette.length === 0;

  for (const section of song.chart) {
    const block = serializeSection(section, dropStalePalette);
    if (block !== '') blocks.push(block);
  }
  for (const part of song.parts) blocks.push(serializePart(part));

  return blocks.length === 0 ? '' : blocks.join('\n\n') + '\n';
}

/**
 * A RawLine that would re-parse as a (non-empty) top-level `{x_palette: …}`
 * directive, only relevant when `dropStalePalette` (an explicit palette
 * clear) is true.
 */
function isStalePaletteLine(
  line: ChartLine,
  dropStalePalette: boolean,
): boolean {
  if (!dropStalePalette || !('raw' in line)) return false;
  const d = parseDirective(line.raw);
  if (!d || !d.value) return false;
  return META_ALIASES[d.name] === 'palette';
}

function serializeSection(
  section: ChartSection,
  dropStalePalette: boolean,
): string {
  const kept =
    section.kind === '' && dropStalePalette
      ? section.lines.filter((l) => !isStalePaletteLine(l, dropStalePalette))
      : section.lines;
  const lines = kept.map(serializeLine);
  if (section.kind === '') return lines.join('\n');
  return [
    withValue(`start_of_${section.kind}`, section.label),
    ...lines,
    `{end_of_${section.kind}}`,
  ].join('\n');
}

export function serializeLine(line: ChartLine): string {
  if ('raw' in line) return line.raw;
  return line.segments
    .map((s) => (s.chord === undefined ? s.lyrics : `[${s.chord}]${s.lyrics}`))
    .join('');
}

function serializePart(part: Part): string {
  const head = withValue('start_of_part', part.name);
  return part.body === ''
    ? `${head}\n{end_of_part}`
    : `${head}\n${part.body}\n{end_of_part}`;
}

function withValue(name: string, value: string): string {
  return value === '' ? `{${name}}` : `{${name}: ${value}}`;
}

/** Display name for a song without a title. */
export const UNTITLED = '無題の曲';

/** Text of a brand-new song: only `{title: 無題の曲}` (editor A starts at step 1). */
export function newSongText(): string {
  return serializeSong({ meta: { title: UNTITLED }, chart: [], parts: [] });
}

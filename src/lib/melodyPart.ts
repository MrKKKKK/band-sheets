/**
 * Part-level helpers for the melody editor (M4, T4). See docs/m4-plan.md,
 * design decisions 1, 4 and 5. All functions are pure and never mutate their
 * arguments.
 *
 * ## Sections of a part body
 *
 * A "header line" is a line that does not start with `//` (after leading
 * whitespace) and contains a `\section` marker — the same rule as
 * `partSectionLabels` in sections.ts, so labels always agree with
 * `sectionLabels(song)`. The label is the first argument (`"A"`, `'A'` or a
 * bare word; `\section "A" "Verse"` → `A`).
 *
 * - preamble = the lines before the first header line, verbatim (`\staff`,
 *   `\clef`, `\ks`, part-level `\lyrics`, comments, …). Never rewritten.
 * - section body = the lines after a header line up to (not including) the
 *   next header line. `start`/`end` are offsets into the part body; the
 *   range excludes the newline before the next header. An empty section's
 *   range is the empty range at the end of its header line.
 *
 * ## Decisions
 *
 * - Notes before the first `\section` (`unlabeled`: preamble lines that are
 *   not blank, not `\…` metadata and not `//` comments) are ALWAYS read-only
 *   — also when the part has no `\section` at all. The editor is driven by
 *   section labels; writing a label into such a part inserts a new
 *   `\section` block after the preamble notes, which stay untouched. The UI
 *   can show `unlabeled` with 「テキスト入力で編集してください」.
 * - A section is read-only when its body fails `parseMelody` (the parser's
 *   reason is passed through), when its header line holds anything besides
 *   `\section` and at most two label strings, or when the NEXT header line
 *   has text before its `\section` (that text would belong to this section).
 * - `writeSection` THROWS on a read-only section (programming error; the UI
 *   never calls it then) instead of silently returning the body unchanged.
 * - A label that is written into a new header is double-quoted, or
 *   single-quoted if it contains `"`; a label containing both quotes, `\`
 *   or a line break cannot be written (throws an Error with a Japanese
 *   message the UI can show as is).
 * - Bar-length mismatch (M3): when a section fails `parseMelody` ONLY because
 *   of bar lengths (typically the song's time signature changed after the
 *   notes were written), `readSection` returns `barMismatch` with the events
 *   read by `parseMelodyIgnoringBars`. The section is still not writable
 *   (`writeSection` throws) until the user confirms `reflowSection`, which
 *   re-bars it with the new time signature.
 * - `preambleOverrides`: `\ts` / `\ks` in the preamble override the song's
 *   meta time / key for this part (alphaTab uses them when rendering).
 *
 * ## Generic section range handling (M5, T4)
 *
 * `readSectionWith` / `writeSectionText` / `reflowSectionWith` do the range
 * splitting, read-only checks and `chartOrder` insertion above for any event
 * type `E`, given a `SectionCodec<E>` (a strict + bar-ignoring parser pair);
 * `readSection` / `writeSection` / `reflowSection` are melody-only wrappers
 * over them with `melodyCodec` (`parseMelody` / `parseMelodyIgnoringBars`)
 * and `serializeMelody`, kept for backward compatibility and unchanged
 * behaviour. `drumPart.ts` (M5, T17) builds its own `readDrumSection` /
 * `writeDrumSection` / `reflowDrumSection` the same way with a drum codec.
 */

import { KS_NAMES } from './keys';
import { barTicks, isValidTicks, WHOLE_TICKS } from './melody';
import type { MelodyEvent, TimeSig } from './melody';
import {
  parseMelody,
  parseMelodyBeats,
  parseMelodyIgnoringBars,
} from './melodyParse';
import { serializeMelody } from './melodyTex';
import { isDrumPart, type Part, type Song } from './song';
import { atoms, tupletGroups, type Timed } from './tuplet';

// ---------------------------------------------------------------------------
// Parts

/** Melody parts = non-drum parts, in song order. */
export function melodyParts(song: Song): Part[] {
  return song.parts.filter((p) => !isDrumPart(p));
}

/**
 * Index of the first melody part; when there is none, appends an empty part
 * named `name` (or `name 2`, `name 3`, … if a drum part already uses it).
 * Returns the same song object when nothing was added.
 */
export function ensureMelodyPart(
  song: Song,
  name = 'Vocal',
): { song: Song; partIndex: number } {
  const i = song.parts.findIndex((p) => !isDrumPart(p));
  if (i >= 0) return { song, partIndex: i };
  const taken = new Set(song.parts.map((p) => p.name));
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = `${name} ${n}`;
  return {
    song: { ...song, parts: [...song.parts, { name: unique, body: '' }] },
    partIndex: song.parts.length,
  };
}

/**
 * Renames one part. The name is trimmed; empty names, names used by another
 * part and names containing `{`, `}` or a line break (they would break the
 * `{start_of_part: …}` directive), `\` or `"` (they would break the
 * `\track "…"` line alphaTab reads) are rejected with a Japanese message.
 * Throws RangeError for an invalid index.
 */
export function renamePart(
  song: Song,
  partIndex: number,
  newName: string,
): Song | { error: string } {
  if (
    !Number.isInteger(partIndex) ||
    partIndex < 0 ||
    partIndex >= song.parts.length
  ) {
    throw new RangeError(`no part at index ${partIndex}`);
  }
  if (/[\r\n]/.test(newName)) return { error: 'パート名に改行は使えません' };
  const name = newName.trim();
  if (name === '') return { error: 'パート名を入力してください' };
  if (/[{}]/.test(name)) return { error: 'パート名に { や } は使えません' };
  if (/[\\"]/.test(name)) return { error: 'パート名に \\ や " は使えません' };
  if (song.parts.some((p, i) => i !== partIndex && p.name === name)) {
    return { error: '同じ名前のパートがあります' };
  }
  return {
    ...song,
    parts: song.parts.map((p, i) => (i === partIndex ? { ...p, name } : p)),
  };
}

// ---------------------------------------------------------------------------
// Sections

export interface PartSection {
  label: string;
  /** The exact header line (including any leading/trailing whitespace). */
  header: string;
  /** Section body text = `partBody.slice(start, end)`. */
  body: string;
  start: number;
  end: number;
}

export interface PartSections {
  /** Lines before the first `\section`, verbatim (whole body if none). */
  preamble: string;
  sections: PartSection[];
  /** Note lines in the preamble (read-only); absent when there are none. */
  unlabeled?: string;
}

const LABEL = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s"'{}|]+))`;
const SECTION_ANY = new RegExp(String.raw`\\section\s+${LABEL}`);
const HEADER_STRICT = new RegExp(
  String.raw`^\s*\\section\s+${LABEL}(?:\s+(?:"[^"]*"|'[^']*'))?\s*$`,
);
const LYRICS = /^\s*\\lyrics\b/;

interface Line {
  text: string;
  start: number;
}

function splitLines(body: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const text of body.split('\n')) {
    lines.push({ text, start });
    start += text.length + 1;
  }
  return lines;
}

/** Label of a header line, or null when the line is not a header. */
function headerLabel(line: string): string | null {
  if (line.trimStart().startsWith('//')) return null;
  const m = SECTION_ANY.exec(line);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

interface Split {
  preambleLines: Line[];
  sections: (PartSection & { headerLine: number; nextHeaderLine: number })[];
}

function split(body: string): Split {
  const lines = splitLines(body);
  const headers: { index: number; label: string }[] = [];
  lines.forEach((l, index) => {
    const label = headerLabel(l.text);
    if (label !== null) headers.push({ index, label });
  });
  const first = headers.length ? headers[0].index : lines.length;
  const sections = headers.map(({ index, label }, k) => {
    const next = k + 1 < headers.length ? headers[k + 1].index : lines.length;
    const header = lines[index];
    let start: number;
    let end: number;
    if (next > index + 1) {
      start = lines[index + 1].start;
      const last = lines[next - 1];
      end = last.start + last.text.length;
    } else {
      start = end = header.start + header.text.length;
    }
    return {
      label,
      header: header.text,
      body: body.slice(start, end),
      start,
      end,
      headerLine: index,
      nextHeaderLine: next,
    };
  });
  return { preambleLines: lines.slice(0, first), sections };
}

/** Splits a part body into preamble and `\section` blocks (see top). */
export function partSections(body: string): PartSections {
  const { preambleLines, sections } = split(body);
  const preamble = preambleLines.map((l) => l.text).join('\n');
  const notes = preambleLines
    .map((l) => l.text)
    .filter((t) => {
      const s = t.trim();
      return s !== '' && !s.startsWith('\\') && !s.startsWith('//');
    });
  const result: PartSections = {
    preamble,
    sections: sections.map(({ label, header, body, start, end }) => ({
      label,
      header,
      body,
      start,
      end,
    })),
  };
  if (notes.length) result.unlabeled = notes.join('\n');
  return result;
}

/** True when the preamble has a part-level `\lyrics` line. */
export function hasPartLevelLyrics(body: string): boolean {
  return split(body).preambleLines.some((l) => LYRICS.test(l.text));
}

export type PreambleOverrides =
  | { ts?: TimeSig; key?: string }
  /** A `\ts` / `\ks` the app cannot interpret: keep the part read-only. */
  | { unsupported: true };

const TS_DENOMINATORS = new Set(['1', '2', '4', '8', '16', '32']);

/**
 * The part's own time signature / key from `\ts N D` and `\ks <key>` in its
 * preamble (alphaTab renders the part with these, not with the song meta;
 * M11). The UI should prefer them over `meta.time` / `meta.key` for this
 * part, and make the whole part read-only on `{ unsupported: true }`.
 *
 * - `ts`: `\ts 3 4` (1–2 digit numbers, denominator 1…32, bar length a
 *   writable tick count as in `barTicks`).
 * - `key`: in the app's key format (`parseKey`): `\ks G` / `\ks Gmajor` →
 *   'G', `\ks Aminor` → 'Am', `\ks f#minor` → 'F#m', `\ks Bb` → 'Bb'.
 * - `// …` comment lines and quoted strings are ignored. `\ts`/`\ks` inside
 *   sections are not looked at (they make that section read-only anyway).
 * - Anything else — another form (`\ts common`, `\ks "G"`), a key alphaTab
 *   does not know, a second `\ts` or `\ks` — gives `{ unsupported: true }`.
 * - No `\ts`/`\ks` → `{}`.
 */
export function preambleOverrides(body: string): PreambleOverrides {
  const out: { ts?: TimeSig; key?: string } = {};
  const unsupported = { unsupported: true } as const;
  for (const { text } of split(body).preambleLines) {
    if (text.trimStart().startsWith('//')) continue;
    const tokens = text
      .replace(/"[^"]*"/g, '""')
      .trim()
      .split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!/^\\(ts|ks)/i.test(tok)) continue;
      if (tok === '\\ts') {
        const [num, den] = [tokens[i + 1], tokens[i + 2]];
        if (
          out.ts ||
          !/^\d{1,2}$/.test(num ?? '') ||
          !TS_DENOMINATORS.has(den ?? '') ||
          Number(num) < 1 ||
          !isValidTicks((Number(num) * WHOLE_TICKS) / Number(den))
        ) {
          return unsupported;
        }
        out.ts = { num: Number(num), den: Number(den) };
        i += 2;
      } else if (tok === '\\ks') {
        const name = (tokens[i + 1] ?? '').toLowerCase();
        const m = /^([a-g])([#b]?)(major|minor)?$/.exec(name);
        if (out.key !== undefined || !KS_NAMES.has(name) || !m) {
          return unsupported;
        }
        out.key = m[1].toUpperCase() + m[2] + (m[3] === 'minor' ? 'm' : '');
        i += 1;
      } else {
        return unsupported;
      }
    }
  }
  return out;
}

const LYRICS_PLAIN = /^\\lyrics\s+"([^"]*)"\s*$/;
const LYRICS_START_BAR = /^\\lyrics\s+\d+\s+"([^"]*)"\s*$/;

/**
 * Syllables of a part-level `\lyrics "…"` string, the way alphaTab's
 * `applyLyrics` distributes them (verified against alphaTab 1.8.4):
 * space-separated words become syllables; `+` inside one word joins its
 * parts into one syllable (space-joined, e.g. `a+b` → `a b`); `[…]`
 * comments are removed from a word wherever they appear (simplified from
 * alphaTab's own leading-bracket-only, sometimes-inconsistent handling,
 * which this subset does not need to reproduce byte for byte); a word that
 * is empty after that removal is dropped (consumes no note).
 */
function lyricsSyllables(raw: string): string[] {
  const out: string[] = [];
  for (const word of raw.split(/\s+/)) {
    if (word === '') continue;
    const parts = word
      .split('+')
      .map((p) => p.replace(/\[[^\]]*\]/g, ''))
      .filter((p) => p !== '');
    if (parts.length > 0) out.push(parts.join(' '));
  }
  return out;
}

/**
 * Converts a part-level `\lyrics "…"` line (M4 T14) into per-note `lyric`
 * fields: syllables are distributed over the notes of every section in the
 * part, in order (rests are skipped, consuming no syllable; running out of
 * syllables just leaves the remaining notes without a lyric). Like alphaTab
 * (verified, 1.8.4), every WRITTEN beat of a note consumes one syllable,
 * including tied continuation beats (`C4 C4{t}` takes two): since our model
 * has one event per tied note, the note keeps its first beat's syllable and
 * the continuation's syllable is dropped — so the lyrics visible on the
 * notes' first beats match alphaTab's rendering of the original. Each section
 * is rewritten with `writeSection`-equivalent splicing, and the `\lyrics`
 * line is removed from the preamble.
 *
 * `\lyrics N "…"` (the start-bar form) is rejected: alphaTab starts
 * distributing from bar `N`, which this function does not attempt to
 * replicate (bars aren't addressable at this level — see `melody.ts`).
 * Any section that fails to parse (`parseMelody` / a malformed `\section`
 * header) makes the whole conversion fail: nothing is written.
 */
export function convertPartLevelLyrics(
  body: string,
  ts: TimeSig,
): string | { error: string } {
  const { preambleLines, sections } = split(body);
  const lyricsIdx = preambleLines.findIndex((l) => LYRICS.test(l.text));
  if (lyricsIdx < 0) {
    return { error: 'パート全体の \\lyrics が見つかりません' };
  }
  const lyricsText = preambleLines[lyricsIdx].text.trim();
  if (LYRICS_START_BAR.test(lyricsText)) {
    return { error: '開始小節付きの \\lyrics は変換できません' };
  }
  const m = LYRICS_PLAIN.exec(lyricsText);
  if (!m) {
    return { error: '\\lyrics の行を読み取れません' };
  }
  const syllables = lyricsSyllables(m[1]);

  // Same read-only rules as readSection/writeSection (strict header, and no
  // text before the NEXT header — that text would belong to THIS section's
  // body but `split()` attributes it to the next header line instead, so
  // rewriting this section's body would silently drop it), applied to every
  // section occurrence (not just the first per label, unlike readSection).
  const parsedSections: {
    section: (typeof sections)[number];
    events: MelodyEvent[];
    beats: number[];
  }[] = [];
  for (let k = 0; k < sections.length; k++) {
    const s = sections[k];
    const next = sections[k + 1];
    if (
      !HEADER_STRICT.test(s.header) ||
      (next && !/^\s*\\section/.test(next.header))
    ) {
      return { error: '読み取り専用のセクションがあるため変換できません' };
    }
    const parsed = parseMelodyBeats(s.body, ts);
    if (!parsed.ok) {
      return { error: '読み取り専用のセクションがあるため変換できません' };
    }
    parsedSections.push({
      section: s,
      events: parsed.events,
      beats: parsed.beats,
    });
  }

  let cursor = 0;
  const updated = parsedSections.map(({ section, events, beats }) => {
    const newEvents = events.map((e, i) => {
      if (e.kind === 'rest') return e;
      const at = cursor;
      // alphaTab gives every written beat of a tied note its own syllable
      cursor += beats[i];
      if (at < syllables.length) {
        return { ...e, lyric: syllables[at] };
      }
      const { lyric, ...rest } = e;
      void lyric;
      return rest as MelodyEvent;
    });
    return { section, tex: serializeMelody(newEvents, ts, section.label) };
  });

  let out = '';
  let pos = 0;
  for (const { section, tex } of updated) {
    out += body.slice(pos, section.start);
    const noBodyLines = section.nextHeaderLine === section.headerLine + 1;
    out += noBodyLines ? (tex === '' ? '' : '\n' + tex) : tex;
    pos = section.end;
  }
  out += body.slice(pos);

  const outLines = out.split('\n');
  outLines.splice(lyricsIdx, 1);
  return outLines.join('\n');
}

/** Result of parsing one section's body text with a `SectionCodec`. */
export type SectionParseResult<E> =
  { ok: true; events: E[] } | { ok: false; reason: string };

/**
 * How to read a section's body text for a given event type `E` (melody
 * notes, drum hits, …): a strict parser (bar lengths checked against `ts`)
 * and a lenient one (bar lengths ignored, used to detect `barMismatch`).
 * `parseMelody` / `parseMelodyIgnoringBars` already have this shape.
 */
export interface SectionCodec<E> {
  parse(body: string, ts: TimeSig): SectionParseResult<E>;
  parseIgnoringBars(body: string): SectionParseResult<E>;
}

export type ReadSectionWithResult<E> =
  | { status: 'missing' }
  | { status: 'readonly'; reason: string }
  /**
   * The section only fails the bar-length checks for `ts` (e.g. the song's
   * time signature changed after the notes were written). `events` are the
   * notes read ignoring bars; `reason` is the strict parser's message
   * (「1 小節目が長すぎます」…). Not writable until `reflowSectionWith`.
   */
  | { status: 'barMismatch'; events: E[]; reason: string }
  | { status: 'ok'; events: E[] };

export type ReadSectionResult = ReadSectionWithResult<MelodyEvent>;

/**
 * Reads the FIRST section labelled `label` using `codec` (see top of file
 * for the read-only rules shared by every event type: a strict `\section`
 * header line, and no text before the next header line).
 */
export function readSectionWith<E>(
  body: string,
  label: string,
  ts: TimeSig,
  codec: SectionCodec<E>,
): ReadSectionWithResult<E> {
  const { sections } = split(body);
  const k = sections.findIndex((s) => s.label === label);
  if (k < 0) return { status: 'missing' };
  const s = sections[k];
  if (!HEADER_STRICT.test(s.header)) {
    return {
      status: 'readonly',
      reason: '\\section の行にほかの記述があります',
    };
  }
  const next = sections[k + 1];
  if (next && !/^\s*\\section/.test(next.header)) {
    return {
      status: 'readonly',
      reason: '次の \\section の行の前に記述があります',
    };
  }
  const parsed = codec.parse(s.body, ts);
  if (parsed.ok) return { status: 'ok', events: parsed.events };
  // Everything but the bar-length checks is identical in the lenient
  // parser, so its success means bar lengths were the only problem.
  const lenient = codec.parseIgnoringBars(s.body);
  return lenient.ok
    ? { status: 'barMismatch', events: lenient.events, reason: parsed.reason }
    : { status: 'readonly', reason: parsed.reason };
}

const melodyCodec: SectionCodec<MelodyEvent> = {
  parse: parseMelody,
  parseIgnoringBars: parseMelodyIgnoringBars,
};

/** Reads the FIRST section labelled `label` (see top for read-only rules). */
export function readSection(
  body: string,
  label: string,
  ts: TimeSig,
): ReadSectionResult {
  return readSectionWith(body, label, ts, melodyCodec);
}

/**
 * Re-bars the FIRST section labelled `label` in time signature `ts` (M3:
 * the 「新しい拍子で小節を引き直す」 action): the section must read as
 * `barMismatch` (or `ok`, then this is a plain normalizing rewrite) via
 * `codec`; its events are written back with `serialize(events, ts, label)`,
 * all other text untouched. Throws (Japanese message) when the section is
 * missing or read-only. `chartOrder` is passed through to `writeSectionText`.
 */
export function reflowSectionWith<E>(
  body: string,
  label: string,
  ts: TimeSig,
  chartOrder: string[],
  codec: SectionCodec<E>,
  serialize: (events: E[], ts: TimeSig, label: string) => string,
): string {
  const read = readSectionWith(body, label, ts, codec);
  if (read.status === 'missing') {
    throw new Error(`セクション「${label}」が見つかりません`);
  }
  if (read.status === 'readonly') {
    throw new Error(`セクション「${label}」は読み取り専用です: ${read.reason}`);
  }
  return writeSectionText(
    body,
    label,
    serialize(read.events, ts, label),
    chartOrder,
  );
}

/** `reflowSectionWith` for the melody codec (see there for behaviour). */
export function reflowSection(
  body: string,
  label: string,
  ts: TimeSig,
  chartOrder: string[],
): string {
  return reflowSectionWith(
    body,
    label,
    ts,
    chartOrder,
    melodyCodec,
    serializeMelody,
  );
}

function quoteLabel(label: string): string {
  if (/[\r\n]/.test(label)) {
    throw new Error('セクション名に改行は使えません');
  }
  if (label.includes('\\')) {
    throw new Error('セクション名に \\ を含むセクションは作れません');
  }
  if (!label.includes('"')) return `"${label}"`;
  if (!label.includes("'")) return `'${label}'`;
  throw new Error(
    `セクション名に引用符 " と ' の両方を含むセクションは作れません`,
  );
}

/**
 * Replaces the body of the FIRST section labelled `label` with
 * `serializeMelody(events, ts, label)`; all other text stays byte-for-byte
 * identical. Throws (Japanese message) when the section is read-only or
 * `barMismatch` (see top), or when a new header cannot be written for
 * `label` (see `writeSectionText` for the missing-label insertion rules).
 */
export function writeSection(
  body: string,
  label: string,
  events: MelodyEvent[],
  ts: TimeSig,
  chartOrder: string[],
): string {
  const read = readSection(body, label, ts);
  if (read.status === 'readonly' || read.status === 'barMismatch') {
    throw new Error(`セクション「${label}」は読み取り専用です: ${read.reason}`);
  }
  return writeSectionText(
    body,
    label,
    serializeMelody(events, ts, label),
    chartOrder,
  );
}

/**
 * Replaces the body of the FIRST section labelled `label` with the
 * already-serialized `tex` (a codec-specific wrapper like `writeSection`
 * computes it, e.g. `serializeMelody(events, ts, label)`); all other text
 * stays byte-for-byte identical. A missing label gets a new `\section`
 * block, placed by `chartOrder` (the chart's section labels in order):
 * 1. after the existing section whose label comes latest among the labels
 *    before `label` in chartOrder (last occurrence if duplicated), else
 * 2. before the existing section whose label comes earliest among the labels
 *    after `label` (first occurrence), else
 * 3. at the end of the body.
 * Throws (Japanese message) when a new header cannot be written for `label`
 * (see `quoteLabel`). No read-only check — callers that need one must call
 * `readSectionWith` first (as `writeSection` / `reflowSectionWith` do).
 */
export function writeSectionText(
  body: string,
  label: string,
  tex: string,
  chartOrder: string[],
): string {
  const { sections } = split(body);
  const target = sections.find((s) => s.label === label);

  if (target) {
    if (target.nextHeaderLine === target.headerLine + 1) {
      // no body lines: add them after the header line
      return tex === ''
        ? body
        : body.slice(0, target.start) + '\n' + tex + body.slice(target.end);
    }
    return body.slice(0, target.start) + tex + body.slice(target.end);
  }

  const block =
    `\\section ${quoteLabel(label)}` + (tex === '' ? '' : '\n' + tex);
  const idx = chartOrder.indexOf(label);
  if (idx >= 0) {
    const rank = (l: string) => chartOrder.indexOf(l);
    // 1. latest preceding label in chart order
    let after: (typeof sections)[number] | undefined;
    for (const s of sections) {
      const r = rank(s.label);
      if (r >= 0 && r < idx && (!after || r >= rank(after.label))) after = s;
    }
    if (after)
      return body.slice(0, after.end) + '\n' + block + body.slice(after.end);
    // 2. earliest following label in chart order
    let before: (typeof sections)[number] | undefined;
    for (const s of sections) {
      const r = rank(s.label);
      if (r > idx && (!before || r < rank(before.label))) before = s;
    }
    if (before) {
      const lineStart = splitLines(body)[before.headerLine].start;
      return body.slice(0, lineStart) + block + '\n' + body.slice(lineStart);
    }
  }
  // 3. at the end
  if (body === '') return block;
  return body + (body.endsWith('\n') ? '' : '\n') + block;
}

/**
 * Display-only copy of a `barMismatch` section's events (m5-review.md R1):
 * the staff layouts (`splitAtBars`, `drumBars`) throw on a tuplet that
 * crosses a barline, which the NEW time signature can cause. Every such
 * group (laid out from the first bar, in order) loses its tuplet marks, so
 * its slots are drawn as plain notes of their written value; groups that
 * still fit are kept. A broken group structure drops every mark. Never
 * mutates `events`; returns it unchanged when nothing crosses. The text is
 * not changed by this — 「小節を引き直す」 (reflow) decides what is written.
 */
export function withoutCrossingTuplets<T extends Timed>(
  events: readonly T[],
  ts: TimeSig,
): T[] {
  const strip = (e: T): T => {
    const copy = { ...e };
    delete copy.tuplet;
    return copy;
  };
  if ('error' in tupletGroups(events)) return events.map(strip);
  const bar = barTicks(ts);
  let out: T[] | null = null;
  let pos = 0;
  for (const a of atoms(events)) {
    if (a.kind === 'single') {
      pos += a.ticks;
      continue;
    }
    const { start, end, span, unitTicks } = a.group;
    if ((pos % bar) + span <= bar) {
      pos += span;
      continue;
    }
    out ??= [...events];
    for (let i = start; i < end; i++) out[i] = strip(events[i]);
    pos += (end - start) * unitTicks;
  }
  return out ?? (events as T[]);
}

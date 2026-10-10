/**
 * Part-level helpers for the drum editor (M5, T17), built on `melodyPart.ts`'s
 * generic section-range API (T4) with a drum `SectionCodec`. See
 * docs/m5-plan.md (T17 row, 設計判断 5) and drum.ts's header comment for the
 * alphaTex subset. All functions are pure and never mutate their arguments.
 *
 * ## Parts
 *
 * `drumParts` / `ensureDrumPart` mirror `melodyParts` / `ensureMelodyPart`:
 * a drum part is any part for which `isDrumPart` is true (its body matches
 * `\instrument percussion`); a newly created one gets the minimal body
 * `'\instrument percussion'` (no `\articulation` / `\clef` — `partsToAlphaTex`
 * fills those in at render time with the app's defaults, same as the sample
 * song's Drums part).
 *
 * ## Sections
 *
 * `readDrumSection` / `writeDrumSection` / `reflowDrumSection` are the drum
 * counterparts of `readSection` / `writeSection` / `reflowSection`, using
 * `parseDrums` / `parseDrumsIgnoringBars` (T12) as the strict/lenient parser
 * pair and `serializeDrums` (T11) as the serializer. They add one thing the
 * generic `SectionCodec<E>` shape does not carry: the section's `Shuffle`
 * (`\tf`). Since `parseDrums`/`parseDrumsIgnoringBars` already return it
 * alongside `events`, `readDrumSection` reads the section TWICE — once
 * through `readSectionWith` (for the missing/readonly/barMismatch/ok status
 * and the read-only rules shared with melody: a strict `\section` header,
 * no text before the next header), and once more via
 * `parseDrumsIgnoringBars` on that same section's body text (from
 * `partSections`) to pick out `shuffle`. The second parse cannot fail: it
 * succeeds whenever the first one did (shuffle comes from the `\tf` line in
 * `preamble()`, read before any bar-length check), including after
 * `parseDrumsIgnoringBars` succeeded for a `barMismatch`.
 *
 * ### Shuffle / empty-section decisions
 *
 * - An empty section (no beats) has no shuffle to show: `parseDrums('', ts)`
 *   returns `shuffle: 'none'`, and `serializeDrums([], shuffle, ts)` is `''`
 *   for every `shuffle` (docs/m5-plan.md: 「拍が 1 つもないセクションには
 *   書かない（シャッフルの選択はセクションに拍ができるまで無効）」). So
 *   `writeDrumSection(body, label, [], shuffle, ts, chartOrder)` always empties
 *   the section regardless of `shuffle` — this is intentional, not a bug: the
 *   shuffle choice has nothing to attach to until there is a beat.
 * - A section whose body is only a `\tf <value>` line with NO beats keeps
 *   that shuffle on read (`parseDrumsIgnoringBars` returns it), even though
 *   writing it back straight away would lose it (see above). This lets the
 *   UI show "shuffle: 8分" while the user has not entered a beat yet, without
 *   claiming the text says so once they add one and the section is rewritten.
 *
 * ### Inherited shuffle (m5-review.md R2, user decision 2026-10-05)
 *
 * alphaTab carries `\tf` over into every later bar until the next `\tf`, so a
 * section WITHOUT its own `\tf` renders with the value in effect where it
 * starts: the last `\tf` of an earlier section in part-body order, or of the
 * part's preamble, or alphaTab's default (none). `readDrumSection` reports
 * exactly that value as the section's `shuffle` (for a `missing` section, the
 * value at the position `writeSectionText` would insert it, when `chartOrder`
 * is given), so the editor shows what alphaTab draws, and the first edit
 * writes it explicitly (`serializeDrums` always writes a `\tf` line). When
 * the inherited `\tf` value is not one the app can read, a section without
 * its own `\tf` is read-only.
 *
 * Later sections: a write can change the value that flows OUT of the edited
 * section (a new/changed `\tf`, or the section emptied, or a new section
 * inserted). `writeDrumSection` / `reflowDrumSection` then keep every later
 * section's rendering unchanged: the first following section without its
 * own `\tf` whose incoming value changed gets the OLD value written
 * explicitly at the top of its body (the raw token as it was, so even a
 * value the app cannot read is preserved), and so on down the part. The one
 * exception is a section whose body starts with a bare beat (no `:N` /
 * `.N`): a `\tf` line must be followed by an explicit duration (CLAUDE.md
 * gotcha), so such a (read-only) section is left untouched. Leading blank
 * lines and `//` comment lines are skipped before this check (m5-review.md
 * R9): a handwritten comment before the first beat (making the section
 * read-only on its own, but still part of the `\tf` carry-over chain) must
 * not change whether a `\tf` line is inserted ahead of it.
 *
 * ## `\articulation` override (drum.ts's "Reading" section, last bullet)
 *
 * A part whose preamble (text before its first `\section`, as in
 * `partSections`) redefines one of the 9 kit aliases
 * (`DRUM_KIT[*].id` → `DRUM_KIT[*].midi`, the same numbers
 * `partsToAlphaTex.ts`'s `DRUM_ARTICULATIONS` writes by default) to a
 * DIFFERENT number makes the WHOLE part read-only: our codec assumes the
 * alias → instrument mapping is the app's default, so a redefinition means
 * reading the body under that assumption could silently show the wrong
 * instrument. `readDrumSection` (and therefore `writeDrumSection` /
 * `reflowDrumSection`, which call it first) checks this before looking at
 * any particular section, so every section of such a part reads `readonly`.
 * An `\articulation` line that repeats the SAME number as the default is not
 * a redefinition (it matches what `partsToAlphaTex` would have written
 * anyway) and does not trigger this.
 */

import { type DrumEvent, type Shuffle, normalizeDrums } from './drum';
import { DRUM_KIT } from './drumKit';
import {
  parseDrums,
  parseDrumsIgnoringBars,
  type ParseDrumsResult,
} from './drumParse';
import { serializeDrums } from './drumTex';
import {
  partSections,
  readSectionWith,
  withoutCrossingTuplets,
  writeSectionText,
  type SectionCodec,
  type SectionParseResult,
} from './melodyPart';
import { barTicks, type TimeSig } from './melody';
import { isDrumPart, type Part, type Song } from './song';
import { groupsFitBars } from './tuplet';

// ---------------------------------------------------------------------------
// Parts

/** Drum parts = parts with `\instrument percussion`, in song order. */
export function drumParts(song: Song): Part[] {
  return song.parts.filter(isDrumPart);
}

/** Minimal body of a freshly created drum part (matches the sample song). */
const NEW_DRUM_BODY = '\\instrument percussion';

/**
 * Index of the first drum part; when there is none, appends an empty drum
 * part named `name` (or `name 2`, `name 3`, … if a melody part already uses
 * it). Returns the same song object when nothing was added.
 */
export function ensureDrumPart(
  song: Song,
  name = 'Drums',
): { song: Song; partIndex: number } {
  const i = song.parts.findIndex(isDrumPart);
  if (i >= 0) return { song, partIndex: i };
  const taken = new Set(song.parts.map((p) => p.name));
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = `${name} ${n}`;
  return {
    song: {
      ...song,
      parts: [...song.parts, { name: unique, body: NEW_DRUM_BODY }],
    },
    partIndex: song.parts.length,
  };
}

// ---------------------------------------------------------------------------
// `\articulation` override (see header comment)

/** `DRUM_KIT` alias → the note number `partsToAlphaTex` writes by default. */
const DEFAULT_MIDI: ReadonlyMap<string, number> = new Map(
  DRUM_KIT.map((e) => [e.id, e.midi]),
);

/** `\articulation NAME <rest of the line>` (keyword case-insensitive). */
const ARTICULATION_LINE = /^\\articulation\s+(\S+)\s+(\S.*)$/i;

/**
 * The Japanese reason the whole part is read-only, or `undefined` when its
 * preamble does not redefine one of the 9 kit aliases to a different number
 * (see header comment).
 */
function articulationOverride(body: string): string | undefined {
  for (const raw of partSections(body).preamble.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    const m = ARTICULATION_LINE.exec(line);
    if (!m) continue;
    const [, name, rest] = m;
    const want = DEFAULT_MIDI.get(name);
    if (want !== undefined && rest.trim() !== String(want)) {
      return `パートの冒頭で \\articulation ${name} がアプリの既定値（${want}）と違う番号に変更されているため、このパートは読み取り専用です`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sections

/** `SectionCodec<DrumEvent>` over `parseDrums` / `parseDrumsIgnoringBars`. */
const drumCodec: SectionCodec<DrumEvent> = {
  parse: (body, ts) => toSectionResult(parseDrums(body, ts)),
  parseIgnoringBars: (body) => toSectionResult(parseDrumsIgnoringBars(body)),
};

function toSectionResult(r: ParseDrumsResult): SectionParseResult<DrumEvent> {
  return r.ok
    ? { ok: true, events: r.events }
    : { ok: false, reason: r.reason };
}

/** The section's shuffle; only called once a parse of it is known to succeed. */
function shuffleOf(sectionBody: string): Shuffle {
  const r = parseDrumsIgnoringBars(sectionBody);
  if (!r.ok) {
    // Unreachable: callers only call this for a body that `drumCodec` (which
    // is `parseDrums`/`parseDrumsIgnoringBars` themselves) already read ok.
    throw new Error(`unreachable: ${r.reason}`);
  }
  return r.shuffle;
}

export type ReadDrumSectionResult =
  /**
   * `shuffle` (only when `chartOrder` was passed): the value the section
   * would inherit at the position a write would insert it.
   */
  | { status: 'missing'; shuffle?: Shuffle }
  | { status: 'readonly'; reason: string }
  | {
      status: 'barMismatch';
      events: DrumEvent[];
      shuffle: Shuffle;
      reason: string;
    }
  | { status: 'ok'; events: DrumEvent[]; shuffle: Shuffle };

/**
 * Reads the FIRST section labelled `label` (read-only rules as in
 * `readSectionWith`, plus the whole-part `\articulation` override above).
 * A section without its own `\tf` reads the inherited shuffle (header
 * comment, "Inherited shuffle"); `chartOrder` is only used to work out a
 * `missing` section's would-be inherited shuffle.
 */
export function readDrumSection(
  body: string,
  label: string,
  ts: TimeSig,
  chartOrder?: string[],
): ReadDrumSectionResult {
  const overrideReason = articulationOverride(body);
  if (overrideReason !== undefined) {
    return { status: 'readonly', reason: overrideReason };
  }
  const read = readSectionWith(body, label, ts, drumCodec);
  if (read.status === 'missing') {
    if (chartOrder === undefined) return read;
    const probe = writeSectionText(body, label, '', chartOrder);
    const k = partSections(probe).sections.findIndex((s) => s.label === label);
    const shuffle = tfShuffle(tfFlow(probe)[k].incoming) ?? 'none';
    return { status: 'missing', shuffle };
  }
  if (read.status === 'readonly') return read;
  const sections = partSections(body).sections;
  // readSectionWith resolved status 'ok' or 'barMismatch' for this label, so
  // the section exists.
  const k = sections.findIndex((s) => s.label === label);
  let shuffle: Shuffle;
  const flow = tfFlow(body)[k];
  if (flow.own) {
    shuffle = shuffleOf(sections[k].body);
  } else {
    const inherited = tfShuffle(flow.incoming);
    if (inherited === undefined) {
      return {
        status: 'readonly',
        reason: `前から引き継ぐシャッフル（\\tf ${flow.incoming}）をアプリでは読めません`,
      };
    }
    shuffle = inherited;
  }
  return read.status === 'ok'
    ? { status: 'ok', events: read.events, shuffle }
    : {
        status: 'barMismatch',
        events: read.events,
        shuffle,
        reason: read.reason,
      };
}

// ---------------------------------------------------------------------------
// `\tf` carry-over (header comment, "Inherited shuffle")

/** `\tf <value>` anywhere in a line (alphaTab: case-insensitive keyword). */
const TF_ANY = /\\tf(?![A-Za-z])\s+(\S+)/gi;

/** The last `\tf` value (raw token) in `text`, skipping `//` comment lines. */
function lastTf(text: string): string | undefined {
  let value: string | undefined;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('//')) continue;
    for (const m of line.matchAll(TF_ANY)) value = m[1];
  }
  return value;
}

/**
 * True when `body`'s first non-blank, non-`//`-comment line exists and does
 * NOT start with `:`, `.` or `\` — i.e. the section begins with a
 * duration-less bare beat, where inserting a `\tf` line ahead of it would
 * break (CLAUDE.md gotcha: a `\tf` line needs an explicit duration right
 * after it). Leading blank lines and `//` comments are skipped first, so a
 * handwritten comment before the first beat doesn't flip the answer
 * (m5-review.md R9). A section with nothing but blank/comment lines (or
 * truly empty) answers `false`, same as an empty section always did.
 */
function startsWithBareBeat(body: string): boolean {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    return !/^[:.\\]/.test(line);
  }
  return false;
}

/** alphaTab's default when no `\tf` was written at all. */
const TF_DEFAULT = 'none';

/** A raw `\tf` token → `Shuffle`, or undefined when the app can't read it. */
function tfShuffle(raw: string): Shuffle | undefined {
  const r = parseDrumsIgnoringBars(`\\tf ${raw}`);
  return r.ok ? r.shuffle : undefined;
}

/** Comparison key: same rendering ⇔ same key. */
const tfKey = (raw: string): string =>
  tfShuffle(raw) ?? `?${raw.toLowerCase()}`;

interface TfFlow {
  /** The section has its own `\tf`. */
  own: boolean;
  /** Raw `\tf` value in effect where the section starts. */
  incoming: string;
}

/** Per section of `body` (in `partSections` order): own `\tf` / incoming value. */
function tfFlow(body: string): TfFlow[] {
  const { preamble, sections } = partSections(body);
  let current = lastTf(preamble) ?? TF_DEFAULT;
  return sections.map((s) => {
    const incoming = current;
    const own = lastTf(s.body);
    if (own !== undefined) current = own;
    return { own: own !== undefined, incoming };
  });
}

/**
 * `after` = `before` with one section rewritten (and possibly inserted):
 * writes the old incoming `\tf` explicitly into every later section whose
 * rendering would otherwise change (header comment, "Later sections").
 */
function keepFollowingShuffle(before: string, after: string): string {
  const old = partSections(before).sections;
  const oldFlow = tfFlow(before);
  let out = after;
  const count = partSections(after).sections.length;
  // Index in `before` of section k of `after` (one inserted section at most).
  let inserted = -1;
  if (count === old.length + 1) {
    const labels = partSections(after).sections.map((s) => s.label);
    inserted = labels.findIndex(
      (l, k) => k >= old.length || l !== old[k].label,
    );
  } else if (count !== old.length) {
    return after;
  }
  for (let k = 0; k < count; k++) {
    if (k === inserted) continue;
    const o = inserted >= 0 && k > inserted ? k - 1 : k;
    const flow = tfFlow(out)[k];
    if (flow.own || tfKey(flow.incoming) === tfKey(oldFlow[o].incoming)) {
      continue;
    }
    const section = partSections(out).sections[k];
    if (startsWithBareBeat(section.body)) continue; // bare first beat
    const line = `\\tf ${oldFlow[o].incoming}`;
    const headerOnly = out.charAt(section.start - 1) !== '\n';
    out =
      out.slice(0, section.start) +
      (headerOnly ? `\n${line}` : `${line}\n`) +
      out.slice(section.start);
  }
  return out;
}

/**
 * Replaces the body of the FIRST section labelled `label` with
 * `serializeDrums(events, shuffle, ts)`; all other text stays byte-for-byte
 * identical. Throws (Japanese message) when the section is read-only or
 * `barMismatch` (see `readDrumSection`), or when a new header cannot be
 * written for `label` (see `writeSectionText`).
 */
export function writeDrumSection(
  body: string,
  label: string,
  events: DrumEvent[],
  shuffle: Shuffle,
  ts: TimeSig,
  chartOrder: string[],
): string {
  const read = readDrumSection(body, label, ts);
  if (read.status === 'readonly' || read.status === 'barMismatch') {
    throw new Error(`セクション「${label}」は読み取り専用です: ${read.reason}`);
  }
  return keepFollowingShuffle(
    body,
    writeSectionText(
      body,
      label,
      serializeDrums(events, shuffle, ts),
      chartOrder,
    ),
  );
}

/**
 * Re-bars the FIRST section labelled `label` in time signature `ts` (the
 * 「新しい拍子で小節を引き直す」 action): the section must read as
 * `barMismatch` (or `ok`, then this is a plain normalizing rewrite) via
 * `readDrumSection`. Events are re-split at the new bar length
 * (`normalizeDrums`); when a tuplet group would still cross a barline after
 * that (the only way `serializeDrums` could fail here — `normalizeDrums`
 * never leaves a plain beat crossing one), this throws a Japanese Error
 * itself (`groupsFitBars`'s message) instead of letting `serializeDrums`
 * raise its English one. Throws (Japanese message) when the section is
 * missing or read-only. `chartOrder` is passed through to `writeSectionText`.
 */
export function reflowDrumSection(
  body: string,
  label: string,
  ts: TimeSig,
  chartOrder: string[],
): string {
  const read = readDrumSection(body, label, ts);
  if (read.status === 'missing') {
    throw new Error(`セクション「${label}」が見つかりません`);
  }
  if (read.status === 'readonly') {
    throw new Error(`セクション「${label}」は読み取り専用です: ${read.reason}`);
  }
  const { events, shuffle } = read;
  const { events: normalized } = normalizeDrums(events, ts);
  const fit = groupsFitBars(normalized, barTicks(ts));
  if (!fit.ok) {
    throw new Error(`セクション「${label}」は読み取り専用です: ${fit.error}`);
  }
  return keepFollowingShuffle(
    body,
    writeSectionText(
      body,
      label,
      serializeDrums(normalized, shuffle, ts),
      chartOrder,
    ),
  );
}

/**
 * Display-only events of a `barMismatch` drum section (m5-review.md R1):
 * `layoutDrums` (`drumBars`) throws on a beat or tuplet crossing a barline
 * of the NEW time signature, so beats are cut at barlines
 * (`normalizeDrums`) and crossing tuplets are drawn as plain beats
 * (`withoutCrossingTuplets`). Never written back; reflow decides the text.
 */
export function drumBarMismatchDisplay(
  events: readonly DrumEvent[],
  ts: TimeSig,
): DrumEvent[] {
  return normalizeDrums(withoutCrossingTuplets(events, ts), ts).events;
}

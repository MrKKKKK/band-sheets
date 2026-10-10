/**
 * Melody model (M4) and the alphaTex SUBSET the melody editor reads/writes.
 * See docs/m4-plan.md, design decisions 1, 2 and 5; tuplets: docs/m5-plan.md
 * (設計判断 1, 2) and tuplet.ts.
 *
 * ## Model
 *
 * One section of a melody part = a flat `MelodyEvent[]` without bars. Bars
 * are derived from the song's time signature (`melodyTimeSignature(meta.time)`,
 * 4/4 when unreadable). A note that crosses a barline is one event; it is
 * split into tied pieces only when written (`splitAtBars`) and merged back
 * when read. Pickup bars (弱起) and time-signature changes are out of scope.
 *
 * Length is in ticks: whole = 64, half 32, quarter 16, eighth 8, 16th 4,
 * 32nd 2; a dot = 1.5x (dotted 16th = 6). An event's `ticks` is any
 * positive even integer (`isValidTicks`); it need not be a single note value
 * (e.g. 40 = half + eighth, written tied). The 32nd ('32') exists only so
 * that every even tick count can be written (an odd number of dotted 16ths
 * leaves a 2-tick remainder at the barline); it is not an input duration
 * (`INPUT_DURATIONS`).
 *
 * Tuplets (M5): n consecutive events marked `tuplet: { n, slot }` (slot
 * 0..n-1), all of the same plain written value (unit 2分〜32分, no dot, no
 * tie; rests allowed), n in 3..15 except 4 and 8 (`isValidTupletN`). Their
 * `ticks` is the WRITTEN unit; the group's real length (span) is
 * `tupletDen(n) × unit` (3→2, 5..7→4, 9..15→8), always whole ticks. A group
 * is indivisible: it never crosses a barline (`groupsFitBars`; editors
 * refuse such edits, `splitAtBars` throws) and is never split or tied.
 * Mixed-length tuplets are outside the model (read-only).
 *
 * ## alphaTex subset (contract for serializeMelody / parseMelody)
 *
 * Verified against alphaTab 1.8.4 `importer.AlphaTexImporter` (see the
 * fixture test in melody.test.ts). "Section body" = the lines after one
 * `\section "Label"` line up to the next `\section` line or the end of the
 * part body; the `\section` line itself and text before the first `\section`
 * are handled by the part-level code (T4), not by this subset.
 *
 * ### Writing (serializeMelody(events, ts) → section body; canonical form)
 *
 * 1. `bars = splitAtBars(events, ts)`; one bar per line, each line ends with
 *    ` |` (also the last one). Lines joined with `\n`, no trailing newline.
 *    No events → '' (no lines). The last bar may be short: the serializer
 *    does NOT pad (`padToFullBar` is the editor's decision). alphaTab
 *    accepts a short last bar as is.
 * 2. Beats are separated by one space. Each piece is one beat:
 *      `[:N ]<pitch-or-r>[{effects}]`
 *    - `:N` (N = '1'|'2'|'4'|'8'|'16'|'32', the piece's `d`) is written
 *      before the beat when it differs from the previous beat's N in this
 *      section — and ALWAYS before the section's first beat. (alphaTab
 *      carries the duration across `\section` lines, and a note right after
 *      `\section "A"` is swallowed as a second `\section` argument; a
 *      `:N` token prevents both. Verified.) The dot does not affect this
 *      comparison: dotted is per beat, not sticky.
 *    - note pitch: `event.pitch` exactly as stored, `isValidPitch`:
 *      `^[A-G](#|b)?[0-8]$` (`C4` = middle C = MIDI 60, `C#4`, `Bb3`; also
 *      `Cb4`, `E#4`, which alphaTab reads as B3 / F4). Rest: `r`.
 *    - effects, in this order, space-separated inside ONE pair of braces
 *      attached to the pitch / `r` with no space; braces omitted when empty:
 *        `d`             the piece is dotted
 *        `t`             tie: continues the previous note (same pitch
 *                        string). Written on every continuation piece of a
 *                        note (`isContinuation && kind === 'note'`), never
 *                        on rests.
 *        `tu N`          the piece is a tuplet slot: `tupletTex(n)` =
 *                        `tu N`, or `tu N D` for 13/14/15 (no alphaTab
 *                        default denominator; D = `tupletDen(N)`). Written
 *                        on EVERY slot of the group, notes and rests alike
 *                        (alphaTab needs it on every beat; there is no
 *                        group start/end marker). Never with `d` / `t`.
 *        `lyrics "<s>"`  `cleanTexText(event.lyric)`; first piece of a note
 *                        only, never on rests (a rest's lyric is dropped)
 *        `ch "<s>"`      `cleanTexText(event.chord)`; first piece only;
 *                        allowed on rests
 *        `slur "<id>"`   melisma slur (see "Melisma slurs" below)
 *      e.g. `C4{d lyrics "き" ch "C"}`, `F4{d t}`, `r{ch "G"}`, `Bb3{t}`,
 *      `G4{lyrics "ら" slur "A-1"}`.
 *    - `cleanTexText` removes `" \ { }`, turns CR/LF/TAB into spaces and
 *      yields undefined (= no effect) if only whitespace is left. Inner
 *      spaces are kept: `{lyrics "a b"}` is one syllable string for alphaTab.
 *
 *    Example (4/4; a half note D4 starting on beat 4, tied over the barline):
 *      :4 C4{lyrics "き" ch "C"} C4{lyrics "ら"} G4 D4{lyrics "ばー"} |
 *      D4{t} :2 E4{d} |
 *    Tuplet example (an eighth-note triplet on beat 1, then a quarter
 *    5-tuplet of 16ths): `{tu}` is a beat effect and `lyrics`/`slur` note
 *    effects, but inside ONE `{}` after the pitch (no `.N`) alphaTab takes
 *    both (verified, findings §8.1):
 *      :8 C4{tu 3 lyrics "き" ch "C"} D4{tu 3} r{tu 3} :4 E4 :16 F4{tu 5}
 *      G4{tu 5} A4{tu 5} B4{tu 5} C5{tu 5} :4 r |
 *    (one line in the real output). Bars are counted with the span (2
 *    eighths + quarter + quarter + quarter = 4/4).
 *    Golden data: src/lib/fixtures/melodyFixtures.ts.
 * 3. Melisma slurs (derived, never stored in the model). A melisma
 *    (`melismas`) = a note with a lyric (`cleanTexText(lyric) !==
 *    undefined`) followed by one or more notes WITHOUT a lyric; a rest, a
 *    note with a lyric or the section end ends it. Those notes are sung on
 *    that syllable, so the writer slurs them: `slur "<id>"` on the FIRST
 *    piece of the start note and on the LAST piece (last tied piece) of the
 *    melisma's last note (`slurMarks`). Ties stay `{t}` as before.
 *    alphaTab 1.8.4 syntax (verified with AlphaTexImporter): the note
 *    effect `slur <id>` (`<id>` a quoted string or an identifier); the
 *    first occurrence of an id is the origin, the second the destination
 *    (`Note.slurOrigin` / `slurDestination`). alphaTab's id map is per STAFF
 *    and entries are never removed, so a reused id within one part would
 *    re-point the old slur: ids are `slurId(label, n)` = `"<label>-<n>"`
 *    (`"<n>"` for an empty label), n = 1, 2, … per section. The label
 *    comes from the caller (`serializeMelody(events, ts, label)`).
 *    (Duplicate section labels in one part would collide; accepted.)
 *    Example: `:4 C4{lyrics "る" slur "A-1"} D4 E4{slur "A-1"} |`
 *
 * ### Reading (parseMelody(body, ts) → events | read-only)
 *
 * Strict: the parser accepts exactly the language below; ANYTHING else makes
 * the section read-only (the editor shows 「テキスト入力で編集してください」
 * and never rewrites that section's text).
 *
 * - Tokens are separated by whitespace (spaces, tabs, newlines). Line
 *   breaks carry no meaning: a bar may span lines, a line may hold several
 *   bars. Blank lines are fine.
 * - Token kinds: `|` (end of bar), `:N` with N in 1 2 4 8 16 32, and a beat
 *   `<pitch-or-r>` optionally followed DIRECTLY (no space) by `{…}`.
 *   Inside the braces: items `d`, `t`, `tu N` / `tu N D` (decimal integers;
 *   `parseTupletItem`), `lyrics "<s>"`, `ch "<s>"`, `slur …` separated
 *   by one or more spaces, in any order, each at most once; `<s>` contains
 *   no `"`, `\`, `{`, `}` and no line break. (Strings with spaces inside
 *   quotes are one item, so the brace content must be tokenized with quotes
 *   in mind, not by `split(' ')`.)
 * - A beat may instead carry its duration glued directly to the pitch/`r`
 *   as `.N` (N in 1 2 4 8 16 32), e.g. `C4.4`, `r.8` — the alphaTex idiom
 *   seen in hand-written parts. Verified against alphaTab 1.8.4: `.N` sets
 *   this beat's duration AND becomes the running duration for later beats,
 *   exactly like a `:N` token placed at that spot (sticky across `|` too).
 *   A `{…}` block after `.N` is read by alphaTab as BEAT effects only
 *   (`C4.8{tu 3}`, `C4.2{d}` parse; note effects such as `C4.2{t}` error
 *   with "Unrecognized property 't'"), so after `.N` the block may hold
 *   only the beat effects `d` and `tu …` (M5); anything else there
 *   (`t`, `lyrics`, `ch`, `slur`) makes the section read-only.
 * - The first beat of the section must have an explicit duration, either a
 *   preceding `:N` token or a glued `.N` suffix on the beat itself
 *   (otherwise read-only; see above why alphaTab would misread an
 *   unmarked first beat).
 * - Every bar ends with `|`, except that the section's last bar may omit it.
 *   Empty bars (`| |`) are read-only. Every bar except the last must total
 *   exactly `barTicks(ts)`; the last bar must be ≤ `barTicks(ts)` (a short
 *   last bar is fine, an overfull or short middle bar — e.g. a pickup — is
 *   read-only, since re-barring on write would move notes).
 * - Ties: `t` on a note whose previous beat in the section (across `|` and
 *   lines) is a note with the identical pitch string; the beat's ticks are
 *   added to that event and the beat must carry no `lyrics`/`ch`. `t` on
 *   a rest, on the first beat, after a rest, or with a different spelling
 *   → read-only. Consequence: `C4 C4{t}` inside one bar reads back as one
 *   32-tick note and is rewritten as `:2 C4` (accepted normalization).
 * - `lyrics` on a rest → read-only. A dotted 32nd (`:32` + `d`) → read-only.
 * - Tuplets: beats carrying `tu N` are grouped in order, n at a time (a
 *   new group starts after n beats, exactly like alphaTab's
 *   `TupletGroup.check` for equal-length beats; so 6 beats of `{tu 3}` are
 *   two triplets). Each beat becomes one event with `tuplet: { n, slot }`
 *   and `ticks` = its written value. Read-only when: a group has fewer
 *   than n beats (an untupleted beat or the section end comes first), N
 *   changes inside a group, the written values differ (mixed-length
 *   tuplet, e.g. 4分＋8分 3連 — alphaTab's own grouping is unreliable
 *   there), a slot is dotted or tied (`t` on a slot, or on a beat right
 *   after a slot), the unit is not 2/4/8/16/32, N is not valid, D ≠
 *   `tupletDen(N)`, or a `|` falls inside a group (a tuplet crossing a
 *   barline; also in `parseMelodyIgnoringBars`). For bar lengths a group
 *   counts as its span.
 * - Slurs: `slur "<s>"` (same string rules as `lyrics`) or `slur <ident>`
 *   (`[A-Za-z_][A-Za-z0-9_]*`), at most once per beat, never on a rest.
 *   Each id must occur exactly twice in the section, and every such pair
 *   must span exactly one melisma of the parsed events (origin on the
 *   start note's first beat, destination on the end note's last beat);
 *   anything else — a slur ending early, over notes that all have lyrics,
 *   across a rest, unpaired — is READ-ONLY (not silently dropped, since
 *   the writer could not reproduce it). Slurs carry no data: they are
 *   dropped on read. A melisma WITHOUT a slur (old or hand-written text) is
 *   accepted and gets the canonical slur (and id) on the next write.
 * - Read-only (non-exhaustive, all simply "not in the grammar above"):
 *   chords `(C4 E4)`, tuplets breaking the rules above, any other effect,
 *   other durations (`:64`), a `.N` beat followed by note effects (see
 *   above), `C4{tu 3}.8` (braces before `.N`), lowercase pitches,
 *   fret.string notes (`3.2` — the `.` there is a string number, not a
 *   duration, and the base isn't `r` or a valid pitch), `##`/`bb`, any `\`
 *   metadata inside the section (`\ts`, `\ks`, `\lyrics`, …), comments
 *   (`//`, `/* … *\/`), repeat/bar metadata, `{dd}`.
 * - The parser returns events whose lyric/chord are the strings as written
 *   (already clean by construction).
 *
 * Round trip: for events with valid pitches, clean lyric/chord strings, no
 * lyric on rests, `isValidTicks` ticks and well-formed tuplet groups that
 * fit their bars (`groupsFitBars`),
 * `parseMelody(serializeMelody(events, ts), ts)` deep-equals `events`,
 * except that consecutive rests are normalized: a rest that directly follows
 * another rest and carries no chord of its own is merged into it (rests split
 * at a barline are written without a tie, so `r | r` cannot be told apart
 * from two separate rests). Editors must not rely on rest event indexes
 * surviving a round trip (e.g. two quarter rests become one half rest).
 * Rests inside a tuplet never merge (neither with each other nor with a
 * rest right before / after the group): every slot keeps its own event.
 * `.N` durations read from hand-written text are likewise normalized away:
 * serializeMelody only ever emits `:N`, so a section read with `C4.4` is
 * rewritten as `:4 C4` the next time the editor saves it.
 */

import { parseTimeSignature } from './partsToAlphaTex';
// Values from tuplet.ts are only used inside functions (tuplet.ts imports
// DURATION_TICKS from here, an import cycle that is safe as long as neither
// module uses the other's values at load time).
import { tupletGroups, type TupletMark } from './tuplet';

export interface MelodyEvent {
  kind: 'note' | 'rest';
  /** Notes only: `isValidPitch` spelling such as 'C4', 'C#4', 'Bb3'. */
  pitch?: string;
  /** Length in ticks (whole = 64); positive even integer. */
  ticks: number;
  /** Notes only. Syllable(s) sung on this note; absent = no lyric. */
  lyric?: string;
  /** Chord symbol shown above this event (notes or rests). */
  chord?: string;
  /**
   * Slot of a tuplet (M5, see tuplet.ts): one tuplet = n consecutive events
   * marked `{ n, slot: 0..n-1 }`, all with the same written `ticks` (a plain
   * unit, TUPLET_UNITS). `ticks` is then the WRITTEN length; the group's real
   * length is `tupletDen(n) × ticks`. Absent = not in a tuplet.
   */
  tuplet?: TupletMark;
}

/** Note value: whole, half, quarter, eighth, 16th, 32nd. */
export type Duration = '1' | '2' | '4' | '8' | '16' | '32';

/** One single (optionally dotted) note value. */
export interface NoteValue {
  d: Duration;
  dotted: boolean;
}

export interface TimeSig {
  num: number;
  den: number;
}

export const WHOLE_TICKS = 64;

export const DURATION_TICKS: Readonly<Record<Duration, number>> = {
  '1': 64,
  '2': 32,
  '4': 16,
  '8': 8,
  '16': 4,
  '32': 2,
};

/** Durations the user can pick (keys 1 2 4 8 6). '32' is output-only. */
export const INPUT_DURATIONS: readonly Duration[] = ['1', '2', '4', '8', '16'];

const DURATIONS = Object.keys(DURATION_TICKS) as Duration[];

export function durationTicks(d: Duration, dotted: boolean): number {
  const t = DURATION_TICKS[d];
  return dotted ? t * 1.5 : t;
}

/** All single note values of the subset (dotted 32nd excluded), longest first. */
const VALUES: readonly (NoteValue & { ticks: number })[] = DURATIONS.flatMap(
  (d) =>
    (d === '32' ? [false] : [true, false]).map((dotted) => ({
      d,
      dotted,
      ticks: durationTicks(d, dotted),
    })),
).sort((a, b) => b.ticks - a.ticks);

/** The single note value of exactly `ticks`, or null. */
export function ticksToDuration(ticks: number): NoteValue | null {
  const v = VALUES.find((x) => x.ticks === ticks);
  return v ? { d: v.d, dotted: v.dotted } : null;
}

/** A writable event length: a positive even integer number of ticks. */
export function isValidTicks(ticks: number): boolean {
  return Number.isInteger(ticks) && ticks > 0 && ticks % 2 === 0;
}

/**
 * Splits `ticks` into note values to be tied, largest first: greedily takes
 * the largest value (dotted or not, 16th or longer) whose remainder is still
 * writable without 32nds (0 or even ≥ 4), e.g. 40 → 2 + 8, 10 → 16. + 16.
 * Only a total of exactly 2 gives a 32nd.
 * Throws RangeError when `!isValidTicks(ticks)`.
 */
export function decompose(ticks: number): NoteValue[] {
  if (!isValidTicks(ticks)) {
    throw new RangeError(`unrepresentable ticks: ${ticks}`);
  }
  if (ticks === 2) return [{ d: '32', dotted: false }];
  const out: NoteValue[] = [];
  let rest = ticks;
  while (rest > 0) {
    const v = VALUES.find(
      (x) =>
        x.d !== '32' &&
        x.ticks <= rest &&
        (rest - x.ticks === 0 || rest - x.ticks >= 4),
    )!;
    out.push({ d: v.d, dotted: v.dotted });
    rest -= v.ticks;
  }
  return out;
}

/** Ticks per bar. Throws RangeError unless it is a positive even integer. */
export function barTicks(ts: TimeSig): number {
  const t = (ts.num * WHOLE_TICKS) / ts.den;
  if (!isValidTicks(t)) {
    throw new RangeError(`unsupported time signature: ${ts.num}/${ts.den}`);
  }
  return t;
}

const FOUR_FOUR: TimeSig = { num: 4, den: 4 };

/** The song's time signature for the melody editor; 4/4 when unusable. */
export function melodyTimeSignature(time: string | undefined): TimeSig {
  const parsed = parseTimeSignature(time);
  if (!parsed) return FOUR_FOUR;
  const ts = { num: parsed[0], den: parsed[1] };
  return isValidTicks((ts.num * WHOLE_TICKS) / ts.den) ? ts : FOUR_FOUR;
}

const PITCH_RE = /^[A-G](#|b)?[0-8]$/;

/** Strict pitch spelling of the subset, e.g. 'C4', 'C#4', 'Bb3'. */
export function isValidPitch(pitch: string): boolean {
  return PITCH_RE.test(pitch);
}

/**
 * Lyric / chord text as written into an alphaTex string: removes `" \ { }`,
 * CR/LF/TAB → space; undefined when nothing but whitespace is left.
 */
export function cleanTexText(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const out = s.replace(/["\\{}]/g, '').replace(/[\r\n\t]/g, ' ');
  return out.trim() === '' ? undefined : out;
}

/** One written beat: a piece of an event inside one bar. */
export interface BarPiece extends NoteValue {
  /** The source event (same object reference). */
  event: MelodyEvent;
  /**
   * WRITTEN length of the beat (`durationTicks(d, dotted)`). For a tuplet
   * slot this is the unit, not the real length (real = group span / n).
   */
  ticks: number;
  /** Notes only: a later piece of the same event follows (write `t` on it). */
  tieToNext: boolean;
  /** Not the event's first piece: carries no lyric / chord. */
  isContinuation: boolean;
  /**
   * Tuplet slots only: the event's mark (`{tu N}` is written on every slot).
   * A tuplet event is always exactly one piece (never split or tied).
   */
  tuplet?: TupletMark;
}

/**
 * Lays the events out in bars of `barTicks(ts)`. An event crossing a
 * barline is split at the barline, and every in-bar segment that is not a
 * single note value is decomposed (`decompose`), so each piece is exactly
 * one writable beat. Notes' pieces are tied (`tieToNext` on all but the
 * last); rests are split without ties. The last bar may be incomplete
 * (no padding here; see `padToFullBar`). Throws RangeError on invalid ticks.
 *
 * Tuplets (`tupletGroups`) are laid out as one indivisible block of
 * `span` ticks: each slot is one piece of the unit value (`tuplet` set,
 * never tied or split). Throws RangeError (Japanese message, shown by the
 * editor) on a broken group or a group that would cross a barline
 * (`N 小節目の 3 連符が小節線をまたぎます`, same as `groupsFitBars`).
 */
export function splitAtBars(events: MelodyEvent[], ts: TimeSig): BarPiece[][] {
  const size = barTicks(ts);
  const groups = tupletGroups(events);
  if ('error' in groups) throw new RangeError(groups.error);
  const groupAt = new Map(groups.map((g) => [g.start, g]));
  const bars: BarPiece[][] = [];
  let bar: BarPiece[] = [];
  let pos = 0; // ticks used in `bar`
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!isValidTicks(event.ticks)) {
      throw new RangeError(`invalid event ticks: ${event.ticks}`);
    }
    const g = groupAt.get(i);
    if (g) {
      if (pos + g.span > size) {
        throw new RangeError(
          `${bars.length + 1} 小節目の ${g.n} 連符が小節線をまたぎます`,
        );
      }
      const { d } = ticksToDuration(g.unitTicks)!;
      for (let k = g.start; k < g.end; k++) {
        bar.push({
          event: events[k],
          ticks: g.unitTicks,
          d,
          dotted: false,
          tieToNext: false,
          isContinuation: false,
          tuplet: events[k].tuplet,
        });
      }
      pos += g.span;
      if (pos === size) {
        bars.push(bar);
        bar = [];
        pos = 0;
      }
      i = g.end - 1;
      continue;
    }
    const pieces: BarPiece[] = [];
    let left = event.ticks;
    while (left > 0) {
      const seg = Math.min(left, size - pos);
      for (const v of decompose(seg)) {
        const piece: BarPiece = {
          event,
          ticks: durationTicks(v.d, v.dotted),
          d: v.d,
          dotted: v.dotted,
          tieToNext: false,
          isContinuation: pieces.length > 0,
        };
        pieces.push(piece);
        bar.push(piece);
      }
      left -= seg;
      pos += seg;
      if (pos === size) {
        bars.push(bar);
        bar = [];
        pos = 0;
      }
    }
    if (event.kind === 'note') {
      for (const p of pieces.slice(0, -1)) p.tieToNext = true;
    }
  }
  if (bar.length > 0) bars.push(bar);
  return bars;
}

/**
 * A melisma: one syllable sung over several notes. `start` = a note with a
 * lyric (`cleanTexText(lyric) !== undefined`), `end` = the last of the one
 * or more notes WITHOUT a lyric that directly follow it (a rest, a note
 * with a lyric or the end of the events ends it). Event indexes; always
 * `end > start`. Slurs are derived from these (see the spec comment).
 */
export interface Melisma {
  start: number;
  end: number;
}

const hasLyric = (e: MelodyEvent) =>
  e.kind === 'note' && cleanTexText(e.lyric) !== undefined;

/** The melismas of `events`, in order (see `Melisma`). */
export function melismas(events: readonly MelodyEvent[]): Melisma[] {
  const out: Melisma[] = [];
  for (let i = 0; i < events.length; i++) {
    if (!hasLyric(events[i])) continue;
    let j = i;
    while (
      j + 1 < events.length &&
      events[j + 1].kind === 'note' &&
      !hasLyric(events[j + 1])
    ) {
      j++;
    }
    if (j > i) out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

/** Where a written slur effect goes: `role` on that piece, melisma number `n` (1-based). */
export interface SlurMark {
  role: 'start' | 'end';
  n: number;
}

/**
 * Slur marks for `splitAtBars(events, ts)` output: the FIRST piece of each
 * melisma's start note gets `start`, the LAST piece (last tied piece) of
 * its end note gets `end`. Event indexes are counted from the pieces
 * themselves (first pieces), so repeated event objects are fine.
 */
export function slurMarks(
  bars: BarPiece[][],
  events: readonly MelodyEvent[],
): Map<BarPiece, SlurMark> {
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  melismas(events).forEach((m, k) => {
    starts.set(m.start, k + 1);
    ends.set(m.end, k + 1);
  });
  const out = new Map<BarPiece, SlurMark>();
  let ev = -1;
  for (const bar of bars) {
    for (const piece of bar) {
      if (!piece.isContinuation) ev++;
      if (piece.event.kind !== 'note') continue;
      const s = starts.get(ev);
      if (s !== undefined && !piece.isContinuation) {
        out.set(piece, { role: 'start', n: s });
      }
      const e = ends.get(ev);
      if (e !== undefined && !piece.tieToNext) {
        out.set(piece, { role: 'end', n: e });
      }
    }
  }
  return out;
}

/**
 * The slur id written for melisma `n` of the section labelled `label`:
 * `"<label>-<n>"`, or `"<n>"` for an empty label. alphaTab keeps slur ids
 * per staff (= per part), so ids must differ between the sections of a
 * part; the part's section labels make them unique. The label is cleaned
 * like lyric text (`cleanTexText`).
 */
export function slurId(label: string, n: number): string {
  const l = cleanTexText(label)?.trim();
  return l ? `${l}-${n}` : String(n);
}

/**
 * Real total length in ticks: a tuplet counts as its span
 * (`tupletDen(n) × unit`), not as the sum of its written slot lengths.
 * Throws RangeError on a broken tuplet group.
 */
export function totalTicks(events: readonly MelodyEvent[]): number {
  const groups = tupletGroups(events);
  if ('error' in groups) throw new RangeError(groups.error);
  const written = events.reduce((s, e) => s + e.ticks, 0);
  return groups.reduce((s, g) => s - g.n * g.unitTicks + g.span, written);
}

/**
 * Appends rests so the total fills whole bars (smallest rest first, plain
 * undotted values). Returns `events` itself when nothing is needed.
 * Tuplets count with their real length (`totalTicks`).
 */
export function padToFullBar(
  events: MelodyEvent[],
  ts: TimeSig,
): MelodyEvent[] {
  const size = barTicks(ts);
  const total = totalTicks(events);
  let missing = (size - (total % size)) % size;
  if (missing === 0) return events;
  const rests: MelodyEvent[] = [];
  for (const d of DURATIONS) {
    const t = DURATION_TICKS[d];
    while (missing >= t) {
      rests.push({ kind: 'rest', ticks: t });
      missing -= t;
    }
  }
  return [...events, ...rests.reverse()];
}

/**
 * Drum model (M5 T6) and the alphaTex SUBSET the drum editor reads/writes.
 * See docs/m5-plan.md 設計判断 3 and 4, docs/m5-alphatab-findings.md §3, §5,
 * §8; tuplets: tuplet.ts; the kit: drumKit.ts.
 *
 * ## Model
 *
 * One section of a drum part = a flat `DrumEvent[]` without bars (bars are
 * derived from the time signature, like the melody). One event = ONE
 * written beat:
 * - `hits` = the instruments struck together on that beat; EMPTY = a rest.
 *   Always in `DRUM_KIT` order (top of the staff first: CR HH HO RD T1 T2
 *   SD FT BD — `sortHits`), each instrument at most once, never HH and HO
 *   together (`toggleHit` drops the other one), and a hit is never ghost
 *   and accented at once (`setArticulation`).
 * - `ticks` (whole = 64) is ONE note value, optionally dotted
 *   (`ticksToDuration(ticks) !== null`: 64 48 32 24 16 12 8 6 4 2 — no
 *   dotted 32nd). Drums have no ties and rests never merge: what the editor
 *   holds is exactly what a round trip through the text gives back.
 * - `tuplet` as in tuplet.ts: n consecutive events marked `{ n, slot }`, all
 *   the same plain unit (2分〜32分), rests allowed; a group never crosses a
 *   barline (`groupsFitBars`; editors refuse edits that would make one).
 * - An edit that shifts later beats so that a beat crosses a barline is
 *   fixed by `normalizeDrums`: the beat is cut AT the barline into the
 *   struck beat + rests (docs/m5-plan.md 回答 Q5: not restored if a later
 *   delete moves it back). Shuffle is per SECTION (`Shuffle`), not per
 *   event, and does not change any written value.
 *
 * ## alphaTex subset (contract for serializeDrums (T11) / parseDrums (T12))
 *
 * Verified against alphaTab 1.8.4 `importer.AlphaTexImporter` (findings
 * §3, §8.1–8.3; drum.test.ts reads every golden fixture with it). The
 * instrument names are the project's `\articulation` aliases (= `DrumKitEntry
 * .id`), which `partsToAlphaTex` declares for display; they are not stored in
 * the text. "Section body" = the lines after one `\section "Label"` line, as
 * for the melody (the `\section` line itself is handled by the part code).
 *
 * ### Writing (serializeDrums(events, shuffle, ts) → section body)
 *
 * 1. No events → '' (no lines at all, not even `\tf`: the shuffle choice is
 *    void until the section has a beat).
 * 2. Otherwise the FIRST line is always `\tf <v>` with `<v>` =
 *    `SHUFFLE_TEX[shuffle]` (`none` | `triplet8th` | `triplet16th`) —
 *    written even for `none`, because alphaTab carries `\tf` over into the
 *    following bars (and sections), so each section must state its own.
 * 3. Then `drumBars(events, ts)`: one bar per line, each line ends with
 *    ` |` (also the last one), lines joined with `\n`, no trailing newline.
 *    The events must already be normalized (`normalizeDrums`); the last bar
 *    may be short and is NOT padded.
 * 4. Beats are separated by one space. Each beat:
 *      `[:N ]<body>[{beat effects}]`
 *    - `:N` (N = '1'|'2'|'4'|'8'|'16'|'32', the beat's undotted value) is
 *      written when it differs from the previous beat's N in this section —
 *      and ALWAYS before the section's first beat (a bare note right after
 *      `\section "A"` / `\tf …` would be swallowed or default to a quarter;
 *      findings §8.3, §8.5). The dot does not take part in the comparison.
 *    - `<body>`: a rest is `r` (lowercase; `R` would be read as an
 *      instrument name). One hit is the bare name `SD`. Two or more hits are
 *      `(HH BD)`: names in `DRUM_KIT` order, one space apart, in parens.
 *    - Note effects go DIRECTLY after the instrument name they belong to
 *      (inside the parens for a chord): `{g}` ghost, `{ac}` accent,
 *      `{hac}` heavy accent — at most one per hit. E.g. `SD{g}`,
 *      `(HH{ac} BD)`, `(HH SD{g})`.
 *    - Beat effects, in this order: `d` (dotted), `tu N` (`tupletTex(n)`:
 *      `tu N`, or `tu N D` for 13/14/15). `tu` is written on EVERY slot of a
 *      tuplet, rests included (alphaTab has no group start/end marker).
 *      Never `d` with `tu` (slots are undotted).
 *      - Single hit: note and beat effects share ONE pair of braces after
 *        the name, note effect first: `SD{g d}`, `SD{g tu 6}`, `HH{tu 3}`.
 *        (No `.N` is ever written, so alphaTab accepts both kinds in one
 *        `{}`; findings §8.1.)
 *      - Chord: beat effects in their own braces right after `)`:
 *        `(HH BD){d}`, `(HH SD{g}){tu 3}`.
 *      - Rest: `r{d}`, `r{tu 3}`.
 *      Braces are omitted when empty.
 *    Example (4/4, shuffle 8; an accented backbeat, then a 16th sextuplet
 *    with a ghost note and a heavy-accent crash):
 *      \tf triplet8th
 *      :8 (HH BD) HH (HH SD{ac}) HH (HH BD) (HH BD) (HH SD) HH |
 *      :16 SD{g tu 6} SD{tu 6} SD{tu 6} SD{tu 6} r{tu 6} (SD BD){tu 6} :4 CR{hac} r r |
 *    Golden data: src/lib/fixtures/drumFixtures.ts.
 *
 * ### Reading (parseDrums(body, ts) → { events, shuffle } | read-only)
 *
 * Strict, like parseMelody: anything outside this language makes the
 * section read-only and its text is never rewritten.
 * - Optional first statement `\tf <v>`, before any beat (blank lines before
 *   it are fine). `<v>` may be any alphaTab spelling of none / triplet 8th /
 *   triplet 16th: `none` `no` `notripletfeel` `0`, `triplet8th` `t8`
 *   `triplet-8th` `2`, `triplet16th` `t16` `triplet-16th` `1`
 *   (case-insensitive) → `'none' | '8' | '16'`. Other feels (dotted /
 *   scottish, 3–6) → read-only. No `\tf` → shuffle `'none'` (the next write
 *   adds `\tf none`). A `\tf` anywhere else, or any other `\` command
 *   inside the section → read-only.
 * - Tokens are separated by whitespace; line breaks carry no meaning.
 *   Kinds: `|` (end of bar), `:N` (N in 1 2 4 8 16 32), and a beat.
 * - Beat = `<body>[.N][{beat effects}]` where `<body>` is `r`, `NAME[{note
 *   effect}]` or `(NAME[{note effect}] NAME[{…}] …)` (one or more names,
 *   whitespace-separated inside the parens; `(SD)` reads as one hit).
 *   For a bare single name WITHOUT `.N`, its one `{}` may mix the note
 *   effect and beat effects in any order (`SD{tu 6 g}`); everywhere else
 *   (after `.N`, after `)`, after `r`) the trailing `{}` holds beat effects
 *   only (`SD{g}.8{tu 3}` and `SD.8{tu 3}` are fine, `SD.8{g}` is not —
 *   alphaTab itself rejects it).
 *   - NAME is a `DRUM_KIT` id, exactly (case-sensitive).
 *   - Note effects: `g`, `ac`, `hac`, at most one per hit.
 *   - Beat effects: `d`, `tu N` / `tu N D` (`parseTupletItem`), each at
 *     most once, any order.
 *   - Hits may come in any order; they are sorted (`sortHits`), so the next
 *     write normalizes the order.
 * - `.N` glued to the body sets this beat's value and the running value
 *   (sticky, exactly like `:N`). The first beat must have `:N` before it or
 *   `.N` on it. Written back as `:N`.
 * - Read-only: a name not in `DRUM_KIT`, `R`, the same instrument twice in
 *   one beat, HH with HO, ghost with an accent on one hit (`{g ac}`), `t`,
 *   `lyrics` / `ch` / `slur`, any other effect (including flam-like `{gr}`
 *   and `ten`), a dotted 32nd, comments, empty bars (`| |`), bar lengths
 *   that do not fit (every bar but the last = `barTicks(ts)`, the last ≤;
 *   reported as `barMismatch` like the melody, so the editor can offer to
 *   re-bar), and tuplets breaking tuplet.ts's rules (`{tu N}` beats are
 *   grouped n at a time; fewer than n, mixed N or values, dotted slots,
 *   invalid N, D ≠ `tupletDen(N)`, or a `|` inside a group).
 * - A part whose preamble redefines one of the 9 aliases with another
 *   `\articulation` number is read-only as a whole (part code, T17).
 *
 * Round trip: for normalized events (`normalizeDrums` changes nothing,
 * groups fit their bars, hits sorted and valid),
 * `parseDrums(serializeDrums(events, shuffle, ts), ts)` deep-equals
 * `{ events, shuffle }` (empty events: shuffle reads back as 'none').
 */

import { DRUM_KIT, type DrumInstrument } from './drumKit';
import {
  barTicks,
  decompose,
  durationTicks,
  ticksToDuration,
  type TimeSig,
} from './melody';
import { atoms, type TupletMark } from './tuplet';

export interface DrumHit {
  inst: DrumInstrument;
  ghost?: true;
  accent?: 'normal' | 'heavy';
}

export interface DrumEvent {
  /** Sorted in `DRUM_KIT` order; empty = rest. */
  hits: DrumHit[];
  /** One (optionally dotted) note value; the written value in a tuplet. */
  ticks: number;
  tuplet?: TupletMark;
}

/** Shuffle (triplet feel) of one section. */
export type Shuffle = 'none' | '8' | '16';

/** The canonical `\tf` value written for each shuffle. */
export const SHUFFLE_TEX: Readonly<Record<Shuffle, string>> = {
  none: 'none',
  '8': 'triplet8th',
  '16': 'triplet16th',
};

/** What a hit sounds like: plain, ghost, accent or heavy accent. */
export type Articulation = 'none' | 'ghost' | 'accent' | 'heavy';

const ORDER: ReadonlyMap<DrumInstrument, number> = new Map(
  DRUM_KIT.map((e, i) => [e.id, i]),
);

export function isDrumRest(ev: DrumEvent): boolean {
  return ev.hits.length === 0;
}

/** A writable drum event length: one note value, optionally dotted. */
export function isValidDrumTicks(ticks: number): boolean {
  return ticksToDuration(ticks) !== null;
}

/** A copy of `hits` in `DRUM_KIT` order (top of the staff first). */
export function sortHits(hits: readonly DrumHit[]): DrumHit[] {
  return [...hits].sort((a, b) => ORDER.get(a.inst)! - ORDER.get(b.inst)!);
}

export function hasHit(ev: DrumEvent, inst: DrumInstrument): boolean {
  return ev.hits.some((h) => h.inst === inst);
}

/**
 * Adds `inst` to the beat (plain, no articulation) or removes it if present.
 * Adding HH removes HO and vice versa. Removing the last hit makes the beat
 * a rest. `ticks` / `tuplet` are kept. Never mutates the input.
 */
export function toggleHit(ev: DrumEvent, inst: DrumInstrument): DrumEvent {
  if (hasHit(ev, inst)) {
    return { ...ev, hits: ev.hits.filter((h) => h.inst !== inst) };
  }
  const other = inst === 'HH' ? 'HO' : inst === 'HO' ? 'HH' : null;
  const kept = ev.hits.filter((h) => h.inst !== other);
  return { ...ev, hits: sortHits([...kept, { inst }]) };
}

export function articulationOf(hit: DrumHit): Articulation {
  if (hit.ghost) return 'ghost';
  if (hit.accent === 'heavy') return 'heavy';
  if (hit.accent === 'normal') return 'accent';
  return 'none';
}

/**
 * Sets the articulation of `inst`'s hit; ghost and accent exclude each other
 * (setting one clears the other, 'none' clears both). Returns `ev` itself
 * when `inst` is not on the beat. Never mutates the input.
 */
export function setArticulation(
  ev: DrumEvent,
  inst: DrumInstrument,
  art: Articulation,
): DrumEvent {
  if (!hasHit(ev, inst)) return ev;
  const hits = ev.hits.map((h): DrumHit => {
    if (h.inst !== inst) return h;
    switch (art) {
      case 'ghost':
        return { inst, ghost: true };
      case 'accent':
        return { inst, accent: 'normal' };
      case 'heavy':
        return { inst, accent: 'heavy' };
      default:
        return { inst };
    }
  });
  return { ...ev, hits };
}

const rest = (ticks: number): DrumEvent => ({ hits: [], ticks });

const valueTicks = (ticks: number): number[] =>
  decompose(ticks).map((v) => durationTicks(v.d, v.dotted));

/**
 * Makes every untupleted beat writable as one note value inside one bar,
 * laying events from the start of the first bar: a beat that crosses a
 * barline is cut AT the barline — the beat itself (hits kept) gets the
 * length up to the barline, and rests fill the rest, bar by bar. A length
 * that is not one note value (only possible after such a cut, or for a
 * bad caller value) is likewise written as the beat + rests, largest value
 * first (`decompose`). Tuplet groups are never touched, even if one
 * crosses a barline (refuse that upstream with `groupsFitBars`; cutting
 * singles never moves a group, so the order of the two checks is free).
 *
 * `map[i]` = output index of input event `i` (the struck part of a cut
 * beat). A cursor position `c` (0..length) maps to `map[c]`, or to the new
 * length when `c === input.length`. Returns the input array itself and the
 * identity map when nothing changes. Never mutates the input.
 * Throws RangeError on a broken tuplet group, ticks that are not a
 * positive even integer, or an unsupported time signature.
 */
export function normalizeDrums(
  input: readonly DrumEvent[],
  ts: TimeSig,
): { events: DrumEvent[]; map: number[] } {
  const bar = barTicks(ts);
  const events: DrumEvent[] = [];
  const map: number[] = new Array<number>(input.length);
  let changed = false;
  let pos = 0;
  for (const a of atoms(input)) {
    if (a.kind === 'group') {
      for (let i = a.group.start; i < a.group.end; i++) {
        map[i] = events.length;
        events.push(input[i]);
      }
      pos += a.group.span;
      continue;
    }
    const ev = input[a.index];
    map[a.index] = events.length;
    const room = bar - (pos % bar);
    if (ev.ticks <= room && isValidDrumTicks(ev.ticks)) {
      events.push(ev);
      pos += ev.ticks;
      continue;
    }
    changed = true;
    // Chunks of the beat's length per bar: up to the barline, then bars.
    const chunks: number[] = [];
    let left = ev.ticks;
    let r = room;
    while (left > 0) {
      const c = Math.min(left, r);
      chunks.push(c);
      left -= c;
      r = bar;
    }
    const lengths = chunks.flatMap(valueTicks);
    events.push({ ...ev, ticks: lengths[0] });
    for (const t of lengths.slice(1)) events.push(rest(t));
    pos += ev.ticks;
  }
  if (!changed) {
    return { events: input as DrumEvent[], map: input.map((_, i) => i) };
  }
  return { events, map };
}

/** One bar of a normalized section: events [start, end). */
export interface DrumBar {
  start: number;
  /** Exclusive. */
  end: number;
  /** Real length filled (= barTicks except possibly in the last bar). */
  ticks: number;
}

/**
 * Splits normalized events into bars (a tuplet group counts as its span).
 * No events → []. The last bar may be short. Throws RangeError when a beat
 * or a tuplet group crosses a barline (run `normalizeDrums` /
 * `groupsFitBars` first), or on a broken group.
 */
export function drumBars(events: readonly DrumEvent[], ts: TimeSig): DrumBar[] {
  const bar = barTicks(ts);
  const bars: DrumBar[] = [];
  let cur: DrumBar | null = null;
  for (const a of atoms(events)) {
    const [start, end, len] =
      a.kind === 'group'
        ? [a.group.start, a.group.end, a.group.span]
        : [a.index, a.index + 1, a.ticks];
    if (!cur) {
      cur = { start, end: start, ticks: 0 };
      bars.push(cur);
    }
    if (cur.ticks + len > bar) {
      throw new RangeError(
        `event ${start} crosses the barline after bar ${bars.length}`,
      );
    }
    cur.end = end;
    cur.ticks += len;
    if (cur.ticks === bar) cur = null;
  }
  return bars;
}

/**
 * Tuplets shared by the melody and drum editors (M5, docs/m5-plan.md 設計判断 1).
 *
 * Representation: events stay a flat array. Each event inside a tuplet
 * carries `tuplet: { n, slot }`; one tuplet = n consecutive marked events with
 * slots 0..n-1 in order, all with the same written length (`ticks`, a plain
 * undotted unit from TUPLET_UNITS). Rests are allowed inside.
 *
 * Length: the group's real length (span) is `tupletDen(n) × unitTicks`, which
 * is always an integer number of ticks, so bar arithmetic works per group.
 * Only drawing needs the fractional position of a single slot (`slotOffset`).
 *
 * alphaTex: every beat of the group carries `{tu N}` (or `{tu N D}` when
 * alphaTab has no default denominator for N); see `tupletTex`.
 */

import { DURATION_TICKS, type Duration } from './melody';

export interface TupletMark {
  n: number;
  /** 0..n-1 */
  slot: number;
}

/** Anything with a written length that may be part of a tuplet. */
export interface Timed {
  ticks: number;
  tuplet?: TupletMark;
}

/** The tuplet button's fixed choices; "other" accepts any `isValidTupletN`. */
export const TUPLET_PRESETS: readonly number[] = [3, 5, 6, 7];

/** Note values a tuplet's slots may have (undotted). */
export const TUPLET_UNITS: readonly Duration[] = ['2', '4', '8', '16', '32'];

const MIN_N = 3;
const MAX_N = 15;

/** N values for which alphaTab's one-argument `{tu N}` has a default denominator. */
const ALPHATAB_DEFAULT_N: readonly number[] = [3, 5, 6, 7, 9, 10, 11, 12];

/** 3..15 except 4 and 8 (those would be plain notes of a power-of-two length). */
export function isValidTupletN(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_N && n <= MAX_N && n !== 4 && n !== 8;
}

/**
 * The largest power of two below n: 3→2, 5..7→4, 9..15→8.
 * Throws RangeError unless n is an integer ≥ 2.
 */
export function tupletDen(n: number): number {
  if (!Number.isInteger(n) || n < 2) {
    throw new RangeError(`invalid tuplet n: ${n}`);
  }
  let d = 1;
  while (d * 2 < n) d *= 2;
  return d;
}

/** The alphaTex beat effect: 'tu 3', or 'tu 13 8' when alphaTab has no default. */
export function tupletTex(n: number): string {
  if (!isValidTupletN(n)) throw new RangeError(`invalid tuplet n: ${n}`);
  return ALPHATAB_DEFAULT_N.includes(n) ? `tu ${n}` : `tu ${n} ${tupletDen(n)}`;
}

/**
 * Validates the arguments of a `tu` beat effect (the tokens after `tu`):
 * `['3']` or `['13', '8']`. The denominator, when given, must equal
 * `tupletDen(n)`. The single-argument form (no denominator) is only valid
 * for the N values alphaTab itself accepts without one (`ALPHATAB_DEFAULT_N`)
 * — verified against alphaTab 1.8.4's `AlphaTexImporter` (docs/m5-review.md
 * R3): `{tu 13}`/`{tu 14}`/`{tu 15}` with no denominator fail to import and
 * take down the whole document, so those three are read-only unless the
 * text spells out the denominator (`{tu 13 8}`).
 */
export function parseTupletItem(
  args: string[],
): { n: number } | { error: string } {
  if (args.length < 1 || args.length > 2) {
    return { error: '連符（tu）の数の書き方が正しくありません' };
  }
  if (!args.every((a) => /^\d+$/.test(a))) {
    return { error: `連符（tu ${args.join(' ')}）の数が整数ではありません` };
  }
  const n = Number(args[0]);
  if (!isValidTupletN(n)) {
    return {
      error: `${n} 連符は扱えません（3〜15、4 と 8 を除く）`,
    };
  }
  if (args.length === 1 && !ALPHATAB_DEFAULT_N.includes(n)) {
    return {
      error: `${n} 連符は分母を書いてください（例：{tu ${n} ${tupletDen(n)}}）`,
    };
  }
  if (args.length === 2 && Number(args[1]) !== tupletDen(n)) {
    return {
      error: `${n} 連符の分母 ${args[1]} は扱えません（${tupletDen(n)} のみ）`,
    };
  }
  return { n };
}

/** One well-formed tuplet: events [start, end) with end = start + n. */
export interface TupletGroup {
  start: number;
  /** Exclusive. */
  end: number;
  n: number;
  /** Written length of each slot. */
  unitTicks: number;
  /** Real length of the whole group: tupletDen(n) × unitTicks. */
  span: number;
}

/**
 * Tick lengths of TUPLET_UNITS. Computed on call, not at module load:
 * melody.ts imports this module's functions, so a module-level use of
 * `DURATION_TICKS` here would hit the import cycle before melody.ts is
 * initialized.
 */
const unitTicksList = (): number[] =>
  TUPLET_UNITS.map((d) => DURATION_TICKS[d]);

/**
 * All tuplet groups in order, or the first structural error (Japanese) when a
 * marked run is broken: a slot out of order, a run cut short, mixed n or
 * lengths, an invalid n or a slot length that is not a plain unit.
 */
export function tupletGroups(
  events: readonly Timed[],
): TupletGroup[] | { error: string } {
  const groups: TupletGroup[] = [];
  let i = 0;
  while (i < events.length) {
    const first = events[i].tuplet;
    if (!first) {
      i++;
      continue;
    }
    const at = `${i + 1} 番目の拍`;
    const { n } = first;
    if (!isValidTupletN(n)) {
      return { error: `${at}: ${n} 連符は扱えません（3〜15、4 と 8 を除く）` };
    }
    if (first.slot !== 0) {
      return { error: `${at}: 連符の途中から始まっています` };
    }
    const unitTicks = events[i].ticks;
    if (!unitTicksList().includes(unitTicks)) {
      return {
        error: `${at}: 連符の中の音価は付点なしの 2分〜32分だけです`,
      };
    }
    for (let k = 1; k < n; k++) {
      const e = events[i + k];
      const here = `${i + k + 1} 番目の拍`;
      if (!e || !e.tuplet || e.tuplet.slot === 0) {
        return {
          error: `${at}: ${n} 連符の音が ${k} 個しかありません`,
        };
      }
      if (e.tuplet.n !== n) {
        return { error: `${here}: 連符の数が途中で変わっています` };
      }
      if (e.tuplet.slot !== k) {
        return { error: `${here}: 連符の音の順番が正しくありません` };
      }
      if (e.ticks !== unitTicks) {
        return { error: `${here}: 連符の中の音価がそろっていません` };
      }
    }
    groups.push({
      start: i,
      end: i + n,
      n,
      unitTicks,
      span: tupletDen(n) * unitTicks,
    });
    i += n;
  }
  return groups;
}

export type Atom =
  | { kind: 'single'; index: number; ticks: number }
  | { kind: 'group'; group: TupletGroup };

function groupsOrThrow(events: readonly Timed[]): TupletGroup[] {
  const groups = tupletGroups(events);
  if ('error' in groups) throw new RangeError(groups.error);
  return groups;
}

/**
 * The events as indivisible time units: each untupleted event alone, each
 * tuplet as one group. Throws RangeError on a broken group.
 */
export function atoms(events: readonly Timed[]): Atom[] {
  const groups = groupsOrThrow(events);
  const out: Atom[] = [];
  let g = 0;
  let i = 0;
  while (i < events.length) {
    if (g < groups.length && groups[g].start === i) {
      out.push({ kind: 'group', group: groups[g] });
      i = groups[g].end;
      g++;
    } else {
      out.push({ kind: 'single', index: i, ticks: events[i].ticks });
      i++;
    }
  }
  return out;
}

/**
 * The group containing event `index`, or null.
 * Throws RangeError on a broken group.
 */
export function groupAt(
  events: readonly Timed[],
  index: number,
): TupletGroup | null {
  return (
    groupsOrThrow(events).find((g) => g.start <= index && index < g.end) ?? null
  );
}

/**
 * The group whose slot at `cursor` (a position between events, 0..length)
 * should be overwritten instead of inserting there ("埋める動作"):
 * - the cursor is strictly inside a group (start < cursor < end), or
 * - the cursor is at a group's start and every slot is still a rest.
 * Otherwise null (insert normally). Throws RangeError on a broken group.
 */
export function fillZone(
  events: readonly Timed[],
  cursor: number,
  isRest: (i: number) => boolean,
): TupletGroup | null {
  for (const g of groupsOrThrow(events)) {
    if (g.start < cursor && cursor < g.end) return g;
    if (g.start === cursor) {
      for (let i = g.start; i < g.end; i++) {
        if (!isRest(i)) return null;
      }
      return g;
    }
  }
  return null;
}

/**
 * Inserts an n-tuplet of rests of `unit` at position `at` (0..length).
 * Refuses (Japanese reason) an invalid n or unit, or a position inside a
 * group. Does not check bars; run `groupsFitBars` on the result.
 * Throws RangeError on a broken group or `at` out of range.
 */
export function insertGroup<T extends Timed>(
  events: readonly T[],
  at: number,
  n: number,
  unit: Duration,
  makeRest: (ticks: number, mark: TupletMark) => T,
): T[] | { error: string } {
  if (!Number.isInteger(at) || at < 0 || at > events.length) {
    throw new RangeError(`insert position out of range: ${at}`);
  }
  if (!isValidTupletN(n)) {
    return { error: `${n} 連符は作れません（3〜15、4 と 8 を除く）` };
  }
  if (!TUPLET_UNITS.includes(unit)) {
    return { error: '連符の単位は 2分〜32分の音符だけです' };
  }
  if (groupsOrThrow(events).some((g) => g.start < at && at < g.end)) {
    return { error: '連符の中に連符は入れられません' };
  }
  const ticks = DURATION_TICKS[unit];
  const rests = Array.from({ length: n }, (_, slot) =>
    makeRest(ticks, { n, slot }),
  );
  return [...events.slice(0, at), ...rests, ...events.slice(at)];
}

/**
 * Removes the whole group containing event `index`; `start` is where it was
 * (the natural cursor position afterwards). Throws RangeError when `index`
 * is not inside a group or a group is broken.
 */
export function removeGroup<T extends Timed>(
  events: readonly T[],
  index: number,
): { events: T[]; start: number } {
  const g = groupAt(events, index);
  if (!g) throw new RangeError(`no tuplet at index ${index}`);
  return {
    events: [...events.slice(0, g.start), ...events.slice(g.end)],
    start: g.start,
  };
}

/**
 * Whether every tuplet lies within one bar, laying events from the start of
 * the first bar (singles may cross barlines; callers tie/split those).
 * Broken groups are reported as not ok. Throws RangeError unless `barTicks`
 * is a positive integer.
 */
export function groupsFitBars(
  events: readonly Timed[],
  barTicks: number,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(barTicks) || barTicks <= 0) {
    throw new RangeError(`invalid bar length: ${barTicks}`);
  }
  const groups = tupletGroups(events);
  if ('error' in groups) return { ok: false, error: groups.error };
  let pos = 0;
  for (const a of atoms(events)) {
    if (a.kind === 'single') {
      pos += a.ticks;
      continue;
    }
    const { span, n } = a.group;
    if ((pos % barTicks) + span > barTicks) {
      const bar = Math.floor(pos / barTicks) + 1;
      return {
        ok: false,
        error: `${bar} 小節目の ${n} 連符が小節線をまたぎます`,
      };
    }
    pos += span;
  }
  return { ok: true };
}

/**
 * Real position of `slot` (0..n; n = the group's end) from the group's start,
 * in ticks; fractional in general (drawing only).
 */
export function slotOffset(group: TupletGroup, slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot > group.n) {
    throw new RangeError(`slot out of range: ${slot}`);
  }
  return (slot * group.span) / group.n;
}

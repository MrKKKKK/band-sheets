import { graphemes, lineLyrics } from './chartEdit';
import { parseTimeSignature } from './partsToAlphaTex';
import { isRawLine } from './song';
import type { ChartLine, LyricLine } from './song';

/**
 * Dash notation for chord-only chart lines (docs/audio-integration-plan.md
 * §3.6, user decisions 2026-10-18):
 *
 *   |[C]--------|[C]----[F]----|[G]--------|[G]----[G7]----|     (4/4)
 *
 * After a `[Chord]`, every `-` is one eighth note and every `=` one sixteenth
 * note; ONLY the dashes count (the chord name has no length). `|` separates
 * bars, spaces are ignored, leading / trailing `|` are optional. A bar's
 * dash total must equal the meter, unless no chord of the bar has any dash:
 * then the bar is split equally among its chords. Dashes at the start of a
 * bar (before its first chord) continue the previous bar's last chord.
 *
 * Lengths here are in SIXTEENTHS (`-` = 2, `=` = 1).
 */

/** Time signature, e.g. 4/4 → { num: 4, den: 4 }. */
export interface DashMeter {
  num: number;
  den: number;
}

/**
 * Meter of `{time: n/d}`: the app's `parseTimeSignature` (same as the viewer
 * and auto-scroll), 4/4 when missing, invalid, or not a whole number of
 * sixteenths per bar.
 */
export function meterOf(time: string | undefined): DashMeter {
  const ts = parseTimeSignature(time);
  const meter = ts ? { num: ts[0], den: ts[1] } : { num: 4, den: 4 };
  return barUnits(meter) === null ? { num: 4, den: 4 } : meter;
}

/** Sixteenths per bar of `ts`, or null when not a whole number (>0). */
export function barUnits(ts: DashMeter): number | null {
  const { num, den } = ts;
  if (!Number.isInteger(num) || !Number.isInteger(den)) return null;
  if (num <= 0 || den <= 0 || 16 % den !== 0) return null;
  return (num * 16) / den;
}

export interface DashChord {
  chord: string;
  /** Sixteenths from the start of the bar. */
  start: number;
  /** Sixteenths. */
  length: number;
}

export interface DashBar {
  /** Sixteenths at the start of the bar that continue the previous chord. */
  leading: number;
  chords: DashChord[];
}

/** A dash line is a chart line whose non-chord text is only `| - =` / spaces and has a `|`. */
export function isDashLine(line: ChartLine): boolean {
  if (isRawLine(line)) return false;
  const text = lineLyrics(line);
  return /^[\s|\-=]*$/.test(text) && text.includes('|');
}

const FULL_WIDTH_DASH: Record<string, string> = {
  '｜': '|',
  ー: '-',
  '－': '-',
  '—': '-',
  '＝': '=',
};
const FULL_WIDTH_DASH_RE = new RegExp(
  `[${Object.keys(FULL_WIDTH_DASH).join('')}]`,
  'g',
);

const toHalfWidth = (text: string): string =>
  text.replace(FULL_WIDTH_DASH_RE, (c) => FULL_WIDTH_DASH[c]);

/**
 * True when the line is not a dash line yet, but would be one if its
 * full-width symbols (｜ ー － — ＝) were half-width (`|` `-` `=`). A lyric
 * line that merely contains 「ー」 does not count: after the conversion the
 * non-chord text must be only `| - =` / spaces and contain a `|`.
 */
export function fullWidthDashCandidate(line: ChartLine): boolean {
  if (isRawLine(line) || isDashLine(line)) return false;
  return isDashLine(toHalfWidthDashLine(line));
}

/**
 * The line with ｜ ー － — ＝ turned into `| - =` (lyrics only; chord names
 * are untouched). Raw lines are returned as they are. The caller decides
 * whether the line should be converted (`fullWidthDashCandidate`).
 */
export function toHalfWidthDashLine(line: ChartLine): ChartLine {
  if (isRawLine(line)) return line;
  return {
    ...line,
    segments: line.segments.map((seg) => ({
      ...seg,
      lyrics: toHalfWidth(seg.lyrics),
    })),
  };
}

interface ScanBar {
  leading: number;
  chords: { chord: string; units: number }[];
}

/** Splits a dash line into bars (empty bars dropped); no meter needed. */
function scan(line: LyricLine): ScanBar[] {
  const bars: ScanBar[] = [];
  let cur: ScanBar = { leading: 0, chords: [] };
  const flush = () => {
    if (cur.leading > 0 || cur.chords.length > 0) bars.push(cur);
    cur = { leading: 0, chords: [] };
  };
  const add = (units: number) => {
    const last = cur.chords[cur.chords.length - 1];
    if (last) last.units += units;
    else cur.leading += units;
  };
  for (const seg of line.segments) {
    if (seg.chord !== undefined)
      cur.chords.push({ chord: seg.chord, units: 0 });
    for (const c of graphemes(seg.lyrics)) {
      if (c === '|') flush();
      else if (c === '-') add(2);
      else if (c === '=') add(1);
    }
  }
  flush();
  return bars;
}

/** Number of bars of a dash line (bars with content between `|`). */
export function dashBarCount(line: ChartLine): number {
  return isRawLine(line) ? 0 : scan(line).length;
}

const fmt8 = (units: number): string => String(units / 2);

export interface DashParseResult {
  bars: DashBar[];
  /** Japanese messages; empty when the line is valid. */
  errors: string[];
}

/** Reads a dash line in meter `ts`. `bars` is best-effort when `errors` is not empty. */
export function parseDashLine(line: LyricLine, ts: DashMeter): DashParseResult {
  const total = barUnits(ts);
  const errors: string[] = [];
  if (total === null) {
    return {
      bars: [],
      errors: [`拍子 ${ts.num}/${ts.den} はダッシュ記法に対応していません`],
    };
  }
  const bars = scan(line).map((raw, i): DashBar => {
    const n = i + 1;
    const sum = raw.leading + raw.chords.reduce((s, c) => s + c.units, 0);
    const dashless =
      raw.leading === 0 && raw.chords.every((c) => c.units === 0);
    const chords: DashChord[] = [];
    if (dashless) {
      const k = raw.chords.length;
      raw.chords.forEach((c, j) => {
        const start = Math.round((j * total) / k);
        const end = Math.round(((j + 1) * total) / k);
        chords.push({ chord: c.chord, start, length: end - start });
      });
    } else {
      let pos = raw.leading;
      for (const c of raw.chords) {
        chords.push({ chord: c.chord, start: pos, length: c.units });
        pos += c.units;
      }
      if (sum !== total) {
        errors.push(
          `${n}小節目: ダッシュの合計が八分音符 ${fmt8(sum)} 個ぶんです（${ts.num}/${ts.den} は ${fmt8(total)} 個ぶん）`,
        );
      } else {
        for (const c of raw.chords) {
          if (c.units === 0)
            errors.push(
              `${n}小節目: [${c.chord}] にダッシュがありません（ほかのコードにはあります）`,
            );
        }
      }
    }
    return { leading: raw.leading, chords };
  });
  return { bars, errors };
}

/** Errors of a dash line in meter `ts` (Japanese, one per problem). */
export function validateDashLine(line: LyricLine, ts: DashMeter): string[] {
  return parseDashLine(line, ts).errors;
}

/** One chord as given by a producer (e.g. the audio import): any real-valued position. */
export interface DashChordInput {
  chord: string;
  /** Sixteenths from the start of the bar (snapped to the grid). */
  start: number;
  /**
   * Sixteenths. Informational: the written length always runs to the next
   * chord (or the end of the bar), so there are no gaps.
   */
  length?: number;
}

/** Name used for a bar with no chord. */
export const NO_CHORD = 'N.C.';

/** `-` per eighth, a trailing `=` for an odd sixteenth (the writer's form). */
export function dashes(units: number): string {
  return '-'.repeat(Math.floor(units / 2)) + (units % 2 === 1 ? '=' : '');
}

interface WrittenBar {
  text: string;
  /** Chord sounding at the end of the bar (carried into the next bar). */
  last: string;
  /** A chord that snapped to the very end of the bar, if any. */
  overflow?: string;
}

function layoutBar(
  chords: readonly DashChordInput[],
  total: number,
  carry: string | undefined,
): WrittenBar {
  const snapped = chords.map((c, i) => {
    if (!Number.isFinite(c.start))
      throw new Error(`invalid chord start: ${c.start}`);
    return {
      chord: c.chord,
      start: Math.min(total, Math.max(0, Math.round(c.start))),
      i,
    };
  });
  if (snapped.length === 0)
    return { text: `[${NO_CHORD}]${dashes(total)}`, last: NO_CHORD };
  snapped.sort((a, b) => a.start - b.start || a.i - b.i);
  const overflow = snapped.find((c) => c.start === total)?.chord;
  // Zero-length chords (same snapped start as the next one, or at the end).
  const kept = snapped.filter(
    (c, k) => c.start < total && snapped[k + 1]?.start !== c.start,
  );
  if (kept.length === 0)
    return { text: `[${NO_CHORD}]${dashes(total)}`, last: NO_CHORD };
  if (kept[0].start > 0 && carry !== undefined)
    kept.unshift({ chord: carry, start: 0, i: -1 });
  else kept[0] = { ...kept[0], start: 0 };
  const merged: { chord: string; start: number }[] = [];
  for (const c of kept)
    if (merged[merged.length - 1]?.chord !== c.chord) merged.push(c);
  const text = merged
    .map((c, k) => {
      const end = merged[k + 1]?.start ?? total;
      return `[${c.chord}]${dashes(end - c.start)}`;
    })
    .join('');
  return { text, last: merged[merged.length - 1].chord, overflow };
}

function writeBars(
  bars: readonly (readonly DashChordInput[])[],
  ts: DashMeter,
  carry: string | undefined,
): { texts: string[]; carry: string | undefined } {
  const total = barUnits(ts);
  if (total === null) throw new Error(`unsupported meter ${ts.num}/${ts.den}`);
  const texts: string[] = [];
  let prev = carry;
  for (const bar of bars) {
    const w = layoutBar(bar, total, prev);
    texts.push(w.text);
    prev = w.overflow ?? w.last;
  }
  return { texts, carry: prev };
}

/**
 * Text of one bar (no `|`). Contract (also for `writeDashLine` /
 * `writeDashChart`, which are what T3 should call):
 * - Chord positions are snapped to the sixteenth grid; chords snapped to the
 *   same sixteenth collapse (the earlier one has length 0 and is dropped),
 *   equal neighbours merge. `length` is ignored: each chord runs to the next.
 * - A bar always starts with a chord. If the first chord starts after 0, the
 *   `carry` chord (the previous bar's last sounding chord) is written at 0;
 *   without `carry` (the very first bar) the first chord is moved to 0.
 * - A chord that snaps to the end of the bar is not written here;
 *   `writeDashChart` carries it into the next bar's position 0.
 * - A bar with no chords is silence: `[N.C.]` over the whole bar.
 * Callers validate input: a non-finite `start` throws, and chord names must
 * not contain `[` or `]` (they would break the output).
 */
export function writeDashBar(
  chords: readonly DashChordInput[],
  ts: DashMeter,
  carry?: string,
): string {
  return writeBars([chords], ts, carry).texts[0];
}

/** `|bar|bar|…|` for the given bars (see `writeDashBar` for the contract). */
export function writeDashLine(
  bars: readonly (readonly DashChordInput[])[],
  ts: DashMeter,
  carry?: string,
): string {
  return `|${writeBars(bars, ts, carry).texts.join('|')}|`;
}

/**
 * Splits bars into lines of `barsPerLine` (default 4; the last may be
 * shorter), carrying chords across bars and lines as in `writeDashBar`.
 */
export function writeDashChart(
  bars: readonly (readonly DashChordInput[])[],
  ts: DashMeter,
  barsPerLine = 4,
): string[] {
  const lines: string[] = [];
  let carry: string | undefined;
  for (let i = 0; i < bars.length; i += barsPerLine) {
    const w = writeBars(bars.slice(i, i + barsPerLine), ts, carry);
    carry = w.carry;
    lines.push(`|${w.texts.join('|')}|`);
  }
  return lines;
}

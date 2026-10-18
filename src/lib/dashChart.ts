import { graphemes, lineLyrics } from './chartEdit';
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

function dashes(units: number): string {
  return '-'.repeat(Math.floor(units / 2)) + (units % 2 === 1 ? '=' : '');
}

/**
 * Text of one bar (no `|`). Starts at a chord: the first chord is moved to
 * the bar start; chords snapped to the same sixteenth collapse (the earlier
 * one has length 0 and is merged into its neighbour), equal neighbours are
 * merged; a bar with no chord becomes `[N.C.]` over the whole bar.
 */
export function writeDashBar(
  chords: readonly DashChordInput[],
  ts: DashMeter,
): string {
  const total = barUnits(ts);
  if (total === null) throw new Error(`unsupported meter ${ts.num}/${ts.den}`);
  const snapped = chords
    .map((c, i) => ({
      chord: c.chord,
      start: Math.min(total, Math.max(0, Math.round(c.start))),
      i,
    }))
    .sort((a, b) => a.start - b.start || a.i - b.i);
  // Zero-length chords (same snapped start as the next one, or at the end).
  const kept = snapped.filter(
    (c, k) => c.start < total && snapped[k + 1]?.start !== c.start,
  );
  if (kept.length === 0) return `[${NO_CHORD}]${dashes(total)}`;
  kept[0] = { ...kept[0], start: 0 };
  const merged: { chord: string; start: number }[] = [];
  for (const c of kept)
    if (merged[merged.length - 1]?.chord !== c.chord) merged.push(c);
  return merged
    .map((c, k) => {
      const end = merged[k + 1]?.start ?? total;
      return `[${c.chord}]${dashes(end - c.start)}`;
    })
    .join('');
}

/** `|bar|bar|…|` for the given bars. */
export function writeDashLine(
  bars: readonly (readonly DashChordInput[])[],
  ts: DashMeter,
): string {
  return `|${bars.map((b) => writeDashBar(b, ts)).join('|')}|`;
}

/** Splits bars into lines of `barsPerLine` (default 4; the last may be shorter). */
export function writeDashChart(
  bars: readonly (readonly DashChordInput[])[],
  ts: DashMeter,
  barsPerLine = 4,
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < bars.length; i += barsPerLine)
    lines.push(writeDashLine(bars.slice(i, i + barsPerLine), ts));
  return lines;
}

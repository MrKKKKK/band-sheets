import { drumBars, type DrumEvent, type Shuffle } from './drum';
import {
  DRUM_KIT,
  drumKitEntry,
  type DrumInstrument,
  type DrumKitEntry,
} from './drumKit';
import {
  barTicks,
  durationTicks,
  ticksToDuration,
  type Duration,
  type NoteValue,
  type TimeSig,
} from './melody';
import type { Box, LayoutGlyph, Segment } from './staffLayout';
import { tupletDen, tupletGroups } from './tuplet';
import {
  layoutTupletBracket,
  type LineSegment,
  type TupletNumberGlyph,
} from './tupletLayout';

/**
 * Layout of the hand-drawn DRUM input staff (M5 T14, docs/m5-plan.md
 * 設計判断 6). Pure: everything a thin SVG component (`DrumStaff`, T18)
 * needs, in px. Mirrors `staffLayout.ts` (`layoutMelody`): same coordinate
 * system, spacing, system breaking, cursors and glyph conventions.
 *
 * Simplifications (the polished rendering is alphaTab below the editor):
 * - ONE voice, stems always UP, no beams: every 8th/16th/32nd gets a flag;
 * - a percussion clef on every system, the time signature on the first;
 * - accents are per BEAT (like alphaTab, which draws one `>` / `^` per
 *   beat whatever hit carries it), stacked above the stem tip: `>` first,
 *   then `^` above it when both kinds occur on one beat;
 * - bars never split across systems (an overlong bar is compressed alone),
 *   so a tuplet group (always inside one bar) never splits either.
 *
 * Coordinates: y grows downwards; system i occupies [top, top + height).
 * Staff position ("step", `DrumKitEntry.step`): 0 = bottom line, 4 = middle
 * line, 8 = top line, 10 = the ledger line above (crash); one step =
 * staffSpace / 2.
 *
 * Glyphs are Bravura (SMuFL) characters (`DRUM_GLYPHS`) drawn with
 * `font-family: var(--font-music)` and `font-size: layout.fontSize`
 * (= 4 staff spaces, the SMuFL em). `LayoutGlyph.x` is the glyph's LEFT
 * edge (`text-anchor: start`) and `y` its baseline (SMuFL origin), EXCEPT
 * `DrumSystem.timeSig` digits, `DrumTuplet.number` and
 * `ShuffleMark.equals`, whose x is the CENTER (`text-anchor: middle`).
 *
 * Spacing: every beat gets a fixed part (noteheads incl. a second shifted
 * right of the stem, ghost-parenthesis room, dot room) plus a spring
 * `staffSpace·(1.2 + log2(ticks/2))`, where ticks is the beat's REAL length
 * (a tuplet slot: span / n). Whole bars go onto as few systems as a greedy
 * fill needs, balanced so the systems fill evenly (`breakSystems`); springs
 * of every system but the last are stretched to fill `width`, but to at
 * most `MAX_STRETCH` (1.5) × the system's natural width — a system that
 * would need more stays left-aligned at that width. The last system is
 * never stretched (it only shrinks if it overflows).
 *
 * Vertical room: every system has the same room above the staff, enough
 * for the tallest stem + accents + tuplet bracket of the whole section (at
 * least `MIN_TOP_PAD`); the first system additionally has a `SHUFFLE_H`
 * band on top for the Shuffle marking when `shuffle` ≠ 'none'.
 */

/** SMuFL codepoints (checked against alphaTab 1.8.4's MusicFontSymbol enum). */
export const DRUM_GLYPHS = {
  percussionClef: '', // unpitchedPercussionClef1
  noteheadBlack: '',
  noteheadHalf: '',
  noteheadWhole: '',
  noteheadXBlack: '',
  noteheadXHalf: '',
  noteheadXWhole: '',
  noteheadCircleX: '',
  noteheadCircleXHalf: '',
  noteheadCircleXWhole: '',
  noteheadHeavyX: '', // one shape for every duration
  restWhole: '',
  restHalf: '',
  restQuarter: '',
  rest8th: '',
  rest16th: '',
  rest32nd: '',
  flag8thUp: '',
  flag16thUp: '',
  flag32ndUp: '',
  augmentationDot: '',
  articAccentAbove: '', // '>' accent
  articMarcatoAbove: '', // '^' heavy accent
  /** timeSig0 … timeSig9 are U+E080 … U+E089. */
  timeSig0: '',
} as const;

export type DrumHeadShape = DrumKitEntry['head'];

export interface DrumSystem {
  index: number;
  /** Top of the system's band (incl. the Shuffle band on system 0). */
  top: number;
  height: number;
  /** y of the 5 staff lines, top (step 8) to bottom (step 0). */
  lineYs: number[];
  lineX1: number;
  lineX2: number;
  /** Percussion clef, baseline on the middle line. */
  clef: LayoutGlyph;
  /** First system only; x = CENTER (text-anchor middle). */
  timeSig?: { num: LayoutGlyph; den: LayoutGlyph };
  /** Where the first bar starts (after clef / time signature). */
  contentX: number;
  /** x of the barline after each COMPLETE bar on this system. */
  barlines: number[];
  /** Global index of the first bar on this system, and the bar count. */
  firstBar: number;
  barCount: number;
}

export interface DrumHeadLayout {
  inst: DrumInstrument;
  step: number;
  shape: DrumHeadShape;
  /** Notehead center. */
  x: number;
  y: number;
  /** x = left edge, y = baseline (= center y). */
  glyph: LayoutGlyph;
  /** Drawn right of the stem (the upper note of a second). */
  shifted: boolean;
  /**
   * Ghost note: two SVG paths (stroke `thickness.ghost`, no fill), the
   * left and right parenthesis around the notehead.
   */
  ghost?: { left: string; right: string };
  /** Hit box of this notehead (incl. its parentheses). */
  box: Box;
}

export interface DrumBeatLayout {
  eventIndex: number;
  kind: 'hit' | 'rest';
  system: number;
  /** Global bar index. */
  bar: number;
  /** Center x of the beat's notehead column (or rest glyph). */
  x: number;
  /** In the event's `hits` order (top of the staff first). Empty for a rest. */
  heads: DrumHeadLayout[];
  /** Hits: unshifted noteheads are right-aligned to this x (stem side). */
  headAlignX?: number;
  /** Rests: the rest glyph (x = left edge, y = baseline). */
  rest?: LayoutGlyph;
  /** Always up: y1 = at the lowest notehead, y2 = tip (y2 < y1). None for whole notes / rests. */
  stem?: { x: number; y1: number; y2: number };
  flag?: LayoutGlyph;
  /** One per distinct dotted staff space (chords), or one for a rest. */
  dots: LayoutGlyph[];
  /** `>` then `^` (bottom to top), above the stem tip; x = left edge. */
  accents: LayoutGlyph[];
  ledgerLines: Segment[];
  /** Topmost y drawn for this beat (accents / stem tip / notehead / rest). */
  top: number;
  /**
   * The beat's extent (heads, parentheses, dots, rest glyph; padded).
   * Its x range is the beat's "column" for hit-testing.
   */
  box: Box;
}

/**
 * Tuplet bracket of one group (geometry from `layoutTupletBracket`): draw
 * the 4 `line` segments (stroke `thickness.tuplet`) and `number.text` in
 * the music font (x = CENTER, y = baseline). Always above (stems up); it
 * clears the accents / stem tips, rests by their glyph top.
 */
export interface DrumTuplet {
  /** Event indexes of the group: [start, end). */
  start: number;
  end: number;
  n: number;
  system: number;
  side: 'above';
  line: LineSegment[];
  number: TupletNumberGlyph;
}

/**
 * The Shuffle marking at the section start (system 0, in its own band above
 * the staff): `label` "Shuffle" (plain text font, `labelFontSize`, x = left
 * edge, y = baseline), then a small figure "♫ = ♩♪ with a triplet 3":
 * - '8': two beamed 8ths = quarter + 8th (flag) under a triplet bracket;
 * - '16': two beamed 16ths = 8th + 16th (one full beam + a right-hand
 *   partial beam) under a triplet bracket.
 * Figure glyphs (`heads`, `flags`, `tuplet.number`) use the music font at
 * `fontSize` (smaller than the staff's); `stems` stroke `thickness.stem`,
 * `beams` are center lines stroked `thickness.shuffleBeam` (butt caps),
 * `tuplet.line` strokes `thickness.tuplet`; `equals` is plain text '='
 * (x = CENTER) at `labelFontSize`.
 */
export interface ShuffleMark {
  shuffle: '8' | '16';
  system: number;
  label: LayoutGlyph;
  labelFontSize: number;
  fontSize: number;
  heads: LayoutGlyph[];
  stems: { x: number; y1: number; y2: number }[];
  beams: { x1: number; x2: number; y: number }[];
  flags: LayoutGlyph[];
  equals: LayoutGlyph;
  tuplet: { line: LineSegment[]; number: TupletNumberGlyph };
  box: Box;
}

export interface DrumLayout {
  width: number;
  height: number;
  staffSpace: number;
  /** font-size for all staff music glyphs (4 staff spaces). */
  fontSize: number;
  /** Stroke widths (px). */
  thickness: {
    staffLine: number;
    ledger: number;
    stem: number;
    barline: number;
    tuplet: number;
    ghost: number;
    shuffleBeam: number;
  };
  systems: DrumSystem[];
  /** One per event, in event order. */
  beats: DrumBeatLayout[];
  /** One bracket per tuplet group, in event order. */
  tuplets: DrumTuplet[];
  shuffle?: ShuffleMark;
  /** Insertion points 0..events.length (cursor i = before event i). */
  cursors: { system: number; x: number }[];
}

export interface DrumLayoutOptions {
  width: number;
  /** px between staff lines; default 10. */
  staffSpace?: number;
  /** The section's shuffle; a marking is drawn unless 'none' (default). */
  shuffle?: Shuffle;
}

// ---- metrics, in staff spaces (Bravura metadata, rounded)

type HeadSize = 'black' | 'half' | 'whole';
const HEADS: Record<
  DrumHeadShape,
  Record<HeadSize, { text: string; w: number }>
> = {
  normal: {
    black: { text: DRUM_GLYPHS.noteheadBlack, w: 1.18 },
    half: { text: DRUM_GLYPHS.noteheadHalf, w: 1.18 },
    whole: { text: DRUM_GLYPHS.noteheadWhole, w: 1.69 },
  },
  x: {
    black: { text: DRUM_GLYPHS.noteheadXBlack, w: 1.16 },
    half: { text: DRUM_GLYPHS.noteheadXHalf, w: 1.34 },
    whole: { text: DRUM_GLYPHS.noteheadXWhole, w: 1.51 },
  },
  circleX: {
    black: { text: DRUM_GLYPHS.noteheadCircleX, w: 1.0 },
    half: { text: DRUM_GLYPHS.noteheadCircleXHalf, w: 1.0 },
    whole: { text: DRUM_GLYPHS.noteheadCircleXWhole, w: 1.0 },
  },
  heavyX: {
    black: { text: DRUM_GLYPHS.noteheadHeavyX, w: 1.54 },
    half: { text: DRUM_GLYPHS.noteheadHeavyX, w: 1.54 },
    whole: { text: DRUM_GLYPHS.noteheadHeavyX, w: 1.54 },
  },
};
/** Where an up-stem meets the notehead, above its center. */
const STEM_ANCHOR: Record<DrumHeadShape, number> = {
  normal: 0.168,
  x: 0.42,
  heavyX: 0.42,
  circleX: 0,
};
/** w = width; top / bottom = glyph extent above / below its baseline. */
const REST: Record<
  Duration,
  { glyph: string; w: number; top: number; bottom: number }
> = {
  '1': { glyph: DRUM_GLYPHS.restWhole, w: 1.13, top: 0.04, bottom: 0.54 },
  '2': { glyph: DRUM_GLYPHS.restHalf, w: 1.13, top: 0.57, bottom: 0.01 },
  '4': { glyph: DRUM_GLYPHS.restQuarter, w: 1.08, top: 1.49, bottom: 1.5 },
  '8': { glyph: DRUM_GLYPHS.rest8th, w: 1.0, top: 0.7, bottom: 1.0 },
  '16': { glyph: DRUM_GLYPHS.rest16th, w: 1.28, top: 0.72, bottom: 2.0 },
  '32': { glyph: DRUM_GLYPHS.rest32nd, w: 1.45, top: 1.7, bottom: 2.0 },
};
/** w = glyph width (Bravura bbox), drawn from `stem.x − STEM_INSET`. */
const FLAGS: Partial<
  Record<Duration, { glyph: string; extra: number; w: number }>
> = {
  '8': { glyph: DRUM_GLYPHS.flag8thUp, extra: 0, w: 1.06 },
  '16': { glyph: DRUM_GLYPHS.flag16thUp, extra: 0.25, w: 1.12 },
  '32': { glyph: DRUM_GLYPHS.flag32ndUp, extra: 0.75, w: 1.05 },
};
const ACCENTS = {
  normal: { glyph: DRUM_GLYPHS.articAccentAbove, w: 1.36, h: 0.98 },
  heavy: { glyph: DRUM_GLYPHS.articMarcatoAbove, w: 0.94, h: 1.01 },
} as const;
const ACCENT_GAP = 0.4; // between the stem tip (or a lower accent) and an accent
const STEM_LEN = 3.5;
const STEM_INSET = 0.06; // stem x inside the notehead's right edge
const DOT_GAP = 0.35;
const DOT_W = 0.4;
const DOT_ROOM = 0.8;
const GHOST_GAP = 0.12; // notehead edge → parenthesis
const GHOST_BULGE = 0.35; // how far the parenthesis curves out
const GHOST_HALF_H = 0.6;
const GHOST_ROOM = GHOST_GAP + GHOST_BULGE + 0.15; // per side, in the spacing
const BAR_PAD = 1;
const MAX_STRETCH = 1.5; // a justified system's width ≤ this × its natural width
const END_RESERVE = 2;
const CLEF_X = 0.5;
const CLEF_W = 1.53;
const DIGIT_W = 1.9;
const HIT_PAD = 0.2;
const HEAD_HIT_H = 0.6; // notehead hit box half height
const MIN_TOP_PAD = 6; // staff spaces above the top line, at least
const TOP_MARGIN = 0.6; // above the tallest element
const BOTTOM_PAD = 3; // below the bottom line
const TUPLET_NUMBER_TOP = 0.9; // tuplet digit top above the bracket line
const SHUFFLE_H = 4; // the Shuffle band on system 0
const SHUFFLE_SCALE = 0.55; // figure staff space / staff space
const SHUFFLE_LABEL_FONT = 1.5; // staff spaces
const SHUFFLE_LABEL_W = 5.4; // estimated width of "Shuffle" at that size
const FIG_HEAD_W = 1.18;
const FIG_NOTE_GAP = 2.2; // head-left to head-left, figure spaces
const FIG_STEM = 3; // figure spaces
const FIG_BEAM_GAP = 0.75;

const spring = (ticks: number) => 1.2 + Math.log2(ticks / 2);

function digits(n: number): string {
  return String(n)
    .split('')
    .map((c) => String.fromCharCode(0xe080 + Number(c)))
    .join('');
}

const headSize = (d: Duration): HeadSize =>
  d === '1' ? 'whole' : d === '2' ? 'half' : 'black';

/** Distinct staff steps of the kit, top first; HH wins its step over HO. */
const STEP_INST: readonly { step: number; inst: DrumInstrument }[] =
  DRUM_KIT.filter(
    (e, i) => DRUM_KIT.findIndex((f) => f.step === e.step) === i,
  ).map((e) => ({ step: e.step, inst: e.id }));

// ---- per-beat geometry (shared by layoutDrums and previewDrum)

interface HeadIn {
  inst: DrumInstrument;
  step: number;
  shape: DrumHeadShape;
  ghost: boolean;
}

interface Measured {
  value: NoteValue;
  real: number;
  heads: HeadIn[];
  /** Ascending step order with second-shift flags. */
  shifted: Map<DrumInstrument, boolean>;
  /** Width of the unshifted column / the shifted heads. */
  colW: number;
  shiftW: number;
  ghost: boolean;
  fixed: number;
  spring: number;
  accents: ('normal' | 'heavy')[];
}

function measure(ev: DrumEvent): Measured {
  const value = ev.tuplet
    ? { ...ticksToDuration(ev.ticks)!, dotted: false }
    : ticksToDuration(ev.ticks);
  if (!value) {
    throw new RangeError(`not a writable drum length: ${ev.ticks}`);
  }
  const real = ev.tuplet
    ? (ev.ticks * tupletDen(ev.tuplet.n)) / ev.tuplet.n
    : ev.ticks;
  const size = headSize(value.d);
  const heads: HeadIn[] = ev.hits.map((h) => {
    const k = drumKitEntry(h.inst);
    return { inst: h.inst, step: k.step, shape: k.head, ghost: !!h.ghost };
  });
  // Seconds: walking up from the lowest note, a note one step above an
  // unshifted note goes to the right of the (up) stem.
  const shifted = new Map<DrumInstrument, boolean>();
  let lastStep = -Infinity;
  let lastShifted = false;
  for (const h of [...heads].sort((a, b) => a.step - b.step)) {
    const sh: boolean = h.step - lastStep === 1 && !lastShifted;
    shifted.set(h.inst, sh);
    lastStep = h.step;
    lastShifted = sh;
  }
  let colW = 0;
  let shiftW = 0;
  for (const h of heads) {
    const w = HEADS[h.shape][size].w;
    if (shifted.get(h.inst)) shiftW = Math.max(shiftW, w - STEM_INSET);
    else colW = Math.max(colW, w);
  }
  const ghost = heads.some((h) => h.ghost);
  const accents: ('normal' | 'heavy')[] = [];
  if (ev.hits.some((h) => h.accent === 'normal')) accents.push('normal');
  if (ev.hits.some((h) => h.accent === 'heavy')) accents.push('heavy');
  const body = heads.length > 0 ? colW + shiftW : REST[value.d].w;
  return {
    value,
    real,
    heads,
    shifted,
    colW,
    shiftW,
    ghost,
    fixed:
      body +
      (ghost ? 2 * GHOST_ROOM : 0) +
      (value.dotted
        ? DOT_ROOM + flagDotShift(value.d, colW, shiftW, ghost)
        : 0),
    spring: spring(real),
    accents,
  };
}

/** Right edge of the noteheads (incl. a ghost parenthesis) from the column's left, in staff spaces. */
const headDotStart = (colW: number, shiftW: number, ghost: boolean) =>
  colW + shiftW + (ghost ? GHOST_GAP + GHOST_BULGE : 0);

/**
 * How far a flag pushes the dots right of where the noteheads alone would
 * put them (staff spaces, from the column's left edge after the ghost
 * room): all dots of a beat stay in one column, right of the flag.
 */
function flagDotShift(
  d: Duration,
  colW: number,
  shiftW: number,
  ghost: boolean,
): number {
  const f = FLAGS[d];
  if (!f) return 0;
  const flagRight = colW - 2 * STEM_INSET + f.w;
  return Math.max(0, flagRight - headDotStart(colW, shiftW, ghost));
}

function ghostPaths(
  left: number,
  right: number,
  y: number,
  s: number,
): { left: string; right: string } {
  const lx = left - GHOST_GAP * s;
  const rx = right + GHOST_GAP * s;
  const h = GHOST_HALF_H * s;
  const b = GHOST_BULGE * s;
  return {
    left: `M ${lx} ${y - h} Q ${lx - b} ${y} ${lx} ${y + h}`,
    right: `M ${rx} ${y - h} Q ${rx + b} ${y} ${rx} ${y + h}`,
  };
}

function ledgers(
  steps: { step: number; left: number; right: number }[],
  yOf: (step: number) => number,
  s: number,
): Segment[] {
  const out: Segment[] = [];
  const high = steps.filter((h) => h.step >= 10);
  if (high.length === 0) return out;
  const top = Math.max(...high.map((h) => h.step));
  const x1 = Math.min(...high.map((h) => h.left)) - 0.4 * s;
  const x2 = Math.max(...high.map((h) => h.right)) + 0.4 * s;
  for (let st = 10; st <= top; st += 2) out.push({ x1, x2, y: yOf(st) });
  return out;
}

type PlacedHits = Omit<
  DrumBeatLayout,
  'eventIndex' | 'kind' | 'system' | 'bar' | 'rest'
>;

/** Places one hit beat whose column starts at `left` (incl. ghost room). */
function placeHits(
  m: Measured,
  ev: DrumEvent,
  left: number,
  yOf: (step: number) => number,
  s: number,
): PlacedHits {
  const size = headSize(m.value.d);
  const colLeft = left + (m.ghost ? GHOST_ROOM * s : 0);
  const alignX = colLeft + m.colW * s;
  const stemX = alignX - STEM_INSET * s;
  const midY = yOf(4);
  const heads: DrumHeadLayout[] = m.heads.map((h, i) => {
    const g = HEADS[h.shape][size];
    const shifted = m.shifted.get(h.inst)!;
    const hl = shifted ? stemX : alignX - g.w * s;
    const hr = hl + g.w * s;
    const y = yOf(h.step);
    const out: DrumHeadLayout = {
      inst: h.inst,
      step: h.step,
      shape: h.shape,
      x: (hl + hr) / 2,
      y,
      glyph: { text: g.text, x: hl, y },
      shifted,
      box: {
        x1: hl - HIT_PAD * s,
        y1: y - HEAD_HIT_H * s,
        x2: hr + HIT_PAD * s,
        y2: y + HEAD_HIT_H * s,
      },
    };
    if (ev.hits[i].ghost) {
      out.ghost = ghostPaths(hl, hr, y, s);
      const pad = (GHOST_GAP + GHOST_BULGE) * s;
      out.box.x1 = hl - pad;
      out.box.x2 = hr + pad;
    }
    return out;
  });
  const ys = heads.map((h) => h.y);
  const lowY = Math.max(...ys);
  const highY = Math.min(...ys);
  const lowest = heads.find((h) => h.y === lowY)!;
  let tip = highY - 0.5 * s;
  let stem: DrumBeatLayout['stem'];
  let flag: LayoutGlyph | undefined;
  if (m.value.d !== '1') {
    const f = FLAGS[m.value.d];
    const len = (STEM_LEN + (f?.extra ?? 0)) * s;
    tip = Math.min(highY - len, midY);
    stem = { x: stemX, y1: lowY - STEM_ANCHOR[lowest.shape] * s, y2: tip };
    if (f) flag = { text: f.glyph, x: stemX - STEM_INSET * s, y: tip };
  }
  const centerX = colLeft + (m.colW * s) / 2;
  const accents: LayoutGlyph[] = [];
  let top = tip;
  for (const a of m.accents) {
    const g = ACCENTS[a];
    const baseline = top - ACCENT_GAP * s;
    accents.push({ text: g.glyph, x: centerX - (g.w * s) / 2, y: baseline });
    top = baseline - g.h * s;
  }
  const headRight = Math.max(
    ...heads.map((h) => h.glyph.x + HEADS[h.shape][size].w * s),
  );
  const dots: LayoutGlyph[] = [];
  if (m.value.dotted) {
    let dotX =
      headRight + (m.ghost ? (GHOST_GAP + GHOST_BULGE) * s : 0) + DOT_GAP * s;
    // Dots go right of the flag (one column for the whole beat).
    if (flag) {
      const flagRight = flag.x + FLAGS[m.value.d]!.w * s;
      dotX = Math.max(dotX, flagRight + DOT_GAP * s);
    }
    const steps = new Set(
      m.heads.map((h) => (h.step % 2 === 0 ? h.step + 1 : h.step)),
    );
    for (const st of [...steps].sort((a, b) => b - a)) {
      dots.push({ text: DRUM_GLYPHS.augmentationDot, x: dotX, y: yOf(st) });
    }
  }
  const ledgerLines = ledgers(
    heads.map((h) => ({
      step: h.step,
      left: h.glyph.x,
      right: h.glyph.x + HEADS[h.shape][size].w * s,
    })),
    yOf,
    s,
  );
  const box: Box = {
    x1: Math.min(...heads.map((h) => h.box.x1)),
    y1: Math.min(...heads.map((h) => h.box.y1)),
    x2: Math.max(...heads.map((h) => h.box.x2)),
    y2: Math.max(...heads.map((h) => h.box.y2)),
  };
  if (dots.length) box.x2 = Math.max(box.x2, dots[0].x + (DOT_W + HIT_PAD) * s);
  return {
    x: centerX,
    heads,
    headAlignX: alignX,
    ...(stem && { stem }),
    ...(flag && { flag }),
    dots,
    accents,
    ledgerLines,
    top: Math.min(top, ...ledgerLines.map((l) => l.y)),
    box,
  };
}

// ---- the layout

/**
 * Splits bars (natural widths) into systems: as few systems as the greedy
 * fill needs, with the bars distributed so that the systems except the last
 * are filled as evenly as possible (minimum Σ (1 − natural / avail)²); the
 * last one only has to fit. A bar wider than a whole system stands alone.
 * `availOf(i)` = room of system i. Always returns at least one (maybe
 * empty) system.
 */
export function breakSystems(
  widths: readonly number[],
  availOf: (system: number) => number,
): number[][] {
  const n = widths.length;
  if (n === 0) return [[]];
  // Greedy count = the minimum number of systems.
  let k = 1;
  let used = 0;
  let count = 0;
  for (const w of widths) {
    if (count > 0 && used + w > availOf(k - 1)) {
      k++;
      used = w;
      count = 1;
    } else {
      used += w;
      count++;
    }
  }
  const prefix = [0];
  for (const w of widths) prefix.push(prefix[prefix.length - 1] + w);
  // cost of bars [a, b) on system j (Infinity when it does not fit).
  const cost = (j: number, a: number, b: number) => {
    const w = prefix[b] - prefix[a];
    const avail = availOf(j);
    if (w > avail + 1e-9 && b - a > 1) return Infinity;
    if (j === k - 1) return 0;
    const slack = Math.max(0, 1 - w / avail);
    return slack * slack;
  };
  // best[j][i]: first i bars on systems 0..j-1 (each non-empty).
  const best: number[][] = Array.from({ length: k + 1 }, () =>
    new Array<number>(n + 1).fill(Infinity),
  );
  const from: number[][] = Array.from({ length: k + 1 }, () =>
    new Array<number>(n + 1).fill(-1),
  );
  best[0][0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n; i++) {
      for (let a = j - 1; a < i; a++) {
        if (best[j - 1][a] === Infinity) continue;
        const c = best[j - 1][a] + cost(j - 1, a, i);
        if (c < best[j][i] - 1e-12) {
          best[j][i] = c;
          from[j][i] = a;
        }
      }
    }
  }
  const out: number[][] = [];
  let i = n;
  for (let j = k; j > 0; j--) {
    const a = from[j][i];
    out.unshift(Array.from({ length: i - a }, (_, t) => a + t));
    i = a;
  }
  return out;
}

/**
 * Lays out one section of NORMALIZED drum events (`normalizeDrums`, groups
 * fitting their bars). Throws RangeError (from `drumBars`) when a beat or a
 * tuplet group crosses a barline, on a broken tuplet group, or on a length
 * that is not one (dotted) note value.
 */
export function layoutDrums(
  events: readonly DrumEvent[],
  ts: TimeSig,
  opts: DrumLayoutOptions,
): DrumLayout {
  const first = place(events, ts, opts, MIN_TOP_PAD);
  // Grow the room above the staff when something reaches above it.
  const s = first.staffSpace;
  let need = MIN_TOP_PAD;
  for (const sys of first.systems) {
    const staffTop = sys.lineYs[0];
    let high = staffTop;
    for (const b of first.beats)
      if (b.system === sys.index) high = Math.min(high, b.top);
    for (const t of first.tuplets) {
      if (t.system === sys.index) {
        high = Math.min(high, t.line[1].y1 - TUPLET_NUMBER_TOP * s);
      }
    }
    need = Math.max(need, (staffTop - high) / s + TOP_MARGIN);
  }
  return need > MIN_TOP_PAD + 1e-9 ? place(events, ts, opts, need) : first;
}

interface Slot {
  eventIndex: number;
  ev: DrumEvent;
  m: Measured;
}

function place(
  events: readonly DrumEvent[],
  ts: TimeSig,
  opts: DrumLayoutOptions,
  topPad: number,
): DrumLayout {
  const s = opts.staffSpace ?? 10;
  const width = opts.width;
  const half = s / 2;
  const shuffle = opts.shuffle ?? 'none';
  const shuffleH = shuffle === 'none' ? 0 : SHUFFLE_H;
  const systemH = topPad + 4 + BOTTOM_PAD;

  const bar = barTicks(ts);
  const drumBarList = drumBars(events, ts);
  const bars: Slot[][] = drumBarList.map((b) => {
    const out: Slot[] = [];
    for (let i = b.start; i < b.end; i++) {
      out.push({ eventIndex: i, ev: events[i], m: measure(events[i]) });
    }
    return out;
  });
  const complete = drumBarList.map((b) => b.ticks === bar);

  // ---- system breaking (units: staff spaces)
  const tsW = Math.max(String(ts.num).length, String(ts.den).length) * DIGIT_W;
  const clefEnd = CLEF_X + CLEF_W + 1;
  const contentXOf = (i: number) => (i === 0 ? clefEnd + tsW + 0.8 : clefEnd);
  const availOf = (i: number) => (width - 1) / s - contentXOf(i);
  const barFixed = (b: Slot[]) =>
    BAR_PAD + b.reduce((t, x) => t + x.m.fixed, 0);
  const barSpring = (b: Slot[]) => b.reduce((t, x) => t + x.m.spring, 0);
  const groups = breakSystems(
    bars.map((b) => barFixed(b) + barSpring(b)),
    availOf,
  );

  // ---- place
  const systems: DrumSystem[] = [];
  const beats: DrumBeatLayout[] = [];
  const cursors: { system: number; x: number }[] = [];
  let prevRight = NaN;
  let top = 0;

  groups.forEach((g, si) => {
    const height = (systemH + (si === 0 ? shuffleH : 0)) * s;
    const staffTop = top + (topPad + (si === 0 ? shuffleH : 0)) * s;
    const yOf = (step: number) => staffTop + (8 - step) * half;
    const midY = yOf(4);
    const contentX = contentXOf(si) * s;
    const isLast = si === groups.length - 1;
    const avail = availOf(si) - (isLast ? END_RESERVE : 0);
    const fixed = g.reduce((t, bi) => t + barFixed(bars[bi]), 0);
    const spr = g.reduce((t, bi) => t + barSpring(bars[bi]), 0);
    let f = spr > 0 ? (avail - fixed) / spr : 1;
    if (isLast) f = Math.min(f, 1);
    // A justified system is stretched to at most MAX_STRETCH × its natural
    // width (then left-aligned), so a lone bar is not spread out ~2× looser
    // than its neighbours.
    else if (spr > 0) {
      f = Math.min(f, (MAX_STRETCH * (fixed + spr) - fixed) / spr);
    }
    let scale = 1;
    if (f < 0) {
      f = 0;
      scale = avail / fixed;
    }

    const sys: DrumSystem = {
      index: si,
      top,
      height,
      lineYs: [8, 6, 4, 2, 0].map(yOf),
      lineX1: 0,
      lineX2: width,
      clef: { text: DRUM_GLYPHS.percussionClef, x: CLEF_X * s, y: midY },
      contentX,
      barlines: [],
      firstBar: g.length ? g[0] : bars.length,
      barCount: g.length,
    };
    if (si === 0) {
      const cx = (clefEnd + tsW / 2) * s;
      sys.timeSig = {
        num: { text: digits(ts.num), x: cx, y: yOf(6) },
        den: { text: digits(ts.den), x: cx, y: yOf(2) },
      };
    }
    systems.push(sys);

    let cur = 0;
    const X = (off: number) => contentX + off * scale * s;
    for (const bi of g) {
      const barStart = X(cur);
      cur += BAR_PAD;
      bars[bi].forEach((slot, k) => {
        const { m, ev } = slot;
        const left = X(cur);
        let beat: DrumBeatLayout;
        if (m.heads.length > 0) {
          beat = {
            eventIndex: slot.eventIndex,
            kind: 'hit',
            system: si,
            bar: bi,
            ...placeHits(m, ev, left, yOf, s),
          };
        } else {
          const r = REST[m.value.d];
          const y = m.value.d === '1' ? yOf(6) : midY;
          const right = left + r.w * s;
          beat = {
            eventIndex: slot.eventIndex,
            kind: 'rest',
            system: si,
            bar: bi,
            x: (left + right) / 2,
            heads: [],
            rest: { text: r.glyph, x: left, y },
            dots: [],
            accents: [],
            ledgerLines: [],
            top: y - r.top * s,
            box: {
              x1: left - HIT_PAD * s,
              y1: midY - 1.5 * s,
              x2: right + HIT_PAD * s,
              y2: midY + 1.5 * s,
            },
          };
          if (m.value.dotted) {
            const dot = {
              text: DRUM_GLYPHS.augmentationDot,
              x: right + DOT_GAP * s,
              y: yOf(5),
            };
            beat.dots.push(dot);
            beat.box.x2 = Math.max(beat.box.x2, dot.x + (DOT_W + HIT_PAD) * s);
          }
        }
        if (k === 0) {
          cursors.push({ system: si, x: barStart + (BAR_PAD / 2) * scale * s });
        } else {
          cursors.push({ system: si, x: (prevRight + beat.box.x1) / 2 });
        }
        beats.push(beat);
        prevRight = beat.box.x2;
        cur += m.fixed + m.spring * f;
      });
      if (complete[bi]) sys.barlines.push(X(cur));
    }
    if (isLast) {
      const lastBar = g.length ? g[g.length - 1] : undefined;
      let cx: number;
      if (lastBar === undefined) cx = contentX + (BAR_PAD / 2) * s;
      else if (complete[lastBar]) cx = X(cur) + (BAR_PAD / 2) * s;
      else cx = prevRight + 0.6 * s;
      cursors.push({ system: si, x: Math.min(cx, width - 1) });
    }
    top += height;
  });

  const tuplets = layoutTuplets(events, beats, s);
  const shuffleMark =
    shuffle === 'none' ? undefined : layoutShuffle(shuffle, systems[0], s);

  return {
    width,
    height: top,
    staffSpace: s,
    fontSize: 4 * s,
    thickness: {
      staffLine: 0.13 * s,
      ledger: 0.16 * s,
      stem: 0.12 * s,
      barline: 0.16 * s,
      tuplet: 0.12 * s,
      ghost: 0.12 * s,
      shuffleBeam: 0.5 * SHUFFLE_SCALE * s,
    },
    systems,
    beats,
    tuplets,
    ...(shuffleMark && { shuffle: shuffleMark }),
    cursors,
  };
}

function layoutTuplets(
  events: readonly DrumEvent[],
  beats: DrumBeatLayout[],
  s: number,
): DrumTuplet[] {
  const groups = tupletGroups(events);
  // drumBars already threw on broken groups.
  if ('error' in groups) return [];
  return groups.map((g) => {
    const own = beats.slice(g.start, g.end);
    const tipYs = own.map((b) => b.top);
    const xs = own.map((b) => b.x);
    xs[0] = own[0].box.x1 + HIT_PAD * s;
    xs[xs.length - 1] = own[own.length - 1].box.x2 - HIT_PAD * s;
    const bracket = layoutTupletBracket({
      n: g.n,
      xs,
      tipYs,
      side: 'above',
      staffSpace: s,
    });
    return {
      start: g.start,
      end: g.end,
      n: g.n,
      system: own[0].system,
      side: 'above' as const,
      ...bracket,
    };
  });
}

// ---- Shuffle marking

function layoutShuffle(
  shuffle: '8' | '16',
  sys: DrumSystem,
  s: number,
): ShuffleMark {
  const fs = SHUFFLE_SCALE * s;
  const x0 = sys.contentX;
  const yb = sys.top + (SHUFFLE_H - 0.6) * s; // figure notehead baseline
  const heads: LayoutGlyph[] = [];
  const stems: ShuffleMark['stems'] = [];
  const beams: ShuffleMark['beams'] = [];
  const flags: LayoutGlyph[] = [];
  const tip = yb - FIG_STEM * fs;
  const beamY = (k: number) => tip + (0.25 + k * FIG_BEAM_GAP) * fs;
  /** A head + stem at `left`; returns the stem x. */
  const note = (left: number) => {
    heads.push({ text: DRUM_GLYPHS.noteheadBlack, x: left, y: yb });
    const x = left + (FIG_HEAD_W - STEM_INSET) * fs;
    stems.push({ x, y1: yb - 0.168 * fs, y2: tip });
    return x;
  };
  const label: LayoutGlyph = { text: 'Shuffle', x: x0, y: yb + 0.5 * fs };
  // Left: two beamed 8ths (16ths: two beams).
  let x = x0 + (SHUFFLE_LABEL_W + 0.8) * s;
  const a1 = note(x);
  const a2 = note(x + FIG_NOTE_GAP * fs);
  const beamCount = shuffle === '8' ? 1 : 2;
  for (let k = 0; k < beamCount; k++)
    beams.push({ x1: a1, x2: a2, y: beamY(k) });
  x += (FIG_NOTE_GAP + FIG_HEAD_W + 1.3) * fs;
  const equals: LayoutGlyph = { text: '=', x, y: yb + 0.5 * fs };
  x += 1.9 * fs;
  // Right: long + short under a triplet bracket.
  const leftEdge = x;
  const b1 = note(x);
  const b2 = note(x + FIG_NOTE_GAP * fs);
  let rightEdge = b2 + STEM_INSET * fs;
  if (shuffle === '8') {
    flags.push({
      text: DRUM_GLYPHS.flag8thUp,
      x: b2 - STEM_INSET * fs,
      y: tip,
    });
    rightEdge = b2 + 1.0 * fs;
  } else {
    beams.push({ x1: b1, x2: b2, y: beamY(0) });
    beams.push({ x1: b2 - 1.0 * fs, x2: b2, y: beamY(1) });
  }
  const tuplet = layoutTupletBracket({
    n: 3,
    xs: [leftEdge, rightEdge],
    tipYs: [tip, tip],
    side: 'above',
    staffSpace: fs,
  });
  const boxTop = tuplet.number.y - (TUPLET_NUMBER_TOP + 0.6) * fs;
  return {
    shuffle,
    system: sys.index,
    label,
    labelFontSize: SHUFFLE_LABEL_FONT * s,
    fontSize: 4 * fs,
    heads,
    stems,
    beams,
    flags,
    equals,
    tuplet,
    box: {
      x1: x0,
      y1: Math.max(sys.top, boxTop),
      x2: Math.max(rightEdge, tuplet.line[3].x1),
      y2: yb + 0.6 * fs,
    },
  };
}

// ---- hit-testing

/** The system whose band contains y (clamped to the first / last). */
export function drumSystemAt(layout: DrumLayout, y: number): number {
  const i = layout.systems.findIndex((s) => y < s.top + s.height);
  return i === -1 ? layout.systems.length - 1 : Math.max(0, i);
}

/**
 * The instrument at y on `system`: the kit step nearest to y (exact
 * midpoints go to the higher step), clamped to the kit's range (above the
 * crash → CR, below the bass drum → BD). HH and HO share step 9: HH.
 */
export function yToInstrument(
  layout: DrumLayout,
  system: number,
  y: number,
): DrumInstrument {
  const lineTop = layout.systems[system].lineYs[0];
  const step = 8 + (lineTop - y) / (layout.staffSpace / 2);
  let best = STEP_INST[0];
  let dist = Infinity;
  for (const e of STEP_INST) {
    const d = Math.abs(e.step - step);
    if (d < dist - 1e-9) {
      dist = d;
      best = e;
    }
  }
  return best.inst;
}

/** Notehead center y of `inst` on `system`. */
export function instrumentY(
  layout: DrumLayout,
  system: number,
  inst: DrumInstrument,
): number {
  const lineTop = layout.systems[system].lineYs[0];
  return lineTop + (8 - drumKitEntry(inst).step) * (layout.staffSpace / 2);
}

/** Index of the insertion point nearest to x on the system at y. */
export function nearestDrumCursor(
  layout: DrumLayout,
  x: number,
  y: number,
): number {
  const sys = drumSystemAt(layout, y);
  let best = -1;
  let dist = Infinity;
  layout.cursors.forEach((c, i) => {
    if (c.system !== sys) return;
    const d = Math.abs(c.x - x);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  if (best === -1) {
    best = layout.cursors.findLastIndex((c) => c.system < sys);
    if (best === -1) best = 0;
  }
  return best;
}

/**
 * What a click / hover at (x, y) means:
 * - `head`: in the column (x range of `box`) of beat `event`, at the height
 *   of an instrument the beat already has (its notehead) → select the beat,
 *   `inst` = that notehead's instrument (HO stays HO);
 * - `column`: in the column of beat `event`, at the height
 *   of an instrument it does not have → add `inst` to that beat (回答 Q6).
 *   `rest` tells a rest's column (adding turns the rest into a hit);
 * - `insert`: anywhere else → insert a beat of `inst` at insertion point
 *   `cursor` (the nearest one on that system).
 * `inst` from the height is `yToInstrument` (HH, not HO, at step 9).
 * The decision is by height (nearest kit step), not by the noteheads' hit
 * boxes: those overlap the neighbouring steps (HH's box covers RD's step),
 * which would make adding RD / T2 next to HH / SD impossible by mouse.
 */
export type DrumTarget =
  | { kind: 'head'; event: number; inst: DrumInstrument }
  | { kind: 'column'; event: number; inst: DrumInstrument; rest: boolean }
  | { kind: 'insert'; cursor: number; inst: DrumInstrument };

export function hitTestDrums(
  layout: DrumLayout,
  x: number,
  y: number,
): DrumTarget {
  const system = drumSystemAt(layout, y);
  const own = layout.beats.filter((b) => b.system === system);
  const inst = yToInstrument(layout, system, y);
  const col = own.find((b) => x >= b.box.x1 && x <= b.box.x2);
  if (col) {
    const step = drumKitEntry(inst).step;
    const same = col.heads.find((h) => h.step === step);
    if (same) return { kind: 'head', event: col.eventIndex, inst: same.inst };
    return {
      kind: 'column',
      event: col.eventIndex,
      inst,
      rest: col.kind === 'rest',
    };
  }
  return { kind: 'insert', cursor: nearestDrumCursor(layout, x, y), inst };
}

// ---- hover preview

/** Drawable parts of the translucent hover / input preview notehead. */
export interface DrumPreview {
  system: number;
  inst: DrumInstrument;
  /** Notehead center. */
  x: number;
  y: number;
  glyph: LayoutGlyph;
  /** Insert previews only (as a new beat of the given value). */
  stem?: { x: number; y1: number; y2: number };
  flag?: LayoutGlyph;
  dots: LayoutGlyph[];
  ledgerLines: Segment[];
}

/**
 * The notehead a click at `target` would add:
 * - `insert`: a new beat of `inst` and the given value, its notehead
 *   centered on the cursor's x (with stem, flag, dot);
 * - `column`: just the notehead, placed in that beat's column like the
 *   beat's own unshifted heads (no stem / flag / dot: the beat keeps its
 *   value); on a rest column, centered on the rest;
 * - `head`: null (nothing would be added).
 * Null too for a cursor / event index out of range.
 */
export function previewDrum(
  layout: DrumLayout,
  target: DrumTarget,
  value: NoteValue,
): DrumPreview | null {
  const s = layout.staffSpace;
  const entry = drumKitEntry(target.inst);
  if (target.kind === 'head') return null;
  if (target.kind === 'column') {
    const b = layout.beats[target.event];
    if (!b) return null;
    const lineTop = layout.systems[b.system].lineYs[0];
    const yOf = (st: number) => lineTop + (8 - st) * (s / 2);
    const size = b.kind === 'rest' ? 'black' : headSizeOfBeat(b);
    const w = HEADS[entry.head][size].w * s;
    const left = b.headAlignX !== undefined ? b.headAlignX - w : b.x - w / 2;
    const y = yOf(entry.step);
    return {
      system: b.system,
      inst: target.inst,
      x: left + w / 2,
      y,
      glyph: { text: HEADS[entry.head][size].text, x: left, y },
      dots: [],
      ledgerLines: ledgers(
        [{ step: entry.step, left, right: left + w }],
        yOf,
        s,
      ),
    };
  }
  const c = layout.cursors[target.cursor];
  if (!c) return null;
  const lineTop = layout.systems[c.system].lineYs[0];
  const yOf = (st: number) => lineTop + (8 - st) * (s / 2);
  const ev: DrumEvent = {
    hits: [{ inst: target.inst }],
    ticks: durationTicks(value.d, value.dotted),
  };
  if (!ticksToDuration(ev.ticks)) return null; // a dotted 32nd
  const w = HEADS[entry.head][headSize(value.d)].w * s;
  const placed = placeHits(measure(ev), ev, c.x - w / 2, yOf, s);
  const head = placed.heads[0];
  return {
    system: c.system,
    inst: target.inst,
    x: head.x,
    y: head.y,
    glyph: head.glyph,
    ...(placed.stem && { stem: placed.stem }),
    ...(placed.flag && { flag: placed.flag }),
    dots: placed.dots,
    ledgerLines: placed.ledgerLines,
  };
}

function headSizeOfBeat(b: DrumBeatLayout): HeadSize {
  const h = b.heads[0];
  for (const size of ['black', 'half', 'whole'] as const) {
    if (HEADS[h.shape][size].text === h.glyph.text) return size;
  }
  return 'black';
}

import {
  melismas,
  splitAtBars,
  type BarPiece,
  type Duration,
  type MelodyEvent,
  type NoteValue,
  type TimeSig,
} from './melody';
import { formatPitch, parsePitch, staffStep, stepToPitch } from './pitch';
import { tupletDen, tupletGroups } from './tuplet';
import {
  layoutTupletBracket,
  type LineSegment,
  type TupletNumberGlyph,
} from './tupletLayout';

/**
 * Layout of the hand-drawn INPUT treble staff (M4, docs/m4-plan.md
 * decision 3). Pure: everything a thin SVG component needs, in px.
 *
 * Simplifications (by design; the polished rendering is alphaTab below):
 * - no beams, every 8th/16th/32nd gets its own flag;
 * - no key signature is drawn, so accidentals are shown exactly as spelled
 *   on EVERY note ('#' / 'b'), and naturals are never shown;
 * - one treble clef per system, the time signature on the first system only;
 * - bars never split across systems (an overlong bar is compressed alone).
 *
 * Coordinates: y grows downwards; system i occupies [top, top + height).
 * Systems are equally tall except one whose above-side tuplet brackets
 * (line + number) would reach past its usual top padding: that system gets
 * just enough extra top padding (and room for a chord label above), so
 * nothing is drawn above its band.
 * Staff position ("step", see `staffStep`): E4 = 0 (bottom line), B4 = 4
 * (middle line), F5 = 8 (top line); one step = staffSpace / 2.
 *
 * Glyphs are Bravura (SMuFL) characters drawn with
 * `font-family: var(--font-music)` and `font-size: layout.fontSize`
 * (= 4 staff spaces, the SMuFL em). `LayoutGlyph.x` is the glyph's LEFT edge
 * (`text-anchor: start`) and `y` its baseline (SMuFL origin), EXCEPT
 * `System.timeSig` digits and `LayoutPiece.lyric`, whose x is the CENTER
 * (`text-anchor: middle`).
 *
 * Spacing: every piece gets a fixed part (accidental room, notehead width,
 * dot room) plus a spring `staffSpace·(1.2 + log2(ticks/2))`, where ticks is
 * the piece's REAL length (a tuplet slot: span / n, e.g. 16/3 for a slot of
 * an 8th-note triplet — not its written 8). Systems are
 * filled greedily with whole bars by natural width; springs of every system
 * but the last are stretched to fill `width` (the last system only shrinks
 * if it overflows).
 */

/** SMuFL codepoints (checked against SMuFL 1.4 / Bravura). */
export const GLYPHS = {
  gClef: '',
  noteheadWhole: '',
  noteheadHalf: '',
  noteheadBlack: '',
  restWhole: '',
  restHalf: '',
  restQuarter: '',
  rest8th: '',
  rest16th: '',
  rest32nd: '',
  flag8thUp: '',
  flag8thDown: '',
  flag16thUp: '',
  flag16thDown: '',
  flag32ndUp: '',
  flag32ndDown: '',
  augmentationDot: '',
  accidentalFlat: '',
  accidentalNatural: '',
  accidentalSharp: '',
  /** timeSig0 … timeSig9 are U+E080 … U+E089. */
  timeSig0: '',
} as const;

export interface LayoutGlyph {
  text: string;
  x: number;
  y: number;
}

export interface Segment {
  x1: number;
  x2: number;
  y: number;
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LayoutSystem {
  index: number;
  /** Top of the system's band; height includes ledger room and lyrics. */
  top: number;
  height: number;
  /** y of the 5 staff lines, top (F5) to bottom (E4). */
  lineYs: number[];
  /** Staff lines run from lineX1 to lineX2. */
  lineX1: number;
  lineX2: number;
  clef: LayoutGlyph;
  /** First system only; digit strings, x = CENTER (text-anchor middle). */
  timeSig?: { num: LayoutGlyph; den: LayoutGlyph };
  /** Where the first bar starts (after clef / time signature). */
  contentX: number;
  /** x of the barline after each COMPLETE bar on this system. */
  barlines: number[];
  /** Baseline for lyric text (text-anchor middle). */
  lyricY: number;
  /** Global index of the first bar on this system, and the bar count. */
  firstBar: number;
  barCount: number;
  /**
   * Baseline of the first (lower) chord-label row, also where a chord
   * placeholder for a chordless note goes (issue #6). Row 1 is
   * `CHORD_ROW_SPACES` staff spaces above it.
   */
  chordY: number;
}

/**
 * A chord name above a note (issue #6): x = LEFT edge (text-anchor start),
 * y = baseline, drawn in the chord font at `CHORD_FONT_SPACES` staff
 * spaces. Overlapping names on dense notes are stacked into a second row
 * (`row` 1, still at the note's x); only when neither row has room is a
 * name shifted right past the previous one on the emptier row.
 */
export interface ChordLabel extends LayoutGlyph {
  /** Estimated drawn width (monospace advance × characters). */
  width: number;
  row: 0 | 1;
}

export interface LayoutPiece {
  eventIndex: number;
  /** Index of this piece within its event's pieces (0 = first). */
  pieceIndex: number;
  kind: 'note' | 'rest';
  system: number;
  /** Global bar index. */
  bar: number;
  /** Center x of the notehead / rest glyph. */
  x: number;
  /** Notes: notehead center y. Rests: glyph baseline y. */
  y: number;
  /** Notes: staff step of the notehead. */
  step?: number;
  /** Notehead or rest glyph (x = left edge). */
  glyph: LayoutGlyph;
  stem?: { x: number; y1: number; y2: number; dir: 'up' | 'down' };
  flag?: LayoutGlyph;
  dot?: LayoutGlyph;
  accidental?: LayoutGlyph;
  ledgerLines: Segment[];
  /** First piece of a note with a lyric only; x = CENTER. */
  lyric?: LayoutGlyph;
  /**
   * First piece of an event (note or rest) with a `chord` only: the chord
   * name, x = LEFT edge of the notehead / rest glyph (text-anchor start)
   * unless shifted (see `ChordLabel`), y = baseline. All row-0 labels of a
   * system share one baseline (`LayoutSystem.chordY`) above the staff and
   * above that system's highest notehead / stem / ledger line (clamped into
   * the system band; draw with font-size `CHORD_FONT_SPACES` staff spaces).
   */
  chordLabel?: ChordLabel;
  /** Hit box (notehead or rest glyph, padded) — also the piece's extent incl. accidental and dot. */
  box: Box;
}

export interface LayoutTie {
  eventIndex: number;
  /** pieceIndex of the piece the tie starts from. */
  fromPiece: number;
  system: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 'below' when the stem is up, 'above' otherwise. */
  side: 'above' | 'below';
  /** 'start' / 'end' for the two halves of a tie across systems. */
  half?: 'start' | 'end';
  /** SVG path (stroked cubic curve, no fill). */
  d: string;
}

/**
 * One drawn segment of a melisma slur (`melismas`): from the first piece of
 * the syllable's note (`start`) to the last piece of the melisma's last
 * note (`end`). Below the noteheads when every note in it has its stem up
 * (or would, for whole notes), above otherwise. A slur spanning several
 * systems is split into a 'start' segment (to the end of the staff),
 * 'middle' segments (whole systems) and an 'end' segment.
 */
export interface LayoutSlur {
  /** Event indexes of the melisma. */
  start: number;
  end: number;
  system: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  side: 'above' | 'below';
  half?: 'start' | 'middle' | 'end';
  /** SVG path (stroked cubic curve, no fill). */
  d: string;
}

/**
 * Tuplet bracket of one group (M5 T16; geometry from `layoutTupletBracket`,
 * tupletLayout.ts): draw the 4 `line` segments (stroke `thickness.tuplet`)
 * and `number.text` in the music font (x = CENTER, text-anchor middle;
 * y = baseline). A group is never split across systems (it fits in one
 * bar, and bars never split).
 *
 * Side rule: 'below' only when strictly more of the group's notes have
 * their stem down than up AND no note in the group has a lyric (the lyric
 * line is below the staff, as in vocal engraving); otherwise 'above'
 * (ties and all-rest groups included). Notes whose stem points away from
 * the bracket are cleared by their notehead (and accidental); rests by
 * their glyph's outer edge on that side.
 */
export interface LayoutTuplet {
  /** Event indexes of the group: [start, end). */
  start: number;
  end: number;
  n: number;
  system: number;
  side: 'above' | 'below';
  /** Left hook, left arm, right arm, right hook. */
  line: LineSegment[];
  number: TupletNumberGlyph;
}

export interface Layout {
  width: number;
  height: number;
  staffSpace: number;
  /** font-size for all music glyphs (4 staff spaces). */
  fontSize: number;
  /** Stroke widths (px). */
  thickness: {
    staffLine: number;
    ledger: number;
    stem: number;
    barline: number;
    tie: number;
    tuplet: number;
  };
  key?: string;
  systems: LayoutSystem[];
  pieces: LayoutPiece[];
  ties: LayoutTie[];
  slurs: LayoutSlur[];
  /** One bracket per tuplet group, in event order. */
  tuplets: LayoutTuplet[];
  /** Insertion points 0..events.length (cursor i = before event i). */
  cursors: { system: number; x: number }[];
}

export interface LayoutOptions {
  width: number;
  key?: string;
  /** px between staff lines; default 10. */
  staffSpace?: number;
}

// All metrics in staff spaces (Bravura metadata, rounded).
const HEAD_W: Record<Duration, number> = {
  '1': 1.69,
  '2': 1.18,
  '4': 1.18,
  '8': 1.18,
  '16': 1.18,
  '32': 1.18,
};
/** w = width; top / bottom = glyph extent above / below its baseline (bbox). */
const REST: Record<
  Duration,
  { glyph: string; w: number; top: number; bottom: number }
> = {
  '1': { glyph: GLYPHS.restWhole, w: 1.13, top: 0.04, bottom: 0.54 },
  '2': { glyph: GLYPHS.restHalf, w: 1.13, top: 0.54, bottom: 0.01 },
  '4': { glyph: GLYPHS.restQuarter, w: 1.08, top: 1.49, bottom: 1.5 },
  '8': { glyph: GLYPHS.rest8th, w: 1.0, top: 0.7, bottom: 1.0 },
  '16': { glyph: GLYPHS.rest16th, w: 1.28, top: 0.72, bottom: 2.0 },
  '32': { glyph: GLYPHS.rest32nd, w: 1.6, top: 1.7, bottom: 2.0 },
};
const FLAGS: Partial<
  Record<Duration, { up: string; down: string; extra: number }>
> = {
  '8': { up: GLYPHS.flag8thUp, down: GLYPHS.flag8thDown, extra: 0 },
  '16': { up: GLYPHS.flag16thUp, down: GLYPHS.flag16thDown, extra: 0.25 },
  '32': { up: GLYPHS.flag32ndUp, down: GLYPHS.flag32ndDown, extra: 0.75 },
};
const ACC_W = { '#': 1.0, b: 0.9 } as const;
const ACC_GAP = 0.25;
const ACC_ROOM = 1.3; // ≥ widest accidental + gap
const DOT_GAP = 0.35;
const DOT_W = 0.4;
const DOT_ROOM = 0.8;
const STEM_LEN = 3.5;
const STEM_ANCHOR = 0.168;
const BAR_PAD = 1; // after a barline / the content start
const END_RESERVE = 2; // room for the end cursor on the last system
const CLEF_X = 0.5;
const CLEF_W = 2.68;
const DIGIT_W = 1.9;
const HIT_PAD = 0.2;
const CHORD_ABOVE_STAFF = 1.5; // chord baseline at least this far above the top line
const CHORD_GAP = 0.7; // … and this far above the highest drawn element
const CHORD_MIN_TOP = 1.6; // … but never closer than this to the system top
/** Chord label font-size, in staff spaces. */
export const CHORD_FONT_SPACES = 1.4;
/** Distance between the two chord-label rows, in staff spaces. */
export const CHORD_ROW_SPACES = 1.6;
const CHORD_CHAR_W = 0.62; // monospace advance (em) of one Latin character
const CHORD_WIDE_W = 1.0; // … of a full-width character
const CHORD_SEP = 0.5; // min gap between two labels on one row (staff spaces)
const MIN_STEP = -8; // D3
const MAX_STEP = 16; // G6
const TOP_PAD = (MAX_STEP - 8) / 2 + 1; // 5 spaces above the top line
const LYRIC_BELOW = (0 - MIN_STEP) / 2 + 2.5; // below the bottom line
const SYSTEM_H = TOP_PAD + 4 + LYRIC_BELOW + 1;
const HEAD_HALF_H = 0.5; // notehead half height
const ACC_ABOVE = 1.8; // accidental top above the notehead center (flat)
const ACC_BELOW = 1.4; // accidental bottom below it (sharp / flat)
const TUPLET_NUMBER_TOP = 0.9; // tuplet digit top above the bracket line
const TUPLET_HEADROOM = 0.5; // min gap between a tuplet number and the system top

const spring = (ticks: number) => 1.2 + Math.log2(ticks / 2);

interface Slot {
  piece: BarPiece;
  eventIndex: number;
  pieceIndex: number;
  /** Notes only; NaN pitch falls back to the middle line. */
  step: number;
  acc?: '#' | 'b';
  headW: number;
  fixed: number;
  spring: number;
  /** REAL length in ticks (fractional inside a tuplet). */
  real: number;
}

function digits(n: number): string {
  return String(n)
    .split('')
    .map((c) => String.fromCharCode(0xe080 + Number(c)))
    .join('');
}

/** Drawable parts of one notehead (shared by layoutMelody and previewPiece). */
interface NoteParts {
  glyph: LayoutGlyph;
  stem?: LayoutPiece['stem'];
  flag?: LayoutGlyph;
  dot?: LayoutGlyph;
  accidental?: LayoutGlyph;
  ledgerLines: Segment[];
}

function noteParts(
  step: number,
  acc: '#' | 'b' | undefined,
  value: NoteValue,
  headLeft: number,
  yOf: (step: number) => number,
  s: number,
): NoteParts {
  const y = yOf(step);
  const midY = yOf(4);
  const headRight = headLeft + HEAD_W[value.d] * s;
  const glyph =
    value.d === '1'
      ? GLYPHS.noteheadWhole
      : value.d === '2'
        ? GLYPHS.noteheadHalf
        : GLYPHS.noteheadBlack;
  const out: NoteParts = {
    glyph: { text: glyph, x: headLeft, y },
    ledgerLines: [],
  };
  if (value.d !== '1') {
    const up = step < 4;
    const flag = FLAGS[value.d];
    const len = (STEM_LEN + (flag?.extra ?? 0)) * s;
    const stemX = up ? headRight - 0.06 * s : headLeft + 0.06 * s;
    const y1 = up ? y - STEM_ANCHOR * s : y + STEM_ANCHOR * s;
    const y2 = up ? Math.min(y - len, midY) : Math.max(y + len, midY);
    out.stem = { x: stemX, y1, y2, dir: up ? 'up' : 'down' };
    if (flag) {
      out.flag = { text: up ? flag.up : flag.down, x: stemX - 0.06 * s, y: y2 };
    }
  }
  if (acc) {
    out.accidental = {
      text: acc === '#' ? GLYPHS.accidentalSharp : GLYPHS.accidentalFlat,
      x: headLeft - (ACC_GAP + ACC_W[acc]) * s,
      y,
    };
  }
  if (value.dotted) {
    const dotY = step % 2 === 0 ? yOf(step + 1) : y;
    out.dot = {
      text: GLYPHS.augmentationDot,
      x: headRight + DOT_GAP * s,
      y: dotY,
    };
  }
  const lx1 = headLeft - 0.4 * s;
  const lx2 = headRight + 0.4 * s;
  for (let st = -2; st >= step; st -= 2)
    out.ledgerLines.push({ x1: lx1, x2: lx2, y: yOf(st) });
  for (let st = 10; st <= step; st += 2)
    out.ledgerLines.push({ x1: lx1, x2: lx2, y: yOf(st) });
  return out;
}

/** Estimated width (px) of a chord name drawn at CHORD_FONT_SPACES. */
function chordWidth(text: string, s: number): number {
  let em = 0;
  for (const ch of text) {
    em += ch.codePointAt(0)! >= 0x2e80 ? CHORD_WIDE_W : CHORD_CHAR_W;
  }
  return em * CHORD_FONT_SPACES * s;
}

interface ChordSlot {
  piece: LayoutPiece;
  text: string;
  x: number;
  width: number;
  row: 0 | 1;
}

/**
 * Horizontal placement of one system's chord labels, left to right: row 0
 * at the note's x when it clears the previous row-0 label, else row 1 at
 * the note's x when that row has room, else shifted right on whichever row
 * ends first. Depends only on x, so it can run before the vertical layout
 * is final.
 */
function chordSlots(
  pieces: readonly LayoutPiece[],
  events: readonly MelodyEvent[],
  system: number,
  s: number,
): ChordSlot[] {
  const out: ChordSlot[] = [];
  const end = [-Infinity, -Infinity];
  const gap = CHORD_SEP * s;
  for (const p of pieces) {
    const text = events[p.eventIndex].chord;
    if (p.system !== system || p.pieceIndex !== 0 || !text) continue;
    const width = chordWidth(text, s);
    let x = p.glyph.x;
    let row: 0 | 1;
    if (x >= end[0] + gap) row = 0;
    else if (x >= end[1] + gap) row = 1;
    else {
      row = end[1] < end[0] ? 1 : 0;
      x = end[row] + gap;
    }
    end[row] = x + width;
    out.push({ piece: p, text, x, width, row });
  }
  return out;
}

/**
 * Unclamped row-0 chord baseline of a system: above the staff and above
 * everything drawn above it (noteheads, stems, ledger lines, above-side
 * tuplet brackets and their numbers).
 */
function chordBaseline(
  sys: LayoutSystem,
  pieces: readonly LayoutPiece[],
  tuplets: readonly LayoutTuplet[],
  s: number,
): number {
  let high = sys.lineYs[0];
  for (const t of tuplets) {
    if (t.system === sys.index && t.side === 'above') {
      high = Math.min(high, t.line[1].y1 - TUPLET_NUMBER_TOP * s);
    }
  }
  for (const p of pieces) {
    if (p.system !== sys.index) continue;
    high = Math.min(high, p.box.y1);
    if (p.stem) high = Math.min(high, p.stem.y2);
    if (p.flag && p.stem?.dir === 'up') high = Math.min(high, p.flag.y);
    for (const l of p.ledgerLines) high = Math.min(high, l.y);
  }
  return Math.min(sys.lineYs[0] - CHORD_ABOVE_STAFF * s, high - CHORD_GAP * s);
}

export function layoutMelody(
  events: MelodyEvent[],
  ts: TimeSig,
  opts: LayoutOptions,
): Layout {
  const s = opts.staffSpace ?? 10;
  const width = opts.width;
  const half = s / 2;

  // ---- bars → slots
  const index = new Map(events.map((e, i) => [e, i]));
  const pieceCounter = new Map<MelodyEvent, number>();
  const bars: Slot[][] = splitAtBars(events, ts).map((bar) =>
    bar.map((piece) => {
      const ev = piece.event;
      const pieceIndex = pieceCounter.get(ev) ?? 0;
      pieceCounter.set(ev, pieceIndex + 1);
      let step = 4;
      let acc: '#' | 'b' | undefined;
      let headW: number;
      if (ev.kind === 'note') {
        const p = ev.pitch ? parsePitch(ev.pitch) : null;
        if (p) {
          step = staffStep(p);
          acc = p.accidental || undefined;
        }
        headW = HEAD_W[piece.d];
      } else {
        headW = REST[piece.d].w;
      }
      const real = piece.tuplet
        ? (piece.ticks * tupletDen(piece.tuplet.n)) / piece.tuplet.n
        : piece.ticks;
      return {
        piece,
        eventIndex: index.get(ev)!,
        pieceIndex,
        step,
        acc,
        headW,
        fixed: (acc ? ACC_ROOM : 0) + headW + (piece.dotted ? DOT_ROOM : 0),
        spring: spring(real),
        real,
      };
    }),
  );
  const barSize = (ts.num * 64) / ts.den;
  // Real lengths of tuplet slots are fractional; their group sums are whole.
  const barComplete = (bar: Slot[]) =>
    Math.abs(bar.reduce((t, x) => t + x.real, 0) - barSize) < 1e-6;

  // ---- system breaking (units: staff spaces)
  const tsW = Math.max(String(ts.num).length, String(ts.den).length) * DIGIT_W;
  const clefEnd = CLEF_X + CLEF_W + 1;
  const contentXOf = (i: number) => (i === 0 ? clefEnd + tsW + 0.8 : clefEnd);
  const availOf = (i: number) => (width - 1) / s - contentXOf(i);
  const barFixed = (b: Slot[]) => BAR_PAD + b.reduce((t, x) => t + x.fixed, 0);
  const barSpring = (b: Slot[]) => b.reduce((t, x) => t + x.spring, 0);
  const groups: number[][] = [[]];
  let used = 0;
  bars.forEach((b, bi) => {
    const w = barFixed(b) + barSpring(b);
    const g = groups[groups.length - 1];
    if (g.length > 0 && used + w > availOf(groups.length - 1)) {
      groups.push([bi]);
      used = w;
    } else {
      g.push(bi);
      used += w;
    }
  });

  // ---- place. `extra[si]` = additional top padding (staff spaces) of
  // system si, for tuplet brackets reaching above TOP_PAD (see below).
  const place = (extra: readonly number[]) => {
    const systems: LayoutSystem[] = [];
    const pieces: LayoutPiece[] = [];
    const cursors: { system: number; x: number }[] = [];
    /** Right edge of the previously placed piece (for mid-bar cursors). */
    let prevRight = NaN;
    let nextTop = 0;

    groups.forEach((g, si) => {
      const top = nextTop;
      const height = (SYSTEM_H + extra[si]) * s;
      nextTop += height;
      const staffTop = top + (TOP_PAD + extra[si]) * s;
      const yOf = (step: number) => staffTop + (8 - step) * half;
      const midY = yOf(4);
      const contentX = contentXOf(si) * s;
      const isLast = si === groups.length - 1;
      const avail = availOf(si) - (isLast ? END_RESERVE : 0);
      const fixed = g.reduce((t, bi) => t + barFixed(bars[bi]), 0);
      const spr = g.reduce((t, bi) => t + barSpring(bars[bi]), 0);
      let f = spr > 0 ? (avail - fixed) / spr : 1;
      if (isLast) f = Math.min(f, 1);
      let scale = 1;
      if (f < 0) {
        f = 0;
        scale = avail / fixed;
      }

      const sys: LayoutSystem = {
        index: si,
        top,
        height,
        lineYs: [8, 6, 4, 2, 0].map(yOf),
        lineX1: 0,
        lineX2: width,
        clef: { text: GLYPHS.gClef, x: CLEF_X * s, y: yOf(2) },
        contentX,
        barlines: [],
        lyricY: yOf(0) + LYRIC_BELOW * s - s,
        firstBar: g.length ? g[0] : bars.length,
        barCount: g.length,
        chordY: 0, // set once tuplets are known
      };
      if (si === 0) {
        const cx = (clefEnd + tsW / 2) * s;
        sys.timeSig = {
          num: { text: digits(ts.num), x: cx, y: yOf(6) },
          den: { text: digits(ts.den), x: cx, y: yOf(2) },
        };
      }
      systems.push(sys);

      let cur = 0; // staff-space offset from contentX, before scaling
      const X = (off: number) => contentX + off * scale * s;
      for (const bi of g) {
        const barStart = X(cur);
        cur += BAR_PAD;
        bars[bi].forEach((slot, k) => {
          const { piece } = slot;
          const left = X(cur);
          const headLeft = left + (slot.acc ? ACC_ROOM : 0) * s * scale;
          const headRight = headLeft + slot.headW * s;
          const x = (headLeft + headRight) / 2;
          const isNote = piece.event.kind === 'note';
          let lp: LayoutPiece;
          if (isNote) {
            const step = slot.step;
            const y = yOf(step);
            const parts = noteParts(step, slot.acc, piece, headLeft, yOf, s);
            lp = {
              eventIndex: slot.eventIndex,
              pieceIndex: slot.pieceIndex,
              kind: 'note',
              system: si,
              bar: bi,
              x,
              y,
              step,
              ...parts,
              box: {
                x1: headLeft - HIT_PAD * s,
                y1: y - 0.6 * s,
                x2: headRight + HIT_PAD * s,
                y2: y + 0.6 * s,
              },
            };
            if (lp.accidental) lp.box.x1 = Math.min(lp.box.x1, lp.accidental.x);
            if (!piece.isContinuation && piece.event.lyric) {
              lp.lyric = { text: piece.event.lyric, x, y: sys.lyricY };
            }
          } else {
            const y = piece.d === '1' ? yOf(6) : midY;
            lp = {
              eventIndex: slot.eventIndex,
              pieceIndex: slot.pieceIndex,
              kind: 'rest',
              system: si,
              bar: bi,
              x,
              y,
              glyph: { text: REST[piece.d].glyph, x: headLeft, y },
              ledgerLines: [],
              box: {
                x1: headLeft - HIT_PAD * s,
                y1: midY - 1.5 * s,
                x2: headRight + HIT_PAD * s,
                y2: midY + 1.5 * s,
              },
            };
            if (piece.dotted) {
              lp.dot = {
                text: GLYPHS.augmentationDot,
                x: headRight + DOT_GAP * s,
                y: yOf(5),
              };
            }
          }
          if (lp.dot) lp.box.x2 = Math.max(lp.box.x2, lp.dot.x + DOT_W * s);

          if (slot.pieceIndex === 0) {
            const cx =
              k === 0
                ? barStart + (BAR_PAD / 2) * scale * s
                : (prevRight + lp.box.x1) / 2;
            cursors.push({ system: si, x: cx });
          }
          pieces.push(lp);
          prevRight = lp.box.x2;
          cur += slot.fixed + slot.spring * f;
        });
        if (barComplete(bars[bi])) sys.barlines.push(X(cur));
      }
      if (isLast) {
        const lastBar = g.length ? bars[g[g.length - 1]] : undefined;
        let cx: number;
        if (!lastBar) cx = contentX + (BAR_PAD / 2) * s;
        else if (barComplete(lastBar)) cx = X(cur) + (BAR_PAD / 2) * s;
        else cx = prevRight + 0.6 * s;
        cursors.push({ system: si, x: Math.min(cx, width - 1) });
      }
    });
    return { systems, pieces, cursors, height: nextTop };
  };

  // Tuplet geometry relative to the staff doesn't depend on the system's
  // top, so place once, measure how far each system's brackets (and their
  // numbers) reach above its band, and place again with that much more top
  // padding. Headroom above the number: room for a chord label when the
  // system has one, else TUPLET_HEADROOM.
  let placed = place(groups.map(() => 0));
  let tuplets = layoutTuplets(events, placed.pieces, s);
  const extra = placed.systems.map((sys) => {
    let high = Infinity;
    for (const t of tuplets) {
      if (t.system === sys.index && t.side === 'above') {
        high = Math.min(high, t.line[1].y1 - TUPLET_NUMBER_TOP * s);
      }
    }
    const slots = chordSlots(placed.pieces, events, sys.index, s);
    const twoRows = slots.some((c) => c.row === 1);
    const rows = twoRows ? CHORD_ROW_SPACES : 0;
    const room =
      slots.length > 0 ? CHORD_MIN_TOP + CHORD_GAP + rows : TUPLET_HEADROOM;
    const forTuplets = Math.max(0, (sys.top + room * s - high) / s);
    // A second chord row also needs room above high notes without tuplets.
    const base = chordBaseline(sys, placed.pieces, tuplets, s);
    const forRows = twoRows
      ? Math.max(0, (sys.top + (CHORD_MIN_TOP + rows) * s - base) / s)
      : 0;
    return Math.max(forTuplets, forRows);
  });
  if (extra.some((e) => e > 0)) {
    placed = place(extra);
    tuplets = layoutTuplets(events, placed.pieces, s);
  }
  const { systems, pieces, cursors } = placed;

  // ---- chord labels: one baseline per row and system, above everything
  systems.forEach((sys) => {
    const slots = chordSlots(pieces, events, sys.index, s);
    const rows = slots.some((c) => c.row === 1) ? CHORD_ROW_SPACES : 0;
    const y = Math.max(
      sys.top + (CHORD_MIN_TOP + rows) * s,
      chordBaseline(sys, pieces, tuplets, s),
    );
    sys.chordY = y;
    for (const c of slots) {
      c.piece.chordLabel = {
        text: c.text,
        x: c.x,
        y: c.row === 0 ? y : y - CHORD_ROW_SPACES * s,
        width: c.width,
        row: c.row,
      };
    }
  });

  // ---- ties
  const ties: LayoutTie[] = [];
  for (let i = 0; i + 1 < pieces.length; i++) {
    const a = pieces[i];
    const b = pieces[i + 1];
    if (a.kind !== 'note' || b.eventIndex !== a.eventIndex) continue;
    const side: LayoutTie['side'] = curvesAbove(a) ? 'above' : 'below';
    const sign = side === 'above' ? -1 : 1;
    const off = 0.6 * s * sign;
    const bulge = 0.8 * s * sign;
    const mk = (
      system: number,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      half?: 'start' | 'end',
    ): LayoutTie => {
      const dx = (x2 - x1) / 3;
      return {
        eventIndex: a.eventIndex,
        fromPiece: a.pieceIndex,
        system,
        x1,
        y1,
        x2,
        y2,
        side,
        ...(half && { half }),
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1 + bulge}, ${x2 - dx} ${y2 + bulge}, ${x2} ${y2}`,
      };
    };
    const ax = a.x + 0.3 * s;
    const bx = b.x - 0.3 * s;
    if (a.system === b.system) {
      ties.push(mk(a.system, ax, a.y + off, bx, b.y + off));
    } else {
      const endX = systems[a.system].lineX2 - 0.5 * s;
      const startX = systems[b.system].contentX - 0.5 * s;
      ties.push(mk(a.system, ax, a.y + off, endX, a.y + off, 'start'));
      ties.push(mk(b.system, startX, b.y + off, bx, b.y + off, 'end'));
    }
  }

  const slurs = layoutSlurs(events, pieces, systems, s);

  return {
    width,
    height: placed.height,
    staffSpace: s,
    fontSize: 4 * s,
    thickness: {
      staffLine: 0.13 * s,
      ledger: 0.16 * s,
      stem: 0.12 * s,
      barline: 0.16 * s,
      tie: 0.16 * s,
      tuplet: 0.12 * s,
    },
    ...(opts.key !== undefined && { key: opts.key }),
    systems,
    pieces,
    ties,
    slurs,
    tuplets,
    cursors,
  };
}

/** Brackets of every tuplet group (see `LayoutTuplet` for the side rule). */
function layoutTuplets(
  events: MelodyEvent[],
  pieces: LayoutPiece[],
  s: number,
): LayoutTuplet[] {
  const groups = tupletGroups(events);
  // splitAtBars already threw on broken groups.
  if ('error' in groups) return [];
  const byEvent = new Map(pieces.map((p) => [p.eventIndex, p]));
  return groups.map((g) => {
    const own: LayoutPiece[] = [];
    for (let i = g.start; i < g.end; i++) own.push(byEvent.get(i)!);
    const notes = own.filter((p) => p.kind === 'note');
    const down = notes.filter((p) => p.stem?.dir === 'down').length;
    const hasLyric = notes.some((p) => p.lyric);
    const side: LayoutTuplet['side'] =
      down * 2 > notes.length && !hasLyric ? 'below' : 'above';
    const above = side === 'above';
    const tipYs = own.map((p) => {
      if (p.kind === 'rest') {
        const r = REST[restDuration(p)];
        return above ? p.y - r.top * s : p.y + r.bottom * s;
      }
      if (p.stem && (p.stem.dir === 'up') === above) return p.stem.y2;
      if (p.accidental) {
        return above ? p.y - ACC_ABOVE * s : p.y + ACC_BELOW * s;
      }
      return above ? p.y - HEAD_HALF_H * s : p.y + HEAD_HALF_H * s;
    });
    // From the first glyph's left edge to the last one's right edge
    // (tuplet slots are never dotted, so box.x2 is the glyph + HIT_PAD).
    const xs = own.map((p) => p.x);
    xs[0] = own[0].glyph.x;
    xs[xs.length - 1] = own[own.length - 1].box.x2 - HIT_PAD * s;
    const bracket = layoutTupletBracket({
      n: g.n,
      xs,
      tipYs,
      side,
      staffSpace: s,
    });
    return {
      start: g.start,
      end: g.end,
      n: g.n,
      system: own[0].system,
      side,
      ...bracket,
    };
  });
}

/** Written duration of a placed rest, from its glyph. */
function restDuration(p: LayoutPiece): Duration {
  const d = (Object.keys(REST) as Duration[]).find(
    (k) => REST[k].glyph === p.glyph.text,
  );
  return d ?? '4';
}

/** Notes whose tie / slur goes above (stem down, or a whole note on/above the middle line). */
const curvesAbove = (p: LayoutPiece) =>
  p.stem?.dir === 'down' || (!p.stem && (p.step ?? 0) >= 4);

const SLUR_OFF = 0.9; // gap between notehead center and slur end (staff spaces)
const SLUR_CLEAR = 1.0; // the arc's middle clears in-between noteheads by this

function layoutSlurs(
  events: MelodyEvent[],
  pieces: LayoutPiece[],
  systems: LayoutSystem[],
  s: number,
): LayoutSlur[] {
  const out: LayoutSlur[] = [];
  for (const m of melismas(events)) {
    const inside = pieces.filter(
      (p) => p.eventIndex >= m.start && p.eventIndex <= m.end,
    );
    if (inside.length < 2) continue;
    const a = inside[0];
    const b = inside[inside.length - 1];
    const side: LayoutSlur['side'] = inside.some(curvesAbove)
      ? 'above'
      : 'below';
    const sign = side === 'above' ? -1 : 1;
    // the most outward notehead y (smallest when above, largest when below)
    const outward = (ps: LayoutPiece[]) =>
      sign < 0
        ? Math.min(...ps.map((p) => p.y))
        : Math.max(...ps.map((p) => p.y));
    for (let k = a.system; k <= b.system; k++) {
      const own = inside.filter((p) => p.system === k);
      const sys = systems[k];
      const first = k === a.system;
      const last = k === b.system;
      const x1 = first ? a.x + 0.2 * s : sys.contentX - 0.5 * s;
      const x2 = last ? b.x - 0.2 * s : sys.lineX2 - 0.5 * s;
      const edge = own.length > 0 ? outward(own) : sys.lineYs[2];
      const y1 = (first ? a.y : edge) + SLUR_OFF * s * sign;
      const y2 = (last ? b.y : edge) + SLUR_OFF * s * sign;
      // Control points at y + bulge; the curve's middle is avg + 3/4·bulge,
      // so pick the bulge that keeps it SLUR_CLEAR outside every notehead.
      const avg = (y1 + y2) / 2;
      const target = (own.length > 0 ? edge : avg) + SLUR_CLEAR * s * sign;
      const base = Math.min(2 * s, Math.max(1.2 * s, (x2 - x1) * 0.08));
      const bulge = sign * Math.max(base, ((target - avg) * sign * 4) / 3);
      const dx = (x2 - x1) / 4;
      const half: LayoutSlur['half'] =
        first && last ? undefined : first ? 'start' : last ? 'end' : 'middle';
      out.push({
        start: m.start,
        end: m.end,
        system: k,
        x1,
        y1,
        x2,
        y2,
        side,
        ...(half && { half }),
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1 + bulge}, ${x2 - dx} ${y2 + bulge}, ${x2} ${y2}`,
      });
    }
  }
  return out;
}

/** The system whose band contains y (clamped to the first / last). */
export function systemAt(layout: Layout, y: number): number {
  const i = layout.systems.findIndex((s) => y < s.top + s.height);
  return i === -1 ? layout.systems.length - 1 : Math.max(0, i);
}

/** Event index of the notehead / rest whose hit box contains (x, y), or null. */
export function hitTestNote(
  layout: Layout,
  x: number,
  y: number,
): number | null {
  const p = layout.pieces.find(
    (p) => x >= p.box.x1 && x <= p.box.x2 && y >= p.box.y1 && y <= p.box.y2,
  );
  return p ? p.eventIndex : null;
}

/**
 * Event index of the chord label whose box (its width × one chord-font em
 * above the baseline, a little below it) contains (x, y), or null.
 */
export function hitTestChord(
  layout: Layout,
  x: number,
  y: number,
): number | null {
  const fs = CHORD_FONT_SPACES * layout.staffSpace;
  const p = layout.pieces.find((p) => {
    const c = p.chordLabel;
    return (
      c !== undefined &&
      x >= c.x - 2 &&
      x <= c.x + c.width + 2 &&
      y >= c.y - fs &&
      y <= c.y + 0.3 * fs
    );
  });
  return p ? p.eventIndex : null;
}

/** Index of the insertion point nearest to x on the system at y. */
export function nearestCursor(layout: Layout, x: number, y: number): number {
  const sys = systemAt(layout, y);
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
  // A system always has a cursor except when every one of its events
  // starts on a previous system; fall back to the last cursor before it.
  if (best === -1) {
    best = layout.cursors.findLastIndex((c) => c.system < sys);
    if (best === -1) best = 0;
  }
  return best;
}

/**
 * Pitch at y on `system`: nearest staff step (clamped to D3…G6), with the
 * key signature's accidental (`stepToPitch`; key G → F#). `key` defaults to
 * the layout's key.
 */
export function yToPitch(
  layout: Layout,
  system: number,
  y: number,
  key: string | undefined = layout.key,
): string {
  const top = layout.systems[system].lineYs[0];
  const raw = 8 + Math.round((top - y) / (layout.staffSpace / 2));
  const step = Math.min(MAX_STEP, Math.max(MIN_STEP, raw));
  return formatPitch(stepToPitch(step, key));
}

/** Notehead center y of `pitch` on `system` (accidental ignored). Throws RangeError on an invalid pitch. */
export function pitchToY(
  layout: Layout,
  system: number,
  pitch: string,
): number {
  const p = parsePitch(pitch);
  if (!p) throw new RangeError(`invalid pitch: ${pitch}`);
  const top = layout.systems[system].lineYs[0];
  return top + (8 - staffStep(p)) * (layout.staffSpace / 2);
}

/** Drawable parts of the translucent hover / input preview note. */
export interface PreviewPiece extends NoteParts {
  system: number;
  /** Notehead center (x = the cursor's x). */
  x: number;
  y: number;
  step: number;
  pitch: string;
}

/**
 * The note that WOULD be inserted at insertion point `cursorIndex`, drawn
 * with its notehead centered on that cursor's x: notehead glyph, stem,
 * flag, dot, accidental (as spelled) and ledger lines, on the cursor's
 * system. Null for an invalid pitch, a pitch outside D3…G6, or a cursor
 * index out of range.
 */
export function previewPiece(
  layout: Layout,
  cursorIndex: number,
  pitch: string,
  duration: Duration,
  dotted = false,
): PreviewPiece | null {
  const c = layout.cursors[cursorIndex];
  const p = parsePitch(pitch);
  if (!c || !p) return null;
  const step = staffStep(p);
  if (step < MIN_STEP || step > MAX_STEP) return null;
  const s = layout.staffSpace;
  const top = layout.systems[c.system].lineYs[0];
  const yOf = (st: number) => top + (8 - st) * (s / 2);
  const headLeft = c.x - (HEAD_W[duration] * s) / 2;
  const parts = noteParts(
    step,
    p.accidental || undefined,
    { d: duration, dotted },
    headLeft,
    yOf,
    s,
  );
  return { ...parts, system: c.system, x: c.x, y: yOf(step), step, pitch };
}

/** Unclamped staff step at y on `system` (E4 = 0, F5 = 8). */
export function stepAt(layout: Layout, system: number, y: number): number {
  const top = layout.systems[system].lineYs[0];
  return 8 + Math.round((top - y) / (layout.staffSpace / 2));
}

/** Staff steps a click can produce (D3 … G6), see yToPitch. */
export const STEP_RANGE = { min: MIN_STEP, max: MAX_STEP } as const;

import { describe, expect, it } from 'vitest';
import type { MelodyEvent, TimeSig } from './melody';
import { melodyFixtures, kirakiraA } from './fixtures/melodyFixtures';
import {
  GLYPHS,
  hitTestChord,
  hitTestNote,
  layoutMelody,
  nearestCursor,
  pitchToY,
  previewPiece,
  STEP_RANGE,
  stepAt,
  systemAt,
  yToPitch,
  type Layout,
  type LayoutPiece,
} from './staffLayout';

const FOUR: TimeSig = { num: 4, den: 4 };
const n = (pitch: string, ticks = 16, lyric?: string): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
  ...(lyric !== undefined && { lyric }),
});
const r = (ticks = 16): MelodyEvent => ({ kind: 'rest', ticks });

const one = (pitch: string, ticks = 16) =>
  layoutMelody([n(pitch, ticks)], FOUR, { width: 600 }).pieces[0];

/** Every piece's left/right extent (accidental … dot). */
const extent = (p: LayoutPiece) => [p.box.x1, p.box.x2];

/** A long melody: 24 bars of mixed values with accidentals and dots. */
const long: MelodyEvent[] = Array.from({ length: 24 }, () => [
  n('C#5', 24, 'ら'),
  n('Bb4', 8),
  n('E4', 4),
  n('F4', 4),
  n('G4', 8),
  r(16),
]).flat();

describe('layoutMelody: systems', () => {
  it('empty input → one system with clef, time signature and a cursor at 0', () => {
    const l = layoutMelody([], FOUR, { width: 500 });
    expect(l.systems).toHaveLength(1);
    const s = l.systems[0];
    expect(s.clef.text).toBe(GLYPHS.gClef);
    expect(s.timeSig?.num.text).toBe('');
    expect(s.timeSig?.den.text).toBe('');
    expect(s.lineYs).toHaveLength(5);
    expect(l.cursors).toEqual([{ system: 0, x: expect.any(Number) }]);
    expect(l.cursors[0].x).toBeGreaterThanOrEqual(s.contentX);
    expect(l.pieces).toEqual([]);
  });

  it('staff lines are evenly spaced by staffSpace, top to bottom', () => {
    const l = layoutMelody([], FOUR, { width: 500, staffSpace: 12 });
    const ys = l.systems[0].lineYs;
    for (let i = 1; i < 5; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(12);
    expect(l.fontSize).toBe(48);
  });

  it('wraps a long melody into several systems without splitting bars', () => {
    const l = layoutMelody(long, FOUR, { width: 700 });
    expect(l.systems.length).toBeGreaterThan(1);
    // A clef on every system, a time signature only on the first.
    expect(l.systems.every((s) => s.clef.text === GLYPHS.gClef)).toBe(true);
    expect(l.systems[0].timeSig).toBeDefined();
    expect(l.systems.slice(1).every((s) => s.timeSig === undefined)).toBe(true);
    // Each bar's pieces are all on one system.
    const barSystem = new Map<number, number>();
    for (const p of l.pieces) {
      if (barSystem.has(p.bar)) expect(barSystem.get(p.bar)).toBe(p.system);
      barSystem.set(p.bar, p.system);
    }
    expect(barSystem.size).toBe(24);
    // Systems are stacked without overlap.
    for (let i = 1; i < l.systems.length; i++) {
      const prev = l.systems[i - 1];
      expect(l.systems[i].top).toBeGreaterThanOrEqual(prev.top + prev.height);
    }
    expect(l.height).toBeGreaterThanOrEqual(
      l.systems.at(-1)!.top + l.systems.at(-1)!.height,
    );
  });

  it('keeps x strictly increasing within a system and inside [0, width]', () => {
    for (const width of [300, 700, 1200]) {
      for (const f of [...melodyFixtures, { ts: FOUR, events: long }]) {
        const l = layoutMelody(f.events, f.ts, { width });
        for (let i = 1; i < l.pieces.length; i++) {
          const a = l.pieces[i - 1];
          const b = l.pieces[i];
          if (a.system === b.system) expect(b.x).toBeGreaterThan(a.x);
          else expect(b.system).toBe(a.system + 1);
        }
        for (const p of l.pieces) {
          expect(p.box.x1).toBeGreaterThanOrEqual(0);
          expect(p.box.x2).toBeLessThanOrEqual(width);
        }
        for (const s of l.systems) {
          for (const b of s.barlines) {
            expect(b).toBeGreaterThan(0);
            expect(b).toBeLessThanOrEqual(width);
          }
        }
        for (const c of l.cursors) {
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.x).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('pieces never overlap barlines', () => {
    const l = layoutMelody(long, FOUR, { width: 700 });
    for (const s of l.systems) {
      const pieces = l.pieces.filter((p) => p.system === s.index);
      for (const b of s.barlines) {
        for (const p of pieces) {
          const [x1, x2] = extent(p);
          expect(b < x1 || b > x2).toBe(true);
        }
      }
      // Bars sit between consecutive barlines.
      const bounds = [s.contentX, ...s.barlines];
      for (const p of pieces) {
        const k = p.bar - s.firstBar;
        expect(p.box.x1).toBeGreaterThan(bounds[k]);
        if (k + 1 < bounds.length) expect(p.box.x2).toBeLessThan(bounds[k + 1]);
      }
    }
  });

  it('draws a barline after every complete bar only', () => {
    const l = layoutMelody([n('C4', 64), n('D4', 16)], FOUR, { width: 800 });
    expect(l.systems[0].barlines).toHaveLength(1);
    const full = layoutMelody([n('C4', 64), n('D4', 64)], FOUR, {
      width: 800,
    });
    expect(full.systems[0].barlines).toHaveLength(2);
  });

  it('gives longer notes more room than shorter ones', () => {
    const l = layoutMelody(
      [n('C5', 4), n('C5', 4), n('C5', 8), n('C5', 16), n('C5', 32)],
      FOUR,
      { width: 2000 },
    );
    const gaps = l.pieces.slice(1).map((p, i) => p.x - l.pieces[i].x);
    expect(gaps[1]).toBeGreaterThan(gaps[0] - 1e-9);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);
    expect(gaps[3]).toBeGreaterThan(gaps[2]);
  });
});

describe('layoutMelody: notes', () => {
  it('stems: down for B4 and above, up below; none on whole notes', () => {
    expect(one('A4').stem?.dir).toBe('up');
    expect(one('C4').stem?.dir).toBe('up');
    expect(one('B4').stem?.dir).toBe('down');
    expect(one('Bb4').stem?.dir).toBe('down');
    expect(one('A5').stem?.dir).toBe('down');
    expect(one('C4', 64).stem).toBeUndefined();
    const up = one('C4')!;
    expect(up.stem!.y2).toBeLessThan(up.stem!.y1);
    const down = one('C5')!;
    expect(down.stem!.y2).toBeGreaterThan(down.stem!.y1);
  });

  it('noteheads, flags and dots by value', () => {
    expect(one('C5', 64).glyph.text).toBe(GLYPHS.noteheadWhole);
    expect(one('C5', 32).glyph.text).toBe(GLYPHS.noteheadHalf);
    expect(one('C5', 16).glyph.text).toBe(GLYPHS.noteheadBlack);
    expect(one('C5', 16).flag).toBeUndefined();
    expect(one('C5', 8).flag?.text).toBe(GLYPHS.flag8thDown);
    expect(one('C4', 8).flag?.text).toBe(GLYPHS.flag8thUp);
    expect(one('C4', 4).flag?.text).toBe(GLYPHS.flag16thUp);
    expect(one('C5', 2).flag?.text).toBe(GLYPHS.flag32ndDown);
    expect(one('C5', 24).dot?.text).toBe(GLYPHS.augmentationDot);
    expect(one('C5', 16).dot).toBeUndefined();
    // Flag sits at the stem end.
    const p = one('C4', 8)!;
    expect(p.flag!.y).toBeCloseTo(p.stem!.y2);
  });

  it('a dot on a line moves into the space above', () => {
    const l = layoutMelody([n('E4', 24), n('F4', 24)], FOUR, { width: 600 });
    const s = l.systems[0];
    const half = l.staffSpace / 2;
    expect(l.pieces[0].dot!.y).toBeCloseTo(s.lineYs[4] - half);
    expect(l.pieces[1].dot!.y).toBeCloseTo(l.pieces[1].y);
  });

  it('accidentals as spelled, never naturals (no key signature drawn)', () => {
    expect(one('C#4').accidental?.text).toBe(GLYPHS.accidentalSharp);
    expect(one('Bb3').accidental?.text).toBe(GLYPHS.accidentalFlat);
    expect(one('C4').accidental).toBeUndefined();
    const g = layoutMelody([n('F4'), n('F#4')], FOUR, {
      width: 600,
      key: 'G',
    });
    expect(g.pieces[0].accidental).toBeUndefined();
    expect(g.pieces[1].accidental?.text).toBe(GLYPHS.accidentalSharp);
    // The accidental is left of the notehead.
    const p = one('C#4')!;
    expect(p.accidental!.x).toBeLessThan(p.glyph.x);
  });

  it('ledger lines: C4 1, A3 2, A5 1, C6 2, none on the staff', () => {
    const count = (pitch: string) => one(pitch)!.ledgerLines.length;
    expect(count('C4')).toBe(1);
    expect(count('B3')).toBe(1);
    expect(count('A3')).toBe(2);
    expect(count('A5')).toBe(1);
    expect(count('C6')).toBe(2);
    expect(count('D4')).toBe(0);
    expect(count('E4')).toBe(0);
    expect(count('G5')).toBe(0);
    const l = layoutMelody([n('A3')], FOUR, { width: 600 });
    const s = l.systems[0];
    const ss = l.staffSpace;
    const ys = l.pieces[0].ledgerLines.map((x) => x.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(s.lineYs[4] + ss); // C4
    expect(ys[1]).toBeCloseTo(s.lineYs[4] + 2 * ss); // A3
    expect(l.pieces[0].y).toBeCloseTo(s.lineYs[4] + 2 * ss);
  });

  it('rests', () => {
    const l = layoutMelody([r(64), r(32), r(16), r(8), r(4), r(2)], FOUR, {
      width: 1000,
    });
    expect(l.pieces.map((p) => p.glyph.text)).toEqual([
      GLYPHS.restWhole,
      GLYPHS.restHalf,
      GLYPHS.restQuarter,
      GLYPHS.rest8th,
      GLYPHS.rest16th,
      GLYPHS.rest32nd,
    ]);
    expect(l.pieces.every((p) => p.kind === 'rest' && !p.stem)).toBe(true);
    expect(l.pieces.every((p) => p.ledgerLines.length === 0)).toBe(true);
  });
});

describe('layoutMelody: ties and lyrics', () => {
  it('a note across the barline gets a tie arc between its pieces', () => {
    const l = layoutMelody([n('C4', 48, 'あ'), n('D4', 32, 'い')], FOUR, {
      width: 800,
    });
    // C4 48 = dotted half; D4 32 → 16 | 16 tied.
    const d = l.pieces.filter((p) => p.eventIndex === 1);
    expect(d).toHaveLength(2);
    expect(l.ties).toHaveLength(1);
    const t = l.ties[0];
    expect(t.eventIndex).toBe(1);
    expect(t.x1).toBeGreaterThan(d[0].x);
    expect(t.x2).toBeLessThan(d[1].x);
    expect(t.d).toMatch(/^M/);
    // Lyrics only on first pieces.
    expect(d[0].lyric?.text).toBe('い');
    expect(d[1].lyric).toBeUndefined();
    expect(d[1].pieceIndex).toBe(1);
  });

  it('a tie across systems becomes two half arcs', () => {
    // Narrow width: one bar per system.
    const l = layoutMelody([n('C4', 48), n('E5', 32)], FOUR, { width: 200 });
    const e = l.pieces.filter((p) => p.eventIndex === 1);
    expect(e[0].system).not.toBe(e[1].system);
    const ties = l.ties.filter((t) => t.eventIndex === 1);
    expect(ties).toHaveLength(2);
    expect(ties[0].system).toBe(e[0].system);
    expect(ties[1].system).toBe(e[1].system);
    expect(ties[0].x2).toBeGreaterThan(e[0].x);
    expect(ties[1].x1).toBeLessThan(e[1].x);
  });

  it('rests are not tied; lyrics only on note first pieces', () => {
    const l = layoutMelody(kirakiraA.events, kirakiraA.ts, { width: 900 });
    expect(l.ties).toHaveLength(0);
    const withLyric = l.pieces.filter((p) => p.lyric);
    expect(withLyric).toHaveLength(14);
    for (const p of withLyric) {
      expect(p.pieceIndex).toBe(0);
      expect(p.lyric!.y).toBe(l.systems[p.system].lyricY);
      expect(p.lyric!.x).toBeCloseTo(p.x);
    }
    const rl = layoutMelody([r(80)], FOUR, { width: 600 });
    expect(rl.ties).toHaveLength(0);
    expect(rl.pieces).toHaveLength(2);
  });

  it('lyric baseline is below the lowest ledger area', () => {
    const l = layoutMelody([n('A3', 16, 'あ')], FOUR, { width: 600 });
    const p = l.pieces[0];
    expect(p.lyric!.y).toBeGreaterThan(p.y + l.staffSpace);
  });
});

/** Point of a slur/tie path `M x y C …, …, x y` at t = 0.5. */
function midOf(d: string): { x: number; y: number } {
  const v = d.match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
  const [x0, y0, x1, y1, x2, y2, x3, y3] = v;
  return {
    x: (x0 + 3 * x1 + 3 * x2 + x3) / 8,
    y: (y0 + 3 * y1 + 3 * y2 + y3) / 8,
  };
}

describe('layoutMelody: melisma slurs', () => {
  it('a 3-note melisma gets one slur from the syllable note to the last note', () => {
    const l = layoutMelody([n('C4', 16, 'る'), n('D4'), n('E4')], FOUR, {
      width: 800,
    });
    expect(l.slurs).toHaveLength(1);
    const s = l.slurs[0];
    const [c, , e] = l.pieces;
    expect(s).toMatchObject({ start: 0, end: 2, system: 0, side: 'below' });
    expect(s.half).toBeUndefined();
    expect(s.x1).toBeGreaterThanOrEqual(c.x - l.staffSpace);
    expect(s.x1).toBeLessThan(l.pieces[1].x);
    expect(s.x2).toBeGreaterThan(l.pieces[1].x);
    expect(s.x2).toBeLessThanOrEqual(e.x + l.staffSpace);
    // below the noteheads (stems up)
    expect(s.y1).toBeGreaterThan(c.y);
    expect(s.y2).toBeGreaterThan(e.y);
    expect(s.d).toMatch(/^M /);
    expect(midOf(s.d).y).toBeGreaterThan(Math.max(s.y1, s.y2));
  });

  it('none when every note has a lyric, or before any lyric', () => {
    expect(
      layoutMelody(kirakiraA.events, kirakiraA.ts, { width: 900 }).slurs,
    ).toEqual([]);
    expect(
      layoutMelody([n('C4'), n('D4')], FOUR, { width: 600 }).slurs,
    ).toEqual([]);
  });

  it('not across rests', () => {
    const l = layoutMelody([n('C4', 16, 'a'), r(), n('D4'), n('E4')], FOUR, {
      width: 600,
    });
    expect(l.slurs).toEqual([]);
    const l2 = layoutMelody([n('C4', 16, 'a'), n('D4'), r(), n('E4')], FOUR, {
      width: 600,
    });
    expect(l2.slurs).toHaveLength(1);
    expect(l2.slurs[0]).toMatchObject({ start: 0, end: 1 });
  });

  it('ends on the last tied piece of the end note', () => {
    // C4 48 (dotted half), D4 32 → D4 | D4{t}
    const l = layoutMelody([n('C4', 48, 'a'), n('D4', 32)], FOUR, {
      width: 800,
    });
    const d = l.pieces.filter((p) => p.eventIndex === 1);
    expect(l.slurs).toHaveLength(1);
    expect(l.slurs[0].x2).toBeGreaterThan(d[0].x);
    expect(l.slurs[0].x2).toBeLessThanOrEqual(d[1].x + l.staffSpace);
  });

  it('goes above when any stem points down, and clears the notes in between', () => {
    const l = layoutMelody([n('C5', 16, 'a'), n('G5'), n('C5')], FOUR, {
      width: 800,
    });
    const s = l.slurs[0];
    expect(s.side).toBe('above');
    expect(s.y1).toBeLessThan(l.pieces[0].y);
    // the arc's middle is above the high G5 in between
    expect(midOf(s.d).y).toBeLessThan(l.pieces[1].y - l.staffSpace / 2);
    const below = layoutMelody([n('C4', 16, 'a'), n('A3'), n('C4')], FOUR, {
      width: 800,
    }).slurs[0];
    expect(below.side).toBe('below');
  });

  it('is split across systems: start / middle / end segments', () => {
    // Narrow width: one bar per system; a melisma over three bars.
    const events = [
      n('C4', 16, 'a'),
      ...Array.from({ length: 9 }, () => n('E4', 16)),
    ];
    const l = layoutMelody(events, FOUR, { width: 200 });
    const last = l.pieces[l.pieces.length - 1];
    expect(last.system).toBe(2);
    const segs = l.slurs.filter((s) => s.start === 0);
    expect(segs.map((s) => [s.system, s.half])).toEqual([
      [0, 'start'],
      [1, 'middle'],
      [2, 'end'],
    ]);
    expect(segs.every((s) => s.end === 9)).toBe(true);
    expect(segs[0].x1).toBeLessThan(l.pieces[1].x);
    expect(segs[0].x2).toBeGreaterThan(l.pieces[3].x);
    expect(segs[2].x1).toBeLessThan(last.x);
    expect(segs[2].x2).toBeLessThanOrEqual(last.x + l.staffSpace);
    for (const s of segs) {
      const sys = l.systems[s.system];
      expect(s.y1).toBeGreaterThan(sys.top);
      expect(s.y1).toBeLessThan(sys.top + sys.height);
    }
  });
});

describe('cursors', () => {
  it('one insertion point per gap, in order', () => {
    const ev = [n('C4'), n('D4', 48), n('E4', 32), r(16)];
    const l = layoutMelody(ev, FOUR, { width: 800 });
    expect(l.cursors).toHaveLength(ev.length + 1);
    for (let i = 1; i < l.cursors.length; i++) {
      const a = l.cursors[i - 1];
      const b = l.cursors[i];
      if (a.system === b.system) expect(b.x).toBeGreaterThan(a.x);
    }
    // Cursor i is left of event i's first piece and right of event i-1's.
    for (let i = 0; i < ev.length; i++) {
      const first = l.pieces.find((p) => p.eventIndex === i)!;
      expect(l.cursors[i].x).toBeLessThan(first.box.x1);
      if (i > 0) {
        const prev = l.pieces.findLast((p) => p.eventIndex === i - 1)!;
        if (prev.system === first.system)
          expect(l.cursors[i].x).toBeGreaterThan(prev.box.x2);
      }
    }
    const last = l.pieces.at(-1)!;
    expect(l.cursors[ev.length].x).toBeGreaterThan(last.box.x2);
  });

  it('nearestCursor picks the closest insertion point on that system', () => {
    const l = layoutMelody([n('C4'), n('D4'), n('E4')], FOUR, { width: 800 });
    const y = l.systems[0].lineYs[2];
    expect(nearestCursor(l, l.cursors[2].x + 1, y)).toBe(2);
    expect(nearestCursor(l, 0, y)).toBe(0);
    expect(nearestCursor(l, 800, y)).toBe(3);
  });
});

describe('hit testing and pitch ↔ y', () => {
  const ev = [n('C4'), n('G4'), r(16), n('C#5')];
  const l: Layout = layoutMelody(ev, FOUR, { width: 800 });

  it('hitTestNote finds the note under the point, null between notes', () => {
    for (const p of l.pieces) {
      expect(hitTestNote(l, p.x, p.y)).toBe(p.eventIndex);
    }
    const [a, b] = l.pieces;
    expect(hitTestNote(l, (a.x + b.x) / 2, a.y)).toBeNull();
    expect(hitTestNote(l, a.x, a.y - 3 * l.staffSpace)).toBeNull();
  });

  it('round-trips pitchToY / yToPitch from E3 to A5 in C', () => {
    const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const pitches: string[] = [];
    for (let o = 3; o <= 5; o++)
      for (const L of letters) pitches.push(`${L}${o}`);
    const range = pitches.slice(
      pitches.indexOf('E3'),
      pitches.indexOf('A5') + 1,
    );
    for (const p of range) {
      expect(yToPitch(l, 0, pitchToY(l, 0, p))).toBe(p);
      expect(yToPitch(l, 0, pitchToY(l, 0, p) + 2)).toBe(p);
    }
    for (const p of range) {
      const g = p[0] === 'F' ? `F#${p[1]}` : p;
      expect(yToPitch(l, 0, pitchToY(l, 0, p), 'G')).toBe(g);
    }
  });

  it('yToPitch uses the layout key by default; pitchToY ignores accidentals', () => {
    const g = layoutMelody([], FOUR, { width: 500, key: 'G' });
    expect(yToPitch(g, 0, pitchToY(g, 0, 'F4'))).toBe('F#4');
    expect(pitchToY(g, 0, 'F#4')).toBe(pitchToY(g, 0, 'F4'));
    expect(pitchToY(g, 0, 'E4')).toBeCloseTo(g.systems[0].lineYs[4]);
    expect(() => pitchToY(g, 0, 'H4')).toThrow(RangeError);
  });

  it('yToPitch clamps far-off positions', () => {
    const s = l.systems[0];
    expect(yToPitch(l, 0, s.top - 1000)).toBe('G6');
    expect(yToPitch(l, 0, s.top + 1000)).toBe('D3');
  });

  it('pitchToY works per system', () => {
    const w = layoutMelody(long, FOUR, { width: 700 });
    expect(pitchToY(w, 1, 'B4')).toBeCloseTo(w.systems[1].lineYs[2]);
    expect(systemAt(w, w.systems[1].lineYs[2])).toBe(1);
    expect(systemAt(w, -50)).toBe(0);
    expect(systemAt(w, 1e6)).toBe(w.systems.length - 1);
  });
});

describe('chord labels', () => {
  it('only first pieces of events with a chord, left-aligned to the glyph', () => {
    const ev: MelodyEvent[] = [
      { ...n('C4'), chord: 'C' },
      n('D4'),
      { kind: 'rest', ticks: 16, chord: 'G7' },
      { ...n('E4', 32), chord: 'Am' }, // crosses the barline: 2 pieces
    ];
    const l = layoutMelody(ev, FOUR, { width: 800 });
    const labels = l.pieces.filter((p) => p.chordLabel);
    expect(labels.map((p) => [p.eventIndex, p.chordLabel!.text])).toEqual([
      [0, 'C'],
      [2, 'G7'],
      [3, 'Am'],
    ]);
    for (const p of labels) expect(p.chordLabel!.x).toBe(p.glyph.x);
    expect(l.pieces.filter((p) => p.eventIndex === 3)).toHaveLength(2);
    expect(
      l.pieces.find((p) => p.eventIndex === 3 && p.pieceIndex === 1)!
        .chordLabel,
    ).toBeUndefined();
  });

  it('one baseline per system, above the staff and above every drawn element', () => {
    const ev: MelodyEvent[] = [
      { ...n('C4'), chord: 'C' },
      { ...n('A5', 8), chord: 'F' }, // ledger line above the staff
      { ...n('A4', 8), chord: 'G' }, // stem up above the staff
    ];
    const l = layoutMelody(ev, FOUR, { width: 800 });
    const ys = l.pieces.flatMap((p) => (p.chordLabel ? [p.chordLabel.y] : []));
    expect(new Set(ys).size).toBe(1);
    const y = ys[0];
    const sys = l.systems[0];
    expect(y).toBeLessThan(sys.lineYs[0] - l.staffSpace);
    for (const p of l.pieces) {
      expect(y).toBeLessThan(p.box.y1);
      if (p.stem) expect(y).toBeLessThan(Math.min(p.stem.y1, p.stem.y2));
      for (const ll of p.ledgerLines) expect(y).toBeLessThan(ll.y);
    }
    expect(y).toBeGreaterThan(sys.top);
  });

  it('stays inside the system band for the highest notes; per system on a long melody', () => {
    const hi = layoutMelody([{ ...n('G6'), chord: 'C' }], FOUR, { width: 500 });
    const c = hi.pieces[0].chordLabel!;
    expect(c.y).toBeGreaterThan(hi.systems[0].top + hi.staffSpace);

    const ev = long.map((e, i) => (i % 6 === 0 ? { ...e, chord: 'C' } : e));
    const w = layoutMelody(ev, FOUR, { width: 700 });
    expect(w.systems.length).toBeGreaterThan(1);
    for (const p of w.pieces) {
      if (!p.chordLabel) continue;
      const sys = w.systems[p.system];
      expect(p.chordLabel.y).toBeGreaterThan(sys.top);
      expect(p.chordLabel.y).toBeLessThan(sys.lineYs[0]);
    }
  });

  it('no chords → no labels', () => {
    expect(
      layoutMelody(long, FOUR, { width: 700 }).pieces.some((p) => p.chordLabel),
    ).toBe(false);
  });

  const s = 10; // default staff space

  /** Labels per system with their horizontal extent. */
  const labelsOf = (l: Layout) =>
    l.pieces.flatMap((p) =>
      p.chordLabel
        ? [{ p, c: p.chordLabel, x2: p.chordLabel.x + p.chordLabel.width }]
        : [],
    );
  const noOverlapPerRow = (l: Layout) => {
    const ls = labelsOf(l);
    for (const a of ls) {
      for (const b of ls) {
        if (a === b || a.p.system !== b.p.system || a.c.row !== b.c.row) {
          continue;
        }
        expect(a.x2 <= b.c.x || b.x2 <= a.c.x).toBe(true);
      }
    }
  };

  it('labels have a width from their length; spaced-out labels stay on row 0', () => {
    const l = layoutMelody(
      [
        { ...n('C4'), chord: 'C' },
        { ...n('D4'), chord: 'Cmaj7' },
      ],
      FOUR,
      { width: 800 },
    );
    const [a, b] = labelsOf(l);
    expect(a.c.row).toBe(0);
    expect(b.c.row).toBe(0);
    expect(b.c.width).toBeCloseTo(a.c.width * 5);
  });

  it('dense chords: an overlapping label goes up to row 1, at its own x', () => {
    const ev = Array.from({ length: 8 }, (_, i) => ({
      ...n('E4', 8),
      chord: i % 2 ? 'G7sus4' : 'Cmaj7',
    }));
    const l = layoutMelody(ev, FOUR, { width: 500 });
    const ls = labelsOf(l);
    expect(ls).toHaveLength(8);
    expect(ls.some((x) => x.c.row === 1)).toBe(true);
    for (const x of ls) {
      if (x.c.row === 1) expect(x.c.x).toBe(x.p.glyph.x);
    }
    noOverlapPerRow(l);
    // row 1 sits one row above row 0, inside the system band
    const y0 = ls.find((x) => x.c.row === 0)!.c.y;
    const y1 = ls.find((x) => x.c.row === 1)!.c.y;
    expect(y0 - y1).toBeGreaterThanOrEqual(1.4 * s);
    const sys = l.systems[0];
    expect(y1 - 1.4 * s).toBeGreaterThan(sys.top);
    expect(sys.chordY).toBe(y0);
  });

  it('too dense for two rows: labels shift right, never overlapping', () => {
    const ev = Array.from({ length: 16 }, () => ({
      ...n('E4', 4),
      chord: 'C7(9,13)',
    }));
    const l = layoutMelody(ev, FOUR, { width: 400 });
    const ls = labelsOf(l);
    expect(ls.some((x) => x.c.x > x.p.glyph.x)).toBe(true);
    for (const x of ls) expect(x.c.x).toBeGreaterThanOrEqual(x.p.glyph.x);
    noOverlapPerRow(l);
  });

  it('a second chord row makes room above high notes', () => {
    const ev = Array.from({ length: 8 }, () => ({
      ...n('G6', 8),
      chord: 'Cmaj7',
    }));
    const l = layoutMelody(ev, FOUR, { width: 400 });
    const sys = l.systems[0];
    for (const { c } of labelsOf(l)) {
      expect(c.y - 1.4 * s).toBeGreaterThan(sys.top);
    }
    for (const p of l.pieces) expect(sys.chordY).toBeLessThan(p.box.y1);
  });

  it('every system has a chord baseline, chords or not', () => {
    const l = layoutMelody(long, FOUR, { width: 700 });
    for (const sys of l.systems) {
      expect(sys.chordY).toBeGreaterThan(sys.top);
      expect(sys.chordY).toBeLessThan(sys.lineYs[0]);
    }
  });

  it('hitTestChord finds the event of the label under the point', () => {
    const l = layoutMelody([n('C4'), { ...n('D4'), chord: 'Am7' }], FOUR, {
      width: 800,
    });
    const c = l.pieces[1].chordLabel!;
    expect(hitTestChord(l, c.x + c.width / 2, c.y - 0.5 * s)).toBe(1);
    expect(hitTestChord(l, c.x - 3 * s, c.y)).toBeNull();
    expect(hitTestChord(l, c.x + 1, l.systems[0].lineYs[4])).toBeNull();
  });
});

describe('previewPiece', () => {
  const ev = [n('C4'), n('G4'), r(16)];
  const l = layoutMelody(ev, FOUR, { width: 800 });

  it('notehead centered on the cursor x at the pitch y, same parts as a placed note', () => {
    for (let i = 0; i < l.cursors.length; i++) {
      const p = previewPiece(l, i, 'A4', '8')!;
      expect(p.system).toBe(l.cursors[i].system);
      expect(p.x).toBe(l.cursors[i].x);
      expect(p.y).toBeCloseTo(pitchToY(l, p.system, 'A4'));
      expect(p.glyph.text).toBe(GLYPHS.noteheadBlack);
      expect(p.glyph.x).toBeLessThan(p.x);
      expect(p.stem?.dir).toBe('up');
      expect(p.flag?.text).toBe(GLYPHS.flag8thUp);
      expect(p.ledgerLines).toEqual([]);
      expect(p.accidental).toBeUndefined();
    }
    // Same shape as layoutMelody's piece for the same note (offset in x only).
    const placed = layoutMelody([n('A4', 8)], FOUR, { width: 800 }).pieces[0];
    const pv = previewPiece(l, 0, 'A4', '8')!;
    expect(pv.stem!.y2 - pv.y).toBeCloseTo(placed.stem!.y2 - placed.y);
    expect(pv.stem!.x - pv.glyph.x).toBeCloseTo(
      placed.stem!.x - placed.glyph.x,
    );
  });

  it('ledger lines, accidental, dot and whole notes', () => {
    const c4 = previewPiece(l, 1, 'C#4', '2', true)!;
    expect(c4.ledgerLines).toHaveLength(1);
    expect(c4.ledgerLines[0].y).toBeCloseTo(c4.y);
    expect(c4.accidental?.text).toBe(GLYPHS.accidentalSharp);
    expect(c4.accidental!.x).toBeLessThan(c4.glyph.x);
    expect(c4.dot?.text).toBe(GLYPHS.augmentationDot);
    expect(c4.glyph.text).toBe(GLYPHS.noteheadHalf);
    expect(c4.pitch).toBe('C#4');

    const a5 = previewPiece(l, 0, 'Bb5', '1')!;
    expect(a5.stem).toBeUndefined();
    expect(a5.glyph.text).toBe(GLYPHS.noteheadWhole);
    expect(a5.ledgerLines).toHaveLength(1);
    expect(a5.accidental?.text).toBe(GLYPHS.accidentalFlat);
    expect(previewPiece(l, 0, 'C6', '4')!.stem!.dir).toBe('down');
  });

  it('null for a bad pitch, an out-of-range pitch or cursor', () => {
    expect(previewPiece(l, 0, 'H4', '4')).toBeNull();
    expect(previewPiece(l, 0, 'C2', '4')).toBeNull();
    expect(previewPiece(l, 0, 'C7', '4')).toBeNull();
    expect(previewPiece(l, 99, 'C4', '4')).toBeNull();
    expect(previewPiece(l, -1, 'C4', '4')).toBeNull();
  });

  it('works on later systems', () => {
    const w = layoutMelody(long, FOUR, { width: 700 });
    const i = w.cursors.findIndex((c) => c.system === 1);
    const p = previewPiece(w, i, 'B4', '4')!;
    expect(p.system).toBe(1);
    expect(p.y).toBeCloseTo(w.systems[1].lineYs[2]);
  });
});

describe('stepAt / STEP_RANGE', () => {
  it('unclamped step, consistent with yToPitch inside the range', () => {
    const l = layoutMelody([], FOUR, { width: 500 });
    const s = l.systems[0];
    expect(stepAt(l, 0, s.lineYs[4])).toBe(0);
    expect(stepAt(l, 0, s.lineYs[0])).toBe(8);
    expect(stepAt(l, 0, s.top + 10000)).toBeLessThan(STEP_RANGE.min);
    expect(STEP_RANGE).toEqual({ min: -8, max: 16 });
  });
});

describe('tuplets', () => {
  /** One tuplet group: a pitch per slot, null = rest. */
  const tup = (
    unit: number,
    items: (string | null)[],
    lyric?: string,
  ): MelodyEvent[] =>
    items.map((p, slot) => {
      const tuplet = { n: items.length, slot };
      if (p === null) return { kind: 'rest', ticks: unit, tuplet };
      return {
        ...n(p, unit, slot === 0 ? lyric : undefined),
        tuplet,
      };
    });
  const s = 10;
  const gapsOf = (l: Layout) =>
    l.pieces.slice(1).map((p, i) => p.x - l.pieces[i].x);

  it('spaces tuplet slots by their real length, not the written one', () => {
    // 8th triplet (3 × 16/3) | two 8ths | 16th quintuplet (5 × 16/5) | four 16ths
    const ev = [
      ...tup(8, ['C5', 'C5', 'C5']),
      n('C5', 8),
      n('C5', 8),
      ...tup(4, ['C5', 'C5', 'C5', 'C5', 'C5']),
      ...Array.from({ length: 4 }, () => n('C5', 4)),
    ];
    const l = layoutMelody(ev, FOUR, { width: 2000 });
    const g = gapsOf(l);
    const tri = g[0];
    const eighth = g[3];
    const quint = g[5];
    const sixteenth = g[10];
    // Springs: 1.2 + log2(real / 2) staff spaces (unstretched last system).
    const spr = (t: number) => 1.2 + Math.log2(t / 2);
    expect(eighth - tri).toBeCloseTo((spr(8) - spr(16 / 3)) * s);
    expect(sixteenth - quint).toBeCloseTo((spr(4) - spr(16 / 5)) * s);
    expect(tri).toBeLessThan(eighth);
    expect(tri).toBeGreaterThan(sixteenth);
    expect(quint).toBeLessThan(sixteenth);
    // the whole bar is full → one barline after it
    expect(l.systems[0].barlines).toHaveLength(1);
  });

  it('a bar filled with tuplets is complete; an incomplete one is not', () => {
    const full = layoutMelody(
      [...tup(16, ['C5', 'D5', 'E5']), n('F4', 32), n('G4', 16)],
      FOUR,
      { width: 1200 },
    );
    expect(full.systems[0].barlines).toHaveLength(1);
    expect(full.pieces.map((p) => p.bar)).toEqual([0, 0, 0, 0, 1]);

    const quints = layoutMelody(
      [1, 2, 3, 4].flatMap(() => tup(4, ['C5', 'C5', 'C5', 'C5', 'C5'])),
      FOUR,
      { width: 1600 },
    );
    expect(quints.systems[0].barlines).toHaveLength(1);
    // end cursor after the barline
    const end = quints.cursors.at(-1)!;
    expect(end.x).toBeGreaterThan(quints.systems[0].barlines[0]);

    const part = layoutMelody(tup(8, ['C5', 'D5', 'E5']), FOUR, {
      width: 800,
    });
    expect(part.systems[0].barlines).toHaveLength(0);
  });

  it('one bracket per group with the right n, event range and x range', () => {
    const ev = [
      n('G4', 16),
      ...tup(8, ['A4', 'G4', 'F4']),
      ...tup(4, ['E4', 'F4', 'G4', 'A4', 'G4']),
      n('E4', 28),
    ];
    const l = layoutMelody(ev, FOUR, { width: 1000 });
    expect(l.tuplets.map((t) => [t.start, t.end, t.n])).toEqual([
      [1, 4, 3],
      [4, 9, 5],
    ]);
    expect(l.tuplets[0].number.text).toBe('');
    expect(l.tuplets[1].number.text).toBe('');
    expect(l.thickness.tuplet).toBeGreaterThan(0);
    for (const t of l.tuplets) {
      expect(t.line).toHaveLength(4);
      expect(t.system).toBe(0);
      const own = l.pieces.slice(t.start, t.end);
      const left = Math.min(...t.line.map((x) => Math.min(x.x1, x.x2)));
      const right = Math.max(...t.line.map((x) => Math.max(x.x1, x.x2)));
      // covers the group's glyphs, stays clear of the neighbours
      expect(left).toBeLessThanOrEqual(own[0].glyph.x + 1e-9);
      expect(right).toBeGreaterThanOrEqual(
        own.at(-1)!.glyph.x + 1.18 * s - 1e-9,
      );
      expect(left).toBeGreaterThan(l.pieces[t.start - 1].box.x2 - s);
      expect(t.number.x).toBeGreaterThan(left);
      expect(t.number.x).toBeLessThan(right);
      // stems up → above every stem tip
      expect(t.side).toBe('above');
      const y = t.line[1].y1;
      for (const p of own) expect(y).toBeLessThan(p.stem!.y2);
    }
    // the two brackets don't overlap
    expect(l.tuplets[0].line[3].x1).toBeLessThan(l.tuplets[1].line[0].x1);
  });

  it('no tuplets → empty list', () => {
    expect(layoutMelody([n('C4')], FOUR, { width: 500 }).tuplets).toEqual([]);
  });

  it('side: majority of stems; ties and any lyric → above', () => {
    const side = (ev: MelodyEvent[]) =>
      layoutMelody(ev, FOUR, { width: 800 }).tuplets[0].side;
    expect(side(tup(8, ['C4', 'C5', 'D5']))).toBe('below');
    expect(side(tup(8, ['C4', 'E4', 'D5']))).toBe('above');
    expect(side(tup(8, ['C5', 'D5', 'E5'], 'ら'))).toBe('above');
    // 6-tuplet, 3 up / 3 down → above
    expect(side(tup(8, ['C4', 'D4', 'E4', 'C5', 'D5', 'E5']))).toBe('above');
    // a rest doesn't vote
    expect(side(tup(8, [null, 'C5', 'D5']))).toBe('below');
  });

  it('mixed stems: the bracket clears stem tips on its side and the other noteheads', () => {
    const below = layoutMelody(tup(8, ['C4', 'C5', 'D5']), FOUR, {
      width: 800,
    });
    const tb = below.tuplets[0];
    const yb = tb.line[1].y1;
    const [up, d1, d2] = below.pieces;
    expect(yb).toBeGreaterThan(d1.stem!.y2);
    expect(yb).toBeGreaterThan(d2.stem!.y2);
    expect(yb).toBeGreaterThan(up.y + 0.5 * s);
    // hooks point back toward the notes
    expect(tb.line[0].y2).toBeLessThan(yb);

    const above = layoutMelody(tup(8, ['A5', 'C4', 'D4']), FOUR, {
      width: 800,
    });
    const ta = above.tuplets[0];
    const ya = ta.line[1].y1;
    expect(ta.side).toBe('above');
    expect(ya).toBeLessThan(above.pieces[0].y - 0.5 * s); // stem-down A5's head
    expect(ya).toBeLessThan(above.pieces[1].stem!.y2);
    expect(ta.line[0].y2).toBeGreaterThan(ya);
  });

  it('an all-rest group: bracket above, clear of every rest glyph', () => {
    const l = layoutMelody(tup(8, [null, null, null]), FOUR, { width: 800 });
    expect(l.tuplets).toHaveLength(1);
    const t = l.tuplets[0];
    expect(t.side).toBe('above');
    const y = t.line[1].y1;
    for (const p of l.pieces) {
      expect(p.kind).toBe('rest');
      expect(p.glyph.text).toBe(GLYPHS.rest8th);
      expect(y).toBeLessThan(p.y - 0.7 * s);
    }
    // quarter rests reach higher → the bracket moves up too
    const q = layoutMelody(tup(16, [null, null, null]), FOUR, { width: 800 });
    expect(q.tuplets[0].line[1].y1).toBeLessThan(y);
  });

  it('chord labels sit above an above-side bracket and its number', () => {
    const ev = tup(32, ['C4', 'D4', 'E4']);
    ev[0] = { ...ev[0], chord: 'C' };
    const l = layoutMelody(ev, FOUR, { width: 800 });
    const t = l.tuplets[0];
    expect(l.pieces[0].chordLabel!.y).toBeLessThan(t.line[1].y1 - 0.9 * s);
    expect(l.pieces[0].chordLabel!.y).toBeGreaterThan(l.systems[0].top);
  });

  it('cursors and hit testing around and inside a group', () => {
    const ev = [n('C4', 16), ...tup(8, ['C5', 'D5', 'E5']), n('F4', 16)];
    const l = layoutMelody(ev, FOUR, { width: 800 });
    expect(l.cursors).toHaveLength(ev.length + 1);
    for (let i = 0; i < ev.length; i++) {
      const p = l.pieces[i];
      expect(p.eventIndex).toBe(i);
      expect(l.cursors[i].x).toBeLessThan(p.box.x1);
      if (i > 0) expect(l.cursors[i].x).toBeGreaterThan(l.pieces[i - 1].box.x2);
      expect(hitTestNote(l, p.x, p.y)).toBe(i);
    }
    expect(l.cursors[ev.length].x).toBeGreaterThan(l.pieces.at(-1)!.box.x2);
    const y = l.systems[0].lineYs[2];
    // group start (1), inside (2, 3), group end (4)
    for (const c of [1, 2, 3, 4]) {
      expect(nearestCursor(l, l.cursors[c].x + 0.5, y)).toBe(c);
    }
    // between two tuplet notes there is no note
    const [, a, b] = l.pieces;
    expect(hitTestNote(l, (a.box.x2 + b.box.x1) / 2, a.y)).toBeNull();
  });

  it('a bracket clearing a very high note stays inside its (taller) system band', () => {
    // G6 has its stem down among low notes → bracket above, past TOP_PAD.
    const high = [
      ...tup(8, ['D3', 'G6', 'E3']),
      ...tup(8, ['Gb6', 'C4', 'D4']),
    ];
    const plain = layoutMelody([n('C4')], FOUR, { width: 600 });
    const base = plain.systems[0].height;
    const inBand = (l: Layout) => {
      for (const t of l.tuplets) {
        const sys = l.systems[t.system];
        for (const seg of t.line) {
          for (const y of [seg.y1, seg.y2]) {
            expect(y).toBeGreaterThan(sys.top);
            expect(y).toBeLessThan(sys.top + sys.height);
          }
        }
        // number baseline and digit top (0.9 staff space above the line)
        expect(t.number.y).toBeLessThan(sys.top + sys.height);
        expect(t.line[1].y1 - 0.9 * s).toBeGreaterThan(sys.top);
      }
    };
    const l = layoutMelody(high, FOUR, { width: 600 });
    expect(l.tuplets.map((t) => t.side)).toEqual(['above', 'above']);
    inBand(l);
    expect(l.systems[0].height).toBeGreaterThan(base);
    expect(l.height).toBe(l.systems[0].height);
    // pitch ↔ y still matches the shifted staff
    expect(pitchToY(l, 0, 'G6')).toBeCloseTo(l.pieces[1].y);
    expect(yToPitch(l, 0, l.pieces[1].y)).toBe('G6');

    // with a chord: the label still fits between the system top and the number
    const withChord = high.map((e) => ({ ...e }));
    withChord[0] = { ...withChord[0], chord: 'C' };
    const c = layoutMelody(withChord, FOUR, { width: 600 });
    inBand(c);
    const label = c.pieces[0].chordLabel!;
    expect(label.y).toBeGreaterThan(c.systems[0].top);
    expect(label.y).toBeLessThan(c.tuplets[0].line[1].y1 - 0.9 * s);

    // multi-system: only the system that needs it grows; bands stay stacked
    const ev = [
      ...Array.from({ length: 6 }, () => n('C5', 64)),
      ...high.map((e) => ({ ...e })),
      ...Array.from({ length: 6 }, () => n('C5', 64)),
    ];
    const m = layoutMelody(ev, FOUR, { width: 500 });
    inBand(m);
    expect(m.systems.length).toBeGreaterThan(2);
    for (let i = 1; i < m.systems.length; i++) {
      const a = m.systems[i - 1];
      expect(m.systems[i].top).toBeCloseTo(a.top + a.height);
    }
    const tall = m.systems.filter((x) => x.height > base + 1e-9);
    expect(tall.map((x) => x.index)).toEqual([m.tuplets[0].system]);
    expect(m.height).toBeCloseTo(m.systems.reduce((k, x) => k + x.height, 0));
  });

  it('a group is never split across systems', () => {
    const bar = [
      ...tup(8, ['C5', 'D5', 'E5']),
      ...tup(8, ['F5', 'E5', 'D5']),
      ...tup(4, ['C5', 'D5', 'E5', 'F5', 'G5']),
      ...tup(4, ['A4', 'B4', 'C5', 'D5', 'E5']),
    ];
    // distinct objects: layoutMelody maps events by identity
    const ev = Array.from({ length: 8 }, () =>
      bar.map((e) => ({ ...e })),
    ).flat();
    const l = layoutMelody(ev, FOUR, { width: 500 });
    expect(l.systems.length).toBeGreaterThan(1);
    expect(l.tuplets).toHaveLength(32);
    for (const t of l.tuplets) {
      const systems = new Set(
        l.pieces.slice(t.start, t.end).map((p) => p.system),
      );
      expect([...systems]).toEqual([t.system]);
    }
    expect(l.systems.reduce((k, x) => k + x.barlines.length, 0)).toBe(8);
  });
});

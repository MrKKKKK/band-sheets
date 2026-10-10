import { describe, expect, it } from 'vitest';
import type { DrumEvent, DrumHit } from './drum';
import { DRUM_KIT, type DrumInstrument } from './drumKit';
import {
  breakSystems,
  DRUM_GLYPHS,
  hitTestDrums,
  instrumentY,
  layoutDrums,
  previewDrum,
  yToInstrument,
  type DrumBeatLayout,
  type DrumLayout,
} from './drumLayout';
import type { TimeSig } from './melody';

const S = 10;
const TS: TimeSig = { num: 4, den: 4 };

type Spec = DrumInstrument | `${DrumInstrument}:${'g' | 'ac' | 'hac'}`;
const hit = (spec: Spec): DrumHit => {
  const [inst, eff] = spec.split(':') as [DrumInstrument, string | undefined];
  if (eff === 'g') return { inst, ghost: true };
  if (eff === 'ac') return { inst, accent: 'normal' };
  if (eff === 'hac') return { inst, accent: 'heavy' };
  return { inst };
};
const b = (ticks: number, ...hits: Spec[]): DrumEvent => ({
  hits: hits.map(hit),
  ticks,
});
const r = (ticks: number): DrumEvent => ({ hits: [], ticks });
const group = (n: number, items: DrumEvent[]): DrumEvent[] =>
  items.map((e, slot) => ({ ...e, tuplet: { n, slot } }));

const lay = (events: DrumEvent[], width = 800, extra = {}) =>
  layoutDrums(events, TS, { width, staffSpace: S, ...extra });

/** y of a staff step on system `si`. */
const yAt = (l: DrumLayout, si: number, step: number) =>
  l.systems[si].lineYs[0] + (8 - step) * (S / 2);

const head = (beat: DrumBeatLayout, inst: DrumInstrument) =>
  beat.heads.find((h) => h.inst === inst)!;

describe('layoutDrums: staff', () => {
  it('draws an empty section: 5 lines, percussion clef, time signature, one cursor', () => {
    const l = lay([]);
    expect(l.systems).toHaveLength(1);
    const sys = l.systems[0];
    expect(sys.lineYs).toHaveLength(5);
    for (let i = 1; i < 5; i++) {
      expect(sys.lineYs[i] - sys.lineYs[i - 1]).toBeCloseTo(S);
    }
    expect(sys.clef.text).toBe('');
    expect(sys.clef.y).toBeCloseTo(sys.lineYs[2]);
    expect(sys.timeSig?.num.text).toBe('');
    expect(sys.timeSig?.den.text).toBe('');
    expect(l.cursors).toHaveLength(1);
    expect(l.cursors[0].x).toBeGreaterThan(sys.timeSig!.num.x);
    expect(l.beats).toEqual([]);
    expect(l.fontSize).toBe(4 * S);
    expect(l.shuffle).toBeUndefined();
  });

  it('puts every instrument at its kit step with its notehead shape', () => {
    const l = lay(DRUM_KIT.map((e) => b(16, e.id)).slice(0, 8));
    const l2 = lay([b(16, 'BD')]);
    const glyphOf = {
      normal: DRUM_GLYPHS.noteheadBlack,
      x: DRUM_GLYPHS.noteheadXBlack,
      circleX: DRUM_GLYPHS.noteheadCircleX,
      heavyX: DRUM_GLYPHS.noteheadHeavyX,
    };
    const all = [...l.beats, ...l2.beats];
    const ls = [...l.beats.map(() => l), l2];
    all.forEach((beat, i) => {
      const h = beat.heads[0];
      const entry = DRUM_KIT.find((e) => e.id === h.inst)!;
      expect(h.step).toBe(entry.step);
      expect(h.y).toBeCloseTo(yAt(ls[i], beat.system, entry.step));
      expect(h.glyph.text).toBe(glyphOf[entry.head]);
      expect(h.shape).toBe(entry.head);
      expect(instrumentY(ls[i], beat.system, h.inst)).toBeCloseTo(h.y);
    });
    expect(head(l.beats[0], 'CR').glyph.text).toBe('');
    expect(head(l.beats[2], 'HO').glyph.text).toBe('');
  });

  it('uses half / whole notehead variants; whole notes have no stem', () => {
    const l = lay([b(32, 'SD'), b(32, 'HH')]);
    expect(l.beats[0].heads[0].glyph.text).toBe(DRUM_GLYPHS.noteheadHalf);
    expect(l.beats[1].heads[0].glyph.text).toBe(DRUM_GLYPHS.noteheadXHalf);
    expect(l.beats[0].stem).toBeDefined();
    const w = lay([b(64, 'HO')]);
    expect(w.beats[0].heads[0].glyph.text).toBe(
      DRUM_GLYPHS.noteheadCircleXWhole,
    );
    expect(w.beats[0].stem).toBeUndefined();
    expect(w.beats[0].flag).toBeUndefined();
  });

  it('draws a ledger line for the crash only', () => {
    const l = lay([b(16, 'CR'), b(16, 'HH'), b(16, 'BD')]);
    const [cr, hh, bd] = l.beats;
    expect(cr.ledgerLines).toHaveLength(1);
    expect(cr.ledgerLines[0].y).toBeCloseTo(yAt(l, 0, 10));
    expect(cr.ledgerLines[0].x1).toBeLessThan(cr.heads[0].glyph.x);
    expect(hh.ledgerLines).toEqual([]);
    expect(bd.ledgerLines).toEqual([]);
  });
});

describe('layoutDrums: stems, flags, dots', () => {
  it('stems always point up from the lowest notehead past the highest', () => {
    const l = lay([b(16, 'HH', 'BD'), b(16, 'BD'), b(16, 'CR')]);
    const [chord, bd, cr] = l.beats;
    const mid = l.systems[0].lineYs[2];
    for (const beat of l.beats) {
      expect(beat.stem!.y2).toBeLessThan(beat.stem!.y1);
      expect(beat.stem!.y2).toBeLessThanOrEqual(mid + 1e-9);
    }
    expect(chord.stem!.y1).toBeGreaterThan(head(chord, 'HH').y);
    expect(chord.stem!.y1).toBeLessThanOrEqual(head(chord, 'BD').y);
    expect(chord.stem!.y2).toBeCloseTo(head(chord, 'HH').y - 3.5 * S);
    // A low note's stem still reaches the middle line at least.
    expect(bd.stem!.y2).toBeLessThanOrEqual(mid);
    expect(cr.stem!.y2).toBeCloseTo(head(cr, 'CR').y - 3.5 * S);
    // Stem on the right side of the noteheads.
    const h = head(chord, 'BD');
    expect(chord.stem!.x).toBeGreaterThan(h.x);
    expect(chord.stem!.x).toBeLessThan(h.glyph.x + 1.18 * S);
  });

  it('aligns noteheads of different widths on the stem side', () => {
    const l = lay([b(16, 'CR', 'BD')]);
    const beat = l.beats[0];
    const cr = head(beat, 'CR');
    const bd = head(beat, 'BD');
    expect(cr.glyph.x + 1.54 * S).toBeCloseTo(bd.glyph.x + 1.18 * S);
    expect(beat.headAlignX).toBeCloseTo(bd.glyph.x + 1.18 * S);
  });

  it('gives 8th / 16th / 32nd notes one up-flag at the stem tip, none for quarters', () => {
    const l = lay([b(16, 'SD'), b(8, 'SD'), b(4, 'SD'), b(2, 'SD')]);
    expect(l.beats[0].flag).toBeUndefined();
    expect(l.beats.slice(1).map((x) => x.flag!.text)).toEqual(['', '', '']);
    for (const beat of l.beats.slice(1)) {
      expect(beat.flag!.y).toBeCloseTo(beat.stem!.y2);
    }
    // Longer stems for more flags.
    const len = (x: DrumBeatLayout) => x.stem!.y1 - x.stem!.y2;
    expect(len(l.beats[2])).toBeGreaterThan(len(l.beats[1]));
    expect(len(l.beats[3])).toBeGreaterThan(len(l.beats[2]));
  });

  it('puts the dots of a flagged beat right of the flag, in one column', () => {
    const flagW = { '\uE240': 1.06, '\uE242': 1.12, '\uE244': 1.05 };
    const l = lay([
      b(12, 'RD', 'BD'),
      b(12, 'HH'),
      b(6, 'HH', 'SD:g'),
      b(6, 'HH', 'RD'),
      b(24, 'RD', 'BD'),
    ]);
    for (const beat of l.beats.slice(0, 4)) {
      const flagRight =
        beat.flag!.x + flagW[beat.flag!.text as keyof typeof flagW] * S;
      expect(beat.dots.length).toBeGreaterThan(0);
      for (const d of beat.dots) {
        expect(d.x).toBeGreaterThanOrEqual(flagRight + 0.3 * S);
        expect(d.x).toBeCloseTo(beat.dots[0].x);
      }
      expect(beat.box.x2).toBeGreaterThanOrEqual(beat.dots[0].x + 0.4 * S);
    }
    // Spacing makes room: the next beat starts after the dots.
    for (let i = 0; i < 4; i++) {
      expect(l.beats[i + 1].box.x1).toBeGreaterThan(l.beats[i].box.x2);
    }
    // No flag: dots stay next to the noteheads.
    const q = l.beats[4];
    expect(q.dots[0].x).toBeLessThan(
      head(q, 'BD').glyph.x + 1.18 * S + 0.5 * S,
    );
  });

  it('dots each distinct space of a dotted chord (line notes dot the space above)', () => {
    const l = lay([b(24, 'HH', 'SD', 'BD'), b(24, 'T2', 'SD'), r(16)]);
    const [a, t] = l.beats;
    expect(a.dots.map((d) => d.y)).toEqual(
      [9, 5, 1].map((st) => yAt(l, 0, st)),
    );
    // T2 (step 6, a line) → 7; SD (5) → 5.
    expect(t.dots.map((d) => d.y)).toEqual([7, 5].map((st) => yAt(l, 0, st)));
    for (const d of a.dots) {
      expect(d.text).toBe('');
      expect(d.x).toBeGreaterThan(head(a, 'HH').glyph.x + 1.16 * S);
    }
  });

  it('draws rests with their glyphs; a dotted rest gets one dot', () => {
    const l = lay([r(16), r(8), r(4), r(2), r(12), r(6), r(16)]);
    expect(l.beats.map((x) => x.rest!.text)).toEqual([
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    for (const beat of l.beats) {
      expect(beat.kind).toBe('rest');
      expect(beat.heads).toEqual([]);
      expect(beat.stem).toBeUndefined();
    }
    expect(l.beats[4].dots).toHaveLength(1);
    expect(l.beats[0].dots).toHaveLength(0);
    const whole = lay([r(64)]);
    expect(whole.beats[0].rest!.text).toBe('');
    expect(whole.beats[0].rest!.y).toBeCloseTo(yAt(whole, 0, 6));
  });
});

describe('layoutDrums: seconds, ghosts, accents', () => {
  it('moves the upper note of a second to the right of the stem', () => {
    const l = lay([
      b(16, 'HH', 'RD'),
      b(16, 'CR', 'HH', 'RD'),
      b(16, 'HH', 'SD'),
    ]);
    const [a, c, plain] = l.beats;
    expect(head(a, 'RD').shifted).toBe(false);
    expect(head(a, 'HH').shifted).toBe(true);
    expect(head(a, 'HH').glyph.x).toBeGreaterThanOrEqual(a.stem!.x - 1e-9);
    expect(head(a, 'RD').glyph.x).toBeLessThan(a.stem!.x);
    // 8 / 9 / 10: alternate.
    expect(c.heads.map((h) => [h.inst, h.shifted])).toEqual([
      ['CR', false],
      ['HH', true],
      ['RD', false],
    ]);
    expect(plain.heads.every((h) => !h.shifted)).toBe(true);
    // The shifted head widens the beat.
    expect(a.box.x2 - a.box.x1).toBeGreaterThan(plain.box.x2 - plain.box.x1);
  });

  it('wraps a ghost note in parentheses (SVG paths) and widens its box', () => {
    const l = lay([b(16, 'HH', 'SD:g'), b(16, 'HH', 'SD')]);
    const g = head(l.beats[0], 'SD');
    expect(g.ghost).toBeDefined();
    expect(head(l.beats[0], 'HH').ghost).toBeUndefined();
    expect(head(l.beats[1], 'SD').ghost).toBeUndefined();
    const nums = (d: string) => d.match(/-?[\d.]+/g)!.map(Number);
    const [lx1, ly1, lcx, , lx2, ly2] = nums(g.ghost!.left);
    expect(g.ghost!.left.startsWith('M ')).toBe(true);
    expect(lx1).toBeLessThan(g.glyph.x);
    expect(lcx).toBeLessThan(lx1);
    expect(lx2).toBeCloseTo(lx1);
    expect(ly1).toBeLessThan(g.y);
    expect(ly2).toBeGreaterThan(g.y);
    const [rx1, , rcx] = nums(g.ghost!.right);
    expect(rx1).toBeGreaterThan(g.glyph.x + 1.18 * S);
    expect(rcx).toBeGreaterThan(rx1);
    expect(g.box.x1).toBeLessThanOrEqual(lcx);
    expect(g.box.x2).toBeGreaterThanOrEqual(rcx);
    expect(l.thickness.ghost).toBeGreaterThan(0);
  });

  it('draws one > / ^ per beat above the stem tip, > below ^ when both', () => {
    const l = lay([
      b(16, 'HH:ac', 'BD'),
      b(16, 'CR:hac'),
      b(16, 'HH:ac', 'SD:hac', 'BD:ac'),
      b(16, 'SD'),
    ]);
    const [acc, heavy, both, none] = l.beats;
    expect(acc.accents.map((a) => a.text)).toEqual(['']);
    expect(heavy.accents.map((a) => a.text)).toEqual(['']);
    expect(both.accents.map((a) => a.text)).toEqual(['', '']);
    expect(none.accents).toEqual([]);
    expect(acc.accents[0].y).toBeLessThan(acc.stem!.y2);
    expect(both.accents[1].y).toBeLessThan(both.accents[0].y - S * 0.9);
    // Centered on the notehead column.
    const center = acc.accents[0].x + (1.36 * S) / 2;
    expect(center).toBeCloseTo(acc.x);
    expect(both.top).toBeLessThan(both.accents[1].y - 0.9 * S);
  });
});

describe('layoutDrums: spacing, bars, systems', () => {
  it('spaces by real length: quarters wider than 8ths, triplet 8ths narrower than 8ths', () => {
    const l = lay([
      b(16, 'SD'),
      b(16, 'SD'),
      b(8, 'SD'),
      b(8, 'SD'),
      ...group(3, [b(8, 'SD'), b(8, 'SD'), b(8, 'SD')]),
    ]);
    const x = l.beats.map((beat) => beat.x);
    const quarter = x[1] - x[0];
    const eighth = x[3] - x[2];
    const triplet = x[5] - x[4];
    expect(quarter).toBeGreaterThan(eighth);
    expect(eighth).toBeGreaterThan(triplet);
    expect(x[6] - x[5]).toBeCloseTo(triplet);
  });

  it('draws a barline after each complete bar only', () => {
    const l = lay([
      ...Array.from({ length: 4 }, () => b(16, 'SD')),
      b(16, 'BD'),
      b(16, 'BD'),
    ]);
    const sys = l.systems[0];
    expect(sys.barlines).toHaveLength(1);
    expect(sys.barlines[0]).toBeGreaterThan(l.beats[3].box.x2);
    expect(sys.barlines[0]).toBeLessThan(l.beats[4].box.x1);
    expect(l.beats.map((x) => x.bar)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(sys.barCount).toBe(2);
  });

  it('wraps whole bars onto new systems; a tuplet group stays on one system', () => {
    const bar = (): DrumEvent[] => [
      ...group(
        6,
        Array.from({ length: 6 }, () => b(4, 'HH')),
      ),
      ...Array.from({ length: 6 }, () => b(8, 'HH', 'BD')),
    ];
    const events = [...bar(), ...bar(), ...bar(), ...bar(), ...bar(), ...bar()];
    const l = lay(events, 400);
    expect(l.systems.length).toBeGreaterThan(1);
    for (let i = 1; i < l.systems.length; i++) {
      const prev = l.systems[i - 1];
      expect(l.systems[i].top).toBeCloseTo(prev.top + prev.height);
      expect(l.systems[i].timeSig).toBeUndefined();
      expect(l.systems[i].firstBar).toBe(prev.firstBar + prev.barCount);
    }
    // Every bar lies on one system.
    const sysOfBar = new Map<number, Set<number>>();
    for (const beat of l.beats) {
      if (!sysOfBar.has(beat.bar)) sysOfBar.set(beat.bar, new Set());
      sysOfBar.get(beat.bar)!.add(beat.system);
      expect(beat.box.x2).toBeLessThanOrEqual(l.width);
    }
    for (const set of sysOfBar.values()) expect(set.size).toBe(1);
    for (const t of l.tuplets) {
      const systems = new Set(
        l.beats.slice(t.start, t.end).map((x) => x.system),
      );
      expect([...systems]).toEqual([t.system]);
    }
    expect(l.height).toBeCloseTo(
      l.systems.reduce((sum, sys) => sum + sys.height, 0),
    );
  });

  it('does not spread a lone bar much looser than its neighbours (sample song)', () => {
    const eight = (): DrumEvent[] =>
      Array.from({ length: 8 }, (_, i) =>
        i % 4 === 2 ? b(8, 'HH', 'SD') : b(8, 'HH', 'BD'),
      );
    const last: DrumEvent[] = [
      ...eight().slice(0, 6),
      ...Array.from({ length: 4 }, () => b(4, 'SD')),
    ];
    const l = lay([...eight(), ...eight(), ...eight(), ...last], 800);
    // Mean 8th-note gap per system (within bars).
    const gaps = l.systems.map((sys) => {
      const own = l.beats.filter(
        (x, i) =>
          x.system === sys.index &&
          l.beats[i + 1]?.bar === x.bar &&
          x.eventIndex < 24,
      );
      const d = own.map((x) => l.beats[x.eventIndex + 1].x - x.x);
      return d.length ? d.reduce((a, c) => a + c, 0) / d.length : NaN;
    });
    const real = gaps.filter((g) => !Number.isNaN(g));
    expect(real.length).toBeGreaterThan(1);
    expect(Math.max(...real) / Math.min(...real)).toBeLessThan(1.6);
  });

  it('left-aligns a justified system that would stretch over 1.5×', () => {
    // A long bar forces a break, leaving one short bar on system 0.
    const short = Array.from({ length: 4 }, () => b(16, 'SD'));
    const long = Array.from({ length: 32 }, () => b(2, 'HH'));
    const l = lay([...short, ...long, ...short], 500);
    expect(l.beats[0].system).toBe(0);
    expect(l.beats[4].system).toBe(1);
    const sys0 = l.systems[0];
    // The first bar's barline is well left of the staff end.
    expect(sys0.barlines[sys0.barlines.length - 1]).toBeLessThan(
      sys0.lineX2 - 5 * S,
    );
  });

  it('throws on events that are not normalized (a beat across the barline)', () => {
    expect(() => lay([b(48, 'SD'), b(32, 'SD')])).toThrow(RangeError);
  });
});

describe('breakSystems', () => {
  const avail = () => 20;
  it('uses the greedy number of systems, balanced', () => {
    // Greedy: [12 4 4] [15] [15] — balanced moves a 4 down.
    expect(breakSystems([12, 4, 4, 15, 15], avail)).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
  });
  it('keeps a fitting single system, an empty one, and an overlong bar alone', () => {
    expect(breakSystems([5, 5, 5], avail)).toEqual([[0, 1, 2]]);
    expect(breakSystems([], avail)).toEqual([[]]);
    expect(breakSystems([5, 30, 5], avail)).toEqual([[0], [1], [2]]);
  });
  it("respects each system's own room (the first is narrower)", () => {
    const roomOf = (i: number) => (i === 0 ? 10 : 20);
    const out = breakSystems([6, 6, 6, 6], roomOf);
    expect(out[0]).toEqual([0]);
    expect(out.flat()).toEqual([0, 1, 2, 3]);
  });
});

describe('layoutDrums: tuplets', () => {
  it('draws one bracket above each group, clearing stems, accents and rests', () => {
    const l = lay([
      ...group(3, [b(8, 'HH', 'SD'), b(8, 'HH:ac'), r(8)]),
      ...group(3, [r(8), r(8), r(8)]),
      b(16, 'SD'),
      b(16, 'SD'),
    ]);
    expect(l.tuplets).toHaveLength(2);
    const [t, rests] = l.tuplets;
    expect(t).toMatchObject({ start: 0, end: 3, n: 3, side: 'above' });
    expect(t.number.text).toBe('');
    expect(t.line).toHaveLength(4);
    const lineY = t.line[1].y1;
    for (const beat of l.beats.slice(0, 3)) {
      expect(lineY).toBeLessThan(beat.top);
    }
    expect(lineY).toBeLessThan(l.beats[1].accents[0].y - 0.98 * S);
    expect(t.line[0].x1).toBeLessThanOrEqual(
      l.beats[0].heads[0].glyph.x + 1e-9,
    );
    // All-rest group: above the rest glyphs' tops.
    for (const beat of l.beats.slice(3, 6)) {
      expect(rests.line[1].y1).toBeLessThan(beat.top);
      expect(beat.top).toBeLessThan(beat.rest!.y);
    }
  });

  it('labels 13-tuplets and keeps everything inside the system band', () => {
    const l = lay(
      group(
        13,
        Array.from({ length: 13 }, () => b(2, 'CR:ac', 'HH:hac')),
      ),
    );
    expect(l.tuplets[0].number.text).toBe('');
    const sys = l.systems[0];
    const numberTop = l.tuplets[0].line[1].y1 - 0.9 * S;
    expect(numberTop).toBeGreaterThanOrEqual(sys.top);
    for (const beat of l.beats) expect(beat.top).toBeGreaterThan(sys.top);
    // More room above the staff than a plain section.
    const plain = lay([b(16, 'SD')]);
    expect(sys.lineYs[0] - sys.top).toBeGreaterThan(
      plain.systems[0].lineYs[0] - plain.systems[0].top,
    );
  });
});

describe('layoutDrums: Shuffle marking', () => {
  it('has none for shuffle none', () => {
    expect(
      lay([b(16, 'SD')], 800, { shuffle: 'none' }).shuffle,
    ).toBeUndefined();
  });

  it('8th shuffle: label + two beamed 8ths = quarter + flagged 8th under a 3', () => {
    const plain = lay([b(16, 'SD')]);
    const l = lay([b(16, 'SD')], 800, { shuffle: '8' });
    const m = l.shuffle!;
    expect(m.shuffle).toBe('8');
    expect(m.system).toBe(0);
    expect(m.label.text).toBe('Shuffle');
    expect(m.heads).toHaveLength(4);
    expect(m.heads.every((h) => h.text === DRUM_GLYPHS.noteheadBlack)).toBe(
      true,
    );
    expect(m.stems).toHaveLength(4);
    expect(m.beams).toHaveLength(1);
    expect(m.flags.map((f) => f.text)).toEqual(['']);
    expect(m.equals.text).toBe('=');
    expect(m.tuplet.number.text).toBe('');
    expect(m.fontSize).toBeLessThan(l.fontSize);
    // Order: label, left pair, '=', right pair.
    expect(m.label.x).toBeLessThan(m.heads[0].x);
    expect(m.heads[1].x).toBeLessThan(m.equals.x);
    expect(m.equals.x).toBeLessThan(m.heads[2].x);
    // The bracket is over the right pair only.
    expect(m.tuplet.line[0].x1).toBeGreaterThan(m.equals.x);
    // Its own band above the staff on system 0: the staff moves down.
    const sys = l.systems[0];
    expect(sys.lineYs[0] - sys.top).toBeCloseTo(
      plain.systems[0].lineYs[0] - plain.systems[0].top + 4 * S,
    );
    expect(m.box.y1).toBeGreaterThanOrEqual(sys.top);
    expect(m.box.y2).toBeLessThan(sys.lineYs[0] - 4 * S);
    expect(m.box.x2).toBeLessThan(l.width);
  });

  it('16th shuffle: two double-beamed 16ths = 8th + 16th (full + partial beam)', () => {
    const m = lay([b(16, 'SD')], 800, { shuffle: '16' }).shuffle!;
    expect(m.flags).toEqual([]);
    expect(m.beams).toHaveLength(4);
    const [l1, l2, r1, r2] = m.beams;
    expect(l1.x1).toBeCloseTo(l2.x1);
    expect(l1.x2).toBeCloseTo(l2.x2);
    expect(r2.x2).toBeCloseTo(r1.x2);
    expect(r2.x1).toBeGreaterThan(r1.x1);
    expect(l2.y).toBeGreaterThan(l1.y);
  });

  it('leaves room between "=" and the right-hand figure', () => {
    for (const sh of ['8', '16'] as const) {
      const m = lay([], 800, { shuffle: sh }).shuffle!;
      const fs = m.fontSize / 4;
      expect(m.heads[2].x - m.equals.x).toBeGreaterThanOrEqual(1.8 * fs);
      expect(m.equals.x - (m.heads[1].x + 1.18 * fs)).toBeGreaterThanOrEqual(
        1.2 * fs,
      );
    }
  });

  it('is drawn even without beats', () => {
    expect(lay([], 800, { shuffle: '8' }).shuffle).toBeDefined();
  });
});

describe('layoutDrums: cursors', () => {
  it('has events + 1 insertion points, between the beats, in order', () => {
    const l = lay([
      b(16, 'SD'),
      b(16, 'SD'),
      b(16, 'SD'),
      b(16, 'SD'),
      b(8, 'BD'),
    ]);
    expect(l.cursors).toHaveLength(6);
    for (let i = 0; i < l.beats.length; i++) {
      const beat = l.beats[i];
      expect(l.cursors[i].x).toBeLessThan(beat.box.x1 + 1e-9);
      expect(l.cursors[i + 1].x).toBeGreaterThan(beat.box.x2 - 1e-9);
    }
    // After a complete bar the cursor is past the barline.
    expect(l.cursors[4].x).toBeGreaterThan(l.systems[0].barlines[0]);
  });
});

describe('hit-testing', () => {
  const events = [b(16, 'HH', 'BD'), r(16), b(16, 'HO'), b(16, 'HH', 'SD')];
  const l = lay(events);
  const [first, rest, ho, fourth] = l.beats;

  it('yToInstrument: nearest kit step, HH for step 9, clamped', () => {
    for (const e of DRUM_KIT) {
      const want = e.id === 'HO' ? 'HH' : e.id;
      expect(yToInstrument(l, 0, yAt(l, 0, e.step))).toBe(want);
    }
    expect(yToInstrument(l, 0, yAt(l, 0, 5.4))).toBe('SD');
    expect(yToInstrument(l, 0, yAt(l, 0, 4.6))).toBe('SD');
    expect(yToInstrument(l, 0, yAt(l, 0, 4))).toBe('SD'); // tie → higher
    expect(yToInstrument(l, 0, yAt(l, 0, 3.6))).toBe('FT');
    expect(yToInstrument(l, 0, yAt(l, 0, 2))).toBe('FT');
    expect(yToInstrument(l, 0, yAt(l, 0, 1.9))).toBe('BD');
    expect(yToInstrument(l, 0, yAt(l, 0, 20))).toBe('CR');
    expect(yToInstrument(l, 0, yAt(l, 0, -6))).toBe('BD');
  });

  it('a notehead → head, HO stays HO', () => {
    const hh = head(first, 'HH');
    expect(hitTestDrums(l, hh.x, hh.y)).toEqual({
      kind: 'head',
      event: 0,
      inst: 'HH',
    });
    const o = head(ho, 'HO');
    expect(hitTestDrums(l, o.x + 2, o.y - 2)).toEqual({
      kind: 'head',
      event: 2,
      inst: 'HO',
    });
  });

  it('the same column at another height → column (add to that beat)', () => {
    expect(hitTestDrums(l, first.x, yAt(l, 0, 5))).toEqual({
      kind: 'column',
      event: 0,
      inst: 'SD',
      rest: false,
    });
    // Neighbouring steps are addable although the notehead boxes overlap.
    expect(hitTestDrums(l, fourth.x, yAt(l, 0, 8))).toMatchObject({
      kind: 'column',
      inst: 'RD',
    });
    expect(hitTestDrums(l, fourth.x, yAt(l, 0, 6))).toMatchObject({
      kind: 'column',
      inst: 'T2',
    });
    // HH height on a beat that has HO: the HO head (no HH + HO).
    expect(hitTestDrums(l, ho.x, yAt(l, 0, 9) - 0.2 * S)).toEqual({
      kind: 'head',
      event: 2,
      inst: 'HO',
    });
    expect(hitTestDrums(l, rest.x, yAt(l, 0, 1))).toEqual({
      kind: 'column',
      event: 1,
      inst: 'BD',
      rest: true,
    });
    expect(hitTestDrums(l, fourth.x, yAt(l, 0, 10))).toMatchObject({
      kind: 'column',
      inst: 'CR',
    });
  });

  it('elsewhere → insert at the nearest cursor with the height instrument', () => {
    const x = (first.box.x2 + rest.box.x1) / 2;
    expect(hitTestDrums(l, x, yAt(l, 0, 9))).toEqual({
      kind: 'insert',
      cursor: 1,
      inst: 'HH',
    });
    const end = l.cursors[4].x + 20;
    expect(hitTestDrums(l, end, yAt(l, 0, 3))).toEqual({
      kind: 'insert',
      cursor: 4,
      inst: 'FT',
    });
  });

  it('works on later systems', () => {
    const many = lay(
      Array.from({ length: 64 }, () => b(8, 'HH', 'BD')),
      300,
    );
    const beat = many.beats.find((x) => x.system === 1)!;
    const h = head(beat, 'BD');
    expect(hitTestDrums(many, h.x, h.y)).toEqual({
      kind: 'head',
      event: beat.eventIndex,
      inst: 'BD',
    });
    expect(yToInstrument(many, 1, yAt(many, 1, 5))).toBe('SD');
  });
});

describe('previewDrum', () => {
  const l = lay([b(16, 'HH', 'BD'), r(16)]);

  it('insert: a new beat centered on the cursor, with stem / flag / dot', () => {
    const p = previewDrum(
      l,
      { kind: 'insert', cursor: 2, inst: 'SD' },
      { d: '8', dotted: true },
    )!;
    expect(p.x).toBeCloseTo(l.cursors[2].x);
    expect(p.y).toBeCloseTo(yAt(l, 0, 5));
    expect(p.glyph.text).toBe(DRUM_GLYPHS.noteheadBlack);
    expect(p.stem!.y2).toBeLessThan(p.y);
    expect(p.flag!.text).toBe('');
    expect(p.dots).toHaveLength(1);
    const cr = previewDrum(
      l,
      { kind: 'insert', cursor: 0, inst: 'CR' },
      { d: '4', dotted: false },
    )!;
    expect(cr.glyph.text).toBe('');
    expect(cr.ledgerLines).toHaveLength(1);
    expect(cr.flag).toBeUndefined();
  });

  it('column: just the notehead, aligned with the beat (or the rest)', () => {
    const beat = l.beats[0];
    const p = previewDrum(
      l,
      { kind: 'column', event: 0, inst: 'SD', rest: false },
      { d: '8', dotted: false },
    )!;
    expect(p.glyph.x + 1.18 * S).toBeCloseTo(beat.headAlignX!);
    expect(p.y).toBeCloseTo(yAt(l, 0, 5));
    expect(p.stem).toBeUndefined();
    expect(p.dots).toEqual([]);
    const onRest = previewDrum(
      l,
      { kind: 'column', event: 1, inst: 'HH', rest: true },
      { d: '4', dotted: false },
    )!;
    expect(onRest.x).toBeCloseTo(l.beats[1].x);
  });

  it('head / out of range / dotted 32nd → null', () => {
    const v = { d: '4' as const, dotted: false };
    expect(
      previewDrum(l, { kind: 'head', event: 0, inst: 'HH' }, v),
    ).toBeNull();
    expect(
      previewDrum(l, { kind: 'insert', cursor: 9, inst: 'HH' }, v),
    ).toBeNull();
    expect(
      previewDrum(l, { kind: 'column', event: 9, inst: 'HH', rest: false }, v),
    ).toBeNull();
    expect(
      previewDrum(
        l,
        { kind: 'insert', cursor: 0, inst: 'HH' },
        { d: '32', dotted: true },
      ),
    ).toBeNull();
  });
});

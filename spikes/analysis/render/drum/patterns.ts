// Spike 5 T2: seeded drum pattern generator (docs/audio-spike5-plan.md section 4 "パターン").
//
// A pattern is bars of grid hits {tick, inst, mark} (ticks from the bar start, whole = 64, a 16th = 4), written
// STRAIGHT; a shuffle style says so in `shuffle` (the app's per-section `\tf`) and the timing (notation.ts) moves the
// off-beats. `inst` is the TRUE instrument, including the provisional S-拡張 names (SD.rim, RD.bell, CB, ...); the
// app score (notation.ts) writes those with their base piece (WRITTEN_AS).
//
// Styles (STYLES): 8 beat, 16 beat, half time, shuffle 8 / 16, ballad (RD), funk (ghosts, open HH), 3/4, 6/8, and
// `ext` (only the S-拡張 pieces the kit has: cross-stick, rimshot, ride bell, cowbell, pedal HH, foot splash, splash,
// china). Bar 1 and bar 5 start with a crash.
// Level features (plan section 4 levels): D0 strips ghosts and accents (plain hits only), D1+ keep them; fills
// (toms, 16th runs) at D2+ every 4 or 8 bars; dense cymbals at D3 (crash every 2 bars, ride instead of HH in
// every second bar). The base groove is drawn from the `score` stream only, so all levels of one seed share it;
// fills use their own stream.

import type { DrumInst, DrumMark } from '../../ts/drum/types';

export interface GridHit {
  tick: number;
  inst: DrumInst;
  mark?: DrumMark;
}
export type DrumShuffle = 'none' | '8' | '16';

export interface Pattern {
  style: StyleId;
  ts: [number, number];
  shuffle: DrumShuffle;
  bars: GridHit[][];
  /** Bars (0-based) that hold a fill. */
  fillBars: number[];
}

export const STYLE_IDS = ['rock8', 'pop16', 'half', 'shuffle8', 'shuffle16', 'ballad', 'funk', 'waltz', 'six8', 'ext'] as const;
/**
 * T12: `ext2` = more S-拡張 hits for tuning only (variants.ts EXT2 set, its own seeds): every bar is one kind out of
 * the ones the kit has (cross-stick, pedal HH, ride bell, cowbell, splash, china), cycled from a random start so the
 * kinds get about the same number of bars (BarFn gets bar + start for ext2). Not part of STYLE_IDS, so the T2 variants are unchanged.
 */
export const EXTRA_STYLE_IDS = ['ext2'] as const;
export type StyleId = (typeof STYLE_IDS)[number] | (typeof EXTRA_STYLE_IDS)[number];

export interface StyleInfo {
  ts: [number, number];
  shuffle: DrumShuffle;
  /** Tempo range (bpm counts the denominator's beat: quarters in x/4, eighths in 6/8). */
  bpm: [number, number];
}

export const STYLES: Record<StyleId, StyleInfo> = {
  rock8: { ts: [4, 4], shuffle: 'none', bpm: [90, 200] },
  pop16: { ts: [4, 4], shuffle: 'none', bpm: [80, 130] },
  half: { ts: [4, 4], shuffle: 'none', bpm: [70, 110] },
  shuffle8: { ts: [4, 4], shuffle: '8', bpm: [70, 140] },
  shuffle16: { ts: [4, 4], shuffle: '16', bpm: [70, 100] },
  ballad: { ts: [4, 4], shuffle: 'none', bpm: [60, 80] },
  funk: { ts: [4, 4], shuffle: 'none', bpm: [85, 115] },
  waltz: { ts: [3, 4], shuffle: 'none', bpm: [90, 160] },
  six8: { ts: [6, 8], shuffle: 'none', bpm: [120, 200] },
  ext: { ts: [4, 4], shuffle: 'none', bpm: [80, 120] },
  ext2: { ts: [4, 4], shuffle: 'none', bpm: [80, 120] },
};

export const N_BARS = 8;
const SLOT = 4; // a 16th

export const HH_GROUP: ReadonlySet<DrumInst> = new Set<DrumInst>(['HH', 'HO', 'HH.foot', 'HH.fsp']);

/** One row of 16th slots: 'x' hit, 'g' ghost, 'a' accent, '.' none (spaces ignored). */
function row(inst: DrumInst, pat: string): GridHit[] {
  const p = pat.replace(/ /g, '');
  const out: GridHit[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '.') continue;
    if (c !== 'x' && c !== 'g' && c !== 'a') throw new Error(`bad pattern char ${c}`);
    out.push({ tick: i * SLOT, inst, ...(c === 'g' ? { mark: 'g' as const } : c === 'a' ? { mark: 'ac' as const } : {}) });
  }
  return out;
}

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

/** Per-style bar builders: (bar index, score stream, kit pieces) -> hits. */
type BarFn = (b: number, rnd: () => number, has: (i: DrumInst) => boolean) => GridHit[];

const BARS: Record<StyleId, BarFn> = {
  rock8: (b, rnd) => [
    ...row('HH', pick(rnd, ['x.x.x.x.x.x.x.x.', 'a.x.a.x.a.x.a.x.'])),
    ...row('SD', '....x.......x...'),
    ...row('BD', pick(rnd, ['x.......x.......', 'x.......x.x.....', 'x......xx.......', 'x.x.....x.......'])),
    ...(b % 2 === 1 && rnd() < 0.5 ? openOn(14) : []),
  ],
  pop16: (_b, rnd) => [
    ...row('HH', pick(rnd, ['xxxxxxxxxxxxxxxx', 'axxxaxxxaxxxaxxx', 'axxxxxaxaxxxxxax'])),
    ...row('SD', pick(rnd, ['....x.......x...', '....x..g....x..g', '....x.......x.g.'])),
    ...row('BD', pick(rnd, ['x.....x...x.....', 'x..x....x.x.....', 'x.....x.x.......'])),
  ],
  half: (_b, rnd) => [
    ...row('HH', pick(rnd, ['x.x.x.x.x.x.x.x.', 'xxxxxxxxxxxxxxxx'])),
    ...row('SD', pick(rnd, ['........x.......', '........x.....g.'])),
    ...row('BD', pick(rnd, ['x.....x.....x...', 'x......x..x.....', 'x.........x.....'])),
  ],
  shuffle8: (_b, rnd) => [
    ...row('HH', pick(rnd, ['x.x.x.x.x.x.x.x.', 'a.x.a.x.a.x.a.x.'])),
    ...row('SD', pick(rnd, ['....x.......x...', '....x.g.....x.g.'])),
    ...row('BD', pick(rnd, ['x.......x.......', 'x.......x.....x.', 'x.....x.x.......'])),
  ],
  shuffle16: (_b, rnd) => [
    ...row('HH', pick(rnd, ['xxxxxxxxxxxxxxxx', 'x.xxx.xxx.xxx.xx'])),
    ...row('SD', pick(rnd, ['....x..g.g..x...', '....x...g...x..g', '.g..x.g.....x.g.'])),
    ...row('BD', pick(rnd, ['x..x..x...x.....', 'x.....x...x..x..', 'x..x......x.....'])),
  ],
  ballad: (_b, rnd) => [
    ...row('RD', pick(rnd, ['x.x.x.x.x.x.x.x.', 'x...x...x...x...', 'a.x.a.x.a.x.a.x.'])),
    ...row('SD', '....x.......x...'),
    ...row('BD', pick(rnd, ['x.......x.......', 'x.......x.x.....', 'x......x..x.....'])),
  ],
  funk: (_b, rnd) => [
    ...row('HH', pick(rnd, ['xxxxxxxxxxxxxx.x', 'axxxaxxxaxxxax.x'])),
    ...openOn(14),
    ...row('SD', pick(rnd, ['....x..g.g..x..g', '.g..x..g.g..x...', '....x.g..g.gx...'])),
    ...row('BD', pick(rnd, ['x.x...x...x..x..', 'x..x..x...x.....', 'x.x....x..x.....'])),
  ],
  waltz: (_b, rnd) => [
    ...row('HH', pick(rnd, ['x.x.x.x.x.x.', 'a.x.x.x.x.x.'])),
    ...row('SD', pick(rnd, ['....x...x...', '....x...x.g.'])),
    ...row('BD', pick(rnd, ['x...........', 'x.........x.'])),
  ],
  six8: (_b, rnd) => [
    ...row('HH', pick(rnd, ['x.x.x.x.x.x.', 'a.x.x.a.x.x.'])),
    ...row('SD', pick(rnd, ['......x.....', '......x...g.'])),
    ...row('BD', pick(rnd, ['x...........', 'x.........x.', 'x...x.......'])),
  ],
  ext: (b, rnd, has) => {
    const kind = (b + Math.floor(rnd() * 4)) % 4;
    const bd = row('BD', 'x.......x.x.....');
    if (kind === 0 && has('SD.xs'))
      return [...row('RD', 'x.x.x.x.x.x.x.x.'), ...row('SD.xs', '....x.......x...'), ...(has('HH.foot') ? row('HH.foot', '....x.......x...') : []), ...bd];
    if (kind === 1 && has('SD.rim')) return [...row('HH', 'x.x.x.x.x.x.x.x.'), ...row('SD.rim', '....x.......x...'), ...bd];
    if (kind === 2 && has('RD.bell'))
      return [...row('RD.bell', 'x...x...x...x...'), ...(has('CB') ? row('CB', '..x...x...x...x.') : row('RD', '..x...x...x...x.')), ...row('SD', '....x.......x...'), ...bd];
    if (kind === 3 && has('HH.fsp'))
      return [...row('RD', 'x.x.x.x.x.x.x.x.'), ...row('HH.fsp', '..x.......x.....'), ...row('SD', '....x.......x...'), ...bd];
    return [...row('HH', 'x.x.x.x.x.x.x.x.'), ...row('SD', '....x.......x...'), ...bd];
  },
  ext2: (b, rnd, has) => {
    const kinds = EXT2_KINDS_BY.filter(([inst]) => has(inst)).map(([, f]) => f);
    const bd = row('BD', pick(rnd, ['x.......x.x.....', 'x......x..x.....', 'x.......x.......']));
    if (!kinds.length) return [...row('HH', 'x.x.x.x.x.x.x.x.'), ...row('SD', '....x.......x...'), ...bd];
    return [...kinds[b % kinds.length](rnd), ...bd];
  },
};

const SD_BACKBEAT = '....x.......x...';
/** HH 8ths with a splash / china on some off-beats instead of the HH there. */
function cymbalAccents(inst: DrumInst, rnd: () => number): GridHit[] {
  const cym = row(inst, pick(rnd, ['......x.......x.', '......x.........', '..............x.']));
  return [...row('HH', 'x.x.x.x.x.x.x.x.').filter((h) => !cym.some((c) => c.tick === h.tick)), ...cym, ...row('SD', SD_BACKBEAT)];
}
/** ext2 bar kinds, one per S-拡張 piece of the tuning kits (rimshot and foot splash: no tuning kit has them). */
const EXT2_KINDS_BY: [DrumInst, (rnd: () => number) => GridHit[]][] = [
  ['SD.xs', (rnd) => [...row('RD', 'x.x.x.x.x.x.x.x.'), ...row('SD.xs', pick(rnd, ['....x.......x...', '....x.....x.x...']))]],
  ['HH.foot', (rnd) => [...row('RD', 'x...x...x...x...'), ...row('HH.foot', pick(rnd, ['..x...x...x...x.', '....x.......x...'])), ...row('SD', SD_BACKBEAT)]],
  ['RD.bell', (rnd) => [...row('RD.bell', pick(rnd, ['x...x...x...x...', 'x.x.x.x.x.x.x.x.'])), ...row('SD', SD_BACKBEAT)]],
  ['CB', (rnd) => [...row('CB', 'x...x...x...x...'), ...row('HH', pick(rnd, ['..x...x...x...x.', '................'])), ...row('SD', SD_BACKBEAT)]],
  ['SP', (rnd) => cymbalAccents('SP', rnd)],
  ['CN', (rnd) => cymbalAccents('CN', rnd)],
];

/** Open HH on slot `s` (the closed HH there is removed; the next HH-group hit closes it). */
function openOn(s: number): GridHit[] {
  return [{ tick: s * SLOT, inst: 'HO' }];
}

function barTicksOf(ts: [number, number]): number {
  return (ts[0] * 64) / ts[1];
}

/** Puts a crash (or the ext style's splash / china) on the bar head, replacing the timekeeper hit there. */
function crashOnHead(hits: GridHit[], inst: DrumInst): GridHit[] {
  const kept = hits.filter((h) => !(h.tick === 0 && (HH_GROUP.has(h.inst) || h.inst === 'RD' || h.inst === 'RD.bell' || h.inst === 'CB')));
  if (!kept.some((h) => h.tick === 0 && h.inst === 'BD')) kept.push({ tick: 0, inst: 'BD' });
  return [...kept, { tick: 0, inst }];
}

/** Removes duplicates and HH-group clashes (HO wins over HH on the same tick; later rows lose). */
function tidy(hits: GridHit[]): GridHit[] {
  const out: GridHit[] = [];
  const order = [...hits].sort((a, b) => a.tick - b.tick || (a.inst === 'HO' ? -1 : 0) - (b.inst === 'HO' ? -1 : 0));
  for (const h of order) {
    const clash = out.some((o) => o.tick === h.tick && (o.inst === h.inst || (HH_GROUP.has(o.inst) && HH_GROUP.has(h.inst)) || writtenAs(o.inst) === writtenAs(h.inst)));
    if (!clash) out.push(h);
  }
  return out.sort((a, b) => a.tick - b.tick);
}

/** The app piece an S-拡張 hit is written with (plan section 3 持ち越しの質問 1: the app cannot write them yet). */
export const WRITTEN_AS: Record<string, string> = {
  SP: 'CR',
  CN: 'CR',
  CB: 'RD',
  'SD.rim': 'SD',
  'SD.xs': 'SD',
  'RD.bell': 'RD',
  'HH.foot': 'HH',
  'HH.fsp': 'HO',
};
export const writtenAs = (inst: string): string => WRITTEN_AS[inst] ?? inst;

/** A fill over the second half of the bar (or the last 6 slots of 3/4 and 6/8): SD and toms, high to low. */
function fill(barTicks: number, shuffle: DrumShuffle, toms: DrumInst[], rnd: () => number): { from: number; hits: GridHit[] } {
  const from = barTicks === 64 ? 32 : barTicks - 24;
  const voices: DrumInst[] = ['SD', ...toms];
  const kind = shuffle !== 'none' ? 'eighths' : pick(rnd, ['sixteenths', 'eighths', 'mixed'] as const);
  const step = kind === 'eighths' ? 2 * SLOT : SLOT;
  const n = (barTicks - from) / step;
  const hits: GridHit[] = [];
  for (let i = 0; i < n; i++) {
    const v = voices[Math.min(voices.length - 1, Math.floor((i * voices.length) / n))];
    const tick = from + i * step;
    if (kind === 'mixed' && i % 4 === 3) hits.push({ tick, inst: 'BD' });
    else hits.push({ tick, inst: v, ...(i === 0 ? { mark: 'ac' as const } : {}) });
  }
  if (rnd() < 0.5) hits.push({ tick: from, inst: 'BD' });
  return { from, hits };
}

export interface PatternOptions {
  /** Instruments the kit has. */
  instruments: readonly DrumInst[];
  marks: boolean;
  fills: boolean;
  denseCymbals: boolean;
}

export interface PatternStreams {
  score: () => number;
  fill: () => number;
}

export function generatePattern(style: StyleId, s: PatternStreams, o: PatternOptions): Pattern {
  const info = STYLES[style];
  const has = (i: DrumInst) => o.instruments.includes(i);
  const bt = barTicksOf(info.ts);
  const toms = (['T1', 'T2', 'FT'] as DrumInst[]).filter(has);
  const fillEvery = s.fill() < 0.5 ? 4 : 8;
  const headCrash: DrumInst = style === 'ext' || style === 'ext2' ? (has('CN') && s.score() < 0.5 ? 'CN' : has('SP') ? 'SP' : 'CR') : 'CR';
  const bars: GridHit[][] = [];
  const fillBars: number[] = [];
  // ext2: the bar kinds start at a seed-drawn kind (only ext2 draws this, so the other styles' streams are unchanged)
  const rot = style === 'ext2' ? Math.floor(s.score() * 6) : 0;
  for (let b = 0; b < N_BARS; b++) {
    let hits = BARS[style](b + rot, s.score, has).filter((h) => has(h.inst));
    if (o.fills && (b + 1) % fillEvery === 0) {
      const f = fill(bt, info.shuffle, toms, s.fill);
      hits = [...hits.filter((h) => h.tick < f.from), ...f.hits];
      fillBars.push(b);
    }
    const crashBar = b % 4 === 0 || (o.denseCymbals && b % 2 === 0) || (o.fills && fillBars.includes(b - 1));
    if (o.denseCymbals && b % 2 === 1) {
      hits = hits.map((h) => (h.inst === 'HH' && !fillBars.includes(b) ? { ...h, inst: 'RD' as DrumInst } : h)).filter((h) => h.inst !== 'HO');
    }
    if (crashBar) hits = crashOnHead(hits, b === 0 || b === 4 ? headCrash : 'CR');
    if (!o.marks) hits = hits.filter((h) => h.mark !== 'g').map((h) => ({ tick: h.tick, inst: h.inst }));
    bars.push(tidy(hits));
  }
  return { style, ts: info.ts, shuffle: info.shuffle, bars, fillBars };
}

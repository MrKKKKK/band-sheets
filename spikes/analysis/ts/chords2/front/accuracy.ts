/**
 * Spike 8 T4: the front end's accuracy against a synthetic truth (plan §2.1 「前段の当たり」; docs/audio-spike8-t4.md).
 * Pure: the caller passes the F1 beats (on the truth's own beat grid) and the truth's notes / chords; counts only.
 *
 *  - Sounding truth note of a beat: a note that covers at least half of the beat ([t, end) as written).
 *  - Octave level: truth notes and picked notes in C2-B5 (plan: output C2-B5). Pitch-class level: every truth note and
 *    every picked note (C1 upward), folded to the 12 pitch classes.
 *  - Added tones: the beat's truth chord holds the 6th / minor 7th / major 7th (d = 9 / 10 / 11 above the root) and a
 *    note of it sounds. "out" = F1 picked that pitch class (not as the lowest note); "ρ" = addedRatio(d) >= θ_low (D2's, ../config.ts).
 *  - Fake added tones: the truth chord is a plain maj / min triad (its pitch classes are the triad's); per d, the beats
 *    where F1 shows root + d in the same two senses.
 */
import { DEFAULT_F1_CONFIG, type F1Config } from './config';
import { pcStrength, type F1Beat } from './f1';
import { DEFAULT_D2_VALUES } from '../config';
import { triadOf, TRIADS } from '../vocab';
import { addedRatio } from './ratio';

export interface TruthNote {
  midi: number;
  t: number;
  end: number;
}
export interface TruthChordSpan {
  start: number;
  end: number;
  /** root pitch class, null = no chord */
  root: number | null;
  quality: string;
  /** every pitch class sounding in the chord (truth segments' pcs) */
  pcs: readonly number[];
}

export const ADDED = [9, 10, 11] as const;
export type Added = (typeof ADDED)[number];

/** Triad intervals of a quality's family (vocab.ts triadOf; null = sus / aug / dim7 etc.: not used for added tones). */
export function triadIntervals(quality: string): readonly number[] | null {
  const t = triadOf(quality === 'm7' ? 'min7' : quality);
  return t ? TRIADS[t] : null;
}

export interface Counter {
  n: number;
  out: number;
  rho: number;
}
export interface FrontAcc {
  beats: number;
  oct: { tp: number; det: number; truth: number };
  pc: { tp: number; det: number; truth: number };
  added: Record<Added, Counter>;
  /** beats with a plain-triad truth: `n` per d is the same (the triad beats), `out` / `rho` the fakes */
  fake: Record<Added, Counter>;
  /** triad beats with at least one fake (any d) */
  fakeAny: Counter;
}

const newCounter = (): Counter => ({ n: 0, out: 0, rho: 0 });
export const newFrontAcc = (): FrontAcc => ({
  beats: 0,
  oct: { tp: 0, det: 0, truth: 0 },
  pc: { tp: 0, det: 0, truth: 0 },
  added: { 9: newCounter(), 10: newCounter(), 11: newCounter() },
  fake: { 9: newCounter(), 10: newCounter(), 11: newCounter() },
  fakeAny: newCounter(),
});

export function sounding(notes: readonly TruthNote[], start: number, end: number): TruthNote[] {
  const half = (end - start) / 2;
  return notes.filter((n) => Math.min(n.end, end) - Math.max(n.t, start) >= half);
}

/** Add one file's beats to `acc`. */
export function addBeats(acc: FrontAcc, beats: readonly F1Beat[], notes: readonly TruthNote[], chords: readonly TruthChordSpan[], cfg: F1Config = DEFAULT_F1_CONFIG, thetaLow = DEFAULT_D2_VALUES.thetaLow): void {
  for (const b of beats) {
    acc.beats++;
    const tn = sounding(notes, b.start, b.end);
    const inOut = (m: number) => m >= cfg.outLo && m <= cfg.candHi;
    const tOct = new Set(tn.map((n) => n.midi).filter(inOut));
    const dOct = new Set(b.notes.map((n) => n.midi).filter(inOut));
    acc.oct.truth += tOct.size;
    acc.oct.det += dOct.size;
    for (const m of dOct) if (tOct.has(m)) acc.oct.tp++;
    const tPc = new Set(tn.map((n) => n.midi % 12));
    const dPc = new Set(b.notes.map((n) => n.midi % 12));
    acc.pc.truth += tPc.size;
    acc.pc.det += dPc.size;
    for (const p of dPc) if (tPc.has(p)) acc.pc.tp++;

    const mid = (b.start + b.end) / 2;
    const ch = chords.find((c) => c.start <= mid && mid < c.end);
    if (!ch || ch.root === null) continue;
    const triad = triadIntervals(ch.quality);
    if (!triad) continue;
    const rel = new Set(ch.pcs.map((p) => (p - ch.root! + 12) % 12));
    const shown = pcStrength(b.notes, true, cfg);
    const plain = (ch.quality === 'maj' || ch.quality === 'min') && [...rel].every((iv) => triad.includes(iv));
    let anyOut = 0;
    let anyRho = 0;
    for (const d of ADDED) {
      const pc = (ch.root + d) % 12;
      const out = shown[pc] > 0 ? 1 : 0;
      const rho = addedRatio(b.notes, ch.root, triad, d, thetaLow, cfg) >= thetaLow ? 1 : 0;
      if (rel.has(d) && tPc.has(pc)) {
        const c = acc.added[d];
        c.n++;
        c.out += out;
        c.rho += rho;
      }
      if (plain) {
        const c = acc.fake[d];
        c.n++;
        c.out += out;
        c.rho += rho;
        anyOut |= out;
        anyRho |= rho;
      }
    }
    if (plain) {
      acc.fakeAny.n++;
      acc.fakeAny.out += anyOut;
      acc.fakeAny.rho += anyRho;
    }
  }
}

const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const div = (a: number, b: number) => (b > 0 ? a / b : NaN);

/** Markdown rows of one accumulator (rates and counts only). */
export function accRow(label: string, a: FrontAcc): string {
  const addN = ADDED.reduce((s, d) => s + a.added[d].n, 0);
  const addOut = ADDED.reduce((s, d) => s + a.added[d].out, 0);
  const addRho = ADDED.reduce((s, d) => s + a.added[d].rho, 0);
  const fakeN = a.fakeAny.n;
  return [
    label,
    String(a.beats),
    `${r3(div(a.oct.tp, a.oct.det))} / ${r3(div(a.oct.tp, a.oct.truth))}`,
    `${r3(div(a.pc.tp, a.pc.det))} / ${r3(div(a.pc.tp, a.pc.truth))}`,
    `${r3(div(addRho, addN))} (${r3(div(addOut, addN))}) n=${addN}`,
    ADDED.map((d) => `${r3(div(a.added[d].rho, a.added[d].n))}`).join(' / '),
    `${r3(div(a.fakeAny.rho, fakeN))} (${r3(div(a.fakeAny.out, fakeN))}) n=${fakeN}`,
    ADDED.map((d) => `${r3(div(a.fake[d].rho, fakeN))}`).join(' / '),
  ].join(' | ');
}
export const ACC_HEADER = [
  '| 行 | 拍 | オクターブつき P / R | 音名 P / R | 足した音の再現率 ρ≥θ_low（出力にある） | 同 6 / 短7 / 長7 | 偽の足す音（3 和音の拍のうち 1 つ以上）ρ≥θ_low（出力にある） | 同 6 / 短7 / 長7 |',
  '|---|---|---|---|---|---|---|---|',
].join('\n');

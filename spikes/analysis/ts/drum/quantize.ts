/**
 * Spike 5 T7: beat grid and quantization of detected drum hits (docs/audio-spike5-plan.md section 2, design decision 4:
 * bpm / meter / bar-1 head are given by the user, never estimated; no ground truth is read).
 *
 * Rules, in order (ticks of src/lib/melody.ts, whole = 64, 16th = 4):
 *  1. Grid: beat = 64 / ts[1] ticks, bpm counts that beat, tick = 60 / (bpm * beat) s, tick 0 = info.startSec.
 *     step = 64 / grid.subdivision (16 -> a 16th). Hit position x = (t - startSec) / tickSec (real ticks).
 *  2. Onset bias (grid.onsetBias): b starts at 0; b += median of the residuals of (x - b) to the nearest 8th-note point,
 *     using only residuals within half a step (swung off-beats and 16ths are farther, so the estimate does not depend
 *     on the feel); repeated until it settles, |b| <= maxBiasSec. b is removed from every hit (onsetBiasSec, + = late);
 *     QuantizedDrums.startSec stays the given head (the bias is the player's habit, not a grid shift).
 *  3. Shuffle per bar (swing.ts detectSwing) on the bias-corrected positions; bars = 0 .. the bar of the last hit
 *     (a hit within half a step of the next barline counts in the next bar), at least opts.nBars. A hit that still
 *     snaps to the head after the last bar (rule 5) adds that bar with the take-level shuffle.
 *  4. Grid points per bar: 'none' = every step. Shuffle '8' / '16' (span S = 16 / 8): per span the straight written
 *     positions 0 and S/2 sit at REAL positions 0 and 2S/3 (the app writes shuffle as straight values plus `\tf`);
 *     with grid.triplet also the middle triplet slot S/3 (only writable as an 8th / 16th triplet `{tu 3}`).
 *  5. Each hit snaps to the nearest grid point (ties -> the later one). A hit nearer to a point before bar 1 than to
 *     bar 1 beat 1 (x < -step / 2) is dropped ('beforeStart').
 *  6. Same instrument on one point (HH and HO are different instruments here), in time order: if the two hits are less
 *     than half a grid gap apart they are one hit (flam / double detection): merged ('merged'; the stronger hit's
 *     strength / src / alts / mark, the higher confidence). Otherwise the later one moves to the next point or the
 *     earlier one to the previous point, whichever is free for that instrument and nearer to its raw position;
 *     if neither is free they are merged.
 *  7. HH and HO on one point (the app never writes both): the higher confidence stays (tie: higher strength, then HH);
 *     the other is dropped ('exclusive').
 *  8. A span holding a middle-slot hit becomes a triplet span: its hits keep their REAL fractional ticks (0, S/3, 2S/3
 *     from the span start); every other hit gets its WRITTEN tick. QuantizedDrums.grid = 'triplet' when any bar swings.
 *  9. Marks: strength.ts strengthMarks over all input hits (before merging). confidence = the hit's own (not lowered).
 * Hits are sorted by bar, tick, then app kit order (S-拡張 names after the 9 pieces); S-拡張 names are kept here.
 */
import { barTicks } from '../../../../src/lib/melody';
import { DEFAULT_DRUM_CONFIG, type DrumConfig } from './config';
import { strengthMarks } from './strength';
import { SWING_SPAN, detectSwing, median, type SwingKind } from './swing';
import { APP_DRUM_INSTRUMENTS, EXT_DRUM_INSTRUMENTS, WHOLE_TICKS, type AnalysisDrumHit, type DrumInfo, type DrumInst, type DrumSwingBar, type QuantizedDrumHit, type QuantizedDrums } from './types';

export interface DroppedHit {
  src: number;
  reason: 'beforeStart' | 'merged' | 'exclusive';
  /** For merged / exclusive: the src of the hit that stayed. */
  into?: number;
}

export interface QuantizeResult {
  quantized: QuantizedDrums;
  swingBars: DrumSwingBar[];
  /** Take-level shuffle; absent = none. */
  swing?: { kind: '8' | '16'; confidence: number };
  onsetBiasSec: number;
  dropped: DroppedHit[];
}

interface Point {
  pos: number;
  bar: number;
  /** Written tick (middle slot: real tick). */
  tick: number;
  /** Global start of the shuffle span, when in a swung bar. */
  span?: number;
  spanLen?: number;
  mid?: boolean;
}

export const INST_ORDER: readonly string[] = [...APP_DRUM_INSTRUMENTS, ...EXT_DRUM_INSTRUMENTS];
const instRank = (i: string) => {
  const k = INST_ORDER.indexOf(i);
  return k < 0 ? INST_ORDER.length : k;
};

/** Seconds per tick for the given info. */
export function tickSeconds(info: DrumInfo): number {
  return 60 / (info.bpm * (WHOLE_TICKS / info.ts[1]));
}

function gridPoints(kinds: readonly SwingKind[], barT: number, step: number, triplet: boolean): Point[] {
  const out: Point[] = [];
  kinds.forEach((kind, bar) => {
    const b0 = bar * barT;
    if (kind === 'none') {
      for (let t = 0; t < barT; t += step) out.push({ pos: b0 + t, bar, tick: t });
      return;
    }
    const S = SWING_SPAN[kind];
    for (let s = 0; s < barT; s += S) {
      const span = b0 + s;
      out.push({ pos: span, bar, tick: s, span, spanLen: S });
      if (triplet) out.push({ pos: span + S / 3, bar, tick: s + S / 3, span, spanLen: S, mid: true });
      out.push({ pos: span + (2 * S) / 3, bar, tick: s + S / 2, span, spanLen: S });
    }
  });
  return out;
}

function nearest(points: readonly Point[], x: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (points[m].pos < x) lo = m + 1;
    else hi = m;
  }
  // lo = first point >= x; compare with the one before (ties -> later).
  if (lo > 0 && x - points[lo - 1].pos < points[lo].pos - x) return lo - 1;
  return lo;
}

/** Estimated onset bias in ticks (rule 2). */
export function onsetBiasTicks(x: readonly number[], step: number, maxTicks: number): number {
  let b = 0;
  for (let it = 0; it < 20; it++) {
    const res = x.map((v) => v - b - 8 * Math.round((v - b) / 8)).filter((r) => Math.abs(r) <= step / 2);
    if (!res.length) break;
    const nb = Math.max(-maxTicks, Math.min(maxTicks, b + median(res)));
    if (Math.abs(nb - b) < 1e-9) break;
    b = nb;
  }
  return b;
}

export function quantizeDrums(hits: readonly AnalysisDrumHit[], info: DrumInfo, opts: { cfg?: DrumConfig; nBars?: number } = {}): QuantizeResult {
  const cfg = opts.cfg ?? DEFAULT_DRUM_CONFIG;
  const barT = barTicks({ num: info.ts[0], den: info.ts[1] });
  const tickSec = tickSeconds(info);
  const step = WHOLE_TICKS / cfg.grid.subdivision;
  const x0 = hits.map((h) => (h.t - info.startSec) / tickSec);
  const b = cfg.grid.onsetBias ? onsetBiasTicks(x0, step, cfg.grid.maxBiasSec / tickSec) : 0;
  const x = x0.map((v) => v - b);
  const dropped: DroppedHit[] = [];
  const live: number[] = [];
  x.forEach((v, i) => (v < -step / 2 ? dropped.push({ src: i, reason: 'beforeStart' }) : live.push(i)));

  const lastBar = live.length ? Math.max(...live.map((i) => Math.floor((x[i] + step / 2) / barT))) : -1;
  const nBars = Math.max(lastBar + 1, opts.nBars ?? 0);
  const sw = detectSwing(
    live.map((i) => x[i]),
    barT,
    nBars,
    info.ts[1],
    cfg.swing,
  );
  const points = gridPoints(
    sw.bars.map((s) => s.kind),
    barT,
    step,
    cfg.grid.triplet,
  );
  // Closing head (bar nBars, tick 0): a late-bar hit nearer to it than to the swung grid's last point lands there.
  points.push({ pos: nBars * barT, bar: nBars, tick: 0 });
  const { marks } = strengthMarks(hits, cfg.strength);

  // slot[i] = point index of hit i (rules 5, 6).
  const slot = new Map<number, number>();
  for (const i of live) slot.set(i, nearest(points, x[i]));
  const gap = (k: number) => (k + 1 < points.length ? points[k + 1].pos - points[k].pos : step);
  const stronger = (i: number, j: number) => (hits[j].strength > hits[i].strength ? j : i);
  const conf = new Map<number, number>(live.map((i) => [i, hits[i].confidence]));
  const merge = (keep: number, gone: number) => {
    const k = stronger(keep, gone);
    const g = k === keep ? gone : keep;
    conf.set(k, Math.max(conf.get(k)!, conf.get(g)!));
    if (k !== keep) slot.set(k, slot.get(keep)!);
    slot.delete(g);
    dropped.push({ src: g, reason: 'merged', into: k });
    return k;
  };
  const byInst = new Map<string, number[]>();
  for (const i of live) byInst.set(hits[i].inst, [...(byInst.get(hits[i].inst) ?? []), i]);
  for (const idx of byInst.values()) {
    idx.sort((a, c) => x[a] - x[c] || a - c);
    const kept: number[] = [];
    for (const j of idx) {
      const prev = kept[kept.length - 1];
      if (prev === undefined || slot.get(j)! > slot.get(prev)!) {
        kept.push(j);
        continue;
      }
      const s = slot.get(prev)!;
      if (Math.abs(x[j] - x[prev]) < gap(s) / 2) {
        kept[kept.length - 1] = merge(prev, j);
        continue;
      }
      const before = kept[kept.length - 2];
      const canNext = s + 1 < points.length;
      const canPrev = s - 1 >= 0 && (before === undefined || slot.get(before)! < s - 1);
      const costNext = canNext ? Math.abs(x[j] - points[s + 1].pos) : Infinity;
      const costPrev = canPrev ? Math.abs(x[prev] - points[s - 1].pos) : Infinity;
      if (costNext === Infinity && costPrev === Infinity) {
        kept[kept.length - 1] = merge(prev, j);
      } else if (costNext <= costPrev) {
        slot.set(j, s + 1);
        kept.push(j);
      } else {
        slot.set(prev, s - 1);
        kept.push(j);
      }
    }
  }
  // Rule 7: HH / HO exclusivity per point.
  const hhAt = new Map<number, number>();
  const hoAt = new Map<number, number>();
  for (const [i, k] of slot) {
    if (hits[i].inst === 'HH') hhAt.set(k, i);
    if (hits[i].inst === 'HO') hoAt.set(k, i);
  }
  for (const [k, hh] of hhAt) {
    const ho = hoAt.get(k);
    if (ho === undefined) continue;
    const c = conf.get(ho)! - conf.get(hh)! || hits[ho].strength - hits[hh].strength;
    const [keep, gone] = c > 0 ? [ho, hh] : [hh, ho];
    slot.delete(gone);
    dropped.push({ src: gone, reason: 'exclusive', into: keep });
  }
  const swingBars = [...sw.bars];
  if ([...slot.values()].some((k) => points[k].bar === nBars)) {
    const kind = sw.swing?.kind ?? 'none';
    swingBars.push({ bar: nBars, kind, ratio: kind === 'none' ? 0.5 : median(sw.bars.filter((b) => b.kind === kind).map((b) => b.ratio)) });
  }
  // Rule 8: triplet spans.
  const tripletSpans = new Set<number>();
  for (const k of slot.values()) if (points[k].mid) tripletSpans.add(points[k].span!);

  const out: QuantizedDrumHit[] = [];
  for (const [i, k] of slot) {
    const p = points[k];
    const tick = p.span !== undefined && tripletSpans.has(p.span) ? p.pos - p.bar * barT : p.tick;
    const h: QuantizedDrumHit = { bar: p.bar, tick, inst: hits[i].inst as DrumInst, strength: hits[i].strength, confidence: conf.get(i)!, src: i };
    if (marks[i]) h.mark = marks[i];
    if (hits[i].alts?.length) h.alts = hits[i].alts!.map((a) => ({ inst: a.inst as DrumInst, confidence: a.confidence }));
    out.push(h);
  }
  out.sort((a, c) => a.bar - c.bar || a.tick - c.tick || instRank(a.inst) - instRank(c.inst));
  dropped.sort((a, c) => a.src - c.src);
  return {
    quantized: {
      bpm: info.bpm,
      ts: [info.ts[0], info.ts[1]],
      startSec: info.startSec,
      grid: swingBars.some((s) => s.kind !== 'none') ? 'triplet' : 'sixteenth',
      hits: out,
    },
    swingBars,
    ...(sw.swing ? { swing: sw.swing } : {}),
    onsetBiasSec: b * tickSec,
    dropped,
  };
}

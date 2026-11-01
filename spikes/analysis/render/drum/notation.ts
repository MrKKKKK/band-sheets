// Spike 5 T2: pattern -> the app's drum model (DrumEvent[], src/lib/drum.ts, read-only) and its alphaTex section
// body (serializeDrums), plus the performed timing of every hit (swing, jitter) for the truth.
//
// One pattern = one section with one shuffle. Each bar becomes one event per distinct onset tick (length = up to the
// next onset or the bar end, written as the struck value + rests when it is not one note value) and a leading rest
// when the bar does not start with a hit. S-拡張 hits are written as their base piece (patterns.ts WRITTEN_AS).

import { normalizeDrums, type DrumEvent, type DrumHit } from '../../../../src/lib/drum';
import type { DrumInstrument } from '../../../../src/lib/drumKit';
import { serializeDrums } from '../../../../src/lib/drumTex';
import { decompose, durationTicks, type TimeSig } from '../../../../src/lib/melody';
import { writtenAs, type DrumShuffle, type GridHit, type Pattern } from './patterns';

const APP_ORDER: DrumInstrument[] = ['CR', 'HH', 'HO', 'RD', 'T1', 'T2', 'SD', 'FT', 'BD'];

export const barTicksOf = (ts: [number, number]): number => (ts[0] * 64) / ts[1];
export const timeSig = (ts: [number, number]): TimeSig => ({ num: ts[0], den: ts[1] });

function pieces(ticks: number): number[] {
  return decompose(ticks).map((v) => durationTicks(v.d, v.dotted));
}

function toHit(h: GridHit): DrumHit {
  const inst = writtenAs(h.inst) as DrumInstrument;
  if (!APP_ORDER.includes(inst)) throw new Error(`not an app piece: ${h.inst}`);
  return { inst, ...(h.mark === 'g' ? { ghost: true as const } : h.mark === 'ac' ? { accent: 'normal' as const } : {}) };
}

/** The app's events of a pattern (normalized, hits sorted). Throws on two hits of one written piece at one tick. */
export function toDrumEvents(p: Pattern): DrumEvent[] {
  const bt = barTicksOf(p.ts);
  const events: DrumEvent[] = [];
  for (const bar of p.bars) {
    const ticks = [...new Set(bar.map((h) => h.tick))].sort((a, b) => a - b);
    if (ticks.length === 0 || ticks[0] > 0) for (const t of pieces(ticks[0] ?? bt)) events.push({ hits: [], ticks: t });
    ticks.forEach((t, i) => {
      const hits = bar.filter((h) => h.tick === t).map(toHit);
      const names = hits.map((h) => h.inst);
      if (new Set(names).size !== names.length || (names.includes('HH') && names.includes('HO'))) {
        throw new Error(`clashing hits at tick ${t}: ${names.join(' ')}`);
      }
      hits.sort((a, b) => APP_ORDER.indexOf(a.inst) - APP_ORDER.indexOf(b.inst));
      const len = (ticks[i + 1] ?? bt) - t;
      const ps = pieces(len);
      events.push({ hits, ticks: ps[0] });
      for (const r of ps.slice(1)) events.push({ hits: [], ticks: r });
    });
  }
  const n = normalizeDrums(events, timeSig(p.ts));
  if (n.events !== events) throw new Error('generated events were not normalized');
  return events;
}

export function patternTex(p: Pattern): string {
  return serializeDrums(toDrumEvents(p), p.shuffle, timeSig(p.ts));
}

/**
 * Written tick inside a bar -> played tick. Shuffle 8 swings the 8ths of each quarter, 16 the 16ths of each 8th:
 * the off-beat moves to `ratio` of the pair (2/3 = 2:1 triplet feel, 0.6 = 3:2); positions in between are
 * stretched linearly (same rule as ts/drum/recscore/truth.ts swingTick, which is the 2:1 case).
 */
export function swingTick(tick: number, kind: DrumShuffle, ratio: number, den: number): number {
  if (kind === 'none') return tick;
  const unit = (64 / den) * (kind === '8' ? 1 : 0.5);
  const half = unit / 2;
  const base = Math.floor(tick / unit) * unit;
  const p = tick - base;
  return p < half ? base + (p * ratio * unit) / half : base + ratio * unit + ((p - half) * (1 - ratio) * unit) / half;
}

export interface TimedHit extends GridHit {
  bar: number;
  /** Intended second (grid + swing + jitter), before the sample placement. */
  t: number;
}

/** Seconds of every hit: startSec = bar 1 head; jitter(hit) adds the performance offset. */
export function hitTimes(p: Pattern, bpm: number, startSec: number, swingRatio: number, jitter: (h: GridHit) => number): TimedHit[] {
  const secPerTick = 60 / bpm / (64 / p.ts[1]);
  const bt = barTicksOf(p.ts);
  const out: TimedHit[] = [];
  p.bars.forEach((bar, b) => {
    for (const h of bar) {
      const play = swingTick(h.tick, p.shuffle, swingRatio, p.ts[1]);
      out.push({ ...h, bar: b, t: startSec + (b * bt + play) * secPerTick + jitter(h) });
    }
  });
  return out;
}

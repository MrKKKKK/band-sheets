/**
 * Spike 5 T4: score text (`recordings/drum-scores/x.song.txt`, as pasted into the app) -> tick truth of one
 * drum recording. The Python intake (py/drum_intake.py) only adds seconds (needs the user's `開始:`), so the
 * parse rules stay in ONE place: the app's own parser. Pure; the CLI is `truthCli.ts`.
 */
import { parseSong } from '../../../../../src/lib/parseSong';
import { chartOrder } from '../../../../../src/lib/melodyEditor';
import { melodyTimeSignature, barTicks } from '../../../../../src/lib/melody';
import { drumParts, readDrumSection } from '../../../../../src/lib/drumPart';
import type { Shuffle } from '../../../../../src/lib/drum';
import { TAKE_ROLE, type TakeLetter } from './builder';

export interface TickHit {
  bar: number; // 0-based
  /** Written tick from the bar start (whole note = 64). */
  tick: number;
  /** Tick where the hit is PLAYED: triplet-feel sections move off-beat hits (2:1). Fractional. */
  playTick: number;
  inst: string;
  mark?: 'g' | 'ac';
}

export interface TickTruth {
  name: string;
  letter: TakeLetter;
  heldOut: boolean;
  bpm: number;
  ts: [number, number];
  barTicks: number;
  nBars: number;
  hits: TickHit[];
  swingBars: { bar: number; kind: Shuffle }[];
}

/**
 * Written tick -> played tick inside one beat-pair. 8: one beat (quarter) is a triplet pair, the off-beat 8th
 * plays at 2/3 of the beat; 16: the same inside each 8th. Linear inside each half.
 */
export function swingTick(tickInBar: number, kind: Shuffle, ts: [number, number]): number {
  if (kind === 'none') return tickInBar;
  const unit = (64 / ts[1]) * (kind === '8' ? 1 : 0.5); // beat (quarter in x/4) or half beat
  const half = unit / 2;
  const base = Math.floor(tickInBar / unit) * unit;
  const p = tickInBar - base;
  return p < half ? base + p * (4 / 3) : base + (unit * 2) / 3 + (p - half) * (2 / 3);
}

export function tickTruth(songText: string, letter: TakeLetter): TickTruth {
  const song = parseSong(songText);
  const ts = melodyTimeSignature(song.meta.time);
  const bt = barTicks(ts);
  const parts = drumParts(song);
  if (parts.length !== 1) throw new Error(`${letter}: expected one drum part, got ${parts.length}`);
  const body = parts[0].body;
  const labels = [...body.matchAll(/^\\section\s+"([^"]*)"/gm)].map((m) => m[1]);
  if (labels.length === 0) throw new Error(`${letter}: no drum sections`);
  const order = chartOrder(song);
  const hits: TickHit[] = [];
  const swingBars: { bar: number; kind: Shuffle }[] = [];
  let pos = 0;
  for (const label of labels) {
    const r = readDrumSection(body, label, ts, order);
    if (r.status !== 'ok') throw new Error(`${letter} ${label}: drum section is ${r.status}`);
    const startBar = pos / bt;
    if (!Number.isInteger(startBar)) throw new Error(`${letter} ${label}: starts inside a bar`);
    for (const e of r.events) {
      if (e.tuplet) throw new Error(`${letter} ${label}: tuplets are not supported`);
      const bar = Math.floor(pos / bt);
      const tick = pos - bar * bt;
      for (const h of e.hits) {
        hits.push({
          bar, tick, playTick: swingTick(tick, r.shuffle, [ts.num, ts.den]), inst: h.inst,
          ...(h.ghost ? { mark: 'g' as const } : h.accent ? { mark: 'ac' as const } : {}),
        });
      }
      pos += e.ticks;
    }
    if (pos % bt !== 0) throw new Error(`${letter} ${label}: section is not a whole number of bars`);
    for (let b = startBar; b < pos / bt; b++) swingBars.push({ bar: b, kind: r.shuffle });
  }
  const role = TAKE_ROLE[letter];
  return {
    name: role.name, letter, heldOut: role.heldOut, bpm: song.meta.tempo as number,
    ts: [ts.num, ts.den], barTicks: bt, nBars: pos / bt, hits, swingBars,
  };
}

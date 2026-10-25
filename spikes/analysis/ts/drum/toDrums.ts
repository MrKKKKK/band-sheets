/**
 * Spike 5 T7: QuantizedDrums -> the app's drum model (docs/audio-spike5-plan.md section 1 "できた": `DrumEvent[]` that
 * `serializeDrums` writes and `parseDrums` reads back unchanged).
 *
 * src/lib is READ ONLY here: this only checks that the analyzer output can be written by the app's own code.
 *   toDrumEvents()   bars [from, to) -> one section's DrumEvent[] + its shuffle:
 *     - per bar, one beat per distinct onset tick (hits sorted by `sortHits`; mark g -> ghost, ac -> accent 'normal'),
 *       lasting to the next onset (the bar end for the last); a leading gap or an empty bar is a rest; the section's
 *       last bar is full. Lengths that are not one note value become beat + rests via `normalizeDrums`.
 *     - a triplet span (fractional ticks, quantize.ts rule 8) becomes one `{tu 3}` group of written S/2 ticks
 *       (an 8th triplet in an '8' shuffle bar, a 16th triplet in a '16' bar); a gap after it is a rest.
 *     - S-拡張 names are dropped (counted in `droppedExt`); they stay in QuantizedDrums.
 *     - shuffle = sectionShuffle(): the kind most bars of the section have (ties: 'none' over a swing, '8' over '16'),
 *       because the app's shuffle is per section.
 *   drumRoundTrip()  serializeDrums -> parseDrums, and whether the parsed result deep-equals the input.
 * Throws RangeError on broken QuantizedDrums (HH with HO, an instrument twice on one tick, a fractional tick in a
 * straight bar).
 */
import { normalizeDrums, sortHits, type DrumEvent, type DrumHit, type Shuffle } from '../../../../src/lib/drum';
import type { DrumInstrument } from '../../../../src/lib/drumKit';
import { parseDrums } from '../../../../src/lib/drumParse';
import { serializeDrums } from '../../../../src/lib/drumTex';
import { barTicks, type TimeSig } from '../../../../src/lib/melody';
import { SWING_SPAN } from './swing';
import { APP_DRUM_INSTRUMENTS, type DrumSwingBar, type QuantizedDrumHit, type QuantizedDrums } from './types';

export const timeSigOf = (ts: [number, number]): TimeSig => ({ num: ts[0], den: ts[1] });

const APP = new Set<string>(APP_DRUM_INSTRUMENTS);
const EPS = 1e-6;

/** The section's shuffle: the most common bar kind in [from, to) (ties: 'none', then '8'). */
export function sectionShuffle(swingBars: readonly DrumSwingBar[], from: number, to: number): Shuffle {
  const n: Record<Shuffle, number> = { none: 0, '8': 0, '16': 0 };
  for (const s of swingBars) if (s.bar >= from && s.bar < to) n[s.kind]++;
  if (n.none >= n['8'] && n.none >= n['16']) return 'none';
  return n['8'] >= n['16'] ? '8' : '16';
}

function beatHits(hits: readonly QuantizedDrumHit[]): DrumHit[] {
  const seen = new Set<string>();
  const out: DrumHit[] = [];
  for (const h of hits) {
    if (seen.has(h.inst)) throw new RangeError(`${h.inst} twice at bar ${h.bar} tick ${h.tick}`);
    seen.add(h.inst);
    const d: DrumHit = { inst: h.inst as DrumInstrument };
    if (h.mark === 'g') d.ghost = true;
    if (h.mark === 'ac') d.accent = 'normal';
    out.push(d);
  }
  if (seen.has('HH') && seen.has('HO')) throw new RangeError(`HH with HO at bar ${hits[0].bar} tick ${hits[0].tick}`);
  return sortHits(out);
}

export interface ToDrumsResult {
  events: DrumEvent[];
  shuffle: Shuffle;
  /** S-拡張 hits left out. */
  droppedExt: number;
}

/** Bars [from, to) of `q` as one section (default: bar 0 to the last bar with a hit, or of swingBars). */
export function toDrumEvents(q: QuantizedDrums, swingBars: readonly DrumSwingBar[], range: { from?: number; to?: number } = {}): ToDrumsResult {
  const ts = timeSigOf(q.ts);
  const barT = barTicks(ts);
  const from = range.from ?? 0;
  const to = range.to ?? Math.max(swingBars.length, ...q.hits.map((h) => h.bar + 1), from);
  const kindOf = new Map(swingBars.map((s) => [s.bar, s.kind]));
  const inRange = q.hits.filter((h) => h.bar >= from && h.bar < to);
  const app = inRange.filter((h) => APP.has(h.inst));
  const events: DrumEvent[] = [];
  for (let bar = from; bar < to; bar++) {
    const hs = app.filter((h) => h.bar === bar);
    const kind = kindOf.get(bar) ?? 'none';
    const spans = new Set<number>();
    for (const h of hs) {
      if (Math.abs(h.tick - Math.round(h.tick)) < EPS) continue;
      if (kind === 'none') throw new RangeError(`fractional tick ${h.tick} in straight bar ${bar}`);
      const S = SWING_SPAN[kind];
      spans.add(Math.floor((h.tick + EPS) / S) * S);
    }
    const S = kind === 'none' ? 0 : SWING_SPAN[kind];
    const inSpan = (t: number) => [...spans].some((s) => t >= s - EPS && t < s + S - EPS);
    const onsets = [...new Set(hs.filter((h) => !inSpan(h.tick)).map((h) => h.tick))];
    const starts = [...onsets.map((t) => ({ t, span: false })), ...[...spans].map((t) => ({ t, span: true }))].sort((a, b) => a.t - b.t);
    const at = (t: number) => hs.filter((h) => Math.abs(h.tick - t) < EPS);
    if (!starts.length) {
      events.push({ hits: [], ticks: barT });
      continue;
    }
    if (starts[0].t > 0) events.push({ hits: [], ticks: starts[0].t });
    starts.forEach((s, i) => {
      const next = starts[i + 1]?.t ?? barT;
      if (!s.span) {
        events.push({ hits: beatHits(at(s.t)), ticks: next - s.t });
        return;
      }
      for (let k = 0; k < 3; k++) events.push({ hits: beatHits(at(s.t + (k * S) / 3)), ticks: S / 2, tuplet: { n: 3, slot: k } });
      if (next > s.t + S) events.push({ hits: [], ticks: next - s.t - S });
    });
  }
  return { events: normalizeDrums(events, ts).events, shuffle: sectionShuffle(swingBars, from, to), droppedExt: inRange.length - app.length };
}

export interface DrumRoundTrip {
  tex: string;
  parsed: boolean;
  identical: boolean;
  problem?: string;
}

const canon = (e: DrumEvent) => ({
  hits: e.hits.map((h) => ({ inst: h.inst, ghost: h.ghost, accent: h.accent })),
  ticks: e.ticks,
  tuplet: e.tuplet ? { n: e.tuplet.n, slot: e.tuplet.slot } : undefined,
});

/** serializeDrums -> parseDrums, compared with the input (empty events read back as shuffle 'none'). */
export function drumRoundTrip(events: DrumEvent[], shuffle: Shuffle, ts: TimeSig): DrumRoundTrip {
  const tex = serializeDrums(events, shuffle, ts);
  const res = parseDrums(tex, ts);
  if (!res.ok) return { tex, parsed: false, identical: false, problem: res.reason };
  const want = events.length ? shuffle : 'none';
  let problem: string | undefined;
  if (res.shuffle !== want) problem = `shuffle ${res.shuffle} != ${want}`;
  else if (res.events.length !== events.length) problem = `event count ${res.events.length} != ${events.length}`;
  else {
    const i = events.findIndex((e, k) => JSON.stringify(canon(e)) !== JSON.stringify(canon(res.events[k])));
    if (i >= 0) problem = `event ${i} differs`;
  }
  return { tex, parsed: true, identical: problem === undefined, problem };
}

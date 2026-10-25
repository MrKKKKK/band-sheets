// Spike 5 T2: places one-shots on the timeline. Pure and deterministic (no randomness here: the caller draws).
//
// Each hit's one-shot is placed so that its onset sample (`onset`, see render.ts chainOnset) lands on `at`; voices are summed
// with their gain. Hi-hat choke (DRUM_SAMPLES.md risk 2: the sf2's exclusiveClass is lost when one-shots are
// rendered one by one, and B / C have none): every hit of the HH group (HH, HO, HH.foot, HH.fsp) fades out all
// earlier HH-group voices over CHOKE_SEC starting at its own onset sample -- closing the hats stops an open hat.

import type { DrumInst } from '../../ts/drum/types';
import type { OneShot } from './kits';
import { HH_GROUP } from './patterns';

export const CHOKE_SEC = 0.015;

export interface MixHit {
  inst: DrumInst;
  /** Sample index where the one-shot's onset lands. */
  at: number;
  /** The onset (sample of `voice.x`) placed on `at`: the onset of the voice as heard through the room / mic chain. */
  onset: number;
  gain: number;
  voice: OneShot;
}

export interface MixWindow {
  /** First output sample (default 0): out[i] is audio sample from + i. */
  from?: number;
  /** Onset samples of the HH-group hits that choke (default: those in `hits`). */
  hhAt?: readonly number[];
}

export function mixHits(hits: readonly MixHit[], n: number, sr: number, w: MixWindow = {}): Float64Array {
  const from = w.from ?? 0;
  const out = new Float64Array(n);
  const hh = [...(w.hhAt ?? hits.filter((h) => HH_GROUP.has(h.inst)).map((h) => h.at))].sort((a, b) => a - b);
  const chokeLen = Math.max(1, Math.round(CHOKE_SEC * sr));
  for (const h of hits) {
    const start = h.at - h.onset;
    if (start < 0) throw new Error(`hit at sample ${h.at} starts before the audio (onset ${h.onset})`);
    let end = start + h.voice.x.length;
    let chokeAt = Infinity;
    if (HH_GROUP.has(h.inst)) {
      const next = hh.find((a) => a > h.at);
      if (next !== undefined) {
        chokeAt = next;
        end = Math.min(end, next + chokeLen);
      }
    }
    const x = h.voice.x;
    const lo = Math.max(start, from);
    const hi = Math.min(end, from + n);
    for (let i = lo; i < hi; i++) {
      let v = x[i - start] * h.gain;
      if (i >= chokeAt) v *= 0.5 * (1 + Math.cos((Math.PI * (i - chokeAt)) / chokeLen));
      out[i - from] += v;
    }
  }
  return out;
}

// Spike 5 T2: truth-vs-audio check (plan T2 "正解の時刻と音の始まりが ±1 ms").
//
// The rendered audio before the noise is linear in the hits (mix -> room -> mic are linear, causal filters), except
// for the HH choke, which depends on which HH hits exist. So the sound a hit k adds to the wav is exactly
//   chain(mix(all hits)) - chain(mix(all hits without k)),
// both mixes using the same choke times except k's own. We compute that difference on a short window starting at k's
// one-shot start (it is zero before: nothing is added earlier), run room + mic on it, and measure its onset with the
// same definition the one-shots use (kits.ts onsetIndex, from the first non-zero sample). The error is
// measured onset - truth t. Noise is left out (it is the same draw with and without k).

import { onsetIndex, SAMPLE_RATE } from './kits';
import { mixHits } from './mixer';
import { HH_GROUP } from './patterns';
import { placeHits, roomAndMic } from './render';
import type { DrumVariant } from './variants';

/** Window after the one-shot start (covers the pre-roll and the onset peak window). */
const WINDOW_SEC = 0.25;
export const ONSET_TOL_SEC = 0.001;

export interface OnsetCheck {
  checked: number;
  passed: number;
  /** Largest |measured - truth| (s). */
  maxAbsSec: number;
  /** Per instrument: [checked, max |err| (s)]. */
  perInst: Record<string, [number, number]>;
}

export function checkOnsets(v: DrumVariant, every = 1, sr = SAMPLE_RATE): OnsetCheck {
  const { params, placed, mix } = placeHits(v, sr);
  const hhAll = mix.filter((h) => HH_GROUP.has(h.inst)).map((h) => h.at);
  const res: OnsetCheck = { checked: 0, passed: 0, maxAbsSec: 0, perInst: {} };
  for (let k = 0; k < mix.length; k += every) {
    const hk = mix[k];
    const from = hk.at - hk.onset;
    const n = Math.round(WINDOW_SEC * sr) + hk.onset;
    // Voices that k can change: k itself and the HH-group voices it chokes (earlier ones still sounding).
    const others = HH_GROUP.has(hk.inst) ? mix.filter((h, j) => j !== k && HH_GROUP.has(h.inst) && h.at < hk.at) : [];
    const withK = mixHits([hk, ...others], n, sr, { from, hhAt: hhAll });
    const without = mixHits(others, n, sr, { from, hhAt: hhAll.filter((a, j) => !(a === hk.at && j === hhAll.indexOf(hk.at))) });
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = withK[i] - without[i];
    roomAndMic(d, params, sr);
    let s0 = 0;
    while (s0 < n && d[s0] === 0) s0++;
    const on = onsetIndex(d, sr, s0);
    const err = on < 0 ? Infinity : (from + on) / sr - Math.round((placed[k].at / sr) * 1e6) / 1e6;
    const a = Math.abs(err);
    res.checked++;
    if (a <= ONSET_TOL_SEC) res.passed++;
    res.maxAbsSec = Math.max(res.maxAbsSec, a);
    const pi = (res.perInst[hk.inst] ??= [0, 0]);
    pi[0]++;
    pi[1] = Math.max(pi[1], a);
  }
  return res;
}

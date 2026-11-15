// Spike 7 T5: truth-vs-audio checks (plan T5: "正解の時刻 ±1 ms", "正解の種類が描いた音と一致").
//
// Onsets (as spike 6's render/bass/check.ts): the audio before the noise is linear in the placed voices and the room is
// linear and causal, so what note k adds to the wav is exactly room(voice k placed alone). We run the room on that from
// its first sample and measure its onset with the voices' own definition (render/drum/kits.ts onsetIndex);
// error = measured - truth t.
// Pitch classes: per truth segment, the set of pitch classes of the notes struck in it (by their segment and by their
// time: onset within the segment, widened by the timing spread) equals the truth's `pcs`, and that equals the chord's
// own template (the 9th's form) plus its bass, so the written quality is what is heard. A note of a segment must also
// start inside it (+- the spread), and every note-off ends before the next segment's notes start + the spread.

import { onsetIndex } from '../drum/kits';
import { SAMPLE_RATE } from '../bass/timbres';
import { chordPcs } from './chordName';
import { applyRoom, prepareC2 } from './render';
import type { C2Variant } from './variants';

export const ONSET_TOL_SEC = 0.001;

export interface C2Check {
  checked: number;
  passed: number;
  maxAbsSec: number;
  segments: number;
  /** Segments whose struck pitch classes equal the truth chord's (template + bass). */
  pcsOk: number;
  /** First mismatches (text: wanted / played), at most 5. */
  pcsBad: string[];
}

export function checkC2(v: C2Variant, every = 1, sr = SAMPLE_RATE): C2Check {
  const { params, chart, placed } = prepareC2(v, sr);
  const res: C2Check = { checked: 0, passed: 0, maxAbsSec: 0, segments: 0, pcsOk: 0, pcsBad: [] };
  for (let k = 0; k < placed.length; k += every) {
    const pn = placed[k];
    const d = applyRoom(Float64Array.from(pn.x), params.room, sr);
    let s0 = 0;
    while (s0 < d.length && d[s0] === 0) s0++;
    const on = onsetIndex(d, sr, s0);
    const err = on < 0 ? Infinity : (pn.at - pn.onset + on) / sr - pn.t;
    res.checked++;
    if (Math.abs(err) <= ONSET_TOL_SEC) res.passed++;
    res.maxAbsSec = Math.max(res.maxAbsSec, Math.abs(err));
  }
  const spread = params.jitterSec * 1.5 + 1e-3;
  const sec = (beat: number) => params.leadSec + (beat * 60) / params.bpm;
  chart.chords.forEach((c, i) => {
    res.segments++;
    const [s, e] = [sec(c.beat), sec(c.beat + c.beats)];
    const mine = placed.filter((n) => n.seg === i);
    const inTime = placed.filter((n) => n.t >= s - spread && n.t < e - spread);
    const set = (ns: typeof placed) => [...new Set(ns.map((n) => n.midi % 12))].sort((a, b) => a - b).join(',');
    const want = chordPcs(c.chord, c.form === 'no5' ? 1 : 0).join(',');
    const ok = set(mine) === want && set(inTime) === want && mine.every((n) => n.t >= s - spread && n.t < e + spread);
    if (ok) res.pcsOk++;
    else if (res.pcsBad.length < 5) res.pcsBad.push(`${c.text}: ${want} / ${set(mine)} (${set(inTime)})`);
  });
  return res;
}

// Spike 6 T2: truth-vs-audio checks (plan T2: "正解の時刻と音の始まりが ±1 ms", "譜のベースが MIDI の区間の頭の音と一致").
//
// Onsets: the audio before the noise is linear in the bass voices (each voice is fixed by its own note: envelope from
// its note-off and the next onset, render.ts), and room / phone mic are linear, causal filters, so the sound note k adds
// to the wav is exactly chain(voice k placed alone). We run the chain on that, from the voice's first sample, and
// measure its onset with the definition the voices use (render/drum/kits.ts onsetIndex); error = measured - truth t.
// The output gain does not move an onset (relative threshold); the noise is the same draw with and without k.
// Heads: for every truth chord, the bass MIDI (before jitter) has a note starting exactly at the chord's start, and its
// pitch class is the chord's written bass (`/X`, else the root); the truth's `played` head carries the same pitch.

import { onsetIndex } from '../drum/kits';
import { noteToPc } from '../../ts/bass/score';
import { chain, prepareBass } from './render';
import { SAMPLE_RATE } from './timbres';
import type { BassVariant } from './variants';

export const ONSET_TOL_SEC = 0.001;

export interface BassCheck {
  checked: number;
  passed: number;
  maxAbsSec: number;
  segments: number;
  /** Segments whose head note (MIDI and truth) plays the written bass. */
  headsOk: number;
}

export function checkBass(v: BassVariant, every = 1, sr = SAMPLE_RATE): BassCheck {
  const { params, btruth, placed } = prepareBass(v, sr);
  const res: BassCheck = { checked: 0, passed: 0, maxAbsSec: 0, segments: 0, headsOk: 0 };
  for (let k = 0; k < placed.length; k += every) {
    const pn = placed[k];
    const d = Float64Array.from(pn.x);
    chain(d, params, sr);
    let s0 = 0;
    while (s0 < d.length && d[s0] === 0) s0++;
    const on = onsetIndex(d, sr, s0);
    const err = on < 0 ? Infinity : (pn.at - pn.onset + on) / sr - pn.t;
    res.checked++;
    if (Math.abs(err) <= ONSET_TOL_SEC) res.passed++;
    res.maxAbsSec = Math.max(res.maxAbsSec, Math.abs(err));
  }
  const midi = btruth.melody?.notes ?? [];
  const heads = placed.filter((n) => n.note.role === 'head');
  for (const [i, c] of (btruth.chords ?? []).entries()) {
    res.segments++;
    const written = noteToPc(c.bass ?? c.root);
    const m = midi.find((n) => Math.abs(n.start - c.start) < 1e-6);
    if (m && m.midi % 12 === written && heads[i]?.note.midi === m.midi) res.headsOk++;
  }
  return res;
}

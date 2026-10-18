// Spike 4 T1: how the synthetic singer performs a score (docs/audio-spike4-plan.md section 4).
//
// perform() turns the score (MelodyEvent[] + bpm + lead-in) and the SynthParams into
//   - sung notes: start/end in seconds after onset jitter and bias, target pitch (score MIDI + per-note
//     offset + tuning), grouped into phrases (runs sung without a break: "la" and "n" are legato, "ta"
//     and the H0 "gap" style put a short silence before every note);
//   - pitchAt(t, j): the exact pitch contour in fractional MIDI inside note j (glide or scoop at the
//     start, vibrato on long notes, slow drift, micro jitter);
//   - envAt(t, k, j): the loudness envelope (0..1) of phrase k at time t (attack, release, loudness dips
//     at the note boundaries inside the phrase);
//   - breaths and click times.
// The same functions drive the synthesis (voice.ts) and the frame f0 truth (truth.ts), so the truth is
// exact by construction.

import type { MelodyEvent } from '../../../../src/lib/melody';
import { midiOf } from './melodies';
import { PITCH_CLIP_CENTS, streamOf, type HumScore, type HumVariant, type SynthParams } from './variants';

export interface ScoreNote {
  /** Index of the event in the score's MelodyEvent[]. */
  event: number;
  startTick: number;
  ticks: number;
  midi: number;
  /** Score times (s, from the start of the audio). */
  scoreStart: number;
  scoreEnd: number;
  /** A rest (or the end) follows instead of a note. */
  restAfter: boolean;
}

export interface SungNote {
  /** Index into Performance.scoreNotes (same order; one sung note per score note). */
  score: number;
  midi: number;
  start: number;
  end: number;
  /** Per-note offset (cents), before tuning and drift. */
  devCents: number;
  /** Target pitch in fractional MIDI: midi + (dev + tuning) / 100 (drift and jitter are added in pitchAt). */
  target: number;
  phrase: number;
  /** Scoop depth (cents below target) and length (s) at a phrase start, 0 = none. */
  scoopCents: number;
  scoopSec: number;
  glideSec: number;
  /** Vibrato on this note (long enough). */
  vibrato: boolean;
  /** Linear loudness dip factor (0..1) at this note's start inside a phrase. */
  dip: number;
}

export interface Phrase {
  start: number;
  end: number;
  /** Indexes of its sung notes (consecutive). */
  notes: number[];
}

export interface Breath {
  start: number;
  end: number;
}

export interface Performance {
  bpm: number;
  beatSec: number;
  /** Bar 1 beat 1 (after the 1-bar count-in). */
  startSec: number;
  /** End of the last bar. */
  durationSec: number;
  totalTicks: number;
  scoreNotes: ScoreNote[];
  sung: SungNote[];
  phrases: Phrase[];
  breaths: Breath[];
  /** Click times from the count-in to the last bar line, and whether each is a downbeat. */
  clicks: { t: number; down: boolean }[];
  pitchAt(t: number, j: number): number;
  envAt(t: number, k: number, j: number): number;
  /** Drift + tuning + dev of note j at time t, in cents (no vibrato/glide/jitter). */
  centsAt(t: number, j: number): number;
}

/** Raised cosine 0 -> 1 on x in [0, 1]. */
export const rc = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

const clip = (x: number, lim: number) => Math.max(-lim, Math.min(lim, x));
const JITTER_STEP = 0.001;

export function scoreNotes(events: MelodyEvent[], bpm: number, startSec: number): ScoreNote[] {
  const tickSec = 60 / bpm / 16;
  const out: ScoreNote[] = [];
  let t = 0;
  events.forEach((e, i) => {
    if (e.kind === 'note') {
      out.push({
        event: i,
        startTick: t,
        ticks: e.ticks,
        midi: midiOf(e.pitch!),
        scoreStart: startSec + t * tickSec,
        scoreEnd: startSec + (t + e.ticks) * tickSec,
        restAfter: events[i + 1]?.kind !== 'note',
      });
    }
    t += e.ticks;
  });
  return out;
}

export function perform(v: HumVariant, score: HumScore, p: SynthParams): Performance {
  const beatSec = 60 / score.bpm;
  const startSec = score.leadSec + 4 * beatSec;
  const totalTicks = score.events.reduce((s, e) => s + e.ticks, 0);
  const durationSec = startSec + (totalTicks / 16) * beatSec;
  const notes = scoreNotes(score.events, score.bpm, startSec);
  const rt = streamOf(v, `timing-h${v.level}`);
  const rp = streamOf(v, `pitch-h${v.level}`);

  // ---- onsets ----
  const starts: number[] = [];
  notes.forEach((n, i) => {
    let s = n.scoreStart + p.onsetBiasSec + clip(gauss(rt) * p.onsetSigmaSec, 2.5 * p.onsetSigmaSec);
    if (i > 0) {
      const prev = notes[i - 1];
      s = Math.max(s, starts[i - 1] + Math.max(0.5 * (prev.scoreEnd - prev.scoreStart), 0.06));
    }
    starts.push(s);
  });
  // ---- ends ----
  const separated = p.articulation === 'gap' || p.articulation === 'ta';
  const ends: number[] = notes.map((n, i) => {
    const dur = n.scoreEnd - n.scoreStart;
    const gapMin = p.articulation === 'gap' ? Math.min(0.05, 0.25 * dur) : p.articulation === 'ta' ? p.closureSec : 0;
    if (!n.restAfter) return starts[i + 1] - gapMin;
    const early = p.endEarly[0] + (p.endEarly[1] - p.endEarly[0]) * rt();
    let e = n.scoreEnd + p.onsetBiasSec - Math.max(p.source === 'sine' ? gapMin : 0.03, early * dur);
    if (i + 1 < notes.length) e = Math.min(e, starts[i + 1] - 0.05);
    return Math.max(e, starts[i] + Math.max(0.5 * dur, 0.05));
  });

  // ---- phrases ----
  const phrases: Phrase[] = [];
  notes.forEach((_n, i) => {
    const legatoFromPrev = i > 0 && !separated && !notes[i - 1].restAfter;
    if (!legatoFromPrev) phrases.push({ start: starts[i], end: ends[i], notes: [i] });
    else {
      const ph = phrases[phrases.length - 1];
      ph.notes.push(i);
      ph.end = ends[i];
    }
  });

  // ---- pitch draws ----
  const sung: SungNote[] = notes.map((n, i) => {
    const devCents = clip(gauss(rp) * p.pitchSigmaCents, PITCH_CLIP_CENTS);
    const scoop = rp() < p.scoopProb;
    return {
      score: i,
      midi: n.midi,
      start: starts[i],
      end: ends[i],
      devCents,
      target: n.midi + (devCents + p.tuningCents) / 100,
      phrase: -1,
      scoopCents: scoop ? p.scoopCents[0] + (p.scoopCents[1] - p.scoopCents[0]) * rp() : 0,
      scoopSec: p.scoopSec[0] + (p.scoopSec[1] - p.scoopSec[0]) * rp(),
      glideSec: p.glideSec[0] + (p.glideSec[1] - p.glideSec[0]) * rp(),
      vibrato: p.vibrato && ends[i] - starts[i] >= p.vibMinSec,
      dip: 0,
    };
  });
  phrases.forEach((ph, k) =>
    ph.notes.forEach((j, x) => {
      sung[j].phrase = k;
      // Inside a phrase: a loudness dip at the boundary and a glide (scoops only at phrase starts).
      if (x > 0) {
        const db = sung[j].midi === sung[j - 1].midi ? p.repeatDipDb : p.dipDb;
        sung[j].dip = 1 - 10 ** (-db / 20);
        sung[j].scoopCents = 0;
      }
    }),
  );

  // ---- micro jitter (smoothed noise, 1 ms grid) ----
  const nJ = Math.ceil((durationSec + 2) / JITTER_STEP) + 2;
  const jitter = new Float64Array(nJ);
  if (p.jitterCents > 0) {
    const rj = streamOf(v, `jitter-h${v.level}`);
    const a = Math.exp(-JITTER_STEP / 0.03);
    let y = 0;
    let ss = 0;
    for (let i = 0; i < nJ; i++) {
      y = a * y + (1 - a) * gauss(rj);
      jitter[i] = y;
      ss += y * y;
    }
    const scale = p.jitterCents / Math.sqrt(ss / nJ);
    for (let i = 0; i < nJ; i++) jitter[i] *= scale;
  }
  const jitterAt = (t: number) => {
    const x = Math.max(0, t / JITTER_STEP);
    const i = Math.min(nJ - 2, Math.floor(x));
    const f = x - i;
    return jitter[i] * (1 - f) + jitter[i + 1] * f;
  };
  const [T1, T2] = p.driftPeriods;
  const [P1, P2] = p.driftPhases;
  const driftAt = (t: number) =>
    p.driftCents === 0 ? 0 : p.driftCents * (0.7 * Math.sin((2 * Math.PI * t) / T1 + P1) + 0.3 * Math.sin((2 * Math.PI * t) / T2 + P2));

  const vibDepth = p.vibDepthCents / 100;
  const pitchAt = (t: number, j: number): number => {
    const n = sung[j];
    let x = n.target + (driftAt(t) + jitterAt(t)) / 100;
    const dt = t - n.start;
    const first = phrases[n.phrase].notes[0] === j;
    if (first) {
      if (n.scoopCents > 0 && dt < n.scoopSec) x -= (n.scoopCents / 100) * (1 - rc(dt / n.scoopSec));
    } else if (p.glide && dt < n.glideSec) {
      x += (sung[j - 1].target - n.target) * (1 - rc(dt / n.glideSec));
    }
    if (n.vibrato && dt > 0.15) x += vibDepth * rc((dt - 0.15) / 0.2) * Math.sin(2 * Math.PI * p.vibRateHz * dt);
    return x;
  };
  const centsAt = (t: number, j: number) => sung[j].devCents + p.tuningCents + driftAt(t);

  const envAt = (t: number, k: number, j: number): number => {
    const ph = phrases[k];
    if (t < ph.start || t > ph.end) return 0;
    let a = Math.min(rc((t - ph.start) / p.attackSec), rc((ph.end - t) / p.releaseSec));
    const half = p.dipSec / 2;
    for (const q of [j, j + 1]) {
      if (q >= sung.length || sung[q].phrase !== k || sung[q].dip === 0) continue;
      const x = (t - sung[q].start) / half;
      if (x > -1 && x < 1) a *= 1 - sung[q].dip * 0.5 * (1 + Math.cos(Math.PI * x));
    }
    return a;
  };

  // ---- breaths ----
  const breaths: Breath[] = [];
  if (p.breathDb !== null) {
    const rb = streamOf(v, `breath-h${v.level}`);
    phrases.forEach((ph, k) => {
      const prevEnd = k === 0 ? 0 : phrases[k - 1].end;
      const len = 0.2 + 0.15 * rb();
      const end = ph.start - (0.05 + 0.1 * rb());
      if (ph.start - prevEnd >= 0.4 && end - len >= prevEnd + 0.05) breaths.push({ start: end - len, end });
    });
  }

  const clicks: { t: number; down: boolean }[] = [];
  for (let b = 0; score.leadSec + b * beatSec < durationSec - 1e-9; b++) clicks.push({ t: score.leadSec + b * beatSec, down: b % 4 === 0 });

  return { bpm: score.bpm, beatSec, startSec, durationSec, totalTicks, scoreNotes: notes, sung, phrases, breaths, clicks, pitchAt, envAt, centsAt };
}

/** Index of the sung note of phrase k sounding at time t (the last one whose start <= t). */
export function noteAt(perf: Performance, k: number, t: number): number {
  const ns = perf.phrases[k].notes;
  let j = ns[0];
  for (const q of ns) if (perf.sung[q].start <= t) j = q;
  return j;
}

/** Phrase sounding at time t, or -1. */
export function phraseAt(perf: Performance, t: number): number {
  for (let k = 0; k < perf.phrases.length; k++) if (t >= perf.phrases[k].start && t <= perf.phrases[k].end) return k;
  return -1;
}

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

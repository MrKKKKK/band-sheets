import { describe, expect, it } from 'vitest';
import { midiToHz, noteAt, perform, phraseAt, rc, scoreNotes } from './contour';
import { allHumVariants, humScore, synthParams } from './variants';

const find = (name: string) => allHumVariants().find((v) => v.name === name)!;
const run = (name: string) => {
  const v = find(name);
  const score = humScore(v);
  const p = synthParams(v);
  return { v, score, p, perf: perform(v, score, p) };
};

describe('helpers', () => {
  it('rc and midiToHz', () => {
    expect([rc(-1), rc(2)]).toEqual([0, 1]);
    expect(rc(0.5)).toBeCloseTo(0.5, 12);
    expect(midiToHz(69)).toBe(440);
  });
  it('scoreNotes times from bar 1', () => {
    const ns = scoreNotes([{ kind: 'rest', ticks: 16 }, { kind: 'note', pitch: 'C4', ticks: 16 }], 120, 2);
    expect(ns).toEqual([{ event: 1, startTick: 16, ticks: 16, midi: 60, scoreStart: 2.5, scoreEnd: 3, restAfter: true }]);
  });
});

describe('perform', () => {
  it('H0: onsets exactly on the score, a gap before every note, one phrase per note', () => {
    const { perf, score } = run('syn-h0-saints-s2');
    expect(perf.startSec).toBeCloseTo(score.leadSec + 4 * (60 / score.bpm), 12);
    perf.sung.forEach((n, i) => {
      expect(n.start).toBe(perf.scoreNotes[i].scoreStart);
      expect(n.end).toBeLessThan(perf.scoreNotes[i].scoreEnd);
      expect(n.target).toBe(n.midi);
      expect(perf.pitchAt((n.start + n.end) / 2, i)).toBe(n.midi);
    });
    expect(perf.phrases).toHaveLength(perf.sung.length);
  });
  it('H1 la: legato phrases with dips; exact timing; vibrato on long notes only', () => {
    // pick a seed whose H1 articulation is 'la'
    const name = [1, 2, 3, 4, 5].map((s) => `syn-h1-saints-s${s}`).find((n) => synthParams(find(n)).articulation === 'la')!;
    const { perf } = run(name);
    expect(perf.phrases.length).toBeLessThan(perf.sung.length);
    perf.sung.forEach((n, i) => {
      expect(n.start).toBe(perf.scoreNotes[i].scoreStart);
      expect(n.vibrato).toBe(n.end - n.start >= 0.45);
      if (perf.phrases[n.phrase].notes[0] !== i) expect(n.dip).toBeGreaterThan(0);
    });
  });
  it('H2/H3: onsets jittered within bias +- 2.5 sigma, ordered, notes not too short', () => {
    for (const name of ['syn-h2-rand-s3', 'syn-h3-rand-s3', 'syn-h3-saints-s5']) {
      const { perf, p } = run(name);
      let moved = 0;
      perf.sung.forEach((n, i) => {
        const d = n.start - perf.scoreNotes[i].scoreStart - p.onsetBiasSec;
        if (Math.abs(d) > 1e-9) moved++;
        expect(n.end).toBeGreaterThan(n.start + 0.04);
        if (i > 0) expect(n.start).toBeGreaterThanOrEqual(perf.sung[i - 1].end);
        // the clamp may only push an onset later
        expect(d).toBeGreaterThanOrEqual(-2.5 * p.onsetSigmaSec - 1e-9);
        expect(Math.abs(n.devCents)).toBeLessThanOrEqual(45);
      });
      expect(moved).toBeGreaterThan(perf.sung.length / 2);
    }
  });
  it('noteAt / phraseAt find the sounding note', () => {
    const { perf } = run('syn-h2-kirakira-s1');
    perf.sung.forEach((n, j) => {
      const t = (n.start + n.end) / 2;
      const k = phraseAt(perf, t);
      expect(k).toBe(n.phrase);
      expect(noteAt(perf, k, t)).toBe(j);
    });
    expect(phraseAt(perf, 0.01)).toBe(-1);
  });
  it('envelope is 0 outside phrases and 1 in a steady part', () => {
    const { perf } = run('syn-h1-etude-s1');
    const n = perf.sung[0];
    expect(perf.envAt(n.start - 0.01, n.phrase, 0)).toBe(0);
    expect(perf.envAt((n.start + n.end) / 2, n.phrase, 0)).toBe(1);
  });
  it('clicks cover the count-in and every beat to the last bar line', () => {
    const { perf, score } = run('syn-h3-kirakira-s1');
    expect(perf.clicks).toHaveLength(4 + 4 * 4);
    expect(perf.clicks[0]).toEqual({ t: score.leadSec, down: true });
    expect(perf.clicks[4].t).toBeCloseTo(perf.startSec, 12);
  });
});

describe('perform H4 (realistic)', () => {
  it('every note starts with a scoop or (after a different pitch in a phrase) a portamento; onsets stay the sung onsets', () => {
    for (const name of ['syn-h4-saints-s1', 'syn-h4-rand-s4', 'syn-h4-kirakira-s5']) {
      const { perf, p } = run(name);
      perf.sung.forEach((n, j) => {
        const q = n.real!;
        const L = n.end - n.start;
        const first = perf.phrases[n.phrase].notes[0] === j;
        const same = !first && perf.sung[j - 1].midi === n.midi;
        expect(q.kind).toBe(first || same ? 'scoop' : 'porta');
        expect(q.transSec).toBeLessThanOrEqual(0.6 * L + 1e-9);
        expect(q.settleSec).toBeLessThanOrEqual(0.6 * L + 1e-9);
        expect(Math.abs(n.devCents)).toBeLessThanOrEqual(100);
        expect(q.wanderCents).toBeGreaterThanOrEqual(30);
        expect(q.wanderCents).toBeLessThanOrEqual(60);
        const at0 = perf.pitchAt(n.start, j);
        if (q.kind === 'scoop') {
          expect(n.scoopCents).toBeGreaterThanOrEqual(100);
          expect(n.scoopCents).toBeLessThanOrEqual(300);
          // starts (about) scoopCents below the target; wander/drift can move it by < 1 semitone
          expect(n.target - at0).toBeGreaterThan(n.scoopCents / 100 - 1);
        } else expect(Math.abs(at0 - perf.sung[j - 1].target)).toBeLessThan(1);
        expect(n.start).toBeGreaterThanOrEqual(perf.scoreNotes[j].scoreStart + p.onsetBiasSec - 2.5 * p.onsetSigmaSec - 1e-9);
      });
    }
  });
  it('the contour inside the steady part averages to the truth cents within the vibrato/jitter spread', () => {
    const { perf } = run('syn-h4-etude-s2');
    perf.sung.forEach((n, j) => {
      const L = n.end - n.start;
      const a = n.start + Math.max(0.25 * L, n.real!.settleSec + 0.1);
      const b = n.end - 0.2 * L;
      if (b - a < 0.2) return;
      let s = 0;
      const k = 200;
      for (let i = 0; i < k; i++) s += perf.pitchAt(a + ((b - a) * (i + 0.5)) / k, j);
      const ref = n.midi + perf.centsAt((n.start + n.end) / 2, j) / 100;
      expect(Math.abs(s / k - ref) * 100).toBeLessThan(30);
    });
  });
  it('sometimes cuts a phrase-final note short (breath)', () => {
    let cut = 0;
    let total = 0;
    for (const s of [1, 2, 3]) {
      const { perf } = run(`syn-h4-saints-s${s}`);
      perf.sung.forEach((n, i) => {
        const sn = perf.scoreNotes[i];
        if (!sn.restAfter) return;
        total++;
        if (n.end - n.start < 0.75 * (sn.scoreEnd - sn.scoreStart)) cut++;
      });
    }
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(total);
  });
});

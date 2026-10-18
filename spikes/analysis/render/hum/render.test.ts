import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkH0, checkSung, excursionStats, guidedF0, sungTolerance, zeroCrossingHz } from './check';
import { midiToHz } from './contour';
import { renderHum } from './render';
import { F0_HOP_SEC, VOICED_ENV } from './truth';
import { allHumVariants, SAMPLE_RATE } from './variants';

const find = (name: string) => allHumVariants().find((v) => v.name === name)!;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('renderHum', () => {
  it('same seed -> bit-identical wav (every level)', () => {
    for (const l of [0, 1, 2, 3, 4]) {
      const v = find(`syn-h${l}-kirakira-s2`);
      expect(sha(renderHum(v).wav)).toBe(sha(renderHum(v).wav));
    }
  });
  it('different seeds or levels -> different wavs', () => {
    const a = sha(renderHum(find('syn-h3-kirakira-s2')).wav);
    expect(sha(renderHum(find('syn-h3-kirakira-s3')).wav)).not.toBe(a);
    expect(sha(renderHum(find('syn-h2-kirakira-s2')).wav)).not.toBe(a);
  });
  it('H0..H3 stay bit-identical to T1 (bdea309) after adding H4', () => {
    expect(sha(renderHum(find('syn-h1-saints-s4')).wav)).toBe('a3193a4ff6b8ccae02270497113805780248a24a5db821b3e4bb4bc56b2ceaa4');
    const r = renderHum(find('syn-h3-rand-s7'));
    expect(sha(r.wav)).toBe('13462f39e44d1f4d83d82e396f24deb2f878c634231f3072163383376b815b42');
    expect(sha(Buffer.from(JSON.stringify(r.truth)))).toBe('3a9361701e8c37e2f638b1524f3eceb53cdda08fd477ca2f6bf01e427de0d57a');
  });
  it('renders a variant in under 1 s and does not clip', () => {
    const t = performance.now();
    const r = renderHum(find('syn-h3-saints-s1'));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.clipped).toBe(0);
  });
});

describe('truth', () => {
  const r = renderHum(find('syn-h2-rand-s2'));
  const { truth, perf } = r;
  it('HumInfo: bar 1 after the lead-in and a 1-bar count-in', () => {
    expect(truth.hum.info.ts).toEqual([4, 4]);
    expect(truth.hum.info.startSec).toBeCloseTo(r.score.leadSec + (4 * 60) / r.score.bpm, 5);
    expect(truth.hum.info.bpm).toBe(r.score.bpm);
  });
  it('score truth: consecutive events from tick 0, notes linked to sung notes', () => {
    let t = 0;
    for (const e of truth.melody.quantized.events) {
      expect(e.startTick).toBe(t);
      t += e.ticks;
      if (e.kind === 'note') {
        const n = truth.melody.notes[e.src];
        expect([n.midi, n.startTick, n.ticks]).toEqual([e.midi, e.startTick, e.ticks]);
      }
    }
    expect(t).toBe(8 * 64);
    expect(truth.melody.quantized.events.filter((e) => e.kind === 'note')).toHaveLength(truth.melody.notes.length);
  });
  it('sung truth differs from the score times (jitter) but stays ordered', () => {
    const tickSec = 60 / r.score.bpm / 16;
    const off = truth.melody.notes.map((n) => n.start - (truth.hum.info.startSec + n.startTick * tickSec));
    expect(off.some((d) => Math.abs(d) > 0.005)).toBe(true);
    truth.melody.notes.forEach((n, i) => i > 0 && expect(n.start).toBeGreaterThanOrEqual(truth.melody.notes[i - 1].end - 1e-6));
  });
  it('frame f0 truth: analyzer grid, voiced only inside sung notes, near the note pitch mid-note', () => {
    const f0 = truth.hum.f0;
    expect(f0.hopSec).toBe(F0_HOP_SEC);
    expect(f0.hz.length).toBe(Math.floor(truth.source.audioSec! / F0_HOP_SEC) + 1);
    expect(VOICED_ENV).toBe(0.1);
    f0.hz.forEach((hz, i) => {
      const t = i * F0_HOP_SEC;
      const inside = truth.melody.notes.some((n) => t >= n.start - 1e-6 && t <= n.end + 1e-6);
      if (hz > 0) expect(inside).toBe(true);
      expect(f0.voiced[i]).toBe(hz > 0 ? 1 : 0);
    });
    for (const n of perf.sung.filter((s) => s.end - s.start > 0.3)) {
      const i = Math.round((n.start + n.end) / 2 / F0_HOP_SEC);
      expect(Math.abs(1200 * Math.log2(f0.hz[i] / midiToHz(n.midi)))).toBeLessThan(160);
    }
  });
  it('heldOut is flagged in the truth', () => {
    expect(renderHum(find('syn-h0-kirakira-s7')).truth.hum.variant).toMatchObject({ split: 'heldOut', heldOut: true });
    expect(truth.hum.variant).toMatchObject({ split: 'tuning', heldOut: false, level: 'H2' });
  });
});

describe('checks (truth vs audio)', () => {
  it('zeroCrossingHz and guidedF0 measure a sine', () => {
    const x = new Float64Array(SAMPLE_RATE).map((_, i) => Math.sin((2 * Math.PI * 123.4 * i) / SAMPLE_RATE));
    expect(zeroCrossingHz(x, SAMPLE_RATE, 0.1, 0.9)).toBeCloseTo(123.4, 6);
    expect(Math.abs(1200 * Math.log2(guidedF0(x, SAMPLE_RATE, 0.5, 120) / 123.4))).toBeLessThan(1);
  });
  it('H0: every note within +-1 cent', () => {
    for (const m of ['kirakira', 'rand']) {
      const r = renderHum(find(`syn-h0-${m}-s1`));
      const c = checkH0(r.samples, SAMPLE_RATE, r.truth);
      expect(c.passed).toBe(c.notes);
      expect(c.maxAbsCents).toBeLessThan(1);
    }
  });
  it('H2/H3 with jitter: median f0 inside every sung note within sigma of the truth', () => {
    for (const name of ['syn-h2-kirakira-s1', 'syn-h3-kirakira-s4', 'syn-h3-rand-s2']) {
      const r = renderHum(find(name));
      const c = checkSung(r.samples, SAMPLE_RATE, r.truth, sungTolerance(r.truth));
      expect(c.checked).toBeGreaterThan(0.6 * c.notes); // short notes (all glide) are skipped
      expect(c.passed).toBe(c.checked);
    }
  });
  it('H4: median f0 inside every sung note within sigma, onset transitions left out', () => {
    for (const name of ['syn-h4-kirakira-s1', 'syn-h4-rand-s2', 'syn-h4-saints-s4']) {
      const r = renderHum(find(name));
      expect(r.clipped).toBe(0);
      for (const n of r.truth.melody.notes) expect(n.transitionSec).toBeGreaterThan(0);
      const c = checkSung(r.samples, SAMPLE_RATE, r.truth, sungTolerance(r.truth));
      expect(c.tolCents).toBeGreaterThanOrEqual(40);
      expect(c.checked).toBeGreaterThan(0.5 * c.notes);
      expect(c.passed).toBe(c.checked);
    }
  });
  it('excursionStats: none on H0, many long ones on H4 (scoops and wander cross semitone boundaries)', () => {
    const h0 = excursionStats(renderHum(find('syn-h0-rand-s4')).truth);
    expect([h0.withExcursion, h0.runs]).toEqual([0, 0]);
    const h3 = excursionStats(renderHum(find('syn-h3-rand-s4')).truth);
    const h4 = excursionStats(renderHum(find('syn-h4-rand-s4')).truth);
    expect(h4.withLongExcursion).toBeGreaterThan(0.3 * h4.notes);
    expect(h4.withLongExcursion).toBeGreaterThan(h3.withLongExcursion);
  });
  it('the check catches a wrong truth (shifted pitch, or score-time instead of sung-time pitch)', () => {
    const r = renderHum(find('syn-h3-kirakira-s4'));
    const shifted = structuredClone(r.truth);
    for (const n of shifted.melody.notes) n.cents += 60;
    const c = checkSung(r.samples, SAMPLE_RATE, shifted, sungTolerance(r.truth));
    expect(c.passed).toBeLessThan(c.checked / 2);
    const scorePitch = structuredClone(r.truth);
    for (const n of scorePitch.melody.notes) n.cents = 0;
    const c2 = checkSung(r.samples, SAMPLE_RATE, scorePitch, 10);
    expect(c2.passed).toBeLessThan(c2.checked);
  });
});

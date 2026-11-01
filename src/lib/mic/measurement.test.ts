import { describe, expect, it } from 'vitest';
import { softClickSamples } from './clickSound';
import { MEASURE_CLICKS } from './latency';
import { evaluateMeasurement, measurementPlan } from './measurement';

const RATE = 48000;

describe('measurementPlan', () => {
  const plan = measurementPlan(1, RATE);

  it('puts the first click 0.3 s after now, then one every 0.5 s, all weak', () => {
    expect(plan.first).toBeCloseTo(1.3);
    expect(plan.clicks).toHaveLength(MEASURE_CLICKS);
    plan.clicks.forEach((c, i) => {
      expect(c.time).toBeCloseTo(1.3 + 0.5 * i);
      expect(c.strong).toBe(false);
    });
  });

  it('captures from 0.1 s before the first click to 0.45 s after the last', () => {
    expect(plan.fromFrame).toBe(Math.round(1.2 * RATE));
    expect(plan.endSec).toBeCloseTo(1.3 + 0.5 * (MEASURE_CLICKS - 1) + 0.45);
    expect(plan.endFrame).toBe(Math.round(plan.endSec * RATE));
    expect(plan.sampleRate).toBe(RATE);
  });
});

describe('evaluateMeasurement', () => {
  const plan = measurementPlan(0, RATE);
  const length = plan.endFrame - plan.fromFrame;
  /** the clicks heard `delayMs` after they were scheduled */
  const heard = (delayMs: number | null): Float32Array => {
    const x = new Float32Array(length);
    if (delayMs === null) return x;
    const click = softClickSamples(RATE);
    for (const c of plan.clicks) {
      const at = Math.round(
        c.time * RATE - plan.fromFrame + (delayMs / 1000) * RATE,
      );
      x.set(click, at);
    }
    return x;
  };
  const reported = { baseLatencySec: 0.01, outputLatencySec: 0.02 };

  it('judges the round trip and its remainder against the reported latency', () => {
    const v = evaluateMeasurement(heard(40), plan, reported);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.found).toBe(MEASURE_CLICKS);
    expect(v.roundTripMs).toBeGreaterThan(40);
    expect(v.roundTripMs).toBeLessThan(41.5);
    expect(v.remainderMs).toBeCloseTo(v.roundTripMs - 30, 6);
  });

  it('fails with tooFew when nothing is heard', () => {
    expect(evaluateMeasurement(heard(null), plan, reported)).toEqual({
      ok: false,
      reason: 'tooFew',
    });
  });
});

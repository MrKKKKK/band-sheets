import { describe, expect, it } from 'vitest';
import { mixHits, CHOKE_SEC, type MixHit } from './mixer';
import { fdnRoom, phoneMic, addReverb } from './room';
import { onsetIndex } from './kits';

const SR = 1000;
const shot = (len: number, onset: number, v = 1) => {
  const x = new Float32Array(len);
  for (let i = onset; i < len; i++) x[i] = v;
  x.fill(0.001, 0, onset); // quiet pre-roll
  return { x, onset };
};

describe('mixHits', () => {
  it('lands each one-shot onset on its sample and sums with gain', () => {
    const s = shot(10, 3);
    const hits: MixHit[] = [
      { inst: 'SD', at: 20, onset: 3, gain: 0.5, voice: s },
      { inst: 'BD', at: 22, onset: 3, gain: 1, voice: s },
    ];
    const y = mixHits(hits, 40, SR);
    expect(y[19]).toBeCloseTo(0.0015, 9); // SD pre-roll (gain 0.5) + BD pre-roll
    expect(y[20]).toBeCloseTo(0.5 + 0.001, 7);
    expect(y[22]).toBe(1.5);
    expect(y[28]).toBe(1);
    expect(y[29]).toBe(0);
  });

  it('a later HH-group hit chokes an open HH (cosine fade over CHOKE_SEC from its onset)', () => {
    const open = shot(200, 0);
    const closed = shot(5, 0, 0);
    const y = mixHits(
      [
        { inst: 'HO', at: 10, onset: 0, gain: 1, voice: open },
        { inst: 'HH', at: 50, onset: 0, gain: 1, voice: closed },
        { inst: 'SD', at: 100, onset: 0, gain: 0, voice: open },
      ],
      220,
      SR,
    );
    const len = Math.round(CHOKE_SEC * SR);
    expect(y[49]).toBe(1);
    expect(y[50]).toBe(1);
    expect(y[50 + Math.floor(len / 2)]).toBeLessThan(0.6);
    expect(y[50 + len + 1]).toBe(0);
    // a crash is not choked by the hi-hat
    const z = mixHits([{ inst: 'CR', at: 10, onset: 0, gain: 1, voice: open }, { inst: 'HH', at: 50, onset: 0, gain: 1, voice: closed }], 220, SR);
    expect(z[100]).toBe(1);
  });

  it('a window equals the same slice of the full mix', () => {
    const s = shot(30, 2);
    const hits: MixHit[] = [5, 17, 40].map((at) => ({ inst: 'HH', at, onset: 2, gain: 1, voice: s }));
    const full = mixHits(hits, 80, SR);
    const w = mixHits(hits, 30, SR, { from: 15 });
    expect(Array.from(w)).toEqual(Array.from(full.subarray(15, 45)));
  });
});

describe('rooms keep the dry path (truth onsets do not move)', () => {
  it('fdnRoom / addReverb: nothing before the impulse, (1 - wet) at it; phoneMic is causal', () => {
    for (const [f, direct] of [
      [(x: Float64Array) => fdnRoom(x, 0.6, 44100, 0.3), 0.7],
      [(x: Float64Array) => addReverb(x, 0.6, 44100, 0.3), null],
    ] as const) {
      const x = new Float64Array(44100);
      x[1000] = 1;
      f(x);
      expect(x.subarray(0, 1000).every((v) => v === 0)).toBe(true);
      if (direct !== null) expect(x[1000]).toBeCloseTo(direct, 12);
      else expect(x[1000]).toBeGreaterThan(0.5);
      expect(x.subarray(44000).some((v) => v !== 0)).toBe(true);
    }
    const y = new Float64Array(2000);
    y.fill(1, 1000);
    phoneMic(y, 44100);
    expect(y.subarray(0, 1000).every((v) => v === 0)).toBe(true);
    expect(onsetIndex(y, 44100)).toBeGreaterThanOrEqual(1000);
  });
});

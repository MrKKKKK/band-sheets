import { describe, expect, it } from 'vitest';
import { parseMelody } from '../../../../src/lib/melodyParse';
import { serializeMelody } from '../../../../src/lib/melodyTex';
import { FOUR_FOUR, firstBars, fixedMelody, melodyFeatures, noteMidis, randomMelody, REGISTERS, toRegister } from './melodies';

const total = (es: { ticks: number }[]) => es.reduce((s, e) => s + e.ticks, 0);

describe('fixed melodies', () => {
  it('saints A is 16 bars, kirakira 4, etude 8', () => {
    expect(total(fixedMelody('saints'))).toBe(16 * 64);
    expect(total(fixedMelody('kirakira'))).toBe(4 * 64);
    expect(total(fixedMelody('etude'))).toBe(8 * 64);
  });
  it('have no lyrics or chords', () => {
    for (const id of ['saints', 'kirakira', 'etude'] as const)
      for (const e of fixedMelody(id)) expect(Object.keys(e).sort()).toEqual(e.kind === 'note' ? ['kind', 'pitch', 'ticks'] : ['kind', 'ticks']);
  });
  it('firstBars cuts at a bar line', () => {
    const es = firstBars([{ kind: 'note', pitch: 'C4', ticks: 48 }, { kind: 'note', pitch: 'D4', ticks: 32 }], 1);
    expect(es).toEqual([{ kind: 'note', pitch: 'C4', ticks: 48 }, { kind: 'note', pitch: 'D4', ticks: 16 }]);
  });
  it('toRegister moves the median to the register median', () => {
    for (const reg of ['low', 'high'] as const) {
      const { events, semitones } = toRegister(fixedMelody('saints'), reg);
      const ms = noteMidis(events).sort((a, b) => a - b);
      expect(Math.abs(ms[ms.length >> 1] - REGISTERS[reg].median)).toBeLessThanOrEqual(1);
      expect(noteMidis(events)).toEqual(noteMidis(fixedMelody('saints')).map((m) => m + semitones));
    }
  });
});

describe('randomMelody', () => {
  it('is deterministic per seed and differs across seeds', () => {
    expect(randomMelody(3, 'low')).toEqual(randomMelody(3, 'low'));
    expect(randomMelody(3, 'low').events).not.toEqual(randomMelody(4, 'low').events);
  });
  it('has 8 full bars on the 16th grid with every required feature, inside the register', () => {
    for (let seed = 1; seed <= 30; seed++)
      for (const reg of ['low', 'high'] as const) {
        const { events } = randomMelody(seed, reg);
        expect(total(events)).toBe(8 * 64);
        for (const e of events) {
          expect(e.ticks % 4).toBe(0);
          expect(e.ticks).toBeGreaterThan(0);
        }
        expect(Object.values(melodyFeatures(events)).every(Boolean)).toBe(true);
        for (const m of noteMidis(events)) {
          expect(m).toBeGreaterThanOrEqual(REGISTERS[reg].lo);
          expect(m).toBeLessThanOrEqual(REGISTERS[reg].hi);
        }
      }
  });
});

describe('melody model round trip', () => {
  it('serializeMelody -> parseMelody gives the events back', () => {
    const all = [fixedMelody('saints'), fixedMelody('kirakira'), fixedMelody('etude'), ...[1, 2, 6].map((s) => randomMelody(s, 'high').events)];
    for (const events of all) {
      const r = parseMelody(serializeMelody(events, FOUR_FOUR), FOUR_FOUR);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.events).toEqual(events);
    }
  });
});

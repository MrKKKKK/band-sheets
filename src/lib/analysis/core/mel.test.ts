import { describe, expect, it } from 'vitest';
import {
  fftFrequencies,
  hzToMel,
  linspace,
  melFilterBank,
  melFrequencies,
  melToHz,
} from './mel';

// Reference values: librosa 0.11.0 in the analysis image (synthetic, no audio).
describe('Slaney mel scale', () => {
  it('is linear below 1 kHz and logarithmic above', () => {
    expect(hzToMel(200 / 3)).toBeCloseTo(1, 12);
    expect(hzToMel(440)).toBeCloseTo(6.6, 12);
    expect(hzToMel(1000)).toBeCloseTo(15, 12);
    expect(hzToMel(4000)).toBeCloseTo(35.163760314616646, 12);
    for (const f of [0, 100, 999, 1000, 5000, 11025])
      expect(melToHz(hzToMel(f))).toBeCloseTo(f, 9);
  });

  it('mel_frequencies and helpers match librosa', () => {
    const m = melFrequencies(5, 0, 11025);
    const ref = [
      0.0, 831.8432413359842, 1982.6699184003633, 4675.3540882337475, 11025.0,
    ];
    m.forEach((v, i) => expect(v).toBeCloseTo(ref[i], 9));
    expect(Array.from(linspace(0, 1, 5))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const f = fftFrequencies(22050, 2048);
    expect(f.length).toBe(1025);
    expect(f[1024]).toBeCloseTo(11025, 9);
  });
});

describe('melFilterBank(22050, 2048, 128) (norm=slaney)', () => {
  const bank = melFilterBank(22050, 2048, 128, 0, 11025);

  it('has librosa shape, non-zero ranges and values', () => {
    expect(bank.weights.length).toBe(128 * 1025);
    let sum = 0;
    for (const w of bank.weights) sum += w;
    expect(sum).toBeCloseTo(11.886680603027344, 4);
    const ref: [number, number, number, number[]][] = [
      [
        0,
        1,
        5,
        [0.016182852908968925, 0.03236570581793785, 0.028990088030695915],
      ],
      [
        1,
        3,
        8,
        [0.00977923534810543, 0.025962088257074356, 0.03539370372891426],
      ],
      [
        40,
        96,
        102,
        [0.0004014020087197423, 0.014093741774559021, 0.02778608165681362],
      ],
      [
        127,
        971,
        1024,
        [7.184815331129357e-6, 0.00014095657388679683, 0.00027472834335640073],
      ],
    ];
    for (const [i, lo, hi, first] of ref) {
      expect([bank.lo[i], bank.hi[i]]).toEqual([lo, hi]);
      first.forEach((v, j) =>
        expect(bank.weights[i * 1025 + lo + j]).toBe(Math.fround(v)),
      );
    }
  });
});

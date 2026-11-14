import { describe, expect, it } from 'vitest';
import { loadSfz, parseSfz, pickRegion, pitchStep, sfzKey, velGain } from './sfz';
import { BASS_HI, BASS_LO, BASSKITS_DIR, SFZ_FILES, SFZ_KEY_OFFSET, timbreAvailable } from './timbres';

const TEXT = `
// comment <region> sample=nope.wav
<group>
lokey=33 hikey=38
pitch_keycenter=37
ampeg_release=0.300

<region>
sample=sustain\\db2_pp_rr1.wav
hivel=60
hirand=0.5
amp_velcurve_60=1

<region>
sample=sustain\\db2_pp_rr2.wav
hivel=60
lorand=0.5

<region>
sample=sustain\\db2_f.wav
lovel=61
tune=-12

<group>
key=c2
seq_length=2

<region>
sample=a b.wav
<region>
sample=c.wav
seq_position=2
`;

describe('sfz reader', () => {
  const r = parseSfz(TEXT);

  it('carries group settings into regions, resets them at the next group, reads `\\` paths and comments', () => {
    expect(r.map((x) => x.sample)).toEqual(['sustain/db2_pp_rr1.wav', 'sustain/db2_pp_rr2.wav', 'sustain/db2_f.wav', 'a b.wav', 'c.wav']);
    expect(r.slice(0, 3).every((x) => x.lokey === 33 && x.hikey === 38 && x.pitchKeycenter === 37 && x.ampegRelease === 0.3)).toBe(true);
    expect([r[3].lokey, r[3].hikey, r[3].pitchKeycenter, r[3].ampegRelease]).toEqual([36, 36, 36, 0]);
    expect(r[2].tune).toBe(-12);
    expect(sfzKey('c4')).toBe(60);
    expect(sfzKey('eb1')).toBe(27);
  });

  it('picks one region by key, velocity and round robin (lorand/hirand or seq_position)', () => {
    expect(pickRegion(r, 35, 40, 0).sample).toBe('sustain/db2_pp_rr1.wav');
    expect(pickRegion(r, 35, 40, 0.7).sample).toBe('sustain/db2_pp_rr2.wav');
    expect(pickRegion(r, 35, 100, 0.99).sample).toBe('sustain/db2_f.wav');
    expect(pickRegion(r, 37, 100, 0.2).sample).toBe('sustain/db2_f.wav');
    expect(() => pickRegion(r, 39, 100, 0)).toThrow();
    const c2 = r.slice(3);
    expect(pickRegion(c2, 36, 90, 0.1).sample).toBe('a b.wav');
    expect(pickRegion(c2, 36, 90, 0.6).sample).toBe('c.wav');
  });

  it('velocity curve: amp_velcurve points linear from (0, 0) to (127, 1); default (v / 127)^2', () => {
    expect(velGain(r[0], 30)).toBeCloseTo(0.5, 12);
    expect(velGain(r[0], 60)).toBe(1);
    expect(velGain(r[0], 100)).toBe(1);
    expect(velGain(r[2], 127)).toBe(1);
    expect(velGain(r[2], 63.5)).toBeCloseTo(0.25, 12);
  });

  it('re-pitch step from pitch_keycenter and tune', () => {
    expect(pitchStep(r[0], 37)).toBe(1);
    expect(pitchStep(r[0], 49)).toBeCloseTo(2, 12);
    expect(pitchStep(r[2], 37)).toBeCloseTo(2 ** (-12 / 1200), 12);
  });

  for (const id of ['B', 'C'] as const) {
    it.skipIf(!timbreAvailable(id))(`timbre ${id}: every bass note, velocity and round robin maps to one sustained (non-noise) sample`, () => {
      const inst = loadSfz(BASSKITS_DIR + SFZ_FILES[id]);
      for (let m = BASS_LO; m <= BASS_HI; m++)
        for (const vel of [12, 36, 64, 88, 100, 127])
          for (const u of [0, 0.3, 0.6, 0.95]) {
            const reg = pickRegion(inst.regions, m + SFZ_KEY_OFFSET[id], vel, u);
            expect(reg.sample).not.toMatch(/noise|scrape/i);
            expect(Math.abs(m + SFZ_KEY_OFFSET[id] - reg.pitchKeycenter)).toBeLessThanOrEqual(4);
          }
    });
  }
});

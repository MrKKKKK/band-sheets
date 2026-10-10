import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateMidi, importScore } from './truth';
import { MASTER_VOLUME, renderAudio } from './renderAudio';

// Two bars of 4/4 at 120 BPM (4 s). Beat 1 is a rest, the first note is on beat 2 (0.5 s).
const TEX = `\\title "t"
\\tempo 120
\\ts 4 4
.
\\track "Piano"
\\staff{score}
\\instrument 0
r.4 c4.4 r.2 | r.1`;

const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

describe('renderAudio', () => {
  const score = importScore(TEX);
  const midi = generateMidi(score);
  const { samples, sampleRate } = renderAudio(midi);

  it('renders 44.1 kHz mono of the music length plus a 2 s tail', () => {
    expect(sampleRate).toBe(44100);
    expect(Math.abs(samples.length - 6 * 44100)).toBeLessThanOrEqual(64);
    const bare = renderAudio(midi, { tailSec: 0 });
    expect(Math.abs(bare.samples.length - 4 * 44100)).toBeLessThanOrEqual(64);
  });

  it('ends in silence (no cut-off note)', () => {
    expect(peak(samples.subarray(samples.length - 441))).toBeLessThan(0.001);
  });

  it('prepends the lead-in silence without changing the rest', () => {
    const lead = renderAudio(midi, { leadInSec: 1.37 });
    const n = Math.round(1.37 * 44100);
    expect(lead.samples.length).toBe(samples.length + n);
    expect(peak(lead.samples.subarray(0, n))).toBe(0);
    expect(lead.samples[n + 22050 + 100]).toBe(samples[22050 + 100]);
  });

  it('applies the fixed master gain', () => {
    expect(MASTER_VOLUME).toBe(0.6);
  });

  it('puts the first note at its score time', () => {
    const first = samples.findIndex((s) => Math.abs(s) > 0.001);
    expect(first).toBeGreaterThan(0);
    expect(Math.abs(first / sampleRate - 0.5)).toBeLessThan(0.02);
  });

  it('adds a click only when asked', () => {
    const empty = importScore(TEX.replace('r.4 c4.4 r.2', 'r.1'));
    const mid = generateMidi(empty);
    const silent = renderAudio(mid);
    const click = renderAudio(mid, { click: true });
    expect(peak(silent.samples)).toBeLessThan(0.001);
    expect(peak(click.samples)).toBeGreaterThan(0.01);
  });
});

describe('renderAudio: soundfont / balance', () => {
  const two = importScore(`\\title "t"\n\\tempo 120\n\\ts 4 4\n.\n\\track "Piano"\n\\staff{score}\n\\instrument 0\n(c4 e4 g4).1 | r.1`);
  const m = generateMidi(two);
  const hasSf = existsSync(fileURLToPath(new URL('../soundfonts/MuseScore_General.sf2', import.meta.url)));

  it.runIf(hasSf)('renders 2 bars with the musescore font at the computed length', () => {
    const { samples, sampleRate } = renderAudio(m, { soundFont: 'musescore', tailSec: 0 });
    expect(Math.abs(samples.length - 4 * sampleRate)).toBeLessThanOrEqual(64);
    expect(peak(samples)).toBeGreaterThan(0.01);
    expect(peak(samples)).toBeLessThan(1);
    const sonivox = renderAudio(m, { tailSec: 0 });
    expect(samples.some((s, i) => s !== sonivox.samples[i])).toBe(true);
  }, 60000);

  it('lowers the piano by pianoGainDb', () => {
    const base = peak(renderAudio(m, { tailSec: 0 }).samples);
    const low = peak(renderAudio(m, { tailSec: 0, pianoGainDb: -9 }).samples);
    expect(low / base).toBeGreaterThan(0.3);
    expect(low / base).toBeLessThan(0.4); // 10^(-9/20) = 0.355
  });
});

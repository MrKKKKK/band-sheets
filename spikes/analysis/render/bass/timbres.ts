// Spike 6 T2: the three bass timbres as note-voice providers (docs/audio-spike6-plan.md section 4, BASS_SAMPLES.md).
//
//   A  MuseScore_General.sf2 (MIT), GM 33 Electric Bass (finger); tuning + dev. Rendered through the existing alphaTab
//      path (render/renderAudio.ts): one held note per (key, velocity step), cached; the sf2 has no real velocity layers,
//      so the velocity is rendered (quantized to A_VELOCITY_STEPS).
//   B  Growlybass `growlybass_clean.sfz` (CC0); dev only. Its sfz maps ONE OCTAVE UP: MIDI n sounds at sfz key n + 12
//      (SFZ_KEY_OFFSET; timbres.test.ts measures the f0 of every timbre).
//   C  D. Smolken double bass pizzicato `d_smolken_rubner_bass_pizz.sfz` (CC0); HELD-OUT ONLY (variants.ts refuses it
//      elsewhere). Keys >= 72 are noises; only BASS_LO..BASS_HI are ever asked for, and noise samples are refused.
//
// A voice is the note's sound from the attack for as long as the source lasts (no note-off yet; render.ts applies the
// note length and the release, see voiceEnvelope), at SAMPLE_RATE, mono, with its level (velocity curve and TIMBRE_GAIN)
// applied, and its ONSET (render/drum/kits.ts onsetIndex: -30 dB below the peak of the first 150 ms). The mixer places
// the onset on the truth time. The B / C samples do not loop: a note longer than the sample ends with the sample
// (B 6 s, C 6.4-10 s; the longest note of the patterns is one bar, < 3.5 s at the slowest tempo, so none is cut).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alphaTab from '@coderline/alphatab';
import { renderAudio } from '../renderAudio';
import { readAudioFile, resampleStep, toMono } from '../drum/audioFile';
import { onsetIndex, SAMPLE_RATE, SF2_PATH, type OneShot } from '../drum/kits';
import { loadSfz, pickRegion, pitchStep, samplePath, velGain, type SfzInstrument } from './sfz';

export { SAMPLE_RATE };
export type TimbreId = 'A' | 'B' | 'C';

export const BASSKITS_DIR = fileURLToPath(new URL('../../basskits/', import.meta.url));
export const SFZ_FILES: Record<'B' | 'C', string> = {
  B: 'growlybass/Growlybass/growlybass_clean.sfz',
  C: 'dsmolken_double_bass/dsmolken_double_bass/d_smolken_rubner_bass_pizz.sfz',
};
/** sfz key = sounding MIDI note + offset (Growlybass is mapped an octave up, BASS_SAMPLES.md). */
export const SFZ_KEY_OFFSET: Record<'B' | 'C', number> = { B: 12, C: 0 };
/** Sounding range of the generated bass lines (E1..G3), inside every timbre's sampled range. */
export const BASS_LO = 28;
export const BASS_HI = 55;
/** GM program of timbre A (written explicitly into the score and the one-shot MIDI, CLAUDE.md alphaTab gotcha). */
export const GM_BASS_PROGRAM = 33;
export const A_VELOCITY_STEPS = 16;
/** Timbre A: seconds the one-shot holds the key (longer than any note) and its release after the note-off. */
const A_HOLD_SEC = 4;
export const A_RELEASE_SEC = 0.25;
/**
 * Fixed level per timbre (never per file): B and C are scaled so a mezzo-forte E1..E2 sits near timbre A's level
 * (measured once on the dry voices, T2).
 */
export const TIMBRE_GAIN: Record<TimbreId, number> = { A: 1, B: 1, C: 1.3 };

export interface BassVoice extends OneShot {
  /** Release after the note-off (s): ampeg_release of the region, A_RELEASE_SEC for A. */
  release: number;
}

export interface Timbre {
  id: TimbreId;
  /** Voice of a sounding MIDI note; `u` in [0, 1) picks the round robin (0 = the first). */
  voice(midi: number, velocity: number, u: number): BassVoice;
}

export function timbreAvailable(id: TimbreId): boolean {
  return id === 'A' ? existsSync(SF2_PATH) : existsSync(join(BASSKITS_DIR, SFZ_FILES[id]));
}

function withOnset(x: Float32Array, release: number, what: string): BassVoice {
  const onset = onsetIndex(x);
  if (onset < 0) throw new Error(`silent bass voice: ${what}`);
  return { x, onset, release };
}

/** Velocity -> A's rendered velocity (step centre). */
export const aVelocity = (velocity: number): number => {
  const step = Math.max(0, Math.min(A_VELOCITY_STEPS - 1, Math.floor((velocity * A_VELOCITY_STEPS) / 128)));
  return Math.min(127, Math.round(((step + 0.5) * 128) / A_VELOCITY_STEPS));
};

function timbreA(): Timbre {
  const cache = new Map<string, BassVoice>();
  return {
    id: 'A',
    voice(midi, velocity) {
      const vel = aVelocity(velocity);
      const k = `${midi}:${vel}`;
      let v = cache.get(k);
      if (!v) {
        const f = new alphaTab.midi.MidiFile();
        f.division = 960;
        f.addEvent(new alphaTab.midi.TempoChangeEvent(0, 500000)); // 120 bpm: 960 ticks = 0.5 s
        f.addEvent(new alphaTab.midi.ProgramChangeEvent(0, 0, 0, GM_BASS_PROGRAM));
        f.addEvent(new alphaTab.midi.NoteOnEvent(0, 0, 0, midi, vel));
        f.addEvent(new alphaTab.midi.NoteOffEvent(0, A_HOLD_SEC * 2 * 960, 0, midi, 0));
        const x = renderAudio(f, { soundFont: 'musescore', tailSec: 0, sampleRate: SAMPLE_RATE }).samples;
        for (const s of x) if (!Number.isFinite(s)) throw new Error(`timbre A: non-finite samples for key ${midi}`);
        v = withOnset(x.slice(0, A_HOLD_SEC * SAMPLE_RATE), A_RELEASE_SEC, `A ${midi} v${vel}`);
        cache.set(k, v);
      }
      return v;
    },
  };
}

function timbreSfz(id: 'B' | 'C'): Timbre {
  let inst: SfzInstrument | null = null;
  /** Re-pitched sample per (file, key); the level is applied per voice. */
  const pitched = new Map<string, Float32Array>();
  const cache = new Map<string, BassVoice>();
  return {
    id,
    voice(midi, velocity, u) {
      if (midi < BASS_LO || midi > BASS_HI) throw new Error(`timbre ${id}: MIDI ${midi} outside ${BASS_LO}..${BASS_HI}`);
      inst ??= loadSfz(join(BASSKITS_DIR, SFZ_FILES[id]));
      const key = midi + SFZ_KEY_OFFSET[id];
      const r = pickRegion(inst.regions, key, velocity, u);
      if (/noise|scrape/i.test(r.sample)) throw new Error(`timbre ${id}: key ${key} maps to a noise sample (${r.sample})`);
      const ck = `${r.sample}:${key}:${velocity}`;
      let v = cache.get(ck);
      if (!v) {
        const pk = `${r.sample}:${key}`;
        let y = pitched.get(pk);
        if (!y) {
          const a = readAudioFile(samplePath(inst, r));
          y = resampleStep(toMono(a), pitchStep(r, key) * (a.sampleRate / SAMPLE_RATE));
          pitched.set(pk, y);
        }
        const g = velGain(r, velocity) * TIMBRE_GAIN[id];
        v = withOnset(y.map((s) => s * g), r.ampegRelease, `${id} ${r.sample}`);
        cache.set(ck, v);
      }
      return v;
    },
  };
}

const timbres = new Map<TimbreId, Timbre>();
export function getTimbre(id: TimbreId): Timbre {
  let t = timbres.get(id);
  if (!t) {
    t = id === 'A' ? timbreA() : timbreSfz(id);
    timbres.set(id, t);
  }
  return t;
}
/** Drops the caches (golden tests render from cold caches). */
export function resetTimbres(): void {
  timbres.clear();
}

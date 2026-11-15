// Spike 7 T5: the piano timbres of the synthetic chords2 material, as note-voice providers (same contract as
// render/bass/timbres.ts: a voice = the note's sound from the attack, no note-off yet, with its level and its onset).
//
//   P1  MuseScore_General.sf2 (MIT), GM 0 Acoustic Grand Piano; tuning + dev. One held note per (key, velocity step)
//       rendered through alphaTab (render/renderAudio.ts), like bass timbre A (aVelocity's 16 steps).
//   P2  VSCO 2 CE "Upright Piano" (CC0 1.0, fetch-piano-samples.sh); HELD-OUT ONLY (variants.ts refuses it elsewhere).
//       3 dynamics x 23 keys (every 4 semitones; key per file from MappingChart.txt), 24-bit stereo: mixed to mono,
//       the nearest sampled key re-pitched (at most 2 semitones, render/drum/audioFile.ts resampleStep), the dynamic
//       layer by velocity (P2_LAYERS) and the level within the layer linear in velocity. The repo ships no sfz for this
//       piano, so the mapping is here. Samples are cut at P2_MAX_SEC (longer than any note + release) before re-pitching,
//       and their leading silence (below -60 dB of the peak) is dropped so the onset search sees the attack.
// Fixed level per timbre (never per file): P2 was measured 4-5 dB quieter than P1 at a mezzo-forte (velocity 70) C4
// (once, dry voices, T5); P2_GAIN lifts it by 2 dB only, so the peaky variation's fortissimo accents (layer 3, velocity
// 127) stay below full scale (1.6 clipped two held-out files).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alphaTab from '@coderline/alphatab';
import { renderAudio } from '../renderAudio';
import { readAudioFile, resampleStep, toMono } from '../drum/audioFile';
import { onsetIndex, SAMPLE_RATE, SF2_PATH } from '../drum/kits';
import { aVelocity, type BassVoice } from '../bass/timbres';

export type PianoId = 'P1' | 'P2';
export type PianoVoice = BassVoice;

export const PIANOKITS_DIR = fileURLToPath(new URL('../../pianokits/vsco_upright/', import.meta.url));
export const GM_PIANO_PROGRAM = 0;
/** P1: seconds the one-shot holds the key (longer than any note: one bar at the slowest tempo < 3.4 s). */
const P1_HOLD_SEC = 4;
/** Damper release after the note-off (s), both timbres. */
export const PIANO_RELEASE_SEC = 0.15;
export const P2_MAX_SEC = 5;
/** P2 dynamic layer by velocity: [lowest velocity, reference velocity (gain 1)] for dyn 1, 2, 3. */
export const P2_LAYERS: readonly [number, number][] = [
  [1, 40],
  [56, 80],
  [96, 112],
];
export const P2_GAIN = 1.25;

export function pianoAvailable(id: PianoId): boolean {
  return id === 'P1' ? existsSync(SF2_PATH) : existsSync(join(PIANOKITS_DIR, 'MappingChart.txt'));
}

export interface Piano {
  id: PianoId;
  voice(midi: number, velocity: number): PianoVoice;
}

function withOnset(x: Float32Array, what: string): PianoVoice {
  const onset = onsetIndex(x);
  if (onset < 0) throw new Error(`silent piano voice: ${what}`);
  return { x, onset, release: PIANO_RELEASE_SEC };
}

function pianoP1(): Piano {
  const cache = new Map<string, PianoVoice>();
  return {
    id: 'P1',
    voice(midi, velocity) {
      const vel = aVelocity(velocity);
      const k = `${midi}:${vel}`;
      let v = cache.get(k);
      if (!v) {
        const f = new alphaTab.midi.MidiFile();
        f.division = 960;
        f.addEvent(new alphaTab.midi.TempoChangeEvent(0, 500000)); // 120 bpm: 960 ticks = 0.5 s
        f.addEvent(new alphaTab.midi.ProgramChangeEvent(0, 0, 0, GM_PIANO_PROGRAM));
        f.addEvent(new alphaTab.midi.NoteOnEvent(0, 0, 0, midi, vel));
        f.addEvent(new alphaTab.midi.NoteOffEvent(0, P1_HOLD_SEC * 2 * 960, 0, midi, 0));
        const x = renderAudio(f, { soundFont: 'musescore', tailSec: 0, sampleRate: SAMPLE_RATE }).samples;
        for (const s of x) if (!Number.isFinite(s)) throw new Error(`piano P1: non-finite samples for key ${midi}`);
        v = withOnset(x.slice(0, P1_HOLD_SEC * SAMPLE_RATE), `P1 ${midi} v${vel}`);
        cache.set(k, v);
      }
      return v;
    },
  };
}

/** MappingChart.txt: file index -> MIDI key; only the files that exist (even indexes). */
export function p2Keys(dir = PIANOKITS_DIR): { index: number; key: number }[] {
  const text = readFileSync(join(dir, 'MappingChart.txt'), 'utf8');
  return [...text.matchAll(/^(\d{3})=(\d+)\s*$/gm)]
    .map((m) => ({ index: Number(m[1]), key: Number(m[2]) }))
    .filter((e) => existsSync(join(dir, p2File(1, e.index))));
}
export const p2File = (dyn: number, index: number): string => `Player_dyn${dyn}_rr1_${String(index).padStart(3, '0')}.wav`;
export const p2Layer = (velocity: number): number => P2_LAYERS.reduce((d, [lo], i) => (velocity >= lo ? i + 1 : d), 1);

function pianoP2(): Piano {
  let keys: { index: number; key: number }[] | null = null;
  const pitched = new Map<string, Float32Array>();
  const cache = new Map<string, PianoVoice>();
  return {
    id: 'P2',
    voice(midi, velocity) {
      keys ??= p2Keys();
      let near = keys[0];
      for (const e of keys) if (Math.abs(e.key - midi) < Math.abs(near.key - midi)) near = e;
      if (Math.abs(near.key - midi) > 2) throw new Error(`piano P2: no sample within 2 semitones of ${midi}`);
      const dyn = p2Layer(velocity);
      const ck = `${midi}:${velocity}`;
      let v = cache.get(ck);
      if (!v) {
        const pk = `${dyn}:${near.index}:${midi}`;
        let y = pitched.get(pk);
        if (!y) {
          const a = readAudioFile(join(PIANOKITS_DIR, p2File(dyn, near.index)));
          const mono = toMono(a);
          let peak = 0;
          for (const s of mono) peak = Math.max(peak, Math.abs(s));
          let s0 = 0;
          while (s0 < mono.length && Math.abs(mono[s0]) < peak * 1e-3) s0++;
          const step = 2 ** ((midi - near.key) / 12) * (a.sampleRate / SAMPLE_RATE);
          const cut = mono.subarray(Math.max(0, s0 - Math.round(0.001 * a.sampleRate)), s0 + Math.ceil(P2_MAX_SEC * a.sampleRate * step));
          y = resampleStep(Float32Array.from(cut), step);
          pitched.set(pk, y);
        }
        const g = (P2_GAIN * velocity) / P2_LAYERS[dyn - 1][1];
        v = withOnset(y.map((s) => s * g), `P2 ${midi} v${velocity}`);
        cache.set(ck, v);
      }
      return v;
    },
  };
}

const pianos = new Map<PianoId, Piano>();
export function getPiano(id: PianoId): Piano {
  let p = pianos.get(id);
  if (!p) {
    p = id === 'P1' ? pianoP1() : pianoP2();
    pianos.set(id, p);
  }
  return p;
}
/** Drops the caches (golden tests render from cold caches). */
export function resetPianos(): void {
  pianos.clear();
}

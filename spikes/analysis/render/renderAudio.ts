// Headless render of a MIDI file to mono samples with alphaTab's AlphaSynth
// (docs/audio-spike0-plan.md, "事前に確かめたこと" 1). No browser needed:
// AlphaSynth gets a no-op output and `exportAudio` renders synchronously.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as alphaTab from '@coderline/alphatab';
import type { midi } from '@coderline/alphatab';
import { downmixStereo } from './wav';

export const SAMPLE_RATE = 44100;
export const SOUND_FONT = 'sonivox.sf2';

let soundFontBytes: Uint8Array | undefined;
function loadSoundFont(): Uint8Array {
  if (!soundFontBytes) {
    // The package `exports` hides package.json; this file lives in spikes/analysis/render/.
    const path = fileURLToPath(
      new URL(`../../../node_modules/@coderline/alphatab/dist/soundfont/${SOUND_FONT}`, import.meta.url),
    );
    soundFontBytes = new Uint8Array(readFileSync(path));
  }
  return soundFontBytes;
}

const emitter = (): alphaTab.IEventEmitter => ({ on: () => () => {}, off: () => {} });
const emitterOf = <T>(): alphaTab.IEventEmitterOfT<T> => ({ on: () => () => {}, off: () => {} });

function noopOutput(sampleRate: number): alphaTab.synth.ISynthOutput {
  return {
    sampleRate,
    open() {},
    play() {},
    destroy() {},
    pause() {},
    addSamples() {},
    resetSamples() {},
    activate() {},
    ready: emitter(),
    samplesPlayed: emitterOf<number>(),
    sampleRequest: emitter(),
    enumerateOutputDevices: async () => [],
    setOutputDevice: async () => {},
    getOutputDevice: async () => null,
  };
}

/** Fixed gain for every variant (R8): keeps drum-heavy mixes from clipping; never per-file. */
export const MASTER_VOLUME = 0.6;
/** Seconds rendered after the last bar so the final notes ring out (R7). */
export const TAIL_SEC = 2;

export interface RenderOptions {
  click?: boolean;
  sampleRate?: number;
  /** Seconds of silence prepended to the audio (R6). Use a whole number of samples. */
  leadInSec?: number;
  /** Release tail after the MIDI's last tick (default `TAIL_SEC`). */
  tailSec?: number;
}

/**
 * A copy of `file` with a no-op controller event `tailSec` after the last
 * event, so the exporter keeps rendering while the last notes release. The
 * original is untouched (the extra event is neither a note nor a tempo change).
 */
function withTail(file: midi.MidiFile, tailSec: number): midi.MidiFile {
  const T = alphaTab.midi.MidiEventType;
  const tempo = (file.events.find((e) => e.type === T.TempoChange) as midi.TempoChangeEvent | undefined)
    ?.beatsPerMinute;
  if (!tempo || tailSec <= 0) return file;
  const copy = new alphaTab.midi.MidiFile();
  copy.format = file.format;
  copy.division = file.division;
  copy.tickShift = file.tickShift;
  for (const e of file.events) copy.addEvent(e);
  const last = file.events.reduce((m, e) => Math.max(m, e.tick), 0);
  const tick = last + Math.round(((tailSec * tempo) / 60) * file.division);
  copy.addEvent(new alphaTab.midi.ControlChangeEvent(0, tick, 0, alphaTab.midi.ControllerType.ModulationCoarse, 0));
  return copy;
}

/** Renders `file` (from `generateMidi`) to mono samples. */
export function renderAudio(
  file: midi.MidiFile,
  opts: RenderOptions = {},
): { samples: Float32Array; sampleRate: number } {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const synth = new alphaTab.synth.AlphaSynth(noopOutput(sampleRate), 500);
  const options = new alphaTab.synth.AudioExportOptions();
  options.soundFonts = [loadSoundFont()];
  options.sampleRate = sampleRate;
  options.masterVolume = MASTER_VOLUME;
  options.metronomeVolume = opts.click ? 1 : 0;
  const exporter = synth.exportAudio(options, withTail(file, opts.tailSec ?? TAIL_SEC), [], new Map());
  const chunks: Float32Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = exporter.render(1000);
    if (!chunk) break;
    chunks.push(chunk.samples);
    total += chunk.samples.length;
  }
  const lead = Math.round((opts.leadInSec ?? 0) * sampleRate) * 2; // interleaved stereo
  const all = new Float32Array(lead + total);
  let off = lead;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  synth.destroy();
  return { samples: downmixStereo(all), sampleRate };
}

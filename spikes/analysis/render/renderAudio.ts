// Headless render of a MIDI file to mono samples with alphaTab's AlphaSynth
// (docs/audio-spike0-plan.md, "事前に確かめたこと" 1). No browser needed:
// AlphaSynth gets a no-op output and `exportAudio` renders synchronously.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as alphaTab from '@coderline/alphatab';
import type { midi } from '@coderline/alphatab';
import { downmixStereo } from './wav';

export const SAMPLE_RATE = 44100;
export const SOUND_FONT = 'sonivox.sf2';
export type SoundFontName = 'sonivox' | 'musescore';
/** File name recorded in manifests / truth `render.soundFont`. */
export const SOUND_FONT_FILES: Record<SoundFontName, string> = {
  sonivox: SOUND_FONT,
  musescore: 'MuseScore_General.sf2', // converted from the .sf3 by sf3ToSf2.py (alphaTab cannot read sf3)
};

const soundFontCache = new Map<SoundFontName, Uint8Array>();
function loadSoundFont(name: SoundFontName): Uint8Array {
  let bytes = soundFontCache.get(name);
  if (!bytes) {
    // The package `exports` hides package.json; this file lives in spikes/analysis/render/.
    const url =
      name === 'sonivox'
        ? new URL(`../../../node_modules/@coderline/alphatab/dist/soundfont/${SOUND_FONT}`, import.meta.url)
        : new URL(`../soundfonts/${SOUND_FONT_FILES.musescore}`, import.meta.url);
    const path = fileURLToPath(url);
    if (!existsSync(path)) {
      const sf3 = fileURLToPath(new URL('../soundfonts/MuseScore_General.sf3', import.meta.url));
      throw new Error(
        existsSync(sf3)
          ? `音色ファイル ${path} がありません。render/sf3ToSf2.py で sf3 から変換してください（CLAUDE.md の Python の実行方法）`
          : `音色ファイル ${sf3} がありません。spikes/analysis/fetch-soundfont.sh を実行して取得し、render/sf3ToSf2.py で変換してください`,
      );
    }
    bytes = new Uint8Array(readFileSync(path));
    soundFontCache.set(name, bytes);
  }
  return bytes;
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
  /** Default 'sonivox'. 'musescore' needs soundfonts/MuseScore_General.sf3 (fetch-soundfont.sh). */
  soundFont?: SoundFontName;
  /** Piano level in dB relative to the default balance (default 0). */
  pianoGainDb?: number;
}

const GM_PIANO = 0;
/** MIDI channels (not percussion) whose program is the piano. */
function pianoChannels(file: midi.MidiFile): number[] {
  const T = alphaTab.midi.MidiEventType;
  const ch = new Set<number>();
  for (const e of file.events) {
    if (e.type !== T.ProgramChange) continue;
    const p = e as midi.ProgramChangeEvent;
    if (p.channel !== 9 && p.program === GM_PIANO) ch.add(p.channel);
  }
  return [...ch];
}

/**
 * A copy of `file` with a no-op controller event `tailSec` after the last
 * event, so the exporter keeps rendering while the last notes release. The
 * original is untouched (the extra event is neither a note nor a tempo change).
 */
function withTail(file: midi.MidiFile, tailSec: number): midi.MidiFile {
  const T = alphaTab.midi.MidiEventType;
  const tempo = (file.events.filter((e) => e.type === T.TempoChange).at(-1) as midi.TempoChangeEvent | undefined)
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
  options.soundFonts = [loadSoundFont(opts.soundFont ?? 'sonivox')];
  options.sampleRate = sampleRate;
  options.masterVolume = MASTER_VOLUME;
  if (opts.pianoGainDb) {
    const g = 10 ** (opts.pianoGainDb / 20);
    for (const c of pianoChannels(file)) options.trackVolume.set(c, g);
  }
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

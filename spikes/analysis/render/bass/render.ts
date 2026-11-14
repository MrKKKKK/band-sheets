// Spike 6 T2: render one synthetic bass variant -> wav bytes + truth (deterministic per variant).
//
// Two alphaTab scores share the chord timeline, tempo (and drift) and lead-in:
//   - the BASS score (one track "Bass", GM 33 set explicitly): its MIDI note-ons / offs give the bass note times
//     (render/truth.ts buildTruth reads the single non-piano track as `melody`; CLAUDE.md: truth from the MIDI);
//   - the MAIN score (B1+): Piano (render/pianoPart.ts), and from B2 Drums (first, CLAUDE.md) and a melody; rendered by
//     alphaTab with MuseScore_General (render/renderAudio.ts). Its truth gives beats, sections, chords, melody, drums.
// The bass itself is NOT rendered by alphaTab's sequencer: every note is a voice of its timbre (timbres.ts; A is
// alphaTab's GM 33 one note at a time) placed so its onset lands on the note's truth time (+ jitter at B1+), held to
// its note-off and released (voiceEnvelope). This gives an exact, measurable onset per note for all three timbres.
// Mix: main + bass -> room -> phone mic (B3) -> output gain -> pink noise (render/hum/degrade.ts). All but the noise are linear and
// causal, so check.ts can measure each note's onset on its own contribution.

import type { model } from '@coderline/alphatab';
import { partsToAlphaTex } from '../../../../src/lib/partsToAlphaTex';
import type { Song } from '../../../../src/lib/song';
import { addNoise } from '../hum/degrade';
import { gauss } from '../hum/voice';
import { addReverb, fdnRoom, rbj } from '../drum/room';
import { onsetIndex } from '../drum/kits';
import { parseChordSymbol } from '../chordSymbol';
import { noteName, pianoPartBody } from '../pianoPart';
import { renderAudio, SOUND_FONT_FILES } from '../renderAudio';
import { applyTempoCurve, buildScoreTex, buildTruth, generateMidi, importScore, setPrograms } from '../truth';
import type { AnalysisResult, ChordTimeline, Variant } from '../types';
import { driftCurve } from '../variants';
import { encodeWav } from '../wav';
import { applyMarks, bassLine, bassPartBody, type BassNote } from './patterns';
import { chordTones, generateSong, type BassSong } from './progressions';
import { GM_BASS_PROGRAM, getTimbre, SAMPLE_RATE, type BassVoice } from './timbres';
import { BASS_TRACK, buildBassTruth, type BassTruthFile } from './truth';
import { PHONE_HP_HZ, PHONE_LP_HZ, streamOf, synthParams, TAIL_SEC, type BassSynthParams, type BassVariant } from './variants';

/** A note's jitter is clipped at this many sigmas. */
export const JITTER_CLIP = 2.5;
/** A voice still sounding at the next note's onset fades out over this (the player stops the string). */
export const CHOKE_SEC = 0.006;
/** Fixed gain of the bass stem in the mix (never per file). */
export const BASS_MIX_GAIN = 1;
/** Fixed output gain of every variant before the noise (keeps the loudest B2 mixes below full scale). */
export const OUTPUT_GAIN = 0.85;

export interface PlacedNote {
  note: BassNote;
  /** Truth onset / note-off (s), jitter included. */
  t: number;
  end: number;
  velocity: number;
  /** Onset sample (= round(t * sr)). */
  at: number;
  /** The voice with its envelope applied, and the sample of it placed on `at` (its onset through the chain). */
  x: Float32Array;
  onset: number;
  /** The note is longer than its sample (the sample ends before the note-off). */
  cut: boolean;
}

/** The variant's song and bass line (needs no audio files). */
export function bassMaterial(v: BassVariant, p: BassSynthParams = synthParams(v)): { song: BassSong; notes: BassNote[] } {
  const song = generateSong(streamOf(v, 'song'));
  let notes = bassLine(song, v.style, streamOf(v, 'line'));
  if (p.marks) notes = applyMarks(notes, streamOf(v, 'marks'));
  return { song, notes };
}

/** The render/types Variant that buildTruth / buildScoreTex / applyTempoCurve read. */
function truthVariant(v: BassVariant, p: BassSynthParams, bars: number): Variant {
  return {
    song: 'bass',
    mix: p.drumsAndMelody ? 'full' : 'piano',
    tempo: p.bpm,
    swing: 'none',
    click: false,
    name: v.name,
    leadInSec: p.leadSec,
    ...(p.drift ? { tempoCurve: driftCurve(p.bpm, bars) } : {}),
  };
}

const sectionLines = (t: ChordTimeline, bar: (b: number) => string): string[] =>
  t.sections.flatMap((s) => [`\\section "${s.label}"`, ...Array.from({ length: s.bars }, (_, i) => `${bar(s.startBar + i)} |`)]);

/** B2+: a plain rock groove (eighth hats, kick 1 / 3 and the "and" of 3, snare 2 / 4). */
export function drumPartBody(t: ChordTimeline): string {
  return ['\\instrument percussion', ...sectionLines(t, () => ':8 (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH')].join('\n');
}

/** B2+: a melody of chord tones (E4..E5), quarters with some eighth pairs, one segment at a time. */
export function melodyPartBody(t: ChordTimeline, rnd: () => number): string {
  const perBeat: string[] = [];
  let k = 0;
  for (let beat = 0; beat < t.bars * 4; beat++) {
    while (k + 1 < t.chords.length && t.chords[k + 1].bar * 4 + t.chords[k + 1].beat <= beat) k++;
    const c = parseChordSymbol(t.chords[k].text);
    const tone = () => {
      const pc = chordTones(c.root, c.quality)[Math.floor(rnd() * 3)];
      return 64 + ((pc - 64 + 120) % 12);
    };
    perBeat.push(rnd() < 0.3 ? `:8 ${noteName(tone())} ${noteName(tone())}` : `:4 ${noteName(tone())}`);
  }
  return sectionLines(t, (bar) => perBeat.slice(bar * 4, bar * 4 + 4).join(' ')).join('\n');
}

/** Voice gain envelope: 1 up to `off` (voice sample), then a cosine fade over `rel` samples, then 0. */
export function voiceEnvelope(voice: BassVoice, off: number, rel: number): Float32Array {
  const n = Math.min(voice.x.length, off + rel);
  const y = voice.x.slice(0, Math.max(0, n));
  for (let i = Math.max(0, off); i < n; i++) y[i] *= 0.5 * (1 + Math.cos((Math.PI * (i - off)) / rel));
  return y;
}

/** The linear, causal part after the mix (room -> phone mic), in place. */
export function chain(x: Float64Array, p: BassSynthParams, sr = SAMPLE_RATE): Float64Array {
  if (p.room.kind === 'schroeder') addReverb(x, p.room.rt60, sr, p.room.wet);
  else if (p.room.kind === 'fdn') fdnRoom(x, p.room.rt60, sr, p.room.wet);
  if (p.phone) {
    rbj(x, 'hp', PHONE_HP_HZ, sr);
    rbj(x, 'lp', PHONE_LP_HZ, sr);
  }
  return x;
}

const ONSET_WINDOW_SEC = 0.2;
/** Onset of a placed voice as heard through the chain (from its first sample, zero state). */
export function heardOnset(x: Float32Array, p: BassSynthParams, sr = SAMPLE_RATE): number {
  const w = Float64Array.from(x.subarray(0, Math.min(x.length, Math.round(ONSET_WINDOW_SEC * sr) + Math.round(0.05 * sr))));
  if (p.room.kind !== 'none' || p.phone) chain(w, p, sr);
  return onsetIndex(w, sr);
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Scores, truths and the bass placement (everything but the main alphaTab audio; shared by render and check). */
export function prepareBass(v: BassVariant, sr = SAMPLE_RATE) {
  const p = synthParams(v);
  const { song, notes } = bassMaterial(v, p);
  const t = song.timeline;
  const tv = truthVariant(v, p, t.bars);
  const meta = { title: '', tempo: p.bpm, time: '4/4' };
  const soundFont = SOUND_FONT_FILES.musescore;

  // ---- bass score -> MIDI -> note times ----
  const bscore = importScore(partsToAlphaTex({ meta, chart: [], parts: [{ name: BASS_TRACK, body: bassPartBody(song, notes) }] }));
  applyTempoCurve(bscore, tv);
  bscore.tracks[0].playbackInfo.program = GM_BASS_PROGRAM;
  const btruth = buildTruth({ score: bscore, midi: generateMidi(bscore), timeline: t, variant: tv, sampleRate: sr, soundFont });
  const midiNotes = btruth.melody?.notes ?? [];
  if (midiNotes.length !== notes.length || midiNotes.some((m, i) => m.midi !== notes[i].midi)) {
    throw new Error(`${v.name}: the bass MIDI does not match the bass line (${midiNotes.length} / ${notes.length} notes)`);
  }

  // ---- main score (B1+) ----
  let main: { score: model.Score; truth: AnalysisResult; midi: ReturnType<typeof generateMidi> } | null = null;
  if (p.comp !== null) {
    const pianoTimeline = p.pianoRoot ? { ...t, chords: t.chords.map((c) => ({ ...c, text: c.text.replace(/\/.*$/, '') })) } : t;
    const parts = p.drumsAndMelody
      ? [
          { name: 'Drums', body: drumPartBody(t) },
          { name: 'Melody', body: melodyPartBody(t, streamOf(v, 'melody')) },
        ]
      : [];
    const songObj: Song = { meta, chart: [], parts };
    const score = importScore(buildScoreTex(songObj, pianoPartBody(pianoTimeline, p.comp, { lhOctave: p.lhOctave }), tv));
    applyTempoCurve(score, tv);
    setPrograms(score);
    const midi = generateMidi(score);
    const truth = buildTruth({ score, midi, timeline: t, variant: tv, sampleRate: sr, soundFont });
    if (JSON.stringify(truth.beats) !== JSON.stringify(btruth.beats)) throw new Error(`${v.name}: the bass and main scores have different beats`);
    main = { score, truth, midi };
  }

  // ---- bass voices ----
  const timbre = getTimbre(v.timbre);
  const jit = streamOf(v, 'jitter', { perLevel: true, perTimbre: true });
  const vel = streamOf(v, 'velocity', { perLevel: true, perTimbre: true });
  const rrs = streamOf(v, 'rr', { perLevel: true, perTimbre: true });
  const jitter = () => (p.jitterSigmaSec > 0 ? Math.max(-JITTER_CLIP, Math.min(JITTER_CLIP, gauss(jit))) * p.jitterSigmaSec : 0);
  const timed = notes.map((note, i) => {
    const m = midiNotes[i];
    const d = jitter();
    const velocity = Math.max(note.role === 'ghost' ? 12 : 30, Math.min(127, Math.round(note.velocity + (p.velocitySigma > 0 ? gauss(vel) * p.velocitySigma : 0))));
    const at = Math.round((m.start + d) * sr);
    return { note, at, off: Math.round((m.start + (m.end - m.start) * (note.short ? 0.5 : 1) + d) * sr), velocity, u: p.roundRobin ? rrs() : 0 };
  });
  const placed: PlacedNote[] = timed.map((n, i) => {
    const voice = timbre.voice(n.note.midi, n.velocity, n.u);
    const next = timed[i + 1]?.at ?? Infinity;
    const relLen = Math.max(1, Math.round(Math.min(voice.release, Math.max(0, next - n.off) / sr + CHOKE_SEC) * sr));
    // the onset through the chain depends on the envelope only when the note is very short: iterate to a fixed point
    let onset = voice.onset;
    let x = voice.x;
    for (let it = 0; it < 4; it++) {
      x = voiceEnvelope(voice, n.off - n.at + onset, relLen);
      const o = heardOnset(x, p, sr);
      if (o < 0) throw new Error(`${v.name}: silent bass note ${i}`);
      if (o === onset) break;
      onset = o;
    }
    if (n.at - onset < 0) throw new Error(`${v.name}: bass note ${i} starts before the audio`);
    return { note: n.note, t: r6(n.at / sr), end: r6(n.off / sr), velocity: n.velocity, at: n.at, x, onset, cut: n.off - n.at + onset > voice.x.length };
  });
  return { params: p, song, notes, tv, btruth, main, placed };
}

/** The bass stem (placed voices, BASS_MIX_GAIN applied), n samples. */
export function bassStem(placed: readonly PlacedNote[], n: number): Float64Array {
  const out = new Float64Array(n);
  for (const pn of placed) {
    const start = pn.at - pn.onset;
    const hi = Math.min(n, start + pn.x.length);
    for (let i = start; i < hi; i++) out[i] += pn.x[i - start] * BASS_MIX_GAIN;
  }
  return out;
}

export interface RenderedBass {
  wav: Buffer;
  truth: BassTruthFile;
  params: BassSynthParams;
  peak: number;
  clipped: number;
}

export function renderBass(v: BassVariant, sr = SAMPLE_RATE): RenderedBass {
  const prep = prepareBass(v, sr);
  const { params: p, main, btruth, placed } = prep;
  const durationSec = (main?.truth ?? btruth).source.durationSec;
  const mainAudio = main ? renderAudio(main.midi, { soundFont: 'musescore', leadInSec: p.leadSec, sampleRate: sr }).samples : new Float32Array(0);
  const n = Math.max(mainAudio.length, Math.round((durationSec + TAIL_SEC) * sr));
  const x = bassStem(placed, n);
  for (let i = 0; i < mainAudio.length; i++) x[i] += mainAudio[i];
  chain(x, p, sr);
  for (let i = 0; i < n; i++) x[i] *= OUTPUT_GAIN;
  if (p.noiseSnrDb !== null) addNoise(x, p.noiseSnrDb, streamOf(v, 'noise', { perLevel: true, perTimbre: true }));
  const samples = new Float32Array(n);
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    samples[i] = x[i];
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
  }
  const truth = buildBassTruth(v, prep, n / sr);
  return { wav: encodeWav(samples, sr), truth, params: p, peak, clipped };
}

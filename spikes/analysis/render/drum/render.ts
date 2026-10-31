// Spike 5 T2: render one synthetic drum variant -> wav bytes + truth (deterministic per variant).
//
// Order: pattern (patterns.ts) -> hit times (notation.ts: grid + swing + jitter) -> velocity -> layer / round robin
// -> one-shot of the variant's mic mix (kits.ts) -> placement with HH choke (mixer.ts) -> room (room.ts; kit B's
// room is its room mic, already in the mic mix) -> phone mic -> master gain -> pink noise (render/hum/degrade.ts).
// The truth second of a hit is its placed onset sample / SAMPLE_RATE (check.ts measures it in the audio).

import { encodeWav } from '../wav';
import { addNoise } from '../hum/degrade';
import { gauss } from '../hum/voice';
import type { DrumInst } from '../../ts/drum/types';
import { getKit, KIT_INSTRUMENTS, layerOf, micWeights, onsetIndex, SAMPLE_RATE, type Kit, type OneShot } from './kits';
import { mixHits, type MixHit } from './mixer';
import { realGain, realKit, realParams, realTimes } from './realistic';
import { barTicksOf, hitTimes, toDrumEvents, type TimedHit } from './notation';
import { generatePattern, type GridHit, type Pattern } from './patterns';
import { addReverb, fdnRoom, phoneMic } from './room';
import { buildDrumTruth, type DrumTruthFile } from './truth';
import { streamOf, synthParams, TAIL_SEC, type DrumSynthParams, type DrumVariant } from './variants';

/** Nominal MIDI velocity per piece (normal hit); accent adds ACCENT_ADD, a ghost is GHOST_VELOCITY. */
export const NOMINAL_VELOCITY: Record<DrumInst, number> = {
  BD: 100, SD: 100, HH: 80, HO: 90, RD: 85, CR: 110, T1: 100, T2: 100, FT: 100,
  SP: 105, CN: 110, CB: 90, 'SD.rim': 115, 'SD.xs': 90, 'RD.bell': 95, 'HH.foot': 70, 'HH.fsp': 85,
};
export const ACCENT_ADD = 22;
export const GHOST_VELOCITY = 34;
/** Fixed output gain per kit and mic preset (never per file; picked so the loudest variants stay below full scale). */
export const KIT_GAIN: Record<Kit['id'], Record<DrumSynthParams['mic'], number>> = {
  A: { close: 1, oh: 1, phone: 1 },
  B: { close: 0.5, oh: 0.8, phone: 0.8 },
  C: { close: 0.5, oh: 0.8, phone: 0.8 },
  D: { close: 0.6, oh: 1, phone: 1 },
  H: { close: 1, oh: 1, phone: 1 },
};
/** A hit's jitter is clipped at this many sigmas. */
export const JITTER_CLIP = 2.5;

export interface PlacedHit extends TimedHit {
  velocity: number;
  layer: number;
  rr: number;
  /** Placed onset sample. */
  at: number;
}

export interface RenderedDrum {
  wav: Buffer;
  samples: Float32Array;
  truth: DrumTruthFile;
  pattern: Pattern;
  params: DrumSynthParams;
  hits: PlacedHit[];
  /** The mix before noise (check.ts re-renders hit subsets against it). */
  clean: Float64Array;
  peak: number;
  clipped: number;
}

/** The variant's pattern (needs only the kit's instrument list, not its files). */
export function drumPattern(v: DrumVariant, p: DrumSynthParams = synthParams(v)): Pattern {
  return generatePattern(
    v.style,
    { score: streamOf(v, 'score'), fill: streamOf(v, 'fill') },
    { instruments: KIT_INSTRUMENTS[v.kit], marks: p.marks, fills: p.fills, denseCymbals: p.denseCymbals },
  );
}

function velocityOf(h: GridHit, p: DrumSynthParams, rnd: () => number): number {
  const base = h.mark === 'g' ? GHOST_VELOCITY : NOMINAL_VELOCITY[h.inst] + (h.mark === 'ac' ? ACCENT_ADD : 0);
  const v = p.velocitySigma > 0 ? base + gauss(rnd) * p.velocitySigma : base;
  return Math.max(h.mark === 'g' ? 12 : 20, Math.min(127, Math.round(v)));
}

/** Window of a one-shot's start run through the room / mic chain to find its heard onset. */
const ONSET_WINDOW_SEC = 0.2;

/**
 * Onset of a one-shot as heard in the wav: the chain after the mix is linear and causal, so running it on the voice's
 * first samples alone (zero state) gives exactly what this voice adds there; the phone filter or a strong early
 * reflection can move the -30 dB crossing by a few samples relative to the dry one-shot.
 */
export function chainOnset(voice: OneShot, params: DrumSynthParams, memo: Map<OneShot, number>, sr = SAMPLE_RATE): number {
  let on = memo.get(voice);
  if (on === undefined) {
    if (params.room.kind === 'none' || params.room.kind === 'mic') {
      if (params.mic !== 'phone') on = voice.onset;
    }
    if (on === undefined) {
      const x = Float64Array.from(voice.x.subarray(0, Math.min(voice.x.length, voice.onset + Math.round(ONSET_WINDOW_SEC * sr))));
      roomAndMic(x, params, sr);
      on = onsetIndex(x, sr);
    }
    memo.set(voice, on);
  }
  return on;
}

/** Everything up to the placement (shared by render and check). */
export function placeHits(v: DrumVariant, sr = SAMPLE_RATE) {
  const params = synthParams(v);
  // T12b: the realistic set replaces the jitter, adds per-hit gain and changes some voices (realistic.ts)
  const rp = v.real ? realParams(v) : null;
  const kit = rp ? realKit(getKit(v.kit), rp, sr) : getKit(v.kit);
  const pattern = drumPattern(v, params);
  const jit = streamOf(v, 'jitter', { perLevel: true, perKit: true });
  const jitter = () => (params.jitterSigmaSec > 0 ? Math.max(-JITTER_CLIP, Math.min(JITTER_CLIP, gauss(jit))) * params.jitterSigmaSec : 0);
  const timed = rp
    ? realTimes(v, rp, hitTimes(pattern, params.bpm, params.startSec, params.swingRatio, () => 0), params.startSec)
    : hitTimes(pattern, params.bpm, params.startSec, params.swingRatio, jitter);
  const realLevel = streamOf(v, 'realLevel', { perKit: true });
  const beatTicks = 64 / pattern.ts[1];
  const vel = streamOf(v, 'velocity', { perLevel: true, perKit: true });
  const rrs = streamOf(v, 'rr', { perLevel: true, perKit: true });
  const mics = micWeights(v.kit, params.mic, params.room.kind === 'mic' ? params.room.level : 0);
  const gain = KIT_GAIN[v.kit][params.mic];
  const onsets = new Map<OneShot, number>();
  const placed: PlacedHit[] = [];
  const mix: MixHit[] = [];
  for (const h of timed) {
    const velocity = velocityOf(h, params, vel);
    const n = kit.layers(h.inst);
    const layer = layerOf(velocity, n);
    const rr = params.roundRobin ? Math.floor(rrs() * 64) : 0;
    const voice = kit.voice({ inst: h.inst, layer, rr, mics, cents: params.cents, program: params.program });
    // Within a sampled layer the velocity scales the level a little (kit A renders the velocity itself).
    const residual = kit.exactVelocity(h.inst) ? 1 : Math.max(0.8, Math.min(1.25, velocity / kit.layerVelocity(h.inst, layer)));
    const at = Math.round(h.t * sr);
    placed.push({ ...h, velocity, layer, rr, at });
    const extra = rp ? realGain(h, rp, beatTicks, realLevel) : 1;
    mix.push({ inst: h.inst, at, onset: chainOnset(voice, params, onsets, sr), gain: gain * residual * extra, voice });
  }
  const bars = pattern.bars.length;
  const endSec = params.startSec + (bars * barTicksOf(pattern.ts) * 60) / params.bpm / (64 / pattern.ts[1]);
  const n = Math.round((endSec + TAIL_SEC) * sr);
  return { params, kit, pattern, placed, mix, n, endSec };
}

/** The linear, causal part after the mix (room -> mic), in place. */
export function roomAndMic(x: Float64Array, params: DrumSynthParams, sr = SAMPLE_RATE): Float64Array {
  if (params.room.kind === 'schroeder') addReverb(x, params.room.rt60, sr, params.room.wet);
  else if (params.room.kind === 'fdn') fdnRoom(x, params.room.rt60, sr, params.room.wet);
  if (params.mic === 'phone') phoneMic(x, sr);
  return x;
}

export function cleanChain(mix: readonly MixHit[], n: number, params: DrumSynthParams, sr = SAMPLE_RATE): Float64Array {
  return roomAndMic(mixHits(mix, n, sr), params, sr);
}

export function renderDrum(v: DrumVariant, sr = SAMPLE_RATE): RenderedDrum {
  const { params, pattern, placed, mix, n, endSec } = placeHits(v, sr);
  const clean = cleanChain(mix, n, params, sr);
  const x = Float64Array.from(clean);
  if (params.noiseSnrDb !== null) addNoise(x, params.noiseSnrDb, streamOf(v, 'noise', { perLevel: true, perKit: true }));
  const samples = new Float32Array(n);
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    samples[i] = x[i];
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
  }
  const truth = buildDrumTruth(v, params, pattern, toDrumEvents(pattern), placed, sr, endSec, n / sr);
  return { wav: encodeWav(samples, sr), samples, truth, pattern, params, hits: placed, clean, peak, clipped };
}

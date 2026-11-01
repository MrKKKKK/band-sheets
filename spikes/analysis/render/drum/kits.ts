// Spike 5 T2: the three sample kits of the synthetic drums (docs/audio-spike5-plan.md section 4,
// spikes/analysis/DRUM_SAMPLES.md) as one-shot providers for the mixer.
//
//   A  MuseScore_General (MIT), tuning (+ dev). One-shots are RENDERED through the existing alphaTab path
//      (render/renderAudio.ts, soundfonts/MuseScore_General.sf2): a one-note MIDI on channel 10, bank 128 program 0
//      (Standard; program 16 "Power" = the D3 other tuning), per GM key and velocity (DRUM_SAMPLES.md: the sf2 has no
//      real velocity layers, so the velocity is rendered exactly, quantized to A_VELOCITY_STEPS levels). One mic.
//   B  Virtuosity Drums (CC0), dev. 24-bit 48 kHz stereo FLAC, resampled to 44.1 kHz; mics kickmic / snaremic / oh /
//      room (perc: close / mid / oh / room); layers `vlN` (soft -> loud) and round robins `rrN`. Two toms.
//   C  Big Rusty Drums (CC0), held-out only. 16-bit 44.1 kHz FLAC; mics close (cl / top / kick), btm, oh; no room
//      (the held-out room is synthetic, room.ts). Four toms (14", 15", 18" used as T1 T2 FT).
//   D  MuldjordKit v1.0 sfz (Lars Muldjord / DrumGizmo, sfz by kinwie; CC-BY 4.0, attribution in ts/THIRD_PARTY.md),
//      TUNING ONLY (T10b: a tuning kit whose hi-hat / ride / crash differ from kit A's; variants.ts refuses it for
//      dev / held-out). 24-bit 44.1 kHz mono FLAC, one file per mic (`N-<Piece>-<Mic>.flac`); layers and round robins
//      from the sfz region files (`lovel=$vXXl`, soft -> loud). Mics: close (the piece's own), btm (snare bottom),
//      ohl / ohr, ambl / ambr (its room). Four toms (Tom1, Tom2, Tom4 used as T1 T2 FT).
//   H  hybrid, TUNING ONLY: kit A's drums with kit D's HH / HO / RD / RD.bell / CR / CN (close mix, level-matched to
//      kit A's piece), to isolate the effect of the cymbal sound. No HH.foot / SP (kit A's metal).
//
// A one-shot is mono at SAMPLE_RATE, its mics already mixed with the caller's weights (mixer presets), trimmed to
// MAX_SEC (cymbals longer) with a short fade, and carries its ONSET: the first sample whose |x| reaches ONSET_REL_DB
// below the peak of the first ONSET_PEAK_SEC (onsetIndex()). The mixer places that sample on the truth time, and
// check.ts measures the rendered audio with the same function, so the truth is the audible onset of the mix used
// (a room-only mix starts later than the close mics; that delay is in the truth).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alphaTab from '@coderline/alphatab';
import { renderAudio } from '../renderAudio';
import type { DrumInst } from '../../ts/drum/types';
import { readAudioFile, resample, resampleStep, toMono } from './audioFile';

export const SAMPLE_RATE = 44100;
export type KitId = 'A' | 'B' | 'C' | 'D' | 'H';
/** Kits that only the tuning split may use (variants.ts synthParams refuses them elsewhere). */
export const TUNING_ONLY_KITS: ReadonlySet<KitId> = new Set<KitId>(['D', 'H']);

export const DRUMKITS_DIR = fileURLToPath(new URL('../../drumkits/', import.meta.url));
export const SF2_PATH = fileURLToPath(new URL('../../soundfonts/MuseScore_General.sf2', import.meta.url));
export const KIT_DIRS: Record<'B' | 'C' | 'D', string> = { B: 'virtuosity_drums', C: 'big_rusty_drums', D: 'muldjord_kit' };
/** Kit D's sfz root inside its directory (the archive of commit fc16571 of sfzinstruments/DrumGizmo.MuldjordKit). */
export const KIT_D_ROOT = 'DrumGizmo.MuldjordKit-fc165714974aa843125ce88597f341b31376e1d5/DrumGizmo/MuldjordKit';

/** Kit files present locally (tests skip without them). */
export function kitAvailable(kit: KitId): boolean {
  if (kit === 'A') return existsSync(SF2_PATH);
  if (kit === 'H') return kitAvailable('A') && kitAvailable('D');
  return existsSync(join(DRUMKITS_DIR, KIT_DIRS[kit], '.sha256'));
}

/** Onset definition (see top). */
export const ONSET_REL_DB = -30;
export const ONSET_PEAK_SEC = 0.15;

export function onsetIndex(x: ArrayLike<number>, sr = SAMPLE_RATE, from = 0): number {
  const end = Math.min(x.length, from + Math.round(ONSET_PEAK_SEC * sr));
  let peak = 0;
  for (let i = from; i < end; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak === 0) return -1;
  const thr = peak * 10 ** (ONSET_REL_DB / 20);
  for (let i = from; i < end; i++) if (Math.abs(x[i]) >= thr) return i;
  return -1;
}

const LONG: ReadonlySet<DrumInst> = new Set<DrumInst>(['CR', 'RD', 'RD.bell', 'CN', 'SP', 'HO', 'HH.fsp']);
export const MAX_SEC_LONG = 6;
export const MAX_SEC = 2.5;
const FADE_SEC = 0.05;

/** Pitched drums (the "other tuning" shifts these, not the cymbals). */
export const TUNED: ReadonlySet<DrumInst> = new Set<DrumInst>(['BD', 'SD', 'SD.rim', 'SD.xs', 'T1', 'T2', 'FT']);

export interface OneShot {
  x: Float32Array;
  onset: number;
}

export interface VoiceRequest {
  inst: DrumInst;
  /** Layer index 0..layers-1 (soft -> loud). */
  layer: number;
  /** Round robin index (wrapped to the available count). */
  rr: number;
  /** Mic weights (mic channel names of the kit, see MIC_PRESETS). */
  mics: Readonly<Record<string, number>>;
  /** Pitch shift in cents (B/C resampling; ignored for A, which uses `program`). */
  cents: number;
  /** Kit A only: 0 Standard, 16 Power. */
  program: number;
}

export interface Kit {
  id: KitId;
  /** Instruments the kit can play. */
  instruments: DrumInst[];
  /** Number of velocity layers of an instrument. */
  layers(inst: DrumInst): number;
  /** Nominal velocity of a layer (A: the rendered velocity). */
  layerVelocity(inst: DrumInst, layer: number): number;
  /** The one-shot renders the exact velocity (kit A), so the mixer adds no residual level change. */
  exactVelocity(inst: DrumInst): boolean;
  voice(req: VoiceRequest): OneShot;
}

/** Velocity (1..127) -> layer index. */
export function layerOf(velocity: number, layers: number): number {
  return Math.max(0, Math.min(layers - 1, Math.floor((velocity * layers) / 128)));
}

function finish(x: Float32Array, inst: DrumInst): Float32Array {
  const max = Math.round((LONG.has(inst) ? MAX_SEC_LONG : MAX_SEC) * SAMPLE_RATE);
  // trim the tail below -90 dB re peak, then cap the length with a fade
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  let last = x.length - 1;
  const floor = peak * 10 ** (-90 / 20);
  while (last > 0 && Math.abs(x[last]) < floor) last--;
  const n = Math.min(max, last + 1);
  const out = x.slice(0, n);
  const fade = Math.min(n, Math.round(FADE_SEC * SAMPLE_RATE));
  if (n === max) for (let i = 0; i < fade; i++) out[n - fade + i] *= 0.5 * (1 + Math.cos((Math.PI * (i + 1)) / fade));
  return out;
}

/* ------------------------------------------------------------------ kit A (alphaTab render) */

export const GM_KEY: Partial<Record<DrumInst, number>> = {
  BD: 36, SD: 38, HH: 42, HO: 46, RD: 51, CR: 49, T1: 50, T2: 48, FT: 41,
  SP: 55, CN: 52, CB: 56, 'SD.xs': 37, 'RD.bell': 53, 'HH.foot': 44,
};
export const A_VELOCITY_STEPS = 16;

function renderOneShotA(key: number, velocity: number, program: number, seconds: number): Float32Array {
  const f = new alphaTab.midi.MidiFile();
  f.division = 960;
  f.addEvent(new alphaTab.midi.TempoChangeEvent(0, 500000));
  // Without an explicit program change the percussion channel renders NaN (checked with alphaTab 1.8.4).
  f.addEvent(new alphaTab.midi.ProgramChangeEvent(0, 0, 9, program));
  f.addEvent(new alphaTab.midi.NoteOnEvent(0, 0, 9, key, velocity));
  f.addEvent(new alphaTab.midi.NoteOffEvent(0, 480, 9, key, 0));
  const r = renderAudio(f, { soundFont: 'musescore', tailSec: seconds, sampleRate: SAMPLE_RATE });
  for (const v of r.samples) if (!Number.isFinite(v)) throw new Error(`kit A: non-finite samples for key ${key}`);
  return r.samples;
}

function kitA(): Kit {
  const cache = new Map<string, OneShot>();
  const instruments = Object.keys(GM_KEY) as DrumInst[];
  const layerVelocity = (_: DrumInst, layer: number) => Math.min(127, Math.round(((layer + 0.5) * 128) / A_VELOCITY_STEPS));
  return {
    id: 'A',
    instruments,
    layers: () => A_VELOCITY_STEPS,
    layerVelocity,
    exactVelocity: () => true,
    voice(req) {
      const key = GM_KEY[req.inst];
      if (key === undefined) throw new Error(`kit A has no ${req.inst}`);
      const vel = layerVelocity(req.inst, req.layer);
      const ck = `${req.program}:${key}:${vel}`;
      let v = cache.get(ck);
      if (!v) {
        const x = finish(renderOneShotA(key, vel, req.program, LONG.has(req.inst) ? MAX_SEC_LONG : MAX_SEC), req.inst);
        v = { x, onset: onsetIndex(x) };
        if (v.onset < 0) throw new Error(`kit A: silent one-shot ${req.inst} v${vel}`);
        cache.set(ck, v);
      }
      return v;
    },
  };
}

/* ------------------------------------------------------------------ kits B and C (sample files) */

interface MicSource {
  /** Directory relative to the kit root. */
  dir: string;
  /** File-name prefix of this articulation (B folders hold several articulations). */
  prefix: string;
}
type InstSource = Record<string, MicSource>; // mic channel -> source

const bMic = (folder: string, artic: string) => (mic: string): MicSource => ({ dir: `Samples/${mic}/${folder}`, prefix: `${mic}_${artic}_` });
function bSource(folder: string, artic: string): InstSource {
  const f = bMic(folder, artic);
  return { kickmic: f('kickmic'), snaremic: f('snaremic'), oh: f('oh'), room: f('room') };
}
const bPerc = (name: string, prefix: string): InstSource => ({
  close: { dir: `Samples/perc/close/${name}`, prefix },
  oh: { dir: `Samples/perc/oh/${name}`, prefix },
  room: { dir: `Samples/perc/room/${name}`, prefix },
});

/** Kit B: our instrument ids -> articulation folders (no T2, SP, CN). */
export const KIT_B: Partial<Record<DrumInst, InstSource>> = {
  BD: bSource('kick', 'kick_snon'),
  SD: bSource('snare', 'snare_center'),
  'SD.rim': bSource('snare', 'snare_rimshot'),
  'SD.xs': bSource('snare', 'snare_crossstick'),
  HH: bSource('hh', 'hh_closed'),
  HO: bSource('hh', 'hh_open'),
  'HH.foot': bSource('hh', 'hh_pedal'),
  'HH.fsp': bSource('hh', 'hh_splash'),
  T1: bSource('htom', 'htom_center'),
  FT: bSource('ltom', 'ltom_center'),
  CR: bSource('crash', 'crash_crash'),
  RD: bSource('ride', 'ride_ride'),
  'RD.bell': bSource('ride', 'ride_bell'),
  CB: bPerc('cowbell', 'Cowbell1_Normal_'),
};

const cSrc = (path: string, mics: Record<string, string>): InstSource =>
  Object.fromEntries(Object.entries(mics).map(([m, d]) => [m, { dir: `Samples/${path}/${d}`, prefix: '' }]));
const cClOh = (path: string) => cSrc(path, { close: 'cl', oh: 'oh' });
const cSnare = (artic: string) => cSrc(`snare_14/${artic}`, { close: 'top', btm: 'btm', oh: 'oh' });

/** Kit C: our instrument ids -> folders (no CB, SP). */
export const KIT_C: Partial<Record<DrumInst, InstSource>> = {
  BD: cSrc('kick_24/kick', { close: 'kick', oh: 'oh' }),
  SD: cSnare('center'),
  'SD.rim': cSnare('rimshot'),
  'SD.xs': cSnare('sidestick'),
  HH: cClOh('hihat_14/cl'),
  HO: cClOh('hihat_14/open'),
  'HH.foot': cClOh('hihat_14/chik'),
  'HH.fsp': cClOh('hihat_14/footspl'),
  T1: cClOh('tom_14/center'),
  T2: cClOh('tom_15/center'),
  FT: cClOh('tom_18/center'),
  CR: cClOh('crash_17/cr'),
  RD: cClOh('ride_22/rd'),
  'RD.bell': cClOh('ride_22/bl'),
  CN: cClOh('china_18/cn'),
};

const FILE_RE = /(?:_vl|_v)(\d+)(?:_rr(\d+))?(?:_[A-Za-z]+)?\.(?:flac|wav)$/i;
const RR_ONLY_RE = /_rr(\d+)(?:_[A-Za-z]+)?\.(?:flac|wav)$/i;

/** (layer, rr) -> file of one mic directory; layer and rr are 1-based as in the names. */
export function scanMic(root: string, src: MicSource): Map<string, string> {
  const dir = join(root, src.dir);
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.startsWith(src.prefix)) continue;
    const rest = f.slice(src.prefix.length);
    const m = FILE_RE.exec(f);
    let vl: number;
    let rr: number;
    if (m && !/^rr\d/i.test(rest)) {
      vl = Number(m[1]);
      rr = m[2] ? Number(m[2]) : 1;
    } else {
      const r = RR_ONLY_RE.exec(f);
      if (!r) continue;
      vl = 1;
      rr = Number(r[1]);
    }
    out.set(`${vl}:${rr}`, join(dir, f));
  }
  return out;
}

interface Inventory {
  /** Ascending 1-based layer numbers. */
  layers: number[];
  /** rr numbers per layer. */
  rr: Map<number, number[]>;
  files: Record<string, Map<string, string>>;
}

/** Mic channel -> ("layer:rr" -> file) of one instrument; the first channel is the main one (defines the inventory). */
type InstFiles = (inst: DrumInst) => Record<string, Map<string, string>>;

function tableFiles(id: 'B' | 'C', table: Partial<Record<DrumInst, InstSource>>): InstFiles {
  const root = join(DRUMKITS_DIR, KIT_DIRS[id]);
  return (inst) => {
    const src = table[inst];
    if (!src) throw new Error(`kit ${id} has no ${inst}`);
    const files: Record<string, Map<string, string>> = {};
    for (const [mic, s] of Object.entries(src)) files[mic] = scanMic(root, s);
    return files;
  };
}

function sampleKit(id: 'B' | 'C' | 'D', instruments: DrumInst[], instFiles: InstFiles): Kit {
  const inv = new Map<DrumInst, Inventory>();
  const inventory = (inst: DrumInst): Inventory => {
    let v = inv.get(inst);
    if (v) return v;
    const files = instFiles(inst);
    const main = Object.values(files)[0];
    if (!main || main.size === 0) throw new Error(`kit ${id}: no files for ${inst}; run fetch-drum-samples.sh`);
    const rr = new Map<number, number[]>();
    for (const k of main.keys()) {
      const [l, r] = k.split(':').map(Number);
      rr.set(l, [...(rr.get(l) ?? []), r].sort((a, b) => a - b));
    }
    v = { layers: [...rr.keys()].sort((a, b) => a - b), rr, files };
    inv.set(inst, v);
    return v;
  };
  const fileCache = new Map<string, Float32Array>();
  const load = (path: string, inst: DrumInst): Float32Array => {
    let x = fileCache.get(path);
    if (!x) {
      const a = readAudioFile(path);
      // keep what finish() can use (+ room for a downward pitch shift), not the whole ring-out
      const keep = Math.round(((LONG.has(inst) ? MAX_SEC_LONG : MAX_SEC) * 1.2 + 0.1) * a.sampleRate);
      const mono = toMono(a);
      x = resample(mono.length > keep ? mono.slice(0, keep) : mono, a.sampleRate, SAMPLE_RATE);
      fileCache.set(path, x);
    }
    return x;
  };
  const cache = new Map<string, OneShot>();
  return {
    id,
    instruments,
    layers: (inst) => inventory(inst).layers.length,
    layerVelocity: (inst, layer) => Math.min(127, Math.round(((layer + 0.5) * 128) / inventory(inst).layers.length)),
    exactVelocity: () => false,
    voice(req) {
      const iv = inventory(req.inst);
      const layer = iv.layers[Math.max(0, Math.min(iv.layers.length - 1, req.layer))];
      const rrs = iv.rr.get(layer)!;
      const rr = rrs[((req.rr % rrs.length) + rrs.length) % rrs.length];
      const mics = Object.entries(req.mics).filter(([m, w]) => w !== 0 && iv.files[m]);
      const ck = `${req.inst}:${layer}:${rr}:${req.cents}:${JSON.stringify(mics)}`;
      let v = cache.get(ck);
      if (v) return v;
      const parts = mics.flatMap(([m, w]) => {
        const p = iv.files[m].get(`${layer}:${rr}`);
        return p ? [{ x: load(p, req.inst), w }] : [];
      });
      if (parts.length === 0) throw new Error(`kit ${id}: no mic files for ${req.inst} layer ${layer} rr ${rr} (${JSON.stringify(req.mics)})`);
      let x: Float32Array = new Float32Array(Math.max(...parts.map((p) => p.x.length)));
      for (const p of parts) for (let i = 0; i < p.x.length; i++) x[i] += p.w * p.x[i];
      if (req.cents !== 0 && TUNED.has(req.inst)) x = resampleStep(x, 2 ** (req.cents / 1200));
      x = finish(x, req.inst);
      v = { x, onset: onsetIndex(x) };
      if (v.onset < 0) throw new Error(`kit ${id}: silent one-shot ${req.inst}`);
      cache.set(ck, v);
      return v;
    },
  };
}

/* ------------------------------------------------------------------ kit D (MuldjordKit, tuning only) */

/** Kit D: our instrument ids -> sfz piece and its close mics (CrashL / China have no close mic: overheads only). */
export const KIT_D: Partial<Record<DrumInst, { piece: string; close?: string; btm?: string }>> = {
  BD: { piece: 'KdrumL', close: 'KdrumL' },
  SD: { piece: 'Snare', close: 'Snare_top', btm: 'Snare_bottom' },
  HH: { piece: 'HihatClosed', close: 'Hihat' },
  HO: { piece: 'HihatOpen', close: 'Hihat' },
  T1: { piece: 'Tom1', close: 'Tom1' },
  T2: { piece: 'Tom2', close: 'Tom2' },
  FT: { piece: 'Tom4', close: 'Tom4' },
  CR: { piece: 'CrashL' },
  RD: { piece: 'RideR', close: 'RideR' },
  'RD.bell': { piece: 'RideRBell', close: 'RideR' },
  CN: { piece: 'China' },
};

/** sfz region lines -> ("layer:rr" -> sample number N); layers ranked by their `$vXX` label (soft -> loud). */
export function parseMuldjordRegions(text: string): Map<string, number> {
  const rows = [...text.matchAll(/<region>[^\n]*?lovel=\$v(\d+)l[^\n]*?sample=\$instr\/(\d+)-/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const labels = [...new Set(rows.map((r) => r[0]))].sort((a, b) => a - b);
  const out = new Map<string, number>();
  const rr = new Map<number, number>();
  for (const [label, n] of rows) {
    const layer = labels.indexOf(label) + 1;
    const k = (rr.get(layer) ?? 0) + 1;
    rr.set(layer, k);
    out.set(`${layer}:${k}`, n);
  }
  return out;
}

function kitDFiles(): InstFiles {
  const root = join(DRUMKITS_DIR, KIT_DIRS.D, KIT_D_ROOT);
  return (inst) => {
    const src = KIT_D[inst];
    if (!src) throw new Error(`kit D has no ${inst}`);
    const regionPath = join(root, 'Data/region', `${src.piece}.txt`);
    if (!existsSync(regionPath)) throw new Error(`kit D: ${regionPath} missing; run fetch-drum-samples.sh`);
    const regions = parseMuldjordRegions(readFileSync(regionPath, 'utf8'));
    const mics: Record<string, string> = { ohl: 'OHL', ohr: 'OHR', ambl: 'AmbL', ambr: 'AmbR' };
    if (src.close) mics.close = src.close;
    if (src.btm) mics.btm = src.btm;
    const files: Record<string, Map<string, string>> = {};
    for (const [ch, mic] of Object.entries(mics)) {
      files[ch] = new Map([...regions].map(([k, n]) => [k, join(root, 'Samples', src.piece, `${n}-${src.piece}-${mic}.flac`)]));
    }
    return files;
  };
}

/* ------------------------------------------------------------------ kit H (A drums + D cymbals, tuning only) */

export const HYBRID_FROM_D: ReadonlySet<DrumInst> = new Set<DrumInst>(['HH', 'HO', 'RD', 'RD.bell', 'CR', 'CN']);
const HYBRID_INSTRUMENTS: DrumInst[] = (Object.keys(GM_KEY) as DrumInst[]).filter((i) => i !== 'HH.foot' && i !== 'SP');
/** Level match of a kit D piece to kit A's: RMS of the first 100 ms at this velocity (A dry vs D close mix). */
const HYBRID_MATCH_VELOCITY = 100;

function rms100(v: OneShot): number {
  const n = Math.min(v.x.length, v.onset + Math.round(0.1 * SAMPLE_RATE));
  let s = 0;
  for (let i = v.onset; i < n; i++) s += v.x[i] * v.x[i];
  return Math.sqrt(s / Math.max(1, n - v.onset));
}

function hybridKit(): Kit {
  const a = getKit('A');
  const d = getKit('D');
  const dMics = micWeights('D', 'close', 0);
  const ratio = new Map<DrumInst, number>();
  const ratioOf = (inst: DrumInst) => {
    let r = ratio.get(inst);
    if (r === undefined) {
      const va = a.voice({ inst, layer: layerOf(HYBRID_MATCH_VELOCITY, a.layers(inst)), rr: 0, mics: { dry: 1 }, cents: 0, program: 0 });
      const vd = d.voice({ inst, layer: layerOf(HYBRID_MATCH_VELOCITY, d.layers(inst)), rr: 0, mics: dMics, cents: 0, program: 0 });
      r = rms100(va) / rms100(vd);
      ratio.set(inst, r);
    }
    return r;
  };
  const scaled = new WeakMap<OneShot, OneShot>();
  const fromD = (inst: DrumInst) => HYBRID_FROM_D.has(inst);
  return {
    id: 'H',
    instruments: HYBRID_INSTRUMENTS,
    layers: (inst) => (fromD(inst) ? d : a).layers(inst),
    layerVelocity: (inst, layer) => (fromD(inst) ? d : a).layerVelocity(inst, layer),
    exactVelocity: (inst) => !fromD(inst),
    voice(req) {
      if (!HYBRID_INSTRUMENTS.includes(req.inst)) throw new Error(`kit H has no ${req.inst}`);
      if (!fromD(req.inst)) return a.voice(req);
      const v = d.voice({ ...req, mics: dMics, cents: 0 });
      let s = scaled.get(v);
      if (!s) {
        const r = ratioOf(req.inst);
        s = { x: v.x.map((e) => e * r), onset: v.onset };
        scaled.set(v, s);
      }
      return s;
    },
  };
}

const kits = new Map<KitId, Kit>();
/** The kit (memoized per process: one-shots are rendered / decoded once). */
export function getKit(id: KitId): Kit {
  let k = kits.get(id);
  if (!k) {
    if (id === 'A') k = kitA();
    else if (id === 'H') k = hybridKit();
    else if (id === 'D') k = sampleKit('D', Object.keys(KIT_D) as DrumInst[], kitDFiles());
    else k = sampleKit(id, Object.keys(id === 'B' ? KIT_B : KIT_C) as DrumInst[], tableFiles(id, id === 'B' ? KIT_B : KIT_C));
    kits.set(id, k);
  }
  return k;
}

/** Drops the memoized kits (determinism tests start from cold caches). */
export function resetKits(): void {
  kits.clear();
}

/** Instruments of each kit, without touching the files. */
export const KIT_INSTRUMENTS: Record<KitId, readonly DrumInst[]> = {
  A: Object.keys(GM_KEY) as DrumInst[],
  B: Object.keys(KIT_B) as DrumInst[],
  C: Object.keys(KIT_C) as DrumInst[],
  D: Object.keys(KIT_D) as DrumInst[],
  H: HYBRID_INSTRUMENTS,
};

/**
 * Mic presets per kit (plan section 4 "マイクの近さ": close / overhead / phone). `room` is the variant's room-mic
 * level (kits B and D; A, C and H get a synthetic room in room.ts instead). Kit H: kit A dry + kit D's close mix for
 * its cymbals at every preset (the room / phone are the synthetic chain, as for kit A).
 */
export function micWeights(kit: KitId, preset: 'close' | 'oh' | 'phone', room: number): Record<string, number> {
  if (kit === 'A') return { dry: 1 };
  if (kit === 'H') return { dry: 1, ...micWeights('D', 'close', 0) };
  if (kit === 'D') {
    if (preset === 'close') return { close: 1, btm: 0.5, ohl: 0.5, ohr: 0.5 };
    if (preset === 'oh') return { ohl: 0.7, ohr: 0.7, ambl: room, ambr: room };
    return { ambl: 0.7, ambr: 0.7, ohl: 0.2, ohr: 0.2 };
  }
  if (kit === 'B') {
    if (preset === 'close') return { kickmic: 1, snaremic: 1, oh: 1, close: 1 };
    if (preset === 'oh') return { oh: 1, room };
    return { room: 1, oh: 0.3 };
  }
  if (preset === 'close') return { close: 1, btm: 0.5, oh: 0.7 };
  return { oh: 1 };
}

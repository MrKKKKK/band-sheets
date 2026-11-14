// Spike 6 T2: a minimal sfz reader / player for the bass timbres B and C (BASS_SAMPLES.md; alphaTab reads sf2 only).
//
// Supported (only what the two instruments use, YAGNI): headers <control>/<global>/<master>/<group>/<region> (settings
// of the enclosing headers carry into each region; a new <group> resets the group level), `//` comments, opcodes
// sample (path with `\`), lokey/hikey/key, lovel/hivel, pitch_keycenter, tune (cents), transpose, lorand/hirand (B's
// round robins), seq_length/seq_position (C's round robins), ampeg_release, amp_velcurve_N. Everything else is ignored.
// Not loaded: release triggers, loops (the samples do not loop: a note longer than its sample ends with the sample),
// off_by choke (the player in render.ts cuts each voice at the next note instead, see voiceEnvelope).
//
// Picking a region for (key, velocity, u): the regions whose key and velocity ranges hold the request; among them the
// round robin for u in [0, 1): lorand <= u < hirand, or seq_position == floor(u * seq_length) + 1. u = 0 is the first
// round robin. Exactly one region must remain.
// Re-pitch: resample by 2^((key - pitch_keycenter + transpose) / 12 + tune / 1200) (render/drum/audioFile.ts).
// Level: amp_velcurve_N points, linear between them, with (0, 0) and (127, 1) added (sfz spec); no points = the sfz
// default curve (velocity / 127)^2.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SfzRegion {
  sample: string;
  lokey: number;
  hikey: number;
  lovel: number;
  hivel: number;
  pitchKeycenter: number;
  tune: number;
  transpose: number;
  lorand: number;
  hirand: number;
  seqLength: number;
  seqPosition: number;
  ampegRelease: number;
  /** amp_velcurve_N points, sorted by velocity. */
  velcurve: [number, number][];
}

type Opcodes = Map<string, string>;

const NOTE_NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** sfz key value: a number or a note name (c4 = 60). */
export function sfzKey(v: string): number {
  if (/^-?\d+$/.test(v)) return Number(v);
  const m = /^([a-gA-G])(#|b)?(-?\d)$/.exec(v);
  if (!m) throw new Error(`sfz: bad key ${v}`);
  return NOTE_NAMES[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

function toRegion(o: Opcodes): SfzRegion {
  const num = (k: string, d: number) => (o.has(k) ? Number(o.get(k)) : d);
  const key = (k: string, d: number) => (o.has(k) ? sfzKey(o.get(k)!) : d);
  const sample = o.get('sample');
  if (!sample) throw new Error('sfz: region without sample');
  const k = o.has('key') ? sfzKey(o.get('key')!) : undefined;
  const velcurve: [number, number][] = [];
  for (const [name, v] of o) {
    const m = /^amp_velcurve_(\d+)$/.exec(name);
    if (m) velcurve.push([Number(m[1]), Number(v)]);
  }
  velcurve.sort((a, b) => a[0] - b[0]);
  const lokey = key('lokey', k ?? 0);
  return {
    sample: sample.replace(/\\/g, '/'),
    lokey,
    hikey: key('hikey', k ?? 127),
    lovel: num('lovel', 1),
    hivel: num('hivel', 127),
    pitchKeycenter: key('pitch_keycenter', k ?? 60),
    tune: num('tune', 0),
    transpose: num('transpose', 0),
    lorand: num('lorand', 0),
    hirand: num('hirand', 1),
    seqLength: num('seq_length', 1),
    seqPosition: num('seq_position', 1),
    ampegRelease: num('ampeg_release', 0),
    velcurve,
  };
}

/** Regions of an sfz text, header settings carried down. */
export function parseSfz(text: string): SfzRegion[] {
  const levels = ['control', 'global', 'master', 'group'] as const;
  const scope: Record<string, Opcodes> = { control: new Map(), global: new Map(), master: new Map(), group: new Map() };
  const regions: SfzRegion[] = [];
  let current: Opcodes | null = null; // the open header's opcodes
  let region: Opcodes | null = null;
  const flush = () => {
    if (region) regions.push(toRegion(new Map([...levels.flatMap((l) => [...scope[l]]), ...region])));
    region = null;
  };
  // Tokens: headers and key=value pairs; a value runs to the next opcode or header (sample paths may hold spaces).
  const clean = text.replace(/\/\/.*$/gm, '');
  const re = /<(\w+)>|([A-Za-z0-9_]+)=([^=<]*?)(?=\s+[A-Za-z0-9_]+=|\s*<|\s*$)/gs;
  for (const m of clean.matchAll(re)) {
    if (m[1] !== undefined) {
      flush();
      const h = m[1];
      if (h === 'region') {
        region = new Map();
        current = region;
      } else if ((levels as readonly string[]).includes(h)) {
        // a header resets itself and the levels below it
        for (const l of levels.slice(levels.indexOf(h as (typeof levels)[number]))) scope[l] = new Map();
        current = scope[h];
      } else current = null; // <curve>, <effect>, ...: ignored
    } else if (current) current.set(m[2], m[3].trim());
  }
  flush();
  return regions;
}

/** The region to play (see top); throws unless exactly one matches. */
export function pickRegion(regions: readonly SfzRegion[], key: number, velocity: number, u: number): SfzRegion {
  const hit = regions.filter((r) => key >= r.lokey && key <= r.hikey && velocity >= r.lovel && velocity <= r.hivel);
  const rr = hit.filter((r) =>
    r.seqLength > 1 ? r.seqPosition === Math.floor(u * r.seqLength) + 1 : u >= r.lorand && (u < r.hirand || r.hirand >= 1),
  );
  if (rr.length !== 1) throw new Error(`sfz: ${rr.length} regions for key ${key} velocity ${velocity} u ${u}`);
  return rr[0];
}

/** Level of a region at a velocity (see top). */
export function velGain(r: SfzRegion, velocity: number): number {
  if (r.velcurve.length === 0) return (velocity / 127) ** 2;
  const pts: [number, number][] = [[0, 0], ...r.velcurve.filter(([v]) => v > 0 && v < 127), [127, r.velcurve.find(([v]) => v === 127)?.[1] ?? 1]];
  for (let i = 1; i < pts.length; i++) {
    const [v0, g0] = pts[i - 1];
    const [v1, g1] = pts[i];
    if (velocity <= v1) return g0 + ((g1 - g0) * (velocity - v0)) / (v1 - v0);
  }
  return 1;
}

/** Resampling step that re-pitches a region to `key` (> 1 = up). */
export function pitchStep(r: SfzRegion, key: number): number {
  return 2 ** ((key - r.pitchKeycenter + r.transpose) / 12 + r.tune / 1200);
}

export interface SfzInstrument {
  path: string;
  dir: string;
  regions: SfzRegion[];
}

export function loadSfz(path: string): SfzInstrument {
  return { path, dir: dirname(path), regions: parseSfz(readFileSync(path, 'utf8')) };
}

export const samplePath = (inst: SfzInstrument, r: SfzRegion): string => join(inst.dir, r.sample);

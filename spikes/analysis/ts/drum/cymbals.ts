/**
 * Spike 5 T11: S-9 metal pieces - HH / HO / RD / CR (docs/audio-spike5-plan.md section 2, S-9; docs/audio-spike5-t11.md).
 *
 * Only for level S-9 (classify.ts s9Hits, after the S-3 steps; S-3 output is unchanged). One metal piece per
 * onset (the plan's "HH and HO are never hit together", extended to the four pieces: the synthetic grooves never put
 * two of them on one onset). An onset carries a metal piece when S-3 found HH there, or when the cymbal absorbers
 * (HO RD CR RD.bell SP CN) hold >= shareMin of its activations at a level >= levelMinDb re the take's reference.
 *
 * Which piece: the template vote (largest activation of HH / HO / RD (+RD.bell) / CR (+SP CN), which is right for a
 * known kit) corrected by two kit-independent features of the take:
 *  - drop (highDrops): dB change of the >= fminHz mel energy from its peak (onset frame .. +2) to dropFrames later
 *    (fewer when the next onset comes first, scaled to dropFrames; < dropMinFrames = not measured). Closed HH falls
 *    fast (tuning kits A / D / H median -5.6 / -7.6 / -8.2 dB at 6 frames), HO and RD ring (-1.8 .. -3.5), CR rises
 *    while it blooms (+2).
 *  - cosHh: cosine of the onset's >= profileFminHz observation to the take's closed-HH profile (mean of the onsets
 *    with only HH and a fast drop). An open HH is the same pair of cymbals, so it tends to look like the closed HH
 *    (tuning, fine mel bands: HO .82-.94, RD .65-.93, CR .45-.76; it only separates roughly).
 * Rules, in order: drop < fastDb -> HH; drop > riseDb and the cymbal templates hold >= crOverHh of the HH one -> CR;
 * otherwise, when the vote is not dominant (its share of the metal activations < voteDom), a slow onset (drop >
 * slowDb) is HO when cosHh >= hoCos, else RD or CR by the vote between them; a dominant vote stands.
 */
import type { MelSpec } from './classify';
import type { DrumConfig } from './config';

export const METAL = ['HH', 'HO', 'RD', 'CR'] as const;
export type MetalInst = (typeof METAL)[number];

/** Per onset: activation of each metal piece (template columns summed: RD + RD.bell, CR + SP + CN). */
export type MetalVotes = Record<MetalInst, number>;

/** >= fminHz mel energy per frame. */
function bandEnergy(s: MelSpec, centres: ArrayLike<number>, fminHz: number): Float64Array {
  const E = new Float64Array(s.frames);
  for (let t = 0; t < s.frames; t++) {
    let e = 0;
    for (let m = 0; m < s.bands; m++) if (centres[m] >= fminHz) e += s.data[t * s.bands + m];
    E[t] = e;
  }
  return E;
}

/** See the file comment. `frames` = onset frames (round(t sr / hop)); NaN when the next onset leaves < minFrames. */
export function highDrops(s: MelSpec, centres: ArrayLike<number>, frames: readonly number[], o: { fminHz: number; dropFrames: number; dropMinFrames: number }): number[] {
  const E = bandEnergy(s, centres, o.fminHz);
  return frames.map((c, i) => {
    if (c < 0 || c >= s.frames) return NaN;
    let pk = c;
    for (let f = c; f <= Math.min(s.frames - 1, c + 2); f++) if (E[f] > E[pk]) pk = f;
    const next = i + 1 < frames.length ? frames[i + 1] - 1 : Infinity;
    const d = Math.min(o.dropFrames, next - pk, s.frames - 1 - pk);
    if (d < o.dropMinFrames || !(E[pk] > 0)) return NaN;
    return ((10 * Math.log10(Math.max(E[pk + d], 1e-30) / E[pk])) * o.dropFrames) / d;
  });
}

function unit(x: ArrayLike<number>, from: number): Float64Array {
  const v = Float64Array.from(Array.prototype.slice.call(x, from) as number[]);
  const n = Math.hypot(...v);
  return n > 0 ? v.map((e) => e / n) : v;
}

/**
 * Cosine of each observation's bands >= profileFminHz to the take's closed-HH profile (mean of the unit vectors of
 * `profileOf` onsets); all NaN when fewer than minHits such onsets.
 */
export function cosToProfile(obs: readonly ArrayLike<number>[], centres: ArrayLike<number>, profileOf: readonly boolean[], fminHz: number, minHits: number): number[] {
  let from = 0;
  while (from < centres.length && centres[from] < fminHz) from++;
  const idx = profileOf.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  if (idx.length < minHits) return obs.map(() => NaN);
  const prof = new Float64Array(centres.length - from);
  for (const i of idx) unit(obs[i], from).forEach((v, m) => (prof[m] += v));
  const p = unit(prof, 0);
  return obs.map((x) => {
    const u = unit(x, from);
    let c = 0;
    for (let m = 0; m < u.length; m++) c += u[m] * p[m];
    return Math.hypot(...u) > 0 ? c : NaN;
  });
}

export type CymbalCfg = DrumConfig['cymbals'];

/** Metal piece of one onset (see the file comment); `alt` = the runner-up of the vote. */
export function metalLabel(v: MetalVotes, drop: number, cosHh: number, cfg: CymbalCfg): { inst: MetalInst; alt: MetalInst } {
  const order = [...METAL].sort((a, b) => v[b] - v[a]);
  const total = METAL.reduce((s, m) => s + v[m], 0);
  let inst: MetalInst = order[0];
  const dominant = total > 0 && v[inst] >= cfg.voteDom * total;
  if (Number.isFinite(drop)) {
    if (drop < cfg.fastDb) inst = 'HH';
    else if (drop > cfg.riseDb && v.HO + v.RD + v.CR >= cfg.crOverHh * v.HH) inst = 'CR';
    else if (!dominant && drop > cfg.slowDb) inst = Number.isFinite(cosHh) && cosHh >= cfg.hoCos ? 'HO' : v.CR > v.RD ? 'CR' : 'RD';
  }
  const alt = order.find((m) => m !== inst) ?? 'HH';
  return { inst, alt };
}

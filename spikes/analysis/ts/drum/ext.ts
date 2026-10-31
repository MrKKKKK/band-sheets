/**
 * Spike 5 T12: S-拡張 (S-ext) - the pieces and playing techniques the app cannot write yet (docs/audio-spike5-plan.md
 * section 2 S-拡張; docs/audio-spike5-t12.md). Provisional analysis names only (types.ts EXT_DRUM_INSTRUMENTS).
 *
 * Only for level S-ext, on top of the S-9 hits (classify.ts s9Hits; S-9 and S-3 output are unchanged). Evidence per
 * onset: the activations of the kit's template columns in the S-9 metal fit (the fit before the tom adapt; it has the
 * S-拡張 absorber columns CB SD.xs RD.bell SP CN of templates.ts) and two kit-independent numbers of the tom window
 * (toms.ts windowMag): `tonal` = largest magnitude in [tonalMinHz, tonalMaxHz] / median magnitude there, and its
 * frequency `tonalHz` (a bell or a cowbell rings at one strong partial; cymbals and drums do not).
 *
 * New pieces:
 *  - SP / CN (splash / china), written CR: an S-9 CR that does not bloom (drop <= cymbals.riseDb; a crash rises while
 *    it opens) becomes SP or CN when that column holds >= cymVote of the CR + SP + CN activation (template vote only:
 *    the tuning kits have one splash and two chinas, too few for a kit-independent rule).
 *  - CB (cowbell), written RD: a new hit when the CB columns hold >= cbShare of the onset's activations, or when the
 *    onset is tonal (>= cbTonal) at cbMinHz .. cbMaxHz and falls fast (drop < cbMaxDropDb), without a tom hit.
 *    An S-9 HH / HO / RD on that onset is removed when cbDropsMetal (the cowbell's ring read as metal).
 * Techniques (they replace the base piece's hit on the onset):
 *  - RD.bell, written RD: an S-9 RD whose RD.bell columns hold >= bellVote of the metal activations, or an S-9 RD /
 *    HH / HO that is tonal (>= bellTonal) at >= bellMinHz (another kit's bell is often an S-9 HH: it falls fast).
 *  - SD.xs (cross-stick), written SD: when the SD.xs columns hold >= xsShare and the onset's metal is not a CR (another
 *    kit's china looks like the cross-stick template); replaces an S-9 SD there or is added.
 *  - HH.foot (pedal HH), written HH: with footShare > 0, the share of the pedal-HH template columns (templates.ts group
 *    extFoot, never in the S-3 / S-9 basis) when they join the S-9 metal fit's basis; >= footShare relabels an S-9 HH /
 *    HO or adds a hit on an onset without metal.
 * Not output (no tuning kit has them): SD.rim, HH.fsp.
 */
import type { DrumConfig } from './config';
import type { AnalysisDrumHit, DrumInst } from './types';

export type ExtCfg = DrumConfig['ext'];

/** Per-onset S-拡張 evidence. `act`: activation per kit instrument (template columns summed; adapted columns left out). */
export interface ExtEvidence {
  act: Partial<Record<DrumInst, number>>;
  /** Sum of all activations of the onset. */
  total: number;
  /** cymbals.ts highDrops of the onset (dB). */
  drop: number;
  tonal: number;
  tonalHz: number;
  /** Share of the pedal-HH template columns when added to the fit (0 when ext.footShare is 0). */
  foot: number;
}

/** tonal / tonalHz of a tom window (see the file comment); NaN without energy in the range. */
export function tonalPeak(mag: ArrayLike<number>, size: number, sr: number, minHz: number, maxHz: number): { tonal: number; hz: number } {
  const k0 = Math.max(1, Math.round((minHz * size) / sr));
  const k1 = Math.min(mag.length - 1, Math.round((maxHz * size) / sr));
  if (k1 <= k0) return { tonal: NaN, hz: NaN };
  const band: number[] = [];
  let pk = k0;
  for (let k = k0; k <= k1; k++) {
    band.push(mag[k]);
    if (mag[k] > mag[pk]) pk = k;
  }
  band.sort((a, b) => a - b);
  const med = band[band.length >> 1];
  return med > 0 ? { tonal: mag[pk] / med, hz: (pk * sr) / size } : { tonal: NaN, hz: NaN };
}

const METAL_COLS: readonly DrumInst[] = ['HH', 'HO', 'RD', 'RD.bell', 'CR', 'SP', 'CN'];
const TOMS: readonly string[] = ['T1', 'T2', 'FT'];
const a = (e: ExtEvidence, i: DrumInst) => e.act[i] ?? 0;
const conf = (r: number, min: number) => 0.5 + 0.5 * Math.max(0, Math.min(1, (r - min) / Math.max(1e-9, 1 - min)));

/**
 * S-ext hits of one take: `s9` (s9Hits, time order; hits of one onset share its `t`) rewritten per onset. `onsetT[i]`
 * is onset i's time, `ev[i]` its evidence, `riseDb` = cymbals.riseDb.
 */
export function extHits(s9: readonly AnalysisDrumHit[], onsetT: readonly number[], ev: readonly ExtEvidence[], riseDb: number, cfg: ExtCfg): AnalysisDrumHit[] {
  const byT = new Map<number, AnalysisDrumHit[]>();
  for (const h of s9) (byT.get(h.t) ?? byT.set(h.t, []).get(h.t)!).push({ ...h });
  const out: AnalysisDrumHit[] = [];
  onsetT.forEach((t, i) => {
    const e = ev[i];
    let hs = byT.get(t) ?? [];
    byT.delete(t);
    const metal = hs.find((h) => h.inst === 'HH' || h.inst === 'HO' || h.inst === 'RD' || h.inst === 'CR');
    const tonalAt = (min: number, lo: number, hi: number) => Number.isFinite(e.tonal) && e.tonal >= min && e.tonalHz >= lo && e.tonalHz <= hi;
    // new pieces: splash / china
    if (metal?.inst === 'CR' && !(e.drop > riseDb)) {
      const fam = a(e, 'CR') + a(e, 'SP') + a(e, 'CN');
      const pick = (['SP', 'CN'] as const).find((x) => fam > 0 && a(e, x) / fam >= cfg.cymVote);
      if (pick) relabel(metal, pick, conf(a(e, pick) / fam, cfg.cymVote));
    }
    // technique: ride bell
    if (metal && metal.inst !== 'CR') {
      const m = METAL_COLS.reduce((s, x) => s + a(e, x), 0);
      const vote = m > 0 ? a(e, 'RD.bell') / m : 0;
      // the vote only on an S-9 RD: on S-9 hi-hats it relabels ~10 % of ordinary closed HH (tuning A / D, D2)
      const byVote = metal.inst === 'RD' && vote >= cfg.bellVote;
      if (byVote || tonalAt(cfg.bellTonal, cfg.bellMinHz, Infinity)) relabel(metal, 'RD.bell', byVote ? conf(vote, cfg.bellVote) : 0.5);
    }
    // technique: pedal HH (template only)
    if (cfg.footShare > 0 && e.foot >= cfg.footShare) {
      if (metal && (metal.inst === 'HH' || metal.inst === 'HO')) relabel(metal, 'HH.foot', conf(e.foot, cfg.footShare));
      else if (!metal) hs.push(newHit(t, 'HH.foot', e.foot * e.total, conf(e.foot, cfg.footShare), 'HH'));
    }
    // new piece: cowbell
    const cbShare = e.total > 0 ? a(e, 'CB') / e.total : 0;
    const tom = hs.some((h) => TOMS.includes(h.inst));
    if (cbShare >= cfg.cbShare || (!tom && tonalAt(cfg.cbTonal, cfg.cbMinHz, cfg.cbMaxHz) && e.drop < cfg.cbMaxDropDb)) {
      if (cfg.cbDropsMetal) hs = hs.filter((h) => !(h.inst === 'HH' || h.inst === 'HO' || h.inst === 'RD'));
      hs.push(newHit(t, 'CB', a(e, 'CB'), cbShare >= cfg.cbShare ? conf(cbShare, cfg.cbShare) : 0.5, 'RD'));
    }
    // technique: cross-stick
    const xs = e.total > 0 ? a(e, 'SD.xs') / e.total : 0;
    if (xs >= cfg.xsShare && metal?.inst !== 'CR') {
      const sd = hs.find((h) => h.inst === 'SD');
      if (sd) relabel(sd, 'SD.xs', conf(xs, cfg.xsShare));
      else hs.push(newHit(t, 'SD.xs', a(e, 'SD.xs'), conf(xs, cfg.xsShare), 'SD'));
    }
    out.push(...hs);
  });
  // hits on times that are no onset (none today) pass through
  for (const hs of byT.values()) out.push(...hs);
  return out.sort((x, y) => x.t - y.t);
}

/** The technique / new piece replaces the hit's piece; the base piece becomes the hit's alternative. */
function relabel(h: AnalysisDrumHit, inst: DrumInst, confidence: number): void {
  h.alts = [{ inst: h.inst as DrumInst, confidence: Math.min(0.499, 1 - confidence) }];
  h.inst = inst;
  h.confidence = confidence;
}

function newHit(t: number, inst: DrumInst, strength: number, confidence: number, alt: DrumInst): AnalysisDrumHit {
  return { t, inst, strength, confidence, alts: [{ inst: alt, confidence: Math.min(0.499, 1 - confidence) }] };
}

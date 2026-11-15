/**
 * Spike 7 T7: pure aggregation of chords2 scores over many files (baseline.ts reads the files). `scoreChords` /
 * `editCounts` (score.ts) give one file's numbers; this sums the hit / n pairs and the counts and recomputes the rates
 * and the Wilson intervals (z = 1.96, on the truth-segment units) for a group of files. `confusion` counts truth ×
 * result readings on the same scored points as score.ts (two per truth beat, weight 0.5).
 */
import { at } from '../../bass/evalCommon';
import { beatWindows, normalizeTruthSlash, noteToPc, type ScoreBeat, type ScoreChord } from '../../bass/score';
import { resultQuality, truthQuality, wilson, type ChordScores, type EditCounts, type EvalChord, type Interval, type Vocab } from './score';

export interface HitN {
  hit: number;
  n: number;
}
const hn = (): HitN => ({ hit: 0, n: 0 });
const addHn = (a: HitN, hit: number, n: number): void => {
  a.hit += hit;
  a.n += n;
};

export interface Agg {
  files: number;
  nPoints: number;
  droppedPoints: number;
  noChordPoints: number;
  nameP: HitN;
  nameU: HitN;
  slashRootP: HitN;
  slashRootU: HitN;
  slash: { truth: number; result: number; hit: number };
  wrong: { noSlash: number; falseSlash: number; chordPoints: number; falseOnChord: number };
  /** per quality: truth side (recall) and result side (precision) of root + quality */
  byQuality: Record<string, { t: HitN; r: HitN }>;
  bassOnlyP: HitN;
  bassOnlyU: HitN;
  edits: Omit<EditCounts, 'nBeats'> & { nBeats: number };
}

export const newAgg = (): Agg => ({
  files: 0,
  nPoints: 0,
  droppedPoints: 0,
  noChordPoints: 0,
  nameP: hn(),
  nameU: hn(),
  slashRootP: hn(),
  slashRootU: hn(),
  slash: { truth: 0, result: 0, hit: 0 },
  wrong: { noSlash: 0, falseSlash: 0, chordPoints: 0, falseOnChord: 0 },
  byQuality: {},
  bassOnlyP: hn(),
  bassOnlyU: hn(),
  edits: { name: 0, slashAdd: 0, slashRemove: 0, slashChange: 0, split: 0, merge: 0, total: 0, nBeats: 0, nameFixableByCandidate: 0 },
});

export function addFile(a: Agg, s: ChordScores, e: EditCounts): void {
  a.files++;
  a.nPoints += s.nPoints;
  a.droppedPoints += s.droppedPoints;
  a.noChordPoints += s.noChordPoints;
  addHn(a.nameP, s.name.points.hit, s.name.points.n);
  addHn(a.nameU, s.name.units.hit, s.name.units.n);
  addHn(a.slashRootP, s.slashRoot.points.hit, s.slashRoot.points.n);
  addHn(a.slashRootU, s.slashRoot.units.hit, s.slashRoot.units.n);
  a.slash.truth += s.slash.truthSlash;
  a.slash.result += s.slash.resultSlash;
  a.slash.hit += s.slash.hit;
  a.wrong.noSlash += s.wrongSlash.noSlashTruth;
  a.wrong.falseSlash += s.wrongSlash.falseSlash;
  a.wrong.chordPoints += s.wrongSlash.onChordPoints.n;
  a.wrong.falseOnChord += s.wrongSlash.onChordPoints.hit;
  for (const [q, r] of Object.entries(s.byQuality)) {
    const x = (a.byQuality[q] ??= { t: hn(), r: hn() });
    addHn(x.t, r.truth.hit, r.truth.n);
    addHn(x.r, r.result.hit, r.result.n);
  }
  addHn(a.bassOnlyP, s.bassOnly.points.hit, s.bassOnly.points.n);
  addHn(a.bassOnlyU, s.bassOnly.units.hit, s.bassOnly.units.n);
  for (const k of Object.keys(a.edits) as (keyof Agg['edits'])[]) a.edits[k] += e[k];
}

const r = (h: HitN): number | null => (h.n ? h.hit / h.n : null);
export interface Summary {
  files: number;
  nPoints: number;
  name: { rate: number | null; unitRate: number | null; units: number; wilson: Interval | null };
  slashRoot: { rate: number | null; units: number; wilson: Interval | null; n: number };
  slash: { p: number | null; r: number | null; f: number; truth: number };
  wrongSlash: number | null;
  wrongSlashOnChord: number | null;
  editsPer100: number | null;
  editsFixablePer100: number | null;
  bassOnly: { rate: number | null; units: number; unitHit: number };
}
export function summarize(a: Agg): Summary {
  const p = a.slash.result ? a.slash.hit / a.slash.result : null;
  const rc = a.slash.truth ? a.slash.hit / a.slash.truth : null;
  return {
    files: a.files,
    nPoints: a.nPoints,
    name: { rate: r(a.nameP), unitRate: r(a.nameU), units: a.nameU.n, wilson: wilson(a.nameU.hit, a.nameU.n) },
    slashRoot: { rate: r(a.slashRootP), units: a.slashRootU.n, wilson: wilson(a.slashRootU.hit, a.slashRootU.n), n: a.slashRootP.n },
    slash: { p, r: rc, f: p && rc ? (2 * p * rc) / (p + rc) : 0, truth: a.slash.truth },
    wrongSlash: a.wrong.noSlash ? a.wrong.falseSlash / a.wrong.noSlash : null,
    wrongSlashOnChord: a.wrong.chordPoints ? a.wrong.falseOnChord / a.wrong.chordPoints : null,
    editsPer100: a.edits.nBeats ? (a.edits.total * 100) / a.edits.nBeats : null,
    editsFixablePer100: a.edits.nBeats ? (a.edits.nameFixableByCandidate * 100) / a.edits.nBeats : null,
    bassOnly: { rate: r(a.bassOnlyP), units: a.bassOnlyU.n, unitHit: a.bassOnlyU.hit },
  };
}

/* ------------------------------------------------------------ confusion */

export interface Confusion {
  /** `${truth quality}|${result quality or 'none'}` among points where the roots match */
  quality: Record<string, number>;
  /** root offset (result - truth, mod 12, or 'none') at points whose truth has a /X */
  slashRootOffset: Record<string, number>;
  /** the same for the result's sounding bass (bass if marked, else root) against the truth bass, at truth-/X points */
  slashBassOffset: Record<string, number>;
}
export const newConfusion = (): Confusion => ({ quality: {}, slashRootOffset: {}, slashBassOffset: {} });

const isNoChord = (c: ScoreChord): boolean => c.root === null || c.root === undefined || ['', 'N'].includes(String(c.root).trim());
const bump = (o: Record<string, number>, k: string): void => {
  o[k] = (o[k] ?? 0) + 0.5;
};

export function addConfusion(c: Confusion, truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[], vocab: Vocab): void {
  const tt = (normalizeTruthSlash(truth) as EvalChord[]).filter((x) => !isNoChord(x));
  const rt = result.filter((x) => !isNoChord(x));
  for (const w of beatWindows(beats))
    for (const f of [0.25, 0.75]) {
      const t = w[0] + f * (w[2] - w[0]);
      const tc = at(tt, t);
      if (!tc) continue;
      const tq = truthQuality(tc, vocab);
      if (tq === null) continue;
      const rc = at(rt, t);
      const tr = noteToPc(tc.root);
      if (rc && noteToPc(rc.root) === tr) bump(c.quality, `${tq}|${resultQuality(rc, vocab)}`);
      else if (!rc) bump(c.quality, `${tq}|none`);
      if (tc.bass) {
        const off = rc ? String((noteToPc(rc.root) - tr + 12) % 12) : 'none';
        bump(c.slashRootOffset, off);
        const tb = noteToPc(tc.bass);
        bump(c.slashBassOffset, rc ? String(((rc.bass ? noteToPc(rc.bass) : noteToPc(rc.root)) - tb + 12) % 12) : 'none');
      }
    }
}

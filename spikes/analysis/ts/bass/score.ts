/**
 * Spike 6 T3: scoring of the bass analyzer (docs/audio-spike6-plan.md section 5). Separate from root accuracy:
 * py/score.py's chord scoring is untouched; the per-beat rules here mirror it so that `slashRecall` equals its
 * `vocab.bassPerBeat` (py/tools/bass_mireval_check.py compares them on random cases, and note F with mir_eval, to 1e-9).
 *
 * Shared rules (copied from py/score.py, which is the reference; the check script compares mapVocab to map_vocab):
 *  - Points: two per truth beat, at 25 % and 75 % of the beat window, weight 0.5 each (the last window is extended by
 *    the median beat interval). The track lookup is "the chord with start <= t < end"; N / empty roots are ignored.
 *  - A truth chord whose quality map_vocab drops is not scored (like bassPerBeat). Segment bass hit does not need the
 *    quality, but uses the same dropped-beat rule so every metric has one population.
 *  - A bass name that does not parse counts as "no bass" (py `_bass_pc`). The result bass `/X` counts as a `/X` even if
 *    it equals the root (the analyzer should not emit that; precision then falls).
 *
 * Metrics (all over the scored points, weighted):
 *  - segBass.hit: result bass pc (bass ?? root) == truth bass pc (bass ?? root); no result chord = miss. Pass the
 *    analyzer's chords for "analysis segments", or truth chords with the analyzed bass for the "true segments" ceiling.
 *  - slash: recall = hits / points whose truth has /X (hit = result bass pc == truth bass pc); precision = hits /
 *    points whose truth chord exists and result has /X; f = harmonic mean (0 when either is 0 or undefined).
 *    slashRecall === py vocab.bassPerBeat.
 *  - wrongSlash: of points whose truth has no /X, the share where the result has /X.
 *  - cliche: truth runs of >= 3 consecutive chord segments whose bass pcs (bass ?? root) descend by 1 or 2 semitones
 *    per step; a run is hit when every point inside the run's span has segBass hit. Rate = hit runs / runs (null: none).
 *  - edits (直す手数): operations to turn the result chart into the truth chart on the truth beat grid (one label per
 *    beat, taken at the window midpoint): name (root or vocab quality differs from the result piece that covers the
 *    segment most), slashAdd, slashRemove, slashChange, split (a result piece spans a truth boundary), merge (a truth
 *    segment holds several result pieces: pieces - 1). Reported with the bass stripped from the result as well; the
 *    difference per 100 beats is `editDiff`.
 *  - noteF: bass notes, onset +-50 ms, pitch exact (octave) or pitch class, through ts/hum/score.ts's matcher (checked
 *    against mir_eval.transcription already; the bass check script repeats it on bass-like cases).
 */
import { NOTE_VARIANTS, noteScores, type NoteScore, type ScoreNote } from '../hum/score';
import { fMeasure } from '../drum/score';

export interface ScoreChord {
  start: number;
  end: number;
  root: string;
  quality: string;
  bass?: string | null;
}
export interface ScoreBeat {
  t: number;
  downbeat?: boolean;
}

/* ------------------------------------------------------------ vocabulary (port of py/score.py map_vocab) */

const NOTE_BASE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteToPc(name: string): number {
  const m = /^([A-G])([#b]*)$/.exec(String(name).trim());
  if (!m) throw new Error(`bad note name: ${JSON.stringify(name)}`);
  const acc = [...m[2]].reduce((a, c) => a + (c === '#' ? 1 : -1), 0);
  return (((NOTE_BASE[m[1]] + acc) % 12) + 12) % 12;
}

const POWER = '5';
const VOCAB = ['maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'sus4', 'm7b5', 'dim7', POWER];
const ALTERED_FIFTH = /b5|#5|\+5|-5|aug|\+/;
const HAS_EXT = /^(7|9|11|13)/;
/** Returns a vocabulary quality or null (dropped form). Mirrors py/score.py `map_vocab` branch by branch. */
export function mapVocab(quality: string | null | undefined): string | null {
  if (quality === null || quality === undefined) return null;
  const q = String(quality).trim();
  if (VOCAB.includes(q)) return q;
  const s = q.replace(/[(),\s]/g, '');
  if (s.includes('sus2')) return null;
  if (s.includes('sus')) return 'sus4';
  if (/^(mM|mmaj|minmaj|minM|m\^|mΔ)/.test(s)) return null;
  if (s.slice(0, 3) === 'dim' || s[0] === '°') {
    const rest = s.slice(0, 3) === 'dim' ? s.slice(3) : s.slice(1);
    return HAS_EXT.test(rest) ? 'dim7' : 'dim';
  }
  if (s[0] === 'ø') return 'm7b5';
  if (s.slice(0, 3) === 'aug' || s[0] === '+') {
    const rest = s.slice(0, 3) === 'aug' ? s.slice(3) : s.slice(1);
    return rest === '' ? 'aug' : null;
  }
  if (s.slice(0, 3) === 'maj' || s.slice(0, 3) === 'Maj' || 'MΔ^'.includes(s[0] ?? '\0')) {
    const rest = s.replace(/^(maj|Maj|M|Δ|\^)/, '');
    if (ALTERED_FIFTH.test(rest)) return null;
    return HAS_EXT.test(rest) ? 'maj7' : 'maj';
  }
  if (s.slice(0, 3) === 'min' || 'm-'.includes(s[0] ?? '\0')) {
    const rest = s.replace(/^(min|m|-)/, '');
    if (rest.includes('b5')) return HAS_EXT.test(rest) ? 'm7b5' : 'dim';
    if (rest.includes('#5')) return null;
    return HAS_EXT.test(rest) ? 'min7' : 'min';
  }
  if (s === '' || /^add\d+/.test(s)) return 'maj';
  const m = /^(\d+)/.exec(s);
  if (m) {
    if (ALTERED_FIFTH.test(s)) return null;
    const n = Number(m[1]);
    if ([7, 9, 11, 13].includes(n)) return '7';
    if ([2, 5, 6].includes(n)) return 'maj';
  }
  return null;
}

/* ------------------------------------------------------------ beat grid and chord track (py/score.py) */

const isNoChord = (c: ScoreChord): boolean => c.root === null || c.root === undefined || ['', 'N'].includes(String(c.root).trim());

class ChordTrack {
  readonly chords: ScoreChord[];
  private readonly starts: number[];
  constructor(chords: readonly ScoreChord[]) {
    this.chords = chords.filter((c) => !isNoChord(c)).sort((a, b) => a.start - b.start);
    this.starts = this.chords.map((c) => c.start);
  }
  at(t: number): ScoreChord | null {
    let lo = 0;
    let hi = this.starts.length; // bisect_right
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t < this.starts[mid]) hi = mid;
      else lo = mid + 1;
    }
    const i = lo - 1;
    return i >= 0 && t < this.chords[i].end ? this.chords[i] : null;
  }
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** [start, midpoint, end] per truth beat; the last window is extended by the median interval (py `_beat_windows`). */
export function beatWindows(beats: readonly ScoreBeat[]): [number, number, number][] {
  if (beats.length < 2) throw new Error('need at least 2 beats');
  const ts = beats.map((b) => b.t).sort((a, b) => a - b);
  const med = median(ts.slice(1).map((t, i) => t - ts[i]));
  return ts.map((t, i) => {
    const nxt = i + 1 < ts.length ? ts[i + 1] : t + med;
    return [t, (t + nxt) / 2, nxt];
  });
}
const eighthPoints = (wins: [number, number, number][]): { t: number; beat: number }[] =>
  wins.flatMap((w, beat) => [0.25, 0.75].map((f) => ({ t: w[0] + f * (w[2] - w[0]), beat })));

function bassPc(c: ScoreChord | null): number | null {
  const b = c?.bass;
  if (b === null || b === undefined || String(b).trim() === '') return null;
  try {
    return noteToPc(b);
  } catch {
    return null;
  }
}
const soundingBass = (c: ScoreChord): number => bassPc(c) ?? noteToPc(c.root);

/**
 * T8 decision (docs/audio-spike6-t8.md): a truth `X/X` (bass = root, e.g. `G/G` in a descending-bass template) is not a
 * slash chord: the analyzer never writes a `/X` equal to the root, so such a chord could never be hit. Scoring callers
 * pass the truth through this first. scoreBass itself keeps py/score.py's rule (bassPerBeat counts `X/X` as a `/X`).
 */
export function normalizeTruthSlash(chords: readonly ScoreChord[]): ScoreChord[] {
  return chords.map((c) => (bassPc(c) !== null && bassPc(c) === noteToPc(c.root) ? { ...c, bass: null } : c));
}

/* ------------------------------------------------------------ per-point metrics */

export interface BassScores {
  nPoints: number; // weighted scored points (= 0.5 per point)
  segBass: { scored: number; hit: number; rate: number | null };
  slash: { truthSlash: number; resultSlash: number; hit: number; recall: number | null; precision: number | null; f: number };
  /** === py vocab.bassPerBeat. */
  slashRecall: number | null;
  wrongSlash: { noSlashTruth: number; falseSlash: number; rate: number | null };
  cliche: { runs: number; hit: number; rate: number | null };
}

const ratio = (a: number, b: number): number | null => (b ? a / b : null);

/** Truth runs of >= 3 consecutive segments whose bass descends 1-2 semitones per step; [first, last] chord indexes. */
export function clicheRuns(track: ScoreTrackLike): [number, number][] {
  const bs = track.chords.map(soundingBass);
  const runs: [number, number][] = [];
  let i = 0;
  while (i < bs.length - 1) {
    let j = i;
    while (j + 1 < bs.length && [1, 2].includes((bs[j] - bs[j + 1] + 12) % 12)) j++;
    if (j - i + 1 >= 3) runs.push([i, j]);
    i = Math.max(j, i + 1);
  }
  return runs;
}
type ScoreTrackLike = { chords: ScoreChord[] };

export function scoreBass(truth: readonly ScoreChord[], result: readonly ScoreChord[], beats: readonly ScoreBeat[]): BassScores {
  const tt = new ChordTrack(truth);
  const rt = new ChordTrack(result);
  const pts = eighthPoints(beatWindows(beats));
  const W = 0.5;
  const runs = clicheRuns(tt);
  const runOfChord = new Map<ScoreChord, number>();
  runs.forEach(([a, b], r) => tt.chords.slice(a, b + 1).forEach((c) => runOfChord.set(c, r)));
  const runOk = runs.map(() => true);
  let scored = 0, segHit = 0, truthSlash = 0, resultSlash = 0, slashHit = 0, noSlash = 0, falseSlash = 0;
  for (const { t } of pts) {
    const tc = tt.at(t);
    if (!tc || mapVocab(tc.quality) === null) continue;
    scored += W;
    const rc = rt.at(t);
    const tb = bassPc(tc);
    const rb = bassPc(rc);
    const hit = rc !== null && soundingBass(rc) === soundingBass(tc);
    if (hit) segHit += W;
    const r = runOfChord.get(tc);
    if (r !== undefined && !hit) runOk[r] = false;
    if (rb !== null) resultSlash += W;
    if (tb !== null) {
      truthSlash += W;
      if (rb === tb) slashHit += W;
    } else {
      noSlash += W;
      if (rb !== null) falseSlash += W;
    }
  }
  const recall = ratio(slashHit, truthSlash);
  const precision = ratio(slashHit, resultSlash);
  return {
    nPoints: scored,
    segBass: { scored, hit: segHit, rate: ratio(segHit, scored) },
    slash: { truthSlash, resultSlash, hit: slashHit, recall, precision, f: recall && precision ? fMeasure(precision, recall) : 0 },
    slashRecall: recall,
    wrongSlash: { noSlashTruth: noSlash, falseSlash, rate: ratio(falseSlash, noSlash) },
    cliche: { runs: runs.length, hit: runOk.filter(Boolean).length, rate: ratio(runOk.filter(Boolean).length, runs.length) },
  };
}

/* ------------------------------------------------------------ edit counts (直す手数) */

export interface EditCounts {
  name: number;
  slashAdd: number;
  slashRemove: number;
  slashChange: number;
  split: number;
  merge: number;
  total: number;
  nBeats: number;
}
interface Label {
  root: number;
  q: string | null;
  bass: number | null;
  piece: number;
}

/** Operations to turn `result` into `truth` on the truth beat grid. Beats with no truth chord or a dropped truth quality are skipped. */
export function editCounts(truth: readonly ScoreChord[], result: readonly ScoreChord[], beats: readonly ScoreBeat[]): EditCounts {
  const tt = new ChordTrack(truth);
  const rt = new ChordTrack(result);
  const tl: { root: number; q: string; bass: number | null }[] = [];
  const rl: (Label | null)[] = [];
  let piece = -1;
  let prevKey: string | null = null;
  for (const w of beatWindows(beats)) {
    const tc = tt.at(w[1]);
    const tq = tc ? mapVocab(tc.quality) : null;
    if (!tc || tq === null) continue;
    tl.push({ root: noteToPc(tc.root), q: tq, bass: bassPc(tc) });
    const rc = rt.at(w[1]);
    if (!rc) {
      rl.push(null);
      prevKey = null;
      continue;
    }
    const l = { root: noteToPc(rc.root), q: mapVocab(rc.quality), bass: bassPc(rc) };
    const key = `${l.root}|${l.q}|${l.bass}`;
    if (key !== prevKey) piece++;
    prevKey = key;
    rl.push({ ...l, piece });
  }
  const c: EditCounts = { name: 0, slashAdd: 0, slashRemove: 0, slashChange: 0, split: 0, merge: 0, total: 0, nBeats: tl.length };
  // truth segments: consecutive equal labels
  let i = 0;
  while (i < tl.length) {
    let j = i;
    const k = (x: (typeof tl)[number]): string => `${x.root}|${x.q}|${x.bass}`;
    while (j + 1 < tl.length && k(tl[j + 1]) === k(tl[i])) j++;
    // pieces inside the segment (null = a gap, its own piece per run)
    const counts = new Map<number, { n: number; l: Label | null }>();
    let gapRun = -1;
    let prevNull = false;
    for (let b = i; b <= j; b++) {
      const l = rl[b];
      const id = l ? l.piece : prevNull ? gapRun : (gapRun = -1000 - b);
      prevNull = !l;
      const e = counts.get(id) ?? { n: 0, l };
      e.n++;
      counts.set(id, e);
    }
    c.merge += counts.size - 1;
    const dom = [...counts.values()].reduce((a, b) => (b.n > a.n ? b : a));
    const t = tl[i];
    if (!dom.l || dom.l.root !== t.root || dom.l.q !== t.q) c.name++;
    const rb = dom.l ? dom.l.bass : null;
    if (t.bass === null && rb !== null) c.slashRemove++;
    else if (t.bass !== null && rb === null) c.slashAdd++;
    else if (t.bass !== null && rb !== t.bass) c.slashChange++;
    // the result piece continues over the boundary to the next truth segment: one split
    if (j + 1 < tl.length && rl[j] && rl[j + 1] && rl[j]!.piece === rl[j + 1]!.piece) c.split++;
    i = j + 1;
  }
  c.total = c.name + c.slashAdd + c.slashRemove + c.slashChange + c.split + c.merge;
  return c;
}

const stripBass = (cs: readonly ScoreChord[]): ScoreChord[] => cs.map((c) => ({ ...c, bass: null }));

export interface EditDiff {
  withBass: EditCounts;
  withoutBass: EditCounts;
  /** (without - with) / nBeats * 100; positive = the bass analysis saves edits. null without scored beats. */
  savedPer100Beats: number | null;
}
export function editDiff(truth: readonly ScoreChord[], result: readonly ScoreChord[], beats: readonly ScoreBeat[]): EditDiff {
  const withBass = editCounts(truth, result, beats);
  const withoutBass = editCounts(truth, stripBass(result), beats);
  return { withBass, withoutBass, savedPer100Beats: withBass.nBeats ? ((withoutBass.total - withBass.total) / withBass.nBeats) * 100 : null };
}

/* ------------------------------------------------------------ bass notes (B-4) */

export interface BassNoteScores {
  /** pitch exact within 50 cents (octave counts) */
  octave: NoteScore;
  /** octave ignored (pitch class) */
  pitchClass: NoteScore;
}
export function bassNoteScores(ref: ScoreNote[], est: ScoreNote[]): BassNoteScores {
  return {
    octave: noteScores(ref, est, NOTE_VARIANTS.onset),
    pitchClass: noteScores(ref, est, NOTE_VARIANTS.onsetPitchClass),
  };
}

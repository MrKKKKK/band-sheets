/**
 * Spike 6 T10: root re-decision from the bass (docs/audio-spike6-plan.md section 3 decision 6, switch
 * `cliche.redecideRoot`, default OFF; docs/audio-spike6-t10.md).
 *
 * The frozen analyzer reads chroma with the bass in it, so it tends to make the bass note the root (`C/E` read as
 * `Em`, `G/B` as `Bm`) or to keep a minor chord over its relative major's root (`C` read as `Am` with C in the bass).
 * Two triads a third apart share two notes (the relative / mediant pairs: C - Am, C - Em); when the bass is one of the
 * shared notes the bass cannot tell them apart, but the notes above it can. Rule, per segment with a maj / min triad
 * and a bass at `slash.minConfidence` or more:
 *  - alternatives: the two third-related triads of the other mode (maj X: X-3 min, X+4 min; min X: X+3 maj, X-4 maj)
 *    that contain the bass as a SHARED note;
 *  - evidence: the alternative's own note against the note it drops, in the treble chroma (rows from C3 = MIDI 48 up)
 *    of the segment's mean spectrum after the bass note's harmonics h = 1..8 are subtracted. Without that, the bass's
 *    3rd and 6th harmonics (its 5th) and 5th harmonic (its major 3rd) make the chord on the bass win again (on the
 *    tuning split the plain treble chroma read a slash chord's bass as the root in 2 of 3 chords). Each harmonic is
 *    subtracted with spectral smoothness (Klapuri 2003): at most the mean of its two neighbouring harmonics, so a piano
 *    note on the same semitone is mostly kept. The alternative wins when the ratio is >= `redecideRatio` (best first).
 * Root and quality change; `text` is rebuilt (the v1a `?` is kept), `confidence` and v1a's `candidates` stay, so the v1a
 * reading is still the first candidate a reader can offer back. Sevenths and other qualities are left alone (`Am7` vs
 * `C/A` is a reading choice for the user, plan section 8 G2). Ground truth is never read here. No network.
 */
import { chordName, NOTE_NAMES } from '../dsp/chords';
import type { BassConfig } from './config';
import type { LowCqt } from './lowCqt';
import type { SegmentBass, SegmentSpan } from './segmentBass';

/** Lowest MIDI note read as treble (C3; below it the bass and the piano left hand). */
export const TREBLE_LO_MIDI = 48;
/** Harmonics of the bass subtracted before the treble chroma is read. */
export const BASS_HARMONICS = 8;

export interface Triad {
  root: number;
  quality: 'maj' | 'min';
}
interface Alt extends Triad {
  /** the alternative's note that the original triad lacks / the original's note it drops */
  gained: number;
  dropped: number;
}
const pc = (x: number): number => ((x % 12) + 12) % 12;
const tones = (t: Triad): number[] => [t.root, pc(t.root + (t.quality === 'maj' ? 4 : 3)), pc(t.root + 7)];

/** The two third-related triads of the other mode, with the note each gains and drops. */
export function thirdRelated(t: Triad): Alt[] {
  const x = t.root;
  return t.quality === 'maj'
    ? [
        { root: pc(x - 3), quality: 'min', gained: pc(x - 3), dropped: pc(x + 7) },
        { root: pc(x + 4), quality: 'min', gained: pc(x + 11), dropped: x },
      ]
    : [
        { root: pc(x + 3), quality: 'maj', gained: pc(x + 10), dropped: x },
        { root: pc(x - 4), quality: 'maj', gained: pc(x - 4), dropped: pc(x + 7) },
      ];
}

/** Segment mean per semitone row over [start, end). */
function rowMeans(low: LowCqt, seg: SegmentSpan): Float64Array {
  const m = new Float64Array(low.nSemis);
  const f0 = Math.max(0, Math.round(seg.start / low.frameSec));
  const f1 = Math.min(low.cols, Math.max(f0 + 1, Math.round(seg.end / low.frameSec)));
  for (let r = 0; r < low.nSemis; r++) {
    let s = 0;
    for (let t = f0; t < f1; t++) s += low.semi[r * low.cols + t];
    m[r] = s / Math.max(1, f1 - f0);
  }
  return m;
}

/**
 * Treble chroma of [start, end) with the bass note (MIDI `bassMidi`) taken out: the mean spectrum minus each harmonic
 * h = 1..BASS_HARMONICS (row bassMidi + round(12 log2 h)), at most min(own value, mean of the neighbouring harmonics),
 * then summed per pitch class over the rows from TREBLE_LO_MIDI up.
 */
export function trebleChroma(low: LowCqt, seg: SegmentSpan, bassMidi: number): Float64Array {
  const m = rowMeans(low, seg);
  const rows = Array.from({ length: BASS_HARMONICS }, (_, k) => bassMidi - low.midi0 + Math.round(12 * Math.log2(k + 1)));
  const a = rows.map((r) => (r >= 0 && r < low.nSemis ? m[r] : 0));
  rows.forEach((r, k) => {
    if (r < 0 || r >= low.nSemis) return;
    const nb = k === 0 ? a[1] : k === rows.length - 1 ? a[k - 1] : (a[k - 1] + a[k + 1]) / 2;
    m[r] = Math.max(0, m[r] - Math.min(a[k], nb));
  });
  const out = new Float64Array(12);
  for (let r = Math.max(0, TREBLE_LO_MIDI - low.midi0); r < low.nSemis; r++) out[pc(low.midi0 + r)] += m[r];
  return out;
}

/** The re-decided triad of one segment, or null (keep v1a's). */
export function redecide(t: Triad, bass: Pick<SegmentBass, 'pc' | 'confidence'>, chroma: ArrayLike<number>, cfg: Pick<BassConfig, 'slash' | 'cliche'>): Triad | null {
  if (t.quality !== 'min' || bass.confidence < cfg.slash.minConfidence) return null;
  let best: Triad | null = null;
  let bestRatio = cfg.cliche.redecideRatio;
  for (const a of thirdRelated(t)) {
    if (!tones(a).includes(bass.pc) || !tones(t).includes(bass.pc)) continue;
    const ratio = chroma[a.gained] / Math.max(chroma[a.dropped], 1e-12);
    if (ratio >= bestRatio) {
      best = { root: a.root, quality: a.quality };
      bestRatio = ratio;
    }
  }
  return best;
}

export interface RedecideChord extends SegmentSpan {
  root: string;
  quality: string;
  text?: string;
}

/** Chords with re-decided roots (same objects where nothing changed). */
export function redecideRoots<C extends RedecideChord>(low: LowCqt, chords: readonly C[], bass: readonly SegmentBass[], cfg: Pick<BassConfig, 'slash' | 'cliche'>): C[] {
  return chords.map((c, i) => {
    if (c.quality !== 'maj' && c.quality !== 'min') return c;
    const rootPc = (NOTE_NAMES as readonly string[]).indexOf(c.root);
    if (rootPc < 0) throw new Error(`bass: unexpected chord root ${JSON.stringify(c.root)}`);
    const t = redecide({ root: rootPc, quality: c.quality }, bass[i], trebleChroma(low, c, bass[i].midi), cfg);
    if (!t) return c;
    const root = NOTE_NAMES[t.root];
    const text = c.text === undefined ? undefined : `${chordName(t.root, t.quality)}${c.text.endsWith('?') ? '?' : ''}`;
    return { ...c, root, quality: t.quality, ...(text === undefined ? {} : { text }) };
  });
}

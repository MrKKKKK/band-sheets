/**
 * Chord vocabulary (port of py/dsp/vocab.py, default path only: vocab 'v1' | 'v2', no power chords).
 *
 *   states(cfg)  -> [{root, quality}] in the order the decoder and the posterior rows use
 *   intervals(q) / suffix(q) / moveStates(cfg)
 *   gateScores(s, unit, states, cfg)  v2 weighting / "clear win only" gate (in place)
 *
 * Score matrices are row-major Float64Array [nStates, n] (state-major, like numpy (S, N)).
 */

export interface VocabConfig {
  vocab: 'v1' | 'v2';
  use_seventh: boolean;
  power: boolean;
  vocab_weight: number;
  vocab_margin: number;
  vocab_sus4_margin: number;
}

export interface ChordState {
  root: number;
  quality: string;
}

const INTERVALS: Record<string, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus4: [0, 5, 7],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  '5': [0, 7],
};
const SUFFIX: Record<string, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
  dim: 'dim',
  aug: 'aug',
  sus4: 'sus4',
  m7b5: 'm7b5',
  dim7: 'dim7',
  '5': '5',
};
const TRIADS = ['maj', 'min'];
const SEVENTHS = ['7', 'maj7', 'min7'];
const EXTRA_TRIADS = ['dim', 'aug', 'sus4'];
const EXTRA_SEVENTHS = ['m7b5', 'dim7'];
const EXTRA = new Set([...EXTRA_TRIADS, ...EXTRA_SEVENTHS]);
const SYMMETRIC = new Set(['aug', 'dim7']);
const ROOT_TIE = 1e-3; // only breaks exact template ties
const VOCABS = ['v1', 'v2'];

export function states(cfg: VocabConfig): ChordState[] {
  if (!VOCABS.includes(cfg.vocab)) throw new Error(`unknown chords.vocab: ${String(cfg.vocab)}`);
  if (cfg.power) throw new Error('chords.power is not supported by the TS port (default path only)');
  let quals = [...TRIADS, ...(cfg.use_seventh ? SEVENTHS : [])];
  if (cfg.vocab === 'v2') quals = [...quals, ...EXTRA_TRIADS, ...(cfg.use_seventh ? EXTRA_SEVENTHS : [])];
  const out: ChordState[] = [];
  for (const quality of quals) for (let root = 0; root < 12; root++) out.push({ root, quality });
  return out;
}

export function intervals(quality: string): readonly number[] {
  const iv = INTERVALS[quality];
  if (!iv) throw new Error(`unknown quality: ${quality}`);
  return iv;
}

export function suffix(quality: string): string {
  const s = SUFFIX[quality];
  if (s === undefined) throw new Error(`unknown quality: ${quality}`);
  return s;
}

/** State count the move probability is split over: the v1 count for every vocab. */
export function moveStates(cfg: VocabConfig): number {
  return 12 * (TRIADS.length + (cfg.use_seventh ? SEVENTHS.length : 0));
}

export function isExtra(quality: string): boolean {
  return EXTRA.has(quality);
}

/**
 * v2 weighting / gate, in place on `s` ([nStates, n]); `unit` is the unit-norm chroma [12, n].
 * Returns the mask (1 = masked). 'v1' (or no extra state): s untouched, nothing masked.
 */
export function gateScores(
  s: Float64Array,
  unit: Float64Array,
  sts: readonly ChordState[],
  n: number,
  cfg: VocabConfig,
): Uint8Array {
  const k = sts.length;
  const masked = new Uint8Array(k * n);
  const extra = sts.map((st) => EXTRA.has(st.quality));
  const nExtra = extra.filter(Boolean).length;
  if (cfg.vocab === 'v1' || nExtra === 0 || nExtra === k) return masked;
  for (let i = 0; i < k; i++) {
    if (SYMMETRIC.has(sts[i].quality)) {
      const r = sts[i].root;
      for (let t = 0; t < n; t++) s[i * n + t] += ROOT_TIE * unit[r * n + t];
    }
  }
  for (let t = 0; t < n; t++) {
    let bestBase = -Infinity;
    for (let i = 0; i < k; i++) if (!extra[i]) bestBase = Math.max(bestBase, s[i * n + t]);
    for (let i = 0; i < k; i++) {
      if (!extra[i]) continue;
      const se = s[i * n + t] * cfg.vocab_weight;
      const margin = sts[i].quality === 'sus4' ? cfg.vocab_sus4_margin : cfg.vocab_margin;
      const ok = se >= bestBase + margin;
      s[i * n + t] = ok ? se : 0;
      masked[i * n + t] = ok ? 0 : 1;
    }
  }
  return masked;
}

/**
 * Downbeat phase by rule (port of py/dsp/downbeat.py, default path; no learned model).
 *
 * Inputs in the default config (hash adec583eb3c6): beat-level chords with margin confidence
 * (`downbeatChords` from chords.ts, the port of Python's `downbeat_chords`: a beat-level *margin* chord
 * pass over beat_chroma, run by analyze.ts and passed in; the parity test feeds the dumped
 * downbeat_chords_{root,quality,confidence}), the per-beat bass chroma (beat_bass, 12 x n), the onset
 * envelope (onset_env) and the beat times (beat_times).
 *
 * Matches numpy where it matters: ties are decided with the same 1e-9 band, argmax-free.
 */

const EPS = 1e-12;
const TIE = 1e-9;
const BASS_SILENT = 0.05;

export interface DownbeatConfig {
  beats_per_bar: number;
  w_chord_change: number;
  w_bass: number;
  w_onset: number;
  tie_break_phase: number;
  chord_conf_floor: number;
  same_root_change: number;
  anticipation_shift: number;
}

export const DEFAULT_DOWNBEAT_CONFIG: DownbeatConfig = {
  beats_per_bar: 4,
  w_chord_change: 1.0,
  w_bass: 0.5,
  w_onset: 0.5,
  tie_break_phase: 0,
  chord_conf_floor: 0.3,
  same_root_change: 0.5,
  anticipation_shift: 1.0,
};

export interface Downbeats {
  phase: number;
  beatsPerBar: number;
  confidence: number;
  scores: number[];
}

export interface DownbeatChord {
  root: number | null;
  quality: string;
  confidence: number;
}

/** Per-beat chord-change evidence (entry i = change from beat i-1 to i). */
export function chordChangeStrength(
  roots: readonly (number | null)[],
  qualities: readonly string[] | null,
  confidences: ArrayLike<number> | null,
  cfg: DownbeatConfig = DEFAULT_DOWNBEAT_CONFIG,
): Float64Array {
  const n = roots.length;
  const q = qualities ?? new Array<string>(n).fill('maj');
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = confidences === null ? 1 : Math.min(1, Math.max(0, confidences[i]));
  const out = new Float64Array(n);
  const floor = cfg.chord_conf_floor;
  const same = (a: number, b: number) => roots[a] === roots[b] && q[a] === q[b];
  for (let i = 1; i < n; i++) {
    const a = roots[i - 1];
    const b = roots[i];
    if (a === null || b === null || (a === b && q[i - 1] === q[i])) continue;
    const kind = a === b ? cfg.same_root_change : 1.0;
    let oldConf = c[i - 1];
    if (i >= 2 && same(i - 2, i - 1)) oldConf = Math.max(oldConf, c[i - 2]);
    let newConf = c[i];
    const nxt = i + 1 < n && same(i, i + 1);
    if (nxt) newConf = Math.max(newConf, c[i + 1]);
    const w = kind * (floor + (1.0 - floor) * Math.min(oldConf, newConf));
    let frac = 0.0;
    if (nxt && cfg.anticipation_shift > 0 && c[i + 1] > c[i]) {
      frac = Math.min(1.0, cfg.anticipation_shift * (1.0 - c[i] / Math.max(c[i + 1], EPS)));
    }
    out[i] += w * (1.0 - frac);
    if (frac > 0) out[i + 1] += w * frac;
  }
  return out;
}

/** Per-beat bass evidence from bass chroma (row-major [12, n]); null when n == 0. */
export function bassChangeStrength(bass: ArrayLike<number> | null, n: number): Float64Array | null {
  if (bass === null || n === 0) return null;
  const energy = new Float64Array(n);
  const nrm = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let e = 0;
    let s = 0;
    for (let j = 0; j < 12; j++) {
      const v = bass[j * n + t];
      e += v;
      s += v * v;
    }
    energy[t] = e;
    nrm[t] = Math.max(Math.sqrt(s), EPS);
  }
  let emax = -Infinity;
  for (let t = 0; t < n; t++) emax = Math.max(emax, energy[t]);
  const out = new Float64Array(n);
  if (emax <= EPS) return out;
  for (let i = 1; i < n; i++) {
    let cosdist = 0.0;
    if (energy[i] > BASS_SILENT * emax && energy[i - 1] > BASS_SILENT * emax) {
      let dot = 0;
      for (let j = 0; j < 12; j++) dot += (bass[j * n + i] / nrm[i]) * (bass[j * n + i - 1] / nrm[i - 1]);
      cosdist = Math.min(1, Math.max(0, 1.0 - dot));
    }
    const rise = Math.max(0.0, energy[i] - energy[i - 1]) / emax;
    out[i] = 0.5 * cosdist + 0.5 * rise;
  }
  return out;
}

/** Max of the onset envelope within +-radius frames of each beat time. */
export function beatOnsetStrength(
  onsetEnv: ArrayLike<number> | null,
  times: ArrayLike<number>,
  sr: number,
  hop: number,
  radius = 2,
): Float64Array | null {
  if (onsetEnv === null || onsetEnv.length === 0) return null;
  const out = new Float64Array(times.length);
  for (let k = 0; k < times.length; k++) {
    const f = Math.floor((times[k] * sr) / hop + 0.5);
    const lo = Math.max(0, f - radius);
    const hi = Math.min(onsetEnv.length, f + radius + 1);
    if (lo < hi) {
      let m = -Infinity;
      for (let i = lo; i < hi; i++) m = Math.max(m, onsetEnv[i]);
      out[k] = m;
    }
  }
  return out;
}

function phaseShare(x: Float64Array, active: Uint8Array, bpb: number): Float64Array | null {
  const means = new Float64Array(bpb);
  for (let p = 0; p < bpb; p++) {
    let s = 0;
    let cnt = 0;
    for (let i = p; i < x.length; i += bpb) {
      if (active[i]) {
        s += Math.max(x[i], 0);
        cnt++;
      }
    }
    if (cnt > 0) means[p] = s / cnt;
  }
  let total = 0;
  for (let p = 0; p < bpb; p++) total += means[p];
  if (total <= EPS) return null;
  return means.map((m) => m / total);
}

function pick(scores: Float64Array, tiePhase: number): { phase: number; confidence: number } {
  let best = -Infinity;
  for (const s of scores) best = Math.max(best, s);
  const tied: number[] = [];
  for (let p = 0; p < scores.length; p++) if (best - scores[p] <= TIE) tied.push(p);
  if (tied.length > 1) return { phase: tied.includes(tiePhase) ? tiePhase : tied[0], confidence: 0 };
  const phase = tied[0];
  let second = -Infinity;
  for (let p = 0; p < scores.length; p++) if (p !== phase) second = Math.max(second, scores[p]);
  if (second === -Infinity) second = best;
  return { phase, confidence: Math.min(1, Math.max(0, best - second)) };
}

/** Score every phase from plain per-beat arrays (each length nBeats or null). */
export function estimateDownbeats(
  nBeats: number,
  chordChange: Float64Array | null,
  bassChange: Float64Array | null,
  onset: Float64Array | null,
  cfg: DownbeatConfig = DEFAULT_DOWNBEAT_CONFIG,
  active: Uint8Array | null = null,
): Downbeats {
  const bpb = Math.max(1, Math.trunc(cfg.beats_per_bar));
  const tiePhase = cfg.tie_break_phase >= 0 && cfg.tie_break_phase < bpb ? cfg.tie_break_phase : 0;
  const feats: [number, Float64Array][] = [];
  for (const [w, x] of [
    [cfg.w_chord_change, chordChange],
    [cfg.w_bass, bassChange],
    [cfg.w_onset, onset],
  ] as const) {
    if (x === null) continue;
    if (x.length !== nBeats) throw new Error(`feature length ${x.length} != n_beats ${nBeats}`);
    feats.push([w, x.map((v) => (Number.isNaN(v) ? 0 : v))]);
  }
  const wTotal = cfg.w_chord_change + cfg.w_bass + cfg.w_onset;
  const scores = new Float64Array(bpb);
  if (nBeats >= bpb && feats.length > 0 && wTotal > 0) {
    let act: Uint8Array;
    if (active === null) {
      act = new Uint8Array(nBeats);
      let first = -1;
      let last = -1;
      for (let i = 0; i < nBeats; i++) {
        if (feats.some(([, x]) => x[i] > 0)) {
          if (first < 0) first = i;
          last = i;
        }
      }
      if (first >= 0) for (let i = Math.max(0, first - 1); i <= last; i++) act[i] = 1;
    } else act = active;
    for (const [w, x] of feats) {
      const share = phaseShare(x, act, bpb);
      if (share !== null && w > 0) for (let p = 0; p < bpb; p++) scores[p] += w * (share[p] - 1.0 / bpb);
    }
    for (let p = 0; p < bpb; p++) scores[p] /= wTotal;
  }
  const { phase, confidence } = pick(scores, tiePhase);
  return { phase, beatsPerBar: bpb, confidence, scores: Array.from(scores) };
}

export interface ChooseInputs {
  chords: readonly DownbeatChord[] | null;
  /** row-major [12, n] beat bass chroma, or null */
  bass: ArrayLike<number> | null;
  onsetEnv: ArrayLike<number> | null;
  beatTimes: ArrayLike<number>;
  sr: number;
  hop: number;
}

/** Pipeline adapter (choose_downbeats). */
export function chooseDownbeats(inp: ChooseInputs, cfg: DownbeatConfig = DEFAULT_DOWNBEAT_CONFIG): Downbeats {
  const n = inp.beatTimes.length;
  let chordChange: Float64Array | null = null;
  const chords = inp.chords;
  if (chords !== null && chords.length > 0) {
    if (chords.length !== n) throw new Error(`${chords.length} chords for ${n} beats`);
    chordChange = chordChangeStrength(
      chords.map((c) => c.root),
      chords.map((c) => c.quality),
      chords.map((c) => c.confidence),
      cfg,
    );
  }
  const bassChange = bassChangeStrength(inp.bass, n);
  const onset = beatOnsetStrength(inp.onsetEnv, inp.beatTimes, inp.sr, inp.hop);
  const active = new Uint8Array(n);
  if (chords !== null && chords.length === n) chords.forEach((c, i) => c.root !== null && (active[i] = 1));
  if (inp.bass !== null && n > 0) {
    const e = new Float64Array(n);
    let emax = -Infinity;
    for (let t = 0; t < n; t++) {
      for (let j = 0; j < 12; j++) e[t] += inp.bass[j * n + t];
      emax = Math.max(emax, e[t]);
    }
    if (emax > EPS) for (let t = 0; t < n; t++) if (e[t] > BASS_SILENT * emax) active[t] = 1;
  }
  if (onset !== null) {
    let omax = -Infinity;
    for (const v of onset) omax = Math.max(omax, v);
    if (omax > EPS) for (let t = 0; t < n; t++) if (onset[t] > BASS_SILENT * omax) active[t] = 1;
  }
  return estimateDownbeats(n, chordChange, bassChange, onset, cfg, active);
}

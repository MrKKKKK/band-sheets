/**
 * Spike 7 T7: the v1a front end up to the per-bar keys, kept in pieces so the chords2 chord stage (plan §2.0, decision U1)
 * can be run on the same beats / chroma / keys at every stage. ts/dsp/analyze.ts does not hand out the per-column chroma
 * (`cols.cChroma`), so its stage order is repeated here (load -> beats -> chroma -> chords 1st pass -> downbeat -> merge ->
 * sections -> keytrack); baseline.ts checks that chords2 at V0 on this front end equals the frozen `analyze()` result
 * chord for chord (v0Same), so a drift between this copy and analyze.ts shows up. ts/dsp is read only.
 */
import { loadFeatures } from '../../dsp/audio';
import { trackBeats } from '../../dsp/beats';
import { beatLevel, DEFAULT_CHORDS_CONFIG, downbeatChords, estimateChords, mergeSegments, NOTE_NAMES, type ChordSegment } from '../../dsp/chords';
import { aggregate, chordColumns, columnTimes, DEFAULT_CHROMA_CONFIG } from '../../dsp/chroma';
import { MemTracker } from '../../dsp/core/mem';
import { chooseDownbeats, DEFAULT_DOWNBEAT_CONFIG } from '../../dsp/downbeat';
import { DEFAULT_KEY_CONFIG, estimate as keytrackEstimate, type BarKey } from '../../dsp/keytrack';
import { findSections, DEFAULT_SECTIONS_CONFIG } from '../../dsp/sections';
import { tempoEventTimes } from '../../dsp/tempo';
import type { Chords2Input } from '../analyze';
import type { EvalChord } from './score';

export interface FrontEnd {
  /** beat times (s) and the audio length (s) */
  times: Float64Array;
  duration: number;
  /** what chords2 `analyze` needs */
  input: Chords2Input;
  /** wall time of the front end (ms) and the tracker's peak (bytes) */
  ms: number;
  memPeak: number;
}

/** 22,050 Hz mono `y` (not changed) -> the pieces of v1a before its 2nd chord pass. */
export function frontEnd(y: Float32Array, now: () => number = () => performance.now()): FrontEnd {
  const t0 = now();
  const mem = new MemTracker();
  const ccfg = DEFAULT_CHORDS_CONFIG;
  const feat = loadFeatures(y, mem);
  const { sr, hop, duration } = feat;
  const grid = trackBeats({ onsetEnv: feat.onsetEnv, yPerc: feat.yPerc, sr, hop, mem }, () => tempoEventTimes({ onsetEnv: feat.onsetEnv, yHarm: feat.yHarm, sr, hop }, mem));
  const times = grid.times as Float64Array;
  const nb = times.length;
  if (nb < 2) throw new Error('frontEnd: fewer than 2 beats');
  const cols = chordColumns(feat.yHarm, times, duration, {}, mem);
  const pb = cols.perBeat;
  const nc = cols.cChroma.length / 12;
  const colChords = estimateChords(cols.cChroma, nc, ccfg, { perBeat: pb });
  const beatChords = beatLevel(colChords, pb);
  const downbeats = chooseDownbeats({ chords: downbeatChords(cols.chroma, nb, ccfg), bass: cols.bass, onsetEnv: feat.onsetEnv, beatTimes: times, sr, hop }, DEFAULT_DOWNBEAT_CONFIG);
  mergeSegments(colChords, ccfg, pb); // analyze's 'merge' stage (no effect on the keys; kept so the stage list is the same)
  const sections = findSections(
    { chroma: cols.chroma, bass: cols.bass, nBeats: nb, beatTimes: times, phase: downbeats.phase, beatsPerBar: downbeats.beatsPerBar, y: feat.y, yPerc: feat.yPerc, sr, duration },
    DEFAULT_SECTIONS_CONFIG,
  );
  const barOfBeat = new Int32Array(nb);
  for (let i = 0; i < nb; i++) barOfBeat[i] = Math.floor((i - downbeats.phase) / downbeats.beatsPerBar);
  const kt = keytrackEstimate(beatChords, barOfBeat, sections.map((s) => s.startBar), DEFAULT_KEY_CONFIG);
  const barKeys: BarKey[] = kt.keys;
  // T8 (M1): the bass-band chroma per chord column, aggregated like cChroma (same column bounds, v1a's own rule)
  const bassChroma = aggregate(cols.frames.bass, cols.frames.bassFrames, cols.cBounds, DEFAULT_CHROMA_CONFIG.aggregate);
  return { times, duration, input: { chroma: cols.cChroma, n: nc, perBeat: pb, barKeys, barOfBeat, bassChroma }, ms: now() - t0, memPeak: mem.peak };
}

/** chords2 segments -> chords the scorer reads (ts/dsp/result.ts buildResult's times and names; no-chord segments omitted). */
export function toEvalChords(segs: readonly ChordSegment[], times: ArrayLike<number>, duration: number): EvalChord[] {
  const n = times.length;
  const bt = (i: number): number => (i >= 0 && i < n ? times[i] : duration);
  const cts = new Map<number, Float64Array>();
  const ct = (c: number, pb: number): number => {
    let a = cts.get(pb);
    if (!a) cts.set(pb, (a = columnTimes(times, duration, pb)));
    return c >= 0 && c < a.length ? a[c] : duration;
  };
  const out: EvalChord[] = [];
  for (const s of segs) {
    if (s.root === null) continue;
    out.push({
      start: s.perBeat === 1 ? bt(s.startBeat) : ct(s.startBeat, s.perBeat),
      end: s.perBeat === 1 ? bt(s.endBeat) : ct(s.endBeat, s.perBeat),
      root: NOTE_NAMES[s.root % 12],
      quality: s.quality,
      bass: s.bass !== null ? NOTE_NAMES[s.bass % 12] : null,
      candidates: s.candidates.map((c) => ({ root: NOTE_NAMES[c.root % 12], quality: c.quality })),
    });
  }
  return out;
}

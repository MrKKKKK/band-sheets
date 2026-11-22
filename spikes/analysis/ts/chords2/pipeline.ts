/**
 * NOT ADOPTED (G2 / G3, 2026-11-22): the pair rule and the V1 stage are kept as switches; the app takes spike 6's bass
 * config (config.ts appBassConfig) only. This file is the ONE place the identical-pair rule is applied (analyze()
 * refuses `pairRule` on), so a config's `pairRule` value says which rule a row ran.
 *
 * Spike 7 T10: the stages after the chords2 chord stage for the adopted bass config (G2, user 2026-11-22: none of
 * M1-M3; spike 6's G2-default bass stage on the chords2 segments), in this order (docs/audio-spike7-t10.md):
 *
 *   chords2 analyze (pairRule 'off') -> spike 6 marks (`marksOnV2`) -> identical-pair rule (`pairsAfterBass`)
 *
 * so the pair rule sees the `/X` the bass stage wrote (T8's open ordering issue). Also the "new qualities as
 * candidates only" output (`asCandidatesOnly`, the stop-rule path of plan §5 / G1 decision 6).
 *
 * Why a proxy quality in `marksOnV2`: spike 6's slash rules read a chord's tones with v1a's `intervals()` (ts/bass is
 * frozen), which has no entry for the new qualities. The marks therefore see a new quality as its family (vocab.ts
 * FAMILY_OF: mM7 / m6 -> min, 6 -> maj); its added tone (7th / 6th) in the bass is then explained only as a pedal, a
 * passing bass or the line-end 6th (slash.ts), not as an inversion. The chord gets its own quality back unless spike 6's
 * root re-decision changed the reading (then the bass stage's triad stays).
 * No ground truth is read here. No network: computation only.
 */
import { bassChords, type V1aChord } from '../bass/analyze';
import type { BassConfig } from '../bass/config';
import type { LowCqt } from '../bass/lowCqt';
import { segmentBass } from '../bass/segmentBass';
import { NOTE_NAMES } from '../dsp/chords';
import type { BarKey } from '../dsp/keytrack';
import type { CandidateName } from './candidates';
import type { PairRule } from './config';
import { resolvePairs, type PairSegment } from './pairRule';
import { familyOf, newQualities, STAGE_ADDS, type Stage } from './vocab';

/** A timed chord as the eval tools carry it (frontEnd.ts toEvalChords; `candidates` = pair reading first, then top-k). */
export interface TimedChord extends V1aChord {
  candidates?: CandidateName[];
}

const V0 = new Set<string>(STAGE_ADDS.V0);
const pcOf = (name: string): number => {
  const pc = (NOTE_NAMES as readonly string[]).indexOf(name);
  if (pc < 0) throw new Error(`chords2 pipeline: unexpected note name ${JSON.stringify(name)}`);
  return pc;
};

/** The v1a quality a quality is shown to v1a-only code as (itself for a v1a quality; else its single family). */
export function proxyQuality(quality: string): string {
  if (V0.has(quality)) return quality;
  const fam = familyOf(quality);
  if (fam.length !== 1) throw new Error(`chords2 pipeline: ${quality} has no single family (${fam.join(', ')}); decide its proxy first (T11)`);
  return fam[0];
}

/** Spike 6's bass stage (`bassChords`, called, not changed) on chords2 chords, new qualities through their proxy (header). */
export function marksOnV2<C extends TimedChord>(low: LowCqt, chords: readonly C[], beats: readonly number[], marks: BassConfig): C[] {
  type Tagged = C & { v2Orig?: { root: string; quality: string; proxy: string } };
  const tagged: Tagged[] = chords.map((c) => {
    const proxy = proxyQuality(c.quality);
    return proxy === c.quality ? c : { ...c, quality: proxy, v2Orig: { root: c.root, quality: c.quality, proxy } };
  });
  return bassChords(low, tagged, beats, marks).map((c) => {
    const { v2Orig, ...rest } = c as Tagged;
    if (!v2Orig) return c as C;
    const kept = rest.root === v2Orig.root && rest.quality === v2Orig.proxy;
    return { ...rest, quality: kept ? v2Orig.quality : rest.quality } as C;
  });
}

/** The key at time `t`: `beatKeys` per beat (harmony.ts colKeys over the beats), the last beat at or before t. */
function keyAt(t: number, beats: readonly number[], beatKeys: readonly BarKey[]): BarKey | null {
  let i = -1;
  for (let b = 0; b < beats.length && beats[b] <= t + 1e-6; b++) i = b;
  return beatKeys[Math.max(i, 0)] ?? null;
}

/**
 * The identical-pair rule (pairRule.ts resolvePairs, plan §2.3) on chords that went through the bass stage. The bass
 * note b of the bass points is the chord's `/X` when the bass stage marked one, else the B-1 bass of the chord (spike 6
 * segmentBass with the marks config, as T9 measured). A gap between two chords (no-chord) breaks the chain, as N does.
 * The output `/X` follows the marks only: a mark that is the chosen reading's root is dropped, no new mark is added.
 * The other reading goes first into `candidates` (always shown, candidates.ts).
 */
export function pairsAfterBass<C extends TimedChord>(
  low: LowCqt,
  chords: readonly C[],
  beats: readonly number[],
  beatKeys: readonly BarKey[],
  marks: BassConfig,
  rule: Exclude<PairRule, 'off'>,
  stage: Stage,
): C[] {
  const b1 = segmentBass(low, chords, beats, marks.segment);
  const segs: PairSegment[] = [];
  const at: number[] = []; // index in segs of chord i
  chords.forEach((c, i) => {
    if (i > 0 && c.start > chords[i - 1].end + 1e-3) segs.push({ root: null, quality: 'maj', bass: null, key: null });
    at.push(segs.length);
    segs.push({ root: pcOf(c.root), quality: c.quality, bass: c.bass !== null ? pcOf(c.bass) : b1[i].pc, key: keyAt(c.start, beats, beatKeys) });
  });
  const d = resolvePairs(segs, rule, stage);
  return chords.map((c, i) => {
    const x = d[at[i]];
    if (!x) return c;
    const same = x.chosen.root === x.viterbi.root && x.chosen.quality === x.viterbi.quality;
    const mark = c.bass !== null ? pcOf(c.bass) : null;
    const bass = same ? c.bass : mark === null || mark === x.chosen.root ? null : NOTE_NAMES[mark];
    return {
      ...c,
      root: NOTE_NAMES[x.chosen.root],
      quality: x.chosen.quality,
      bass,
      candidates: [{ root: NOTE_NAMES[x.other.root], quality: x.other.quality }, ...(c.candidates ?? [])],
    };
  });
}

/**
 * "New qualities as candidates only" (plan §5 stop rule, G1 decision 6): a chord whose quality is new at `stage` shows
 * its proxy (vocab family, the same as the scorer's 落 mapping for V1) as the answer and the new reading as the first
 * candidate. Everything else is unchanged.
 */
export function asCandidatesOnly<C extends TimedChord>(chords: readonly C[], stage: Stage): C[] {
  const added = new Set(newQualities(stage));
  return chords.map((c) => (added.has(c.quality) ? { ...c, quality: proxyQuality(c.quality), candidates: [{ root: c.root, quality: c.quality }, ...(c.candidates ?? [])] } : c));
}

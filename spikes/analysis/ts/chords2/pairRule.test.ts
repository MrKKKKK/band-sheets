/**
 * Spike 7 T9: the identical-pair post-pass (plan §2.3). Every truth-table row (identicalPairs.ts TRUTH_ROWS) is run
 * through both rules with its key (confidence 1), its bass and its neighbours, and the chosen reading is pinned.
 *
 * Expected agreement (computed with the note's tier values, not tuned):
 *   context  24/25 (conflict 8/8)   misses B8 (G -> F#m7b5 -> F in C: G -> Am6 -> F scores 1.6 against bass 1.0 + 0.3)
 *   bassRoot 23/25 (conflict 6/8)   misses A10 (tie -> current vocabulary Am7) and B5 (bass F# = F#m7b5's root)
 *   The rules disagree on A10, B5 (context right) and B8 (bassRoot right).
 * The other reading is always a candidate; the Viterbi reading only matters for nothing (ties go to the v1a vocabulary).
 */
import { describe, expect, it } from 'vitest';
import { noteToPc } from '../bass/score';
import type { ChordSegment } from '../dsp/chords';
import type { BarKey } from '../dsp/keytrack';
import { analyze, chordName } from './analyze';
import { resolveChords2Config } from './config';
import { parseReading } from './eval/pairs';
import { TRUTH_ROWS } from './identicalPairs';
import {
  applyDecisions,
  choose,
  otherReading,
  pairScore,
  resolvePairs,
  segmentBassPc,
  segmentKeys,
  SUS2_RESOLUTION_TIER,
  transitionTier,
  type PairSegment,
  type Reading,
} from './pairRule';

const R = parseReading;
const name = (r: Reading) => chordName(r.root, r.quality);
const keyOf = (k: string, confidence = 1): BarKey => ({ bar: 0, tonic: noteToPc(k.replace(/m$/, '')), mode: k.endsWith('m') ? 'minor' : 'major', confidence });
const seg = (chord: string | null, bass: string | null, key: BarKey | null): PairSegment => {
  const r = chord ? R(chord) : null;
  return { root: r ? r.root : null, quality: r ? r.quality : 'maj', bass: bass === null ? null : noteToPc(bass), key };
};

/** chosen reading per row: [context, bassRoot]; truth unless marked */
const PINNED: Record<string, [string, string]> = {
  A1: ['C6', 'C6'],
  A2: ['C6', 'C6'],
  A3: ['Am7', 'Am7'],
  A4: ['Am7', 'Am7'],
  A5: ['Am7', 'Am7'],
  A6: ['Am7', 'Am7'], // context: tie 0.6 = 0.6, goes to the v1a reading (Am7) = truth
  A7: ['C6', 'C6'],
  A8: ['C6', 'C6'],
  A9: ['Am7', 'Am7'],
  A10: ['C6', 'Am7'], // bassRoot: no bass, no root continuation -> tie -> Am7 (miss)
  B1: ['Am6', 'Am6'],
  B2: ['Am6', 'Am6'],
  B3: ['F#m7b5', 'F#m7b5'],
  B4: ['F#m7b5', 'F#m7b5'],
  B5: ['Am6', 'F#m7b5'], // bassRoot: the bass F# is F#m7b5's root (miss)
  B6: ['Am6', 'Am6'],
  B7: ['Am6', 'Am6'],
  B8: ['Am6', 'F#m7b5'], // context: G -> Am6 -> F (deceptive + T->S) outweighs the bass (miss)
  B9: ['Fm6', 'Fm6'],
  C1: ['Gsus4', 'Gsus4'],
  C2: ['Csus2', 'Csus2'],
  C3: ['Csus2', 'Csus2'],
  C4: ['Gsus4', 'Gsus4'],
  C6: ['Asus2', 'Asus2'],
  C7: ['Fsus2', 'Fsus2'],
};

describe('truth-table rows (TRUTH_ROWS), both rules pinned', () => {
  it('every row is pinned', () => {
    expect(Object.keys(PINNED).sort()).toEqual(TRUTH_ROWS.map((r) => r.id).sort());
  });

  it.each(TRUTH_ROWS.map((r) => [r.id, r] as const))('%s', (_, row) => {
    const key = keyOf(row.key);
    for (const [i, rule] of (['context', 'bassRoot'] as const).entries()) {
      // the Viterbi reading is either reading of the pair: the result must not depend on it
      for (const viterbi of [row.truth, row.candidate]) {
        // prev / next with their own root as bass (so a pair-reading neighbour keeps its reading)
        const segs = [
          ...(row.prev ? [seg(row.prev, null, key)] : []),
          seg(viterbi, row.bass, key),
          ...(row.next ? [seg(row.next, null, key)] : []),
        ].map((s) => (s.bass === null && s.root !== null ? { ...s, bass: s.root } : s));
        const x = row.prev ? 1 : 0;
        const d = resolvePairs(segs, rule, 'V2');
        expect(d[x], `${row.id} ${rule}`).not.toBeNull();
        expect(name(d[x]!.chosen), `${row.id} ${rule} from ${viterbi}`).toBe(PINNED[row.id][i]);
        // the other reading is always the candidate
        const other = name(d[x]!.chosen) === row.truth ? row.candidate : row.truth;
        expect(name(d[x]!.other)).toBe(other);
        // the neighbours keep their reading
        if (row.prev) expect(d[0] ? name(d[0].chosen) : row.prev).toBe(row.prev);
      }
    }
  });

  it('totals: context 24/25 (conflict 8/8), bassRoot 23/25 (conflict 6/8)', () => {
    const hits = (i: number, conflictOnly: boolean) =>
      TRUTH_ROWS.filter((r) => (!conflictOnly || r.conflict) && PINNED[r.id][i] === r.truth).length;
    expect([hits(0, false), hits(0, true)]).toEqual([24, 8]);
    expect([hits(1, false), hits(1, true)]).toEqual([23, 6]);
    expect(TRUTH_ROWS.filter((r) => r.conflict)).toHaveLength(8);
  });
});

describe('points (plan §2.3 values)', () => {
  const C = keyOf('C');
  it('bass +1.0, root continuation +0.6 once, context = tier x key confidence', () => {
    const c = { prev: R('G7'), next: R('C'), key: keyOf('C', 0.5), nextKey: keyOf('C', 0.5), bass: 0 };
    // C6: G7 -> C6 strong (1.0 x .5), C6 -> C = same family, 0; root C continues to the next
    expect(pairScore(R('C6'), c, 'context')).toEqual({ bass: 1, context: 0.5, root: 0.6, total: 2.1 });
    // bassRoot: the context points are 0
    expect(pairScore(R('C6'), c, 'bassRoot')).toEqual({ bass: 1, context: 0, root: 0.6, total: 1.6 });
    // root continuation counts once even when prev and next share the root
    expect(pairScore(R('Am7'), { prev: R('Am'), next: R('Am6'), key: null, nextKey: null, bass: null }, 'context').root).toBe(0.6);
  });
  it('negative key confidence counts as 0; no key = no context points', () => {
    const c = { prev: R('G7'), next: null, key: keyOf('C', -0.3), nextKey: null, bass: null };
    expect(pairScore(R('C6'), c, 'context').context).toBe(0);
    expect(pairScore(R('C6'), { ...c, key: null }, 'context').context).toBe(0);
  });
  it('tiers: new qualities through their family (note §1.4), sus2 resolution (note §3.7)', () => {
    expect(transitionTier(R('G7'), R('C6'), C)).toBe(1.0); // D -> T
    expect(transitionTier(R('C6'), R('C'), C)).toBe(0); // same family, same root
    expect(transitionTier(R('Am7'), R('Am6'), keyOf('Am'))).toBe(0); // same root quality change: root continuation's job
    expect(transitionTier(R('Csus2'), R('F'), C)).toBe(1.0); // sus2 = the stronger of maj / min
    for (const to of ['C', 'Cm', 'C7', 'Cmaj7', 'Cm7', 'C6', 'Cm6', 'CmM7']) expect(transitionTier(R('Csus2'), R(to), C), to).toBe(SUS2_RESOLUTION_TIER);
    expect(transitionTier(R('Gsus2'), R('G7'), C)).toBe(SUS2_RESOLUTION_TIER); // note §3.7's example
    expect(transitionTier(R('Csus2'), R('Csus4'), C)).toBe(0);
    expect(transitionTier(R('C'), R('Csus2'), C)).toBe(0); // only sus2 -> resolution, not into sus2
    expect(transitionTier(R('Csus2'), R('Csus2'), C)).toBe(0);
  });
});

describe('ties (deterministic)', () => {
  const none = { prev: null, next: null, key: null, nextKey: null, bass: null };
  it.each([
    ['C6', 'Am7', 'Am7'],
    ['Am6', 'F#m7b5', 'F#m7b5'],
    ['Csus2', 'Gsus4', 'Gsus4'],
  ])('%s / %s with no evidence -> %s (the v1a vocabulary), in either order', (a, b, want) => {
    for (const rule of ['context', 'bassRoot'] as const) {
      expect(name(choose(R(a), R(b), none, rule).chosen)).toBe(want);
      expect(name(choose(R(b), R(a), none, rule).chosen)).toBe(want);
      expect(choose(R(a), R(b), none, rule).tie).toBe(true);
    }
  });
  it('a bass on neither root is no evidence', () => {
    expect(choose(R('C6'), R('Am7'), { ...none, bass: noteToPc('E') }, 'bassRoot')).toMatchObject({ tie: true, chosen: R('Am7') });
  });
  it('equal non-zero totals are a tie too (A6: 0.6 root continuation = 0.6 context)', () => {
    const c = { prev: R('AmM7'), next: R('Am6'), key: keyOf('Am'), nextKey: keyOf('Am'), bass: noteToPc('G') };
    const d = choose(R('C6'), R('Am7'), c, 'context');
    expect(d.tie).toBe(true);
    expect(name(d.chosen)).toBe('Am7');
  });
});

describe('left to right: previous = decided reading, next = Viterbi reading', () => {
  it('a decision feeds the next segment', () => {
    // [Am7 (bass C)] [Am6 / F#m7b5 (no bass)]: the first becomes C6 (bass), so the second has no root continuation from
    // A and ties -> F#m7b5. Had the Viterbi Am7 been used as prev, Am6 would win by root continuation.
    const segs = [seg('Am7', 'C', null), seg('F#m7b5', null, null)];
    const d = resolvePairs(segs, 'bassRoot', 'V1');
    expect(name(d[0]!.chosen)).toBe('C6');
    expect(name(d[1]!.chosen)).toBe('F#m7b5');
    expect(d[1]!.tie).toBe(true);
  });
  it('the next segment is read as the Viterbi gave it (not yet decided)', () => {
    // [C6/Am7 (no bass)] [F#m7b5 / Am6 (bass A)]: the first sees next = F#m7b5 (Viterbi), no root A continuation -> tie -> Am7
    const d = resolvePairs([seg('C6', null, null), seg('F#m7b5', 'A', null)], 'bassRoot', 'V1');
    expect(d[0]!.scores.chosen.root).toBe(0);
    expect(name(d[0]!.chosen)).toBe('Am7');
    expect(name(d[1]!.chosen)).toBe('Am6'); // bass A + root continuation from the decided Am7
  });
  it('no-chord segments break the context', () => {
    const d = resolvePairs([seg('Am', null, null), seg(null, null, null), seg('C6', null, null)], 'bassRoot', 'V1');
    expect(d[0]).toBeNull();
    expect(d[1]).toBeNull();
    expect(d[2]!.scores.chosen.root + d[2]!.scores.other.root).toBe(0);
  });
});

describe('scope: stages, aug / dim7 (ROOT_TIE), non-pair readings', () => {
  it('a pair is active only when both qualities are in the stage', () => {
    expect(otherReading(R('Am7'), 'V0')).toBeNull();
    expect(otherReading(R('Am7'), 'V1')).toEqual(R('C6'));
    expect(otherReading(R('F#m7b5'), 'V1')).toEqual(R('Am6'));
    expect(otherReading(R('Gsus4'), 'V1')).toBeNull();
    expect(otherReading(R('Gsus4'), 'V2')).toEqual(R('Csus2'));
    expect(otherReading(R('Csus2'), 'V3')).toEqual(R('Gsus4'));
    expect(otherReading(R('C'), 'V3')).toBeNull();
  });
  it('aug and dim7 are outside the rule (their root stays v1a ROOT_TIE): no decision, no candidate', () => {
    const segs = [seg('C', null, keyOf('C')), seg('Caug', 'E', keyOf('C')), seg('Cdim7', 'D#', keyOf('C')), seg('C6', null, keyOf('C'))];
    for (const rule of ['context', 'bassRoot'] as const) {
      const d = resolvePairs(segs, rule, 'V3');
      expect(d.slice(0, 3)).toEqual([null, null, null]);
      expect(d[3]).not.toBeNull();
    }
  });
  it('aug / dim7 chroma through analyze: pairRule on == off', () => {
    const n = 16;
    const chroma = new Float64Array(12 * n);
    for (let t = 0; t < n; t++) for (const p of t < 8 ? [0, 4, 8] : [0, 3, 6, 9]) chroma[p * n + t] = 1;
    const input = { chroma, n, perBeat: 1, barKeys: [0, 1, 2, 3].map((bar) => ({ ...keyOf('C', 0.8), bar })), barOfBeat: Array.from({ length: n }, (_, i) => Math.floor(i / 4)) };
    const off = analyze(input, resolveChords2Config({ stage: 'V1' }));
    expect(off.segments.map((s) => s.quality)).toEqual(['aug', 'dim7']);
    for (const pairRule of ['context', 'bassRoot']) expect(analyze(input, resolveChords2Config({ stage: 'V1', pairRule })).segments).toEqual(off.segments);
  });
});

describe('applying decisions to segments', () => {
  const s = (root: number | null, quality: string, bass: number | null, startBeat = 0, perBeat = 1): ChordSegment => ({ startBeat, endBeat: startBeat + 4, root, quality, confidence: 0.5, lowConfidence: false, bass, candidates: [], perBeat });
  it('chosen reading replaces root / quality; the bass b stays the bass (slash when not the root); other -> chordCandidates', () => {
    const segs = [s(9, 'min7', null), s(9, 'min7', null), s(0, 'maj', null)];
    const bass = [0, 9, null]; // b = C under Am7 -> C6; b = A -> Am7 stays
    const d = resolvePairs(segs.map((x, i) => ({ root: x.root, quality: x.quality, bass: bass[i], key: null })), 'bassRoot', 'V1');
    const out = applyDecisions(segs, d, bass);
    expect(out[0]).toMatchObject({ root: 0, quality: '6', bass: null, chordCandidates: [R('Am7')] });
    expect(out[1]).toMatchObject({ root: 9, quality: 'min7', bass: null, chordCandidates: [R('C6')] });
    expect(out[2]).toBe(segs[2]);
    // b not the chosen root -> slash
    const out2 = applyDecisions([s(0, '6', null)], [{ ...d[0]!, viterbi: R('C6'), chosen: R('Am7'), other: R('C6') }], [4]);
    expect(out2[0]).toMatchObject({ root: 9, quality: 'min7', bass: 4 });
    // unknown b keeps the segment's bass
    const out3 = applyDecisions([s(0, '6', 4)], [{ ...d[0]!, viterbi: R('C6'), chosen: R('Am7'), other: R('C6') }], [null]);
    expect(out3[0]).toMatchObject({ root: 9, bass: 4 });
  });
  it('segmentBassPc: none with the B method off; slash bass, else the root, with a method on', () => {
    expect(segmentBassPc(s(0, 'maj', 4), 'off')).toBeNull();
    expect(segmentBassPc(s(0, 'maj', 4), 'M3')).toBe(4);
    expect(segmentBassPc(s(0, 'maj', null), 'M3')).toBe(0);
    expect(segmentBassPc(s(null, 'maj', null), 'M3')).toBeNull();
  });
  it('segmentKeys: the key of the segment first beat (columns / perBeat); none without keys', () => {
    const keys: BarKey[] = [{ ...keyOf('C'), bar: 0 }, { ...keyOf('Am'), bar: 1 }];
    const boc = [0, 0, 0, 0, 1, 1, 1, 1];
    expect(segmentKeys([s(0, 'maj', null, 0, 2), s(0, 'maj', null, 8, 2)], keys, boc).map((k) => k?.mode)).toEqual(['major', 'minor']);
    expect(segmentKeys([s(0, 'maj', null)], [], boc)).toEqual([null]);
  });
});

describe('through analyze()', () => {
  // inner-voice cliche Am - AmM7 - Am7 - Am6 (chords2.cliche.test.ts): with pairRule 'off' the last segment is F#m7b5
  const A = 9, C = 0, E = 4, Gs = 8, G = 7, Fs = 6;
  const BEATS = 8;
  const frames = [[A, C, E], [A, C, E, Gs], [A, C, E, G], [A, C, E, Fs]].flatMap((f, i) => Array.from({ length: BEATS }, () => f.map((p) => [p, p === [E, Gs, G, Fs][i] && i > 0 ? 0.9 : 1] as const)));
  const n = frames.length;
  const chroma = new Float64Array(12 * n);
  frames.forEach((f, t) => f.forEach(([p, v]) => (chroma[p * n + t] = v)));
  const barOfBeat = Array.from({ length: n }, (_, i) => Math.floor(i / 4));
  const barKeys: BarKey[] = Array.from({ length: n / 4 }, (_, bar) => ({ bar, tonic: 9, mode: 'minor', confidence: 0.9 }));
  const run = (pairRule: string) => analyze({ chroma, n, perBeat: 1, barKeys, barOfBeat }, resolveChords2Config({ stage: 'V1', pairRule }));
  it.each(['context', 'bassRoot'])('%s: the cliche ends on Am6 (root continuation), F#m7b5 is the candidate', (rule) => {
    const off = run('off').segments;
    const on = run(rule).segments;
    expect(off.map((x) => chordName(x.root, x.quality))).toEqual(['Am', 'AmM7', 'Am7', 'F#m7b5']);
    expect(on.map((x) => chordName(x.root, x.quality))).toEqual(['Am', 'AmM7', 'Am7', 'Am6']);
    expect(on[3].chordCandidates).toEqual([R('F#m7b5')]);
    expect(on[2].chordCandidates).toEqual([R('C6')]); // Am7 kept (root continuation), C6 a candidate
    expect(on[0].chordCandidates).toBeUndefined();
    // everything but the reading is the off segment's
    on.forEach((x, i) => expect({ ...x, root: off[i].root, quality: off[i].quality, chordCandidates: undefined }).toEqual({ ...off[i], chordCandidates: undefined }));
  });
});

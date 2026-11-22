import { describe, expect, it } from 'vitest';
import { enabledBassConfig } from '../bass/config';
import { analyze, chordName, type Chords2Input } from './analyze';
import { CANDIDATE_CAP, shownCandidates } from './candidates';
import { chords2ConfigHash, resolveChords2Config, T10_V1_OVERRIDES } from './config';
import { asCandidatesOnly, marksOnV2, pairsAfterBass, proxyQuality, type TimedChord } from './pipeline';

const frameSec = 512 / 22050;
/** A toy low CQT (row 0 = C1): one loud row per span [start s, end s, row]. */
const toy = (spans: [number, number, number][], sec: number) => {
  const cols = Math.ceil(sec / frameSec) + 1;
  const semi = new Float32Array(60 * cols);
  for (let t = 0; t < cols; t++) for (const [s, e, row] of spans) if (t * frameSec >= s && t * frameSec < e) semi[row * cols + t] = 1;
  return { semi, nSemis: 60, cols, midi0: 24, frameSec, tuning: 0 };
};
const beats = Array.from({ length: 25 }, (_, i) => i * 0.5);
const ch = (start: number, end: number, root: string, quality: string, bass: string | null = null, candidates?: TimedChord['candidates']): TimedChord => ({ start, end, root, quality, bass, ...(candidates ? { candidates } : {}) });
const name = (c: TimedChord) => `${c.root}${c.quality}${c.bass ? `/${c.bass}` : ''}`;
const G2 = enabledBassConfig();

describe('T10 candidates: the cap fixed before tuning', () => {
  it('at most 2 besides the answer, pair reading first, answer and repeats skipped', () => {
    expect(CANDIDATE_CAP).toBe(2);
    const c = (root: string, quality: string) => ({ root, quality });
    expect(shownCandidates(c('A', 'min7'), [c('C', '6'), c('A', 'min7'), c('C', '6'), c('C', 'maj'), c('E', 'min')])).toEqual([c('C', '6'), c('C', 'maj')]);
    expect(shownCandidates(c('A', 'min'), [])).toEqual([]);
  });
});

describe('T10 proxy quality and candidates-only output', () => {
  it('a new quality is shown to v1a-only code as its single family; sus2 (two families) must be decided first', () => {
    expect(['maj', 'min7', 'm7b5'].map(proxyQuality)).toEqual(['maj', 'min7', 'm7b5']);
    expect(['mM7', 'm6', '6'].map(proxyQuality)).toEqual(['min', 'min', 'maj']);
    expect(() => proxyQuality('sus2')).toThrow(/single family/);
  });
  it('asCandidatesOnly: the new reading becomes the first candidate, the proxy the answer; others unchanged', () => {
    const out = asCandidatesOnly([ch(0, 2, 'C', '6', 'E', [{ root: 'A', quality: 'min7' }]), ch(2, 4, 'A', 'min7')], 'V1');
    expect(out[0]).toEqual(ch(0, 2, 'C', 'maj', 'E', [{ root: 'C', quality: '6' }, { root: 'A', quality: 'min7' }]));
    expect(out[1]).toEqual(ch(2, 4, 'A', 'min7'));
    expect(asCandidatesOnly([ch(0, 2, 'C', '6')], 'V0')[0].quality).toBe('6'); // nothing new at V0
  });
});

describe('T10 marksOnV2: spike 6 marks on chords2 chords', () => {
  it('the inner-voice cliche over a descending bass: marks written, the new qualities kept', () => {
    // A1 G#1 G1 F#1 under Am - AmM7 - Am7 - Am6 (rows: A1 = 9 ... F#1 = 6)
    const low = toy([[0, 2, 9], [2, 4, 8], [4, 6, 7], [6, 8, 6]], 8);
    const out = marksOnV2(low, [ch(0, 2, 'A', 'min'), ch(2, 4, 'A', 'mM7'), ch(4, 6, 'A', 'min7'), ch(6, 8, 'A', 'm6')], beats, G2);
    expect(out.map(name)).toEqual(['Amin', 'AmM7/G#', 'Amin7/G', 'Am6/F#']);
    expect(out.every((c) => !('v2Orig' in c))).toBe(true);
  });
  it('v1a-vocabulary chords go through unchanged (same result as bassChords on them)', () => {
    const low = toy([[0, 2, 12], [2, 4, 16]], 4); // C2, E2
    expect(marksOnV2(low, [ch(0, 2, 'C', 'maj'), ch(2, 4, 'C', 'maj')], beats, G2).map(name)).toEqual(['Cmaj', 'Cmaj/E']);
  });
});

describe('T10 pairsAfterBass: the pair rule after the marks', () => {
  const low = toy([[0, 2, 17], [2, 4, 12], [4, 6, 19]], 6); // F2, C2, G2
  it('an unmarked segment: b = its B-1 bass (C under Am7 -> C6), the other reading first in the candidates', () => {
    const out = pairsAfterBass(low, [ch(0, 2, 'F', 'maj'), ch(2, 4, 'A', 'min7', null, [{ root: 'A', quality: 'min' }]), ch(4, 6, 'G', 'maj')], beats, [], G2, 'bassRoot', 'V1');
    expect(out.map(name)).toEqual(['Fmaj', 'C6', 'Gmaj']);
    expect(out[1].candidates).toEqual([{ root: 'A', quality: 'min7' }, { root: 'A', quality: 'min' }]);
  });
  it('a marked /X is the bass the rule reads (over the B-1 bass); a mark on the chosen root is dropped', () => {
    const low2 = toy([[0, 2, 17], [2, 4, 16], [4, 6, 19]], 6); // E2 under the pair segment
    const out = pairsAfterBass(low2, [ch(0, 2, 'F', 'maj'), ch(2, 4, 'A', 'min7', 'C'), ch(4, 6, 'G', 'maj')], beats, [], G2, 'bassRoot', 'V1');
    expect(name(out[1])).toBe('C6');
    // no mark, B-1 bass E (neither root): tie -> the current-vocabulary reading, no /X added
    const keep = pairsAfterBass(low2, [ch(0, 2, 'F', 'maj'), ch(2, 4, 'C', '6'), ch(4, 6, 'G', 'maj')], beats, [], G2, 'bassRoot', 'V1');
    expect(name(keep[1])).toBe('Amin7');
    expect(keep[1].candidates).toEqual([{ root: 'C', quality: '6' }]);
  });
  it('root continuation reaches across chords, but not across a gap (no chord)', () => {
    const low3 = toy([[0, 6, 16]], 6); // E2 everywhere: no bass points for either reading
    const run = (gap: number) => pairsAfterBass(low3, [ch(0, 2, 'C', 'maj'), ch(2 + gap, 4, 'A', 'min7')], beats, [], G2, 'bassRoot', 'V1');
    expect(name(run(0)[1])).toBe('C6');
    expect(name(run(1)[1])).toBe('Amin7');
  });
});

describe('T10 newSeventh: the 7th guard of the new 4-note states', () => {
  it('present only when set (configs without it keep their hashes); validated', () => {
    expect(chords2ConfigHash(resolveChords2Config({ stage: 'V1' }))).toBe('6b3456aceb5e');
    const a = resolveChords2Config({ stage: 'V1', newSeventh: { weight: 1.02, margin: 0 } });
    expect(a.newSeventh).toEqual({ weight: 1.02, margin: 0 });
    expect(chords2ConfigHash(a)).not.toBe('6b3456aceb5e');
    expect(chords2ConfigHash(resolveChords2Config(T10_V1_OVERRIDES))).toBe('733803577894'); // the values look point 3 ran
    expect(() => resolveChords2Config({ newSeventh: { weight: 1 } })).toThrow(/newSeventh/);
    expect(() => resolveChords2Config({ newSeventh: { weight: 'x', margin: 0 } })).toThrow(/newSeventh/);
  });
  it('A C E strong, G# half: v1a 7th guard (x .98) keeps Am, x 1.05 lets AmM7 through', () => {
    const chroma = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 1, 0, 0]);
    const input: Chords2Input = { chroma, n: 1, perBeat: 1, barKeys: [], barOfBeat: [0] };
    const read = (o: object) => {
      const s = analyze(input, resolveChords2Config({ stage: 'V1', newQualityMargin: 0, ...o })).segments[0];
      return chordName(s.root, s.quality);
    };
    expect(read({})).toBe('Am');
    expect(read({ newSeventh: { weight: 1.05, margin: 0 } })).toBe('AmM7');
  });
});

import { describe, expect, it } from 'vitest';
import { newAgg } from './baselineAgg';
import { handEditsLines, hasGroup, leLine, wrongSlashLines } from './g1Common';

const withAgg = (m: Record<string, { files?: number; wrong?: [number, number]; edits?: [number, number] }>) => ({
  agg: Object.fromEntries(
    Object.entries(m).map(([k, v]) => {
      const a = newAgg();
      a.files = v.files ?? 1;
      if (v.wrong) [a.wrong.falseSlash, a.wrong.noSlash] = v.wrong;
      if (v.edits) [a.edits.total, a.edits.nBeats] = v.edits;
      return [k, a];
    }),
  ),
});

describe('g1Common', () => {
  it('leLine: pass within tolerance, null for a missing value', () => {
    expect(leLine('x', 0.02, 0.02)).toEqual({ line: 'x', value: '.020', target: '≤ .020', pass: true });
    expect(leLine('x', 0.03, 0.02).pass).toBe(false);
    expect(leLine('x', null, 0.02).pass).toBeNull();
  });
  it('hasGroup: 落 files only', () => {
    const T = withAgg({ 'down|r|A': {}, 'full|r|B': {}, 'down|r|C': { files: 0 } });
    expect([hasGroup(T, 'r', 'A'), hasGroup(T, 'r', 'B'), hasGroup(T, 'r', 'C'), hasGroup(T, 'r', 'D')]).toEqual([true, false, false, false]);
  });
  it('wrongSlashLines: REC then LR, only for existing groups', () => {
    const T = withAgg({ 'down|r|REC': { wrong: [1, 100] }, 'down|r|LR': { wrong: [6, 100] } });
    expect(wrongSlashLines(T, 'r').map((l) => [l.line, l.pass])).toEqual([['3 誤った /X 録音 ALL', true], ['3 誤った /X 合成 LR', false]]);
    expect(wrongSlashLines(withAgg({}), 'r')).toEqual([]);
  });
  it('handEditsLines: base minus 1.5, vocabulary and wording from the options', () => {
    const T = withAgg({ 'full|r|SYN': { edits: [10, 100] }, 'down|r|SYN': { files: 1 }, 'full|b|SYN': { edits: [12, 100] } });
    const [l] = handEditsLines(T, 'r', { vocab: 'full', base: 'b', vocabLabel: 'V', synLabel: 'S', baseLabel: 'B' });
    expect(l).toEqual({ line: '5 手で直す数 / 100 拍 V S（B −1.5）', value: '10.0', target: '≤ 10.5', pass: true });
  });
});

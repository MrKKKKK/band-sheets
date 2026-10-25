import { describe, expect, it } from 'vitest';
import {
  alignOffset,
  barEdits,
  barKeyboardSteps,
  editScores,
  gridScores,
  hungarian,
  instrumentOnsets,
  matchOnsets,
  matchOnsetsKuhn,
  onsetScores,
  scoreTake,
  swingScores,
  type DrumTruth,
  type EstResult,
  type GridHit,
} from './score';
import { renderDrumReport, type DrumReportRow } from './report';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('onsetScores (mir_eval.onset.f_measure semantics)', () => {
  it('hand example: 2 of 4 match', () => {
    const r = onsetScores([0, 1, 2, 3], [0.04, 1.06, 2.0, 5], 0.05);
    expect([r.matched, r.precision, r.recall, r.f]).toEqual([2, 0.5, 0.5, 0.5]);
  });
  it('the boundary |d| == tol matches (<=, no rounding)', () => {
    expect(onsetScores([0], [0.25], 0.25).matched).toBe(1);
    expect(onsetScores([0], [0.2500001], 0.25).matched).toBe(0);
  });
  it('the window is mir_eval\'s [est - w, est + w] test: 1.0 vs 1.05 at 0.05 matches although 1.05 - 1.0 > 0.05', () => {
    expect(1.05 - 1.0 > 0.05).toBe(true);
    expect(onsetScores([1.0], [1.05], 0.05).matched).toBe(1);
  });
  it('1:1: two estimates near one reference match once', () => {
    const r = onsetScores([1], [0.99, 1.01], 0.05);
    expect([r.matched, r.precision, r.recall]).toEqual([1, 0.5, 1]);
  });
  it('empty reference or estimate gives 0', () => {
    expect(onsetScores([], [1], 0.05).f).toBe(0);
    expect(onsetScores([1], [], 0.05).f).toBe(0);
  });
  it('sorted greedy has the maximum matching size (= Kuhn) on random sets, pairs are within tol', () => {
    const rand = rng(7);
    for (let k = 0; k < 300; k++) {
      const ref = Array.from({ length: Math.floor(rand() * 12) }, () => rand() * 2);
      const est = Array.from({ length: Math.floor(rand() * 12) }, () => rand() * 2);
      const tol = 0.02 + rand() * 0.1;
      const pairs = matchOnsets(ref, est, tol);
      expect(pairs.length).toBe(matchOnsetsKuhn(ref, est, tol));
      for (const [a, b] of pairs) expect(Math.abs(ref[a] - est[b])).toBeLessThanOrEqual(tol + 1e-12);
      expect(new Set(pairs.map((p) => p[0])).size).toBe(pairs.length);
      expect(new Set(pairs.map((p) => p[1])).size).toBe(pairs.length);
    }
  });
});

describe('instrumentOnsets and confusion', () => {
  it('per instrument + micro all + confusion with none', () => {
    const ref = [
      { t: 1.0, inst: 'BD' },
      { t: 2.0, inst: 'SD' },
      { t: 3.0, inst: 'HH' },
    ];
    const est = [
      { t: 1.01, inst: 'SD' }, // wrong instrument at BD's time
      { t: 3.0, inst: 'HH' },
      { t: 9, inst: 'HH' }, // extra
    ];
    const r = instrumentOnsets(ref, est, 0.05);
    expect(r.perInst.HH.precision).toBe(0.5);
    expect(r.perInst.HH.recall).toBe(1);
    expect(r.perInst.BD.f).toBe(0); // BD has no estimate
    expect(r.perInst.SD.f).toBe(0);
    expect([r.all.matched, r.all.precision, r.all.recall]).toEqual([1, 1 / 3, 1 / 3]);
    expect(r.confusion).toEqual({ HH: { HH: 1 }, BD: { SD: 1 }, SD: { none: 1 }, none: { HH: 1 } });
  });
});

describe('alignOffset', () => {
  it('finds a constant lateness of 80 ms (and 0 for aligned input)', () => {
    const ref = [0.5, 1, 1.5, 2, 2.5].map((t) => ({ t, inst: 'BD' }));
    const late = ref.map((h) => ({ ...h, t: h.t + 0.08 }));
    expect(alignOffset(ref, late).offsetSec).toBeCloseTo(0.08, 9);
    expect(alignOffset(ref, ref).offsetSec).toBeCloseTo(0, 9);
    expect(alignOffset(ref, late).matched).toBe(5);
  });
  it('is limited to +-100 ms', () => {
    const ref = [1, 2, 3].map((t) => ({ t, inst: 'BD' }));
    const way = ref.map((h) => ({ ...h, t: h.t + 0.3 }));
    expect(Math.abs(alignOffset(ref, way).offsetSec)).toBeLessThanOrEqual(0.1 + 1e-12);
  });
});

describe('gridScores and strength', () => {
  const truth: GridHit[] = [
    { bar: 0, tick: 0, inst: 'BD' },
    { bar: 0, tick: 16, inst: 'SD', mark: 'g' },
    { bar: 0, tick: 32, inst: 'BD' },
    { bar: 1, tick: 0, inst: 'BD', mark: 'ac' },
  ];
  const est: GridHit[] = [
    { bar: 0, tick: 0, inst: 'BD' },
    { bar: 0, tick: 16, inst: 'SD', mark: 'g' },
    { bar: 0, tick: 36, inst: 'BD' },
    { bar: 1, tick: 0, inst: 'BD' },
  ];
  it('exact bar/tick/inst', () => {
    const g = gridScores(truth, est);
    expect([g.matched, g.precision, g.recall, g.f]).toEqual([3, 0.75, 0.75, 0.75]);
  });
  it('strength over grid-matched pairs', () => {
    const s = gridScores(truth, est).strength;
    expect(s.pairs).toBe(3);
    expect(s.agree).toBeCloseTo(2 / 3, 12);
    expect([s.ghostP, s.ghostR, s.accentP, s.accentR]).toEqual([1, 1, 0, 0]);
  });
});

describe('swingScores', () => {
  it('accuracy, confusion and wrong runs', () => {
    const r = swingScores(
      [{ bar: 0, kind: '8' }, { bar: 1, kind: '8' }],
      [{ bar: 0, kind: '8' }, { bar: 2, kind: '16' }],
      [0, 1, 2],
    );
    expect(r.acc).toBeCloseTo(1 / 3, 12);
    expect(r.wrong).toEqual([false, true, true]);
    expect(r.confusion).toEqual({ '8': { '8': 1, none: 1 }, none: { '16': 1 } });
  });
});

describe('edits', () => {
  it('hungarian solves a 3x3 assignment', () => {
    const c = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
    const a = hungarian(c);
    expect(a.reduce((s, j, i) => s + c[i][j], 0)).toBe(5);
  });
  it('hand cases', () => {
    expect(barEdits([{ tick: 0, inst: 'BD' }], [{ tick: 0, inst: 'SD' }])).toBe(1); // change instrument
    expect(barEdits([{ tick: 0, inst: 'BD' }], [{ tick: 4, inst: 'BD' }])).toBe(1); // one grid cell
    expect(barEdits([{ tick: 0, inst: 'BD' }], [{ tick: 8, inst: 'BD' }])).toBe(2); // 2 cells (= delete + add)
    expect(barEdits([{ tick: 0, inst: 'BD' }], [{ tick: 12, inst: 'BD' }])).toBe(2); // 3 cells > delete + add
    expect(barEdits([{ tick: 0, inst: 'BD', mark: 'g' }], [{ tick: 0, inst: 'BD' }])).toBe(1); // mark
    expect(barEdits([], [{ tick: 0, inst: 'BD' }, { tick: 4, inst: 'BD' }])).toBe(2);
    expect(barEdits([{ tick: 0, inst: 'BD' }], [])).toBe(1);
    expect(
      barEdits(
        [{ tick: 0, inst: 'BD' }, { tick: 16, inst: 'SD', mark: 'g' }, { tick: 32, inst: 'BD' }],
        [{ tick: 0, inst: 'BD' }, { tick: 16, inst: 'SD' }, { tick: 36, inst: 'BD' }],
      ),
    ).toBe(2);
  });
  it('matches brute force on random small bars', () => {
    const rand = rng(3);
    const mk = (): { tick: number; inst: string }[] =>
      Array.from({ length: Math.floor(rand() * 4) }, () => ({ tick: Math.floor(rand() * 4) * 4, inst: ['BD', 'SD'][Math.floor(rand() * 2)] }));
    const brute = (t: ReturnType<typeof mk>, e: ReturnType<typeof mk>): number => {
      const used = new Array(e.length).fill(false);
      const go = (i: number): number => {
        if (i === t.length) return used.filter((u) => !u).length;
        let best = 1 + go(i + 1); // add
        e.forEach((x, j) => {
          if (used[j]) return;
          used[j] = true;
          best = Math.min(best, (x.inst !== t[i].inst ? 1 : 0) + Math.abs(x.tick - t[i].tick) / 4 + go(i + 1));
          used[j] = false;
        });
        return best;
      };
      return go(0);
    };
    for (let k = 0; k < 200; k++) {
      const t = mk();
      const e = mk();
      expect(barEdits(t, e)).toBe(brute(t, e));
    }
  });
  const four = (bar: number): GridHit[] => [0, 16, 32, 48].map((tick) => ({ bar, tick, inst: 'BD' }));
  it('keyboard steps by hand', () => {
    // BD+HH at 0 (len 16 != 8: 2, +1 Shift), SD ghost at 16 (len 48 != 16: 2, +1 S) = 6
    expect(barKeyboardSteps([{ tick: 0, inst: 'BD' }, { tick: 0, inst: 'HH' }, { tick: 16, inst: 'SD', mark: 'g' }], 64, 8).steps).toBe(6);
    expect(barKeyboardSteps([{ tick: 0, inst: 'BD' }], 64, 64).steps).toBe(1);
    expect(barKeyboardSteps([], 64, 8)).toEqual({ steps: 2, cur: 64 }); // R + length switch
    expect(barKeyboardSteps([{ tick: 16, inst: 'BD' }], 64, 8).steps).toBe(2 + 2); // leading rest (16) + hit (48)
    expect(barKeyboardSteps([{ tick: 0, inst: 'BD', mark: 'ac' }], 64, 64).steps).toBe(2);
  });
  it('editScores: ratio and the copy variant', () => {
    const r = editScores([...four(0), ...four(1)], [...four(0), ...four(1).slice(0, 3)], [0, 1], { barTicks: 64 });
    expect(r.hitEdits).toBe(1);
    expect(r.keyboardSteps).toBe(5 + 4);
    expect(r.keyboardStepsCopy).toBe(5 + 1);
    expect(r.ratio).toBeCloseTo(1 / 9, 12);
    expect(r.ratioCopy).toBeCloseTo(1 / 6, 12);
  });
  it('shuffle: one edit per run of wrong bars', () => {
    const r = editScores([], [], [0, 1, 2, 3], { barTicks: 64, swingWrong: [true, true, false, true] });
    expect(r.swingEdits).toBe(2);
  });
});

describe('scoreTake', () => {
  const truth: DrumTruth = {
    barTicks: 64,
    barStartsSec: [0, 2, 4],
    bpm: 120,
    swingBars: [{ bar: 0, kind: 'none' }],
    hits: [
      { t: 0, bar: 0, tick: 0, inst: 'BD' },
      { t: 1, bar: 0, tick: 32, inst: 'SD' },
      { t: 2, bar: 1, tick: 0, inst: 'BD' },
    ],
  };
  const est = (extra: boolean): EstResult => ({
    drums: [
      { t: 0.01, inst: 'BD' },
      { t: 1.0, inst: 'SD' },
      { t: 2.0, inst: 'BD' },
      ...(extra ? [{ t: 3.0, inst: 'HH' }] : []),
    ],
    drum: { quantized: { bpm: 120, ts: [4, 4], startSec: 0, hits: [{ bar: 0, tick: 0, inst: 'BD' }, { bar: 0, tick: 32, inst: 'SD' }, { bar: 1, tick: 0, inst: 'BD' }, ...(extra ? [{ bar: 1, tick: 32, inst: 'HH' }] : [])] } },
  });
  it('perfect take', () => {
    const r = scoreTake({ truth, result: est(false), level: 'S-3' });
    expect(r.scores['onset.f.all']).toBe(1);
    expect(r.scores['grid.f']).toBe(1);
    expect(r.scores['edit.count']).toBe(0);
    expect(r.scores['swing.acc']).toBe(1);
    expect(r.scores['barHead.f']).toBe(1);
    expect(r.scores['tempo.relErr']).toBe(0);
  });
  it('an extra hit costs precision and one delete; excluding its bar removes it everywhere', () => {
    const a = scoreTake({ truth, result: est(true), level: 'S-3' });
    expect(a.scores['onset.p.all']).toBe(0.75);
    expect(a.scores['edit.count']).toBe(1);
    const b = scoreTake({ truth, result: est(true), level: 'S-3', excludedBars: [1] });
    expect(b.scores['onset.p.all']).toBe(1);
    expect(b.scores['onset.r.all']).toBe(1);
    expect(b.scores['grid.f']).toBe(1);
    expect(b.scores['edit.count']).toBe(0);
    expect(b.scores['edit.keyboardSteps']).toBe(barKeyboardSteps([{ tick: 0, inst: 'BD' }, { tick: 32, inst: 'SD' }], 64, 8).steps);
  });
  it('alignment shifts the estimate and reports the offset', () => {
    const late = est(false);
    late.drums = late.drums.map((h) => ({ ...h, t: h.t + 0.08 }));
    expect(scoreTake({ truth, result: late, level: 'S-3' }).scores['onset.f.all']).toBe(0);
    const r = scoreTake({ truth, result: late, level: 'S-3', align: true });
    expect(r.scores['onset.f.all']).toBe(1);
    expect(r.scores['align.offsetMs']).toBeCloseTo(80, 0); // median-like: pairs at 80, 80, 90 ms late -> 80
  });
  it('level mapping: HO counts as HH in S-3, tom is dropped; S-9 keeps both', () => {
    const t2: DrumTruth = { ...truth, hits: [{ t: 0, bar: 0, tick: 0, inst: 'HO' }, { t: 1, bar: 0, tick: 32, inst: 'T1' }] };
    const e2: EstResult = { drums: [{ t: 0, inst: 'HH' }, { t: 1, inst: 'T1' }] };
    expect(scoreTake({ truth: t2, result: e2, level: 'S-3' }).scores['onset.f.all']).toBe(1);
    const s9 = scoreTake({ truth: t2, result: e2, level: 'S-9' });
    expect(s9.scores['onset.f.HO']).toBe(0);
    expect(s9.scores['onset.f.T1']).toBe(1);
  });
});

describe('report', () => {
  const t = scoreTake({
    truth: { barTicks: 64, barStartsSec: [0, 2], hits: [{ t: 0, bar: 0, tick: 0, inst: 'BD' }] },
    result: { drums: [{ t: 0, inst: 'SD' }] },
    level: 'S-3',
  });
  const rows: DrumReportRow[] = [
    { id: 'syn-a', kind: 'synthetic', level: 'D1', drumLevel: 'S-3', take: t },
    { id: 'drm-01-a', kind: 'recording', level: 'R', drumLevel: 'S-3', take: t },
  ];
  it('has the tables and keeps recording ids out', () => {
    const md = renderDrumReport(rows);
    expect(md).toContain('onset F +-50ms');
    expect(md).toContain('confusion');
    expect(md).toContain('R min');
    expect(md).toContain('syn-a');
    expect(md).not.toContain('drm-01-a');
  });
});

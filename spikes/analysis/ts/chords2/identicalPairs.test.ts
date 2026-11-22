import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IDENTICAL_PAIRS,
  OTHER_ROWS,
  SYMMETRIC_EXCLUDED,
  TRUTH_ROWS,
  identicalGroups,
  stageQualities,
  templates,
  type Stage,
} from './identicalPairs';

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SUFFIXES: [string, string][] = [
  // longest first so 'm7b5' is not read as 'm7'
  ['m7b5', 'm7b5'],
  ['maj7', 'maj7'],
  ['sus2', 'sus2'],
  ['sus4', 'sus4'],
  ['mM7', 'mM7'],
  ['aug', 'aug'],
  ['m7', 'min7'],
  ['m6', 'm6'],
  ['7', '7'],
  ['6', '6'],
  ['m', 'min'],
  ['', 'maj'],
];

function note(name: string): number {
  const m = /^([A-G])([#b]?)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}
function chord(name: string): { root: number; quality: string } {
  const m = /^([A-G][#b]?)(.*)$/.exec(name);
  if (!m) throw new Error(`bad chord ${name}`);
  const hit = SUFFIXES.find(([s]) => s === m[2]);
  if (!hit) throw new Error(`unknown suffix in ${name}`);
  return { root: note(m[1]), quality: hit[1] };
}
function pcSet(root: number, quality: string): string {
  return [...new Set(templates(quality)[0].map((i) => (root + i) % 12))].sort((a, b) => a - b).join(',');
}

/** Kinds of identical groups, normalized: cross-quality pairs as 'a>b+offset', same-quality as the quality. */
function kinds(stage: Stage): { cross: string[]; same: string[] } {
  const cross = new Set<string>();
  const same = new Set<string>();
  for (const g of identicalGroups(stageQualities(stage))) {
    const qs = [...new Set(g.map((s) => s.quality))];
    if (qs.length === 1) {
      same.add(qs[0]);
      continue;
    }
    expect(g).toHaveLength(2); // every cross-quality group is a pair
    for (const p of IDENTICAL_PAIRS) {
      const a = g.find((s) => s.quality === p.a);
      const b = g.find((s) => s.quality === p.b);
      if (a && b && (a.root + p.offset) % 12 === b.root) cross.add(`${p.a}>${p.b}+${p.offset}`);
    }
    if (!IDENTICAL_PAIRS.some((p) => qs.includes(p.a) && qs.includes(p.b))) cross.add(`UNLISTED:${qs.join('/')}`);
  }
  return { cross: [...cross].sort(), same: [...same].sort() };
}

const ORDER: Stage[] = ['V0', 'V1', 'V2', 'V3'];
const listedUpTo = (stage: Stage) =>
  IDENTICAL_PAIRS.filter((p) => ORDER.indexOf(p.stage) <= ORDER.indexOf(stage))
    .map((p) => `${p.a}>${p.b}+${p.offset}`)
    .sort();

describe('identical-note pairs (spike 7 T2)', () => {
  it.each(ORDER)('stage %s: listed pairs are exactly the identical pitch-class sets', (stage) => {
    const k = kinds(stage);
    expect(k.cross).toEqual(listedUpTo(stage));
    expect(k.same).toEqual([...SYMMETRIC_EXCLUDED].sort());
  });

  it('every pair is identical on all 12 roots', () => {
    for (const p of IDENTICAL_PAIRS)
      for (let r = 0; r < 12; r++) expect(pcSet(r, p.a)).toBe(pcSet((r + p.offset) % 12, p.b));
  });

  it('truth rows: truth and candidate are the two readings of one listed pair, conflict flag matches the bass', () => {
    for (const row of TRUTH_ROWS) {
      const t = chord(row.truth);
      const c = chord(row.candidate);
      expect(pcSet(t.root, t.quality), row.id).toBe(pcSet(c.root, c.quality));
      const listed = IDENTICAL_PAIRS.some(
        (p) => (p.a === t.quality && p.b === c.quality) || (p.a === c.quality && p.b === t.quality),
      );
      expect(listed, row.id).toBe(true);
      expect(row.conflict, row.id).toBe(note(row.bass) !== t.root);
    }
  });

  it('about a third of the rows are conflict cases (plan §2.3), every pair has at least one', () => {
    const n = TRUTH_ROWS.length;
    const conflicts = TRUTH_ROWS.filter((r) => r.conflict).length;
    expect(conflicts / n).toBeGreaterThanOrEqual(0.3);
    for (const letter of ['A', 'B', 'C'])
      expect(TRUTH_ROWS.some((r) => r.id.startsWith(letter) && r.conflict)).toBe(true);
  });

  it('the doc gives a reason for exactly the rows of this table', () => {
    const md = readFileSync(join(import.meta.dirname, '../../../../docs/audio-spike7-t2-truth.md'), 'utf8');
    const mdIds = [...md.matchAll(/^\| ([A-CP]\d+) +\|/gm)].map((m) => m[1]).sort();
    const tsIds = [...TRUTH_ROWS, ...OTHER_ROWS].map((r) => r.id).sort();
    expect(new Set(tsIds).size).toBe(tsIds.length);
    expect(mdIds).toEqual(tsIds);
  });
});

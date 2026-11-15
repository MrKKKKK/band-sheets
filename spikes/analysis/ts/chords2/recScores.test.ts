/**
 * Spike 7 T6: the recording scores load in the app (dash notation valid, 16 bars, 1 line = 4 bars), agree with their
 * intake templates, every chord is in the chords2 vocabulary with a playable right hand, the READMEs' voicing hints
 * spell their chords, and the coverage floors of docs/audio-spike7-t6.md hold. The held-out part runs only where the
 * gitignored scores exist, and its messages never name a chord.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BARS,
  BARS_PER_LINE,
  coverage,
  DEV,
  DEV_DIR,
  HELDOUT,
  HELDOUT_DIR,
  hintProblem,
  parseChordText,
  parseHints,
  readScore,
  readText,
  rightHandPcs,
  scoreOf,
  templateBars,
} from './recScores';
import { newQualities } from './vocab';

/** Floors (docs/audio-spike7-t6.md §3): every new quality in >= 5 bars per split, >= 60 `/X` points per split. */
const MIN_BARS_WITH = 5;
const MIN_SLASH_POINTS = 60;

describe('helpers', () => {
  it('reads chords, bass and pitch-class right hands', () => {
    expect(parseChordText('Am7/G')).toEqual({ root: 9, quality: 'min7', bass: 7 });
    expect(parseChordText('C/C')).toEqual({ root: 0, quality: 'maj', bass: null });
    expect(() => parseChordText('CM9')).toThrow();
    expect(rightHandPcs(parseChordText('C9')).sort((a, b) => a - b)).toEqual([2, 4, 7, 10]);
    expect(rightHandPcs(parseChordText('C6/E')).sort((a, b) => a - b)).toEqual([0, 4, 7, 9]);
  });
  it('checks hints', () => {
    const [h] = parseHints('`AmM7` = 右手 C・E・G#（左手 A）');
    expect(h).toEqual({ chord: 'AmM7', right: ['C', 'E', 'G#'], left: 'A' });
    expect(hintProblem(h)).toBeNull();
    expect(hintProblem({ chord: 'C9', right: ['E', 'Bb', 'D'], left: 'C' })).toBeNull(); // no-5th form
    expect(hintProblem({ chord: 'C6', right: ['E', 'A', 'C'], left: 'C' })).toBe('notes are not the chord');
    expect(hintProblem({ chord: 'Am7/G', right: ['A', 'C', 'E'], left: 'A' })).toBe('left hand is not the bass');
    expect(hintProblem({ chord: 'Cmaj9', right: ['E', 'B', 'D', 'G'], left: 'C' })).toBe('right hand wider than a ninth');
  });
  it('counts coverage', () => {
    const s = readScore('{time: 4/4}\n|[C6/E]----[Am7]----|[C6]--------|\n');
    const c = coverage([s]);
    expect(c.barsWith['6']).toBe(2);
    expect(c.barsLong['6']).toBe(1.5);
    expect(c.slashPoints).toBe(4);
    expect(c.pairs['6/min7']).toEqual({ all: 3, conflict: 1 });
  });
});

function checkTakes(dir: string, letters: readonly string[], readme: string, named: boolean) {
  const hints = parseHints(readText(readme));
  const say = (l: string, bar: number, what: string, chord: string) => `${l} bar ${bar + 1}: ${what}${named ? ` (${chord})` : ''}`;
  it('load in the app as 16 bars of valid dash notation, 4 bars per line, and match the intake template', () => {
    const problems: string[] = [];
    for (const l of letters) {
      const s = scoreOf(dir, l);
      const t = readText(join(dir, `${l}.txt`));
      if (s.errors.length || s.otherLines) problems.push(`${l}: dash notation errors ${s.errors.length}, other lines ${s.otherLines}`);
      if (s.bars.length !== BARS || s.barsPerLine.some((n) => n !== BARS_PER_LINE)) problems.push(`${l}: bars per line`);
      if (!t.includes(`bpm: ${s.tempo}\n`) || !t.includes(`キー: ${s.key}\n`)) problems.push(`${l}: tempo / key differ from the template`);
      if (JSON.stringify(templateBars(t)) !== JSON.stringify(s.bars.map((b) => b.map((c) => c.text)))) problems.push(`${l}: chords differ from the template`);
      const sec = (BARS * 4 * 60) / (s.tempo ?? 1);
      if (sec < 40 || sec > 60) problems.push(`${l}: length ${sec.toFixed(1)} s`);
    }
    expect(problems).toEqual([]);
  });
  it('have only chords2 chords, at most 4 right-hand notes, and a correct hint for every new-quality chord', () => {
    const problems: string[] = [];
    const fresh = new Set(newQualities('V3'));
    for (const h of hints) {
      const p = hintProblem(h);
      if (p) problems.push(named ? `hint ${h.chord}: ${p}` : `hint: ${p}`);
    }
    for (const l of letters) {
      scoreOf(dir, l).bars.forEach((bar, i) =>
        bar.forEach(({ text }) => {
          let c;
          try {
            c = parseChordText(text);
          } catch {
            problems.push(say(l, i, 'not in the chords2 vocabulary', text));
            return;
          }
          if (rightHandPcs(c).length > 4) problems.push(say(l, i, 'right hand > 4 notes', text));
          if (fresh.has(c.quality) && !hints.some((h) => h.chord === text)) problems.push(say(l, i, 'no voicing hint', text));
        }),
      );
    }
    expect(problems).toEqual([]);
  });
  it('reach the coverage floors', () => {
    const c = coverage(letters.map((l) => scoreOf(dir, l)));
    const low = Object.entries(c.barsWith).filter(([, n]) => n < MIN_BARS_WITH).map(([q]) => q);
    expect(low).toEqual([]);
    expect(c.slashPoints).toBeGreaterThanOrEqual(MIN_SLASH_POINTS);
    for (const p of Object.values(c.pairs)) expect(p.conflict).toBeGreaterThan(0);
    for (const p of Object.values(c.pairs)) expect(p.all).toBeGreaterThan(p.conflict);
  });
}

describe('dev scores (chord-scores/)', () => {
  checkTakes(DEV_DIR, DEV, join(DEV_DIR, 'README.md'), true);
});

describe.skipIf(!existsSync(HELDOUT_DIR))('held-out scores (gitignored; counts only)', () => {
  checkTakes(HELDOUT_DIR, HELDOUT, join(HELDOUT_DIR, 'README.local.md'), false);
});

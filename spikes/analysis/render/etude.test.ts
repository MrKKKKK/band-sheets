import { importer, Settings } from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { parseSong } from '../../../src/lib/parseSong';
import { partsToAlphaTex } from '../../../src/lib/partsToAlphaTex';
import { parseChordSymbol } from './chordSymbol';
import { chordTimeline } from './chordTimeline';
import { chordEtude } from './etude';
import { pianoPartBody } from './pianoPart';

describe('chordEtude', () => {
  const e = chordEtude(1);
  const song = parseSong(e.text);

  it('is deterministic per seed and differs between seeds', () => {
    expect(chordEtude(1).text).toBe(e.text);
    expect(chordEtude(2).text).not.toBe(e.text);
  });

  it('covers all 24 triads and some sevenths, 1-2 chords per bar', () => {
    for (const seed of [1, 2, 3, 99]) {
      const all = chordEtude(seed).chordsPerBar;
      expect(all).toHaveLength(32);
      expect(all.every((b) => b.length >= 1 && b.length <= 2)).toBe(true);
      const parsed = all.flat().map(parseChordSymbol);
      const triads = new Set(
        parsed
          .filter((c) => c.quality === 'maj' || c.quality === 'min')
          .map((c) => `${c.root}${c.quality}`),
      );
      expect(triads.size).toBe(24);
    }
    const q = new Set(e.chordsPerBar.flat().map((c) => parseChordSymbol(c).quality));
    expect([...q].some((x) => ['7', 'maj7', 'min7'].includes(x))).toBe(true);
  });

  it('repeats A1/B1 chords in A2/B2, and A1+B1 alone cover all 24 triads', () => {
    for (const seed of [1, 2, 3, 99]) {
      const all = chordEtude(seed).chordsPerBar;
      expect(all.slice(16, 24)).toEqual(all.slice(0, 8));
      expect(all.slice(24, 32)).toEqual(all.slice(8, 16));
      const triads = new Set(
        all
          .slice(0, 16)
          .flat()
          .map(parseChordSymbol)
          .filter((c) => c.quality === 'maj' || c.quality === 'min')
          .map((c) => `${c.root}${c.quality}`),
      );
      expect(triads.size).toBe(24);
    }
  });

  it('has no key, a crash at each section start and a fill before each boundary', () => {
    expect(song.meta.key).toBeUndefined();
    const drums = e.text.split('{start_of_part: Drums}')[1];
    const bars = drums.split('\n').filter((l) => l.endsWith('|'));
    expect(bars).toHaveLength(32);
    for (const i of [0, 8, 16, 24]) expect(bars[i]).toContain('(CR BD)');
    expect(drums.match(/CR/g)).toHaveLength(4);
    for (const i of [7, 15, 23]) expect(bars[i]).toContain('SD SD SD SD');
    expect(bars[31]).not.toContain('SD SD SD SD');
    expect(drums.match(/\\tf triplet8th/g)).toHaveLength(4);
  });

  it('passes chordTimeline with 4 sections of 8 bars', () => {
    const t = chordTimeline(song);
    expect(t.bars).toBe(32);
    expect(t.sections.map((s) => [s.label, s.bars])).toEqual([
      ['A1', 8],
      ['B1', 8],
      ['A2', 8],
      ['B2', 8],
    ]);
    const flat = e.chordsPerBar;
    flat.forEach((cs, bar) => {
      const got = t.chords.filter((c) => c.bar === bar).map((c) => c.text);
      expect(got).toEqual(cs);
    });
  });

  it('imports all parts with alphaTab without errors', () => {
    const imp = new importer.AlphaTexImporter();
    imp.initFromString(partsToAlphaTex(song), new Settings());
    const score = imp.readScore();
    expect(score.tracks).toHaveLength(2);
    for (const tr of score.tracks) expect(tr.staves[0].bars).toHaveLength(32);

    const piano = new importer.AlphaTexImporter();
    piano.initFromString(
      `.\n\\track "P"\n\\ts 4 4\n${pianoPartBody(chordTimeline(song))}\n`,
      new Settings(),
    );
    expect(piano.readScore().tracks[0].staves[0].bars).toHaveLength(32);
  });

  it('seventhShare controls the share of 7th chords and keeps the structure', () => {
    const share = (xs: string[][]) => {
      const f = xs.flat();
      return f.filter((c) => ['7', 'maj7', 'min7'].includes(parseChordSymbol(c).quality)).length / f.length;
    };
    expect(chordEtude(1, undefined).text).toBe(e.text);
    for (const seed of [1, 2, 3]) {
      const heavy = chordEtude(seed, 0.4);
      expect(heavy.chordsPerBar).toHaveLength(32);
      expect(chordEtude(seed, 0.4).text).toBe(heavy.text);
      expect(share(heavy.chordsPerBar)).toBeGreaterThanOrEqual(0.3);
      expect(share(heavy.chordsPerBar)).toBeGreaterThan(share(chordEtude(seed).chordsPerBar));
      expect(heavy.chordsPerBar.slice(16, 24)).toEqual(heavy.chordsPerBar.slice(0, 8));
      expect(chordTimeline(parseSong(heavy.text)).bars).toBe(32);
    }
  });
});

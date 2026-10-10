import { importer, Settings } from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { parseSong } from '../../../src/lib/parseSong';
import { partsToAlphaTex } from '../../../src/lib/partsToAlphaTex';
import { parseChordSymbol } from './chordSymbol';
import { chordTimeline } from './chordTimeline';
import { createHash } from 'node:crypto';
import { chordEtude, chordEtudeAABA, VOCAB_EXTRAS } from './etude';
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

  it('keeps the spike 1 etudes byte for byte (spike 2, T4)', () => {
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    expect(sha(chordEtude(1).text)).toBe('702735da056e8bf30008392f366c9fa9a9a65223810091b4dd1f4038f7d62c0c');
    expect(sha(chordEtude(2, 0.4).text)).toBe('e492adabd69fc8c3876a52f5a951c535e0792524bcf0008b97daddd5fe928126');
    expect(sha(chordEtude(1, 0.4).text)).toBe('35bc2b1a16fde31af1ba155e5c7a26e92babd2699deb6a332981f9412d8001e3');
    expect(chordEtude(1, undefined, undefined).text).toBe(e.text);
  });

  it('vocabShare mixes in dim / aug / sus4 / m7b5 / dim7 and keeps the structure', () => {
    const v = chordEtude(1, undefined, 0.2);
    expect(chordEtude(1, undefined, 0.2).text).toBe(v.text);
    const q = v.chordsPerBar.flat().map((c) => parseChordSymbol(c).quality);
    const extra = q.filter((x) => (VOCAB_EXTRAS as string[]).includes(x)).length;
    expect(extra / q.length).toBeGreaterThan(0.1);
    expect(extra / q.length).toBeLessThan(0.35);
    expect(new Set(q.filter((x) => (VOCAB_EXTRAS as string[]).includes(x))).size).toBe(5);
    expect(v.chordsPerBar.slice(16, 24)).toEqual(v.chordsPerBar.slice(0, 8));
    expect(chordTimeline(parseSong(v.text)).bars).toBe(32);
  });
});

describe('chordEtudeAABA (etude3)', () => {
  const e3 = chordEtudeAABA(3);
  const t = chordTimeline(parseSong(e3.text));

  it('is AABA with 8-bar sections after a 1-bar pickup, A sections sharing their chords', () => {
    expect(chordEtudeAABA(3).text).toBe(e3.text);
    expect(chordEtudeAABA(4).text).not.toBe(e3.text);
    expect(t.bars).toBe(33);
    expect(t.sections.map((s) => [s.label, s.startBar, s.bars])).toEqual([
      ['A1', 0, 9],
      ['A2', 9, 8],
      ['B', 17, 8],
      ['A3', 25, 8],
    ]);
    const bar = (b: number) => t.chords.filter((c) => c.bar === b).map((c) => c.text);
    for (let i = 0; i < 8; i++) {
      expect(bar(9 + i)).toEqual(bar(25 + i));
      expect(bar(9 + i)).toEqual(bar(1 + i).length ? bar(1 + i) : bar(9 + i));
    }
    expect(e3.chordsPerBar).toHaveLength(33);
  });

  it('pickup: one beat sung on the 4th beat of bar 0, no chord written on it', () => {
    const melody = e3.text.split('{start_of_part: Vocal}')[1];
    expect(melody).toMatch(/\\section "A1"\n:4 r r r [A-G]#?\d\{lyrics "ら"\} \|/);
    expect(e3.text).toMatch(/\{start_of_verse: A1\}\nら\[/);
    // The first chord is the one of bar 1, moved back to bar 0 by chordTimeline.
    expect(t.chords[0].bar).toBe(0);
    expect(t.chords[1].bar).toBeGreaterThanOrEqual(1);
  });

  it('imports with alphaTab, every track 33 bars', () => {
    const imp = new importer.AlphaTexImporter();
    imp.initFromString(partsToAlphaTex(parseSong(e3.text)), new Settings());
    const score = imp.readScore();
    for (const tr of score.tracks) expect(tr.staves[0].bars).toHaveLength(33);
    for (const tr of score.tracks) expect(tr.staves[0].bars.some((b) => b.isEmpty)).toBe(false);
  });
});

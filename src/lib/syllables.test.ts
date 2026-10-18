import { describe, expect, it } from 'vitest';
import { parseSong } from './parseSong';
import { sampleSong } from './fixtures/sampleSong';
import { chartSyllables, splitSyllables } from './syllables';

describe('splitSyllables', () => {
  it('splits one syllable per kana/kanji', () => {
    expect(splitSyllables('きらきら')).toEqual(['き', 'ら', 'き', 'ら']);
  });

  it('joins small kana (and katakana) to the previous syllable', () => {
    expect(splitSyllables('きゃ')).toEqual(['きゃ']);
    expect(splitSyllables('シャッター')).toEqual(['シャッ', 'タ', 'ー']);
  });

  it('joins っ/ッ (sokuon) to the previous syllable', () => {
    expect(splitSyllables('がっこう')).toEqual(['がっ', 'こ', 'う']);
  });

  it('treats ー as its own syllable', () => {
    expect(splitSyllables('ラーメン')).toEqual(['ラ', 'ー', 'メ', 'ン']);
  });

  it('drops whitespace, including full-width space', () => {
    expect(splitSyllables('き ら \tき\nら')).toEqual(['き', 'ら', 'き', 'ら']);
    expect(splitSyllables('き　ら')).toEqual(['き', 'ら']);
  });

  it('attaches punctuation and brackets to the previous syllable', () => {
    expect(splitSyllables('そう。')).toEqual(['そ', 'う。']);
    expect(splitSyllables('ねえ、うん')).toEqual(['ね', 'え、', 'う', 'ん']);
    expect(splitSyllables('（そう）')).toEqual(['（そ', 'う）']);
  });

  it('attaches leading punctuation to the next syllable', () => {
    expect(splitSyllables('「こんにちは」')).toEqual([
      '「こ',
      'ん',
      'に',
      'ち',
      'は」',
    ]);
  });

  it('splits Latin words one syllable per word', () => {
    expect(splitSyllables('hello world')).toEqual(['hello', 'world']);
  });

  it('splits Latin words at hyphens, keeping the hyphen on the left', () => {
    expect(splitSyllables('hel-lo')).toEqual(['hel-', 'lo']);
  });

  it('groups digits like Latin words', () => {
    expect(splitSyllables('2026 年')).toEqual(['2026', '年']);
  });

  it('handles mixed Japanese/English', () => {
    expect(splitSyllables('きみと walk しよう')).toEqual([
      'き',
      'み',
      'と',
      'walk',
      'し',
      'よ',
      'う',
    ]);
  });

  it('handles leading small kana (nothing to attach to)', () => {
    expect(splitSyllables('ゃだ')).toEqual(['ゃ', 'だ']);
  });

  it('returns [] for an empty string', () => {
    expect(splitSyllables('')).toEqual([]);
  });

  it('returns [] for a whitespace-only string', () => {
    expect(splitSyllables('   \n\t')).toEqual([]);
  });

  it('keeps an apostrophe between letters as part of the word', () => {
    expect(splitSyllables("don't")).toEqual(["don't"]);
    expect(splitSyllables("rock'n'roll")).toEqual(["rock'n'roll"]);
  });

  it('attaches 〜 to the previous syllable instead of consuming a note', () => {
    expect(splitSyllables('ラララ〜')).toEqual(['ラ', 'ラ', 'ラ〜']);
  });

  it('attaches a run of trailing symbols to the previous syllable', () => {
    expect(splitSyllables('ラララ〜♪')).toEqual(['ラ', 'ラ', 'ラ〜♪']);
  });

  it('attaches comma and period to the previous syllable, not their own', () => {
    expect(splitSyllables('Hello, world.')).toEqual(['Hello,', 'world.']);
  });

  it('attaches quotes around a word instead of leaving an empty syllable', () => {
    expect(splitSyllables('"quoted"')).toEqual(['"quoted"']);
  });

  it('attaches parenthesis per-character like other brackets', () => {
    expect(splitSyllables('(ハモ)ラ')).toEqual(['(ハ', 'モ)', 'ラ']);
  });

  it('groups a percent sign onto the digit run like other symbols', () => {
    expect(splitSyllables('100%')).toEqual(['100%']);
  });
});

describe('chartSyllables', () => {
  it("returns the syllables of the chart section's lyrics", () => {
    expect(chartSyllables(sampleSong, 'A')).toEqual([
      'き',
      'ら',
      'き',
      'ら',
      'ひ',
      'か',
      'る',
      'お',
      'そ',
      'ら',
      'の',
      'ほ',
      'し',
      'よ',
    ]);
    expect(chartSyllables(sampleSong, 'B')).toEqual([
      'み',
      'ん',
      'な',
      'の',
      'う',
      'た',
      'が',
      'と',
      'ど',
      'く',
      'と',
      'い',
      'い',
      'な',
    ]);
  });

  it('returns [] when the label has no chart section', () => {
    expect(chartSyllables(sampleSong, 'Z')).toEqual([]);
  });
});

describe('dash lines', () => {
  const text = [
    '{start_of_verse: A}',
    '|[C]--------|[C]----[F]----|',
    '[C]きら[G]きら',
    '| [C][G] |',
    '{end_of_verse}',
    '',
  ].join('\n');
  it('contribute no syllables to chartSyllables', () => {
    expect(chartSyllables(parseSong(text), 'A')).toEqual([
      'き',
      'ら',
      'き',
      'ら',
    ]);
  });
});

import { graphemes, lineLyrics } from './chartEdit';
import { isRawLine } from './song';
import type { ChartLine, Song } from './song';

/**
 * Japanese singing-syllable splitting (docs/m4-plan.md decision 5,
 * docs/m4-decisions.md, M4 review finding docs/m4-review.md). Each
 * kana/kanji is one syllable; small kana (ぁぃぅぇぉゃゅょゎ, katakana
 * ァィゥェォャュョヮ) and っ/ッ join the previous syllable; ー is its own
 * syllable; whitespace is dropped; Latin words (and digit runs) are one
 * syllable per word, further split at '-' with the hyphen kept on the left
 * part, except that an apostrophe (' or ’) between two letters/digits is
 * kept as part of the word (`don't` → `["don't"]`). Every other character
 * that is not a letter, digit, kana or kanji — i.e. anything in Unicode
 * category P* (punctuation: `、。.,!?()「」...`) or S* (symbols: `〜～♪★☆...`)
 * — attaches to the previous syllable, or to the next one if at the start.
 */

const SMALL_KANA_AND_SOKUON = new Set(
  'ぁぃぅぇぉゃゅょゎっァィゥェォャュョヮッ',
);
const CHOONPU = 'ー';
/** Unicode categories P* (punctuation) and S* (symbol); anchored to one char. */
const SYMBOL_ATTACH = /^[\p{P}\p{S}]$/u;
const WORD_CHAR = /[A-Za-z0-9-]/;
const WORD_LETTER_OR_DIGIT = /[A-Za-z0-9]/;
const APOSTROPHE = /['’]/;

function isWhitespace(c: string): boolean {
  return /\s/.test(c);
}

/** Splits a run of Latin/digit characters on '-', keeping it on the left part. */
function splitWordOnHyphen(word: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const ch of word) {
    current += ch;
    if (ch === '-') {
      parts.push(current);
      current = '';
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

export function splitSyllables(text: string): string[] {
  const chars = graphemes(text);
  const out: string[] = [];
  let pendingPrefix = '';

  const push = (s: string) => {
    out.push(pendingPrefix + s);
    pendingPrefix = '';
  };

  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (isWhitespace(c)) {
      // Dropped, but still ends a Latin/digit word run.
      i++;
      continue;
    }
    if (WORD_CHAR.test(c)) {
      let word = '';
      while (i < chars.length) {
        const wc = chars[i];
        if (WORD_CHAR.test(wc)) {
          word += wc;
          i++;
          continue;
        }
        // An apostrophe between two letters/digits is part of the word
        // (don't, rock'n'roll), not a symbol to attach separately.
        if (
          APOSTROPHE.test(wc) &&
          word !== '' &&
          WORD_LETTER_OR_DIGIT.test(word[word.length - 1]) &&
          i + 1 < chars.length &&
          WORD_LETTER_OR_DIGIT.test(chars[i + 1])
        ) {
          word += wc;
          i++;
          continue;
        }
        break;
      }
      for (const part of splitWordOnHyphen(word)) push(part);
      continue;
    }
    if (c === CHOONPU) {
      push(c);
      i++;
      continue;
    }
    if (SMALL_KANA_AND_SOKUON.has(c)) {
      if (out.length > 0) out[out.length - 1] += c;
      else push(c);
      i++;
      continue;
    }
    if (SYMBOL_ATTACH.test(c)) {
      if (out.length > 0) out[out.length - 1] += c;
      else pendingPrefix += c;
      i++;
      continue;
    }
    push(c);
    i++;
  }
  // Input was punctuation/symbols only: nothing to attach it to.
  if (out.length === 0 && pendingPrefix !== '') out.push(pendingPrefix);
  return out;
}

function lyricOf(line: ChartLine): string | undefined {
  if (isRawLine(line)) return undefined;
  const text = lineLyrics(line);
  return text.trim() === '' ? undefined : text;
}

/**
 * Syllables of the lyrics of the first chart section whose label matches
 * (skipping raw/chord-only/blank lines, like `lyricsText`). [] if none.
 */
export function chartSyllables(song: Song, label: string): string[] {
  const section = song.chart.find((s) => s.label === label);
  if (!section) return [];
  const text = section.lines
    .map(lyricOf)
    .filter((t): t is string => t !== undefined)
    .join('\n');
  return splitSyllables(text);
}

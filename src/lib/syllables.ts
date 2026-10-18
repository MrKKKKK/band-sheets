import { graphemes, lineLyrics } from './chartEdit';
import { isDashLine } from './dashChart';
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

/** One syllable and the grapheme range [start, end) it was taken from. */
export interface SyllableSpan {
  text: string;
  /** Index of its first grapheme (incl. an attached leading symbol). */
  start: number;
  /** One past its last grapheme (incl. attached small kana / symbols). */
  end: number;
}

export function splitSyllables(text: string): string[] {
  return syllableSpans(graphemes(text)).map((s) => s.text);
}

/**
 * `splitSyllables` over an array of grapheme clusters, keeping where each
 * syllable came from (so chords placed on chart characters can be mapped
 * to syllables, see `chartChords`). Whitespace belongs to no syllable
 * unless it lies between a syllable and a symbol / small kana attached to
 * it.
 */
export function syllableSpans(chars: readonly string[]): SyllableSpan[] {
  const out: SyllableSpan[] = [];
  let pendingPrefix = '';
  let pendingStart = -1;

  const push = (s: string, start: number, end: number) => {
    out.push({
      text: pendingPrefix + s,
      start: pendingStart >= 0 ? pendingStart : start,
      end,
    });
    pendingPrefix = '';
    pendingStart = -1;
  };
  const attach = (c: string, i: number) => {
    const last = out[out.length - 1];
    last.text += c;
    last.end = i + 1;
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
      const wordStart = i;
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
      // Split at '-' (kept on the left part), by grapheme.
      let part = '';
      let partStart = wordStart;
      for (let k = wordStart; k < i; k++) {
        part += chars[k];
        if (chars[k] === '-') {
          push(part, partStart, k + 1);
          part = '';
          partStart = k + 1;
        }
      }
      if (part !== '') push(part, partStart, i);
      continue;
    }
    if (c === CHOONPU) {
      push(c, i, i + 1);
      i++;
      continue;
    }
    if (SMALL_KANA_AND_SOKUON.has(c)) {
      if (out.length > 0) attach(c, i);
      else push(c, i, i + 1);
      i++;
      continue;
    }
    if (SYMBOL_ATTACH.test(c)) {
      if (out.length > 0) attach(c, i);
      else {
        if (pendingStart < 0) pendingStart = i;
        pendingPrefix += c;
      }
      i++;
      continue;
    }
    push(c, i, i + 1);
    i++;
  }
  // Input was punctuation/symbols only: nothing to attach it to.
  if (out.length === 0 && pendingPrefix !== '') {
    out.push({ text: pendingPrefix, start: pendingStart, end: chars.length });
  }
  return out;
}

function lyricOf(line: ChartLine): string | undefined {
  if (isRawLine(line) || isDashLine(line)) return undefined;
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

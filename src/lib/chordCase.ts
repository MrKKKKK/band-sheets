/**
 * alphaTab 1.8.4 keys chords by `name.toLowerCase()` (+ staff/track index) in
 * its alphaTex importer, so `ch "C#M7"` after `ch "C#m7"` reuses the first
 * chord and shows `C#m7` — major seventh turned into minor. Chord names are
 * case-sensitive in music, so before import we make case-variants of the same
 * name distinct with invisible zero-width spaces (`disambiguateChordCase`) and
 * strip them from the imported model (`restoreChordNames`, call it from
 * `api.scoreLoaded`). The stored tex and the song text are never touched.
 */
import type { model } from '@coderline/alphatab';

const ZWSP = '​';
const CH_RE = /\bch\s+"((?:[^"\\]|\\.)*)"/g;

export function disambiguateChordCase(tex: string): string {
  // lowercase key -> distinct exact spellings, in order of first appearance
  const seen = new Map<string, string[]>();
  const out = tex.replace(CH_RE, (match, name: string) => {
    const key = name.toLowerCase();
    let variants = seen.get(key);
    if (!variants) seen.set(key, (variants = []));
    let i = variants.indexOf(name);
    if (i < 0) i = variants.push(name) - 1;
    return i === 0
      ? match
      : match.replace(`"${name}"`, () => `"${name}${ZWSP.repeat(i)}"`);
  });
  return out;
}

/** Removes the markers added by `disambiguateChordCase` from the model. */
export function restoreChordNames(score: model.Score): void {
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      for (const chord of staff.chords?.values() ?? []) {
        chord.name = chord.name.replaceAll(ZWSP, '');
      }
    }
  }
}

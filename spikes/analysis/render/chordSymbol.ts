import type { ChordQuality, ChordSymbol } from './types';

const NATURALS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const QUALITIES: Record<string, ChordQuality> = {
  '': 'maj',
  m: 'min',
  '7': '7',
  maj7: 'maj7',
  M7: 'maj7',
  m7: 'min7',
  dim: 'dim',
  aug: 'aug',
  sus4: 'sus4',
};

const PATTERN = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/;

function pitchClass(name: string): number {
  const base = NATURALS[name[0]];
  const acc = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0;
  return (base + acc + 12) % 12;
}

/** Strictly parses a chord symbol such as `C`, `Db`, `Am7`, `C/E`. Throws on anything else. */
export function parseChordSymbol(text: string): ChordSymbol {
  const m = PATTERN.exec(text);
  if (!m) throw new Error(`コード記号を読めません: "${text}"`);
  const [, rootName, qualityText, bassName] = m;
  const quality = QUALITIES[qualityText];
  if (quality === undefined) {
    throw new Error(`未対応のコードの種類です: "${text}"`);
  }
  return {
    text,
    root: pitchClass(rootName),
    rootName,
    quality,
    bass: bassName === undefined ? null : pitchClass(bassName),
  };
}

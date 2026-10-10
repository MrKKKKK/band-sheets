import { describe, expect, it } from 'vitest';
import { allVariants } from './variants';

describe('allVariants', () => {
  const v = allVariants();
  it('has 21 unique names', () => {
    expect(v).toHaveLength(21);
    expect(new Set(v.map((x) => x.name)).size).toBe(21);
  });
  it('names the key ones as planned', () => {
    const names = v.map((x) => x.name);
    for (const n of [
      'full-t116-shuffle',
      'piano-t80-straight',
      'full-t116-straight-click',
      'etude-piano-t90-straight',
      'etude-full-t140-straight',
      'etude-full-t90-shuffle',
      'full-t116-straight-lead1.37s',
    ])
      expect(names).toContain(n);
  });
  it('splits 13 saints and 8 etude', () => {
    expect(v.filter((x) => x.song === 'saints')).toHaveLength(13);
    expect(v.filter((x) => x.song === 'etude')).toHaveLength(8);
  });
  it('has shuffle only where asWritten, and lead-in only in the lead variants', () => {
    for (const x of v) {
      expect(x.name.includes('shuffle')).toBe(x.swing === 'asWritten');
      expect(x.name.includes('-lead')).toBe((x.leadInSec ?? 0) > 0);
    }
    expect(v.filter((x) => x.leadInSec).map((x) => x.leadInSec)).toEqual([1.37, 0.62]);
  });
  it('uses lead-ins that are whole samples at 44.1 kHz', () => {
    for (const x of v) if (x.leadInSec) expect(Number.isInteger(Math.round(x.leadInSec * 1e6) * 44100 / 1e6)).toBe(true);
  });
});

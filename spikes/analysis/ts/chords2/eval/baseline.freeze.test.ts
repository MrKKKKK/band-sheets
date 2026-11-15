/**
 * Spike 7 T7: the baseline's configs are frozen (plan §4/§5: "設定のハッシュを固定"). A later task (T8-T12) that
 * changes any value of these configs must not do it silently: the pins below fail, and the baseline numbers in
 * docs/audio-spike7-t7.md would no longer belong to them. Values change only by a decision at G1/G2/G3...
 */
import { describe, expect, it } from 'vitest';
import { bassConfigHash } from '../../bass/config';
import { chords2ConfigHash, DEFAULT_CHORDS2_CONFIG } from '../config';
import { bassG2, bassT8, T8EQ_OVERRIDES, v2Config } from './baseline';

describe('T7 baseline config hashes', () => {
  it('v2 all off (V0) = the pin of the T3 golden test; V1-V3 with every B / pair switch off', () => {
    expect(chords2ConfigHash(DEFAULT_CHORDS2_CONFIG)).toBe('607593f71c46');
    expect(chords2ConfigHash(v2Config('V0'))).toBe('607593f71c46');
    expect(chords2ConfigHash(v2Config('V1'))).toBe('6b3456aceb5e');
    expect(chords2ConfigHash(v2Config('V2'))).toBe('0832f4e1fe0b');
    expect(chords2ConfigHash(v2Config('V3'))).toBe('61b54aa1fa1b');
    for (const s of ['V1', 'V2', 'V3'] as const) expect(v2Config(s)).toMatchObject({ bass: { method: 'off' }, pairRule: 'off' });
  });
  it('the reference rows: spike 6 bass stage T8-equivalent (基準) and G2 default (参考)', () => {
    expect(bassConfigHash(bassT8())).toBe('3f11c4c58c5a');
    expect(bassConfigHash(bassG2())).toBe('e5b432a11e3c');
    expect(T8EQ_OVERRIDES).toEqual({ slash: { weakMinConfidence: 0 }, cliche: { split: false, redecideRoot: false } });
  });
});

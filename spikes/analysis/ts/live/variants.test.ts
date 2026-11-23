import { describe, expect, it } from 'vitest';
import { chords2ConfigHash, T7_E1_D2_VALUES } from '../chords2/config';
import { e1Config } from '../chords2/eval/s8dev1';
import { D2_D1_CONFIG, variantById } from './variants';

describe('the s8-dev-1 row s8-D2D1', () => {
  it('is exactly e1Config(T7_E1_D2_VALUES, true) of s8dev1.ts: config hash 462ab1385491', () => {
    expect(chords2ConfigHash(D2_D1_CONFIG)).toBe('462ab1385491');
    expect(D2_D1_CONFIG).toEqual(e1Config(T7_E1_D2_VALUES, true));
    const logic = variantById('s8-D2D1').logic;
    expect(logic?.kind === 'chords2' && chords2ConfigHash(logic.cfg)).toBe('462ab1385491');
  });
  it("s8-D1 (D1 only) is a different, unmeasured config; its label says so", () => {
    const logic = variantById('s8-D1').logic;
    expect(logic?.kind === 'chords2' && chords2ConfigHash(logic.cfg)).not.toBe('462ab1385491');
    expect(variantById('s8-D1').label).toContain('測っていない');
    expect(variantById('s8-D1').note).toContain('一度も測っていない');
  });
});

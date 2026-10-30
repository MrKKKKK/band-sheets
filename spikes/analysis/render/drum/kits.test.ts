import { describe, expect, it } from 'vitest';
import { getKit, kitAvailable, parseMuldjordRegions } from './kits';

describe('kit D (MuldjordKit, T10b)', () => {
  it('sfz regions -> layer:rr -> sample number, layers ranked by their $vXX label', () => {
    const r = (v: number, n: number) => `<region> lovel=$v${v}l hivel=$v${v}h region_label=${n} sample=$instr/${n}-$instr-$mic.$ext`;
    const m = parseMuldjordRegions([r(52, 3), r(51, 1), r(52, 4), r(51, 2), r(60, 5)].join('\n'));
    expect([...m]).toEqual([
      ['2:1', 3],
      ['1:1', 1],
      ['2:2', 4],
      ['1:2', 2],
      ['3:1', 5],
    ]);
  });

  it.skipIf(!kitAvailable('D'))('layers get louder soft -> loud (HH, SD, RD)', { timeout: 120_000 }, () => {
    const d = getKit('D');
    for (const inst of ['HH', 'SD', 'RD'] as const) {
      const n = d.layers(inst);
      expect(n).toBeGreaterThanOrEqual(3);
      const peak = (layer: number) => d.voice({ inst, layer, rr: 0, mics: { close: 1 }, cents: 0, program: 0 }).x.reduce((a, b) => Math.max(a, Math.abs(b)), 0);
      expect(peak(n - 1)).toBeGreaterThan(peak(0));
    }
  });
});

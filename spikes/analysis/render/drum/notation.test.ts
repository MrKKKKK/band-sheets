import { describe, expect, it } from 'vitest';
import { parseDrums } from '../../../../src/lib/drumParse';
import { barTicksOf, hitTimes, patternTex, swingTick, timeSig, toDrumEvents } from './notation';
import { HH_GROUP, writtenAs, type Pattern } from './patterns';
import { drumPattern } from './render';
import { allDrumVariants } from './variants';

/** (bar, tick, written piece, mark) of every hit of the parsed app events. */
function parsedKeys(p: Pattern, tex: string): string[] {
  const r = parseDrums(tex, timeSig(p.ts));
  if (!r.ok) throw new Error(r.reason);
  const bt = barTicksOf(p.ts);
  const keys: string[] = [];
  let pos = 0;
  for (const e of r.events) {
    for (const h of e.hits) keys.push(`${Math.floor(pos / bt)}:${pos % bt}:${h.inst}:${h.ghost ? 'g' : h.accent ? 'ac' : ''}`);
    pos += e.ticks;
  }
  return keys.sort();
}

describe('truth score of every variant', () => {
  const variants = allDrumVariants();
  it('round-trips through serializeDrums -> parseDrums and matches the truth hits', () => {
    for (const v of variants) {
      const p = drumPattern(v);
      const events = toDrumEvents(p);
      const tex = patternTex(p);
      const r = parseDrums(tex, timeSig(p.ts));
      expect(r.ok, v.name).toBe(true);
      if (!r.ok) continue;
      expect(r.events, v.name).toEqual(events);
      expect(r.shuffle, v.name).toBe(p.shuffle);
      const truth = p.bars.flatMap((bar, b) => bar.map((h) => `${b}:${h.tick}:${writtenAs(h.inst)}:${h.mark ?? ''}`)).sort();
      expect(parsedKeys(p, tex), v.name).toEqual(truth);
      expect(p.bars.length, v.name).toBe(8);
    }
  });

  it('never has two HH-group hits or two hits of one piece on one tick', () => {
    for (const v of variants) {
      for (const bar of drumPattern(v).bars) {
        const byTick = new Map<number, string[]>();
        for (const h of bar) byTick.set(h.tick, [...(byTick.get(h.tick) ?? []), h.inst]);
        for (const insts of byTick.values()) {
          expect(new Set(insts).size).toBe(insts.length);
          expect(insts.filter((i) => HH_GROUP.has(i as never)).length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('level features: D0 plain hits, D2 fills with toms, ext pieces only in the ext style', () => {
    const vs = variants.filter((v) => v.seed === 4 && v.kit === 'A');
    for (const v of vs) {
      const p = drumPattern(v);
      const hits = p.bars.flat();
      if (v.level === 0) expect(hits.some((h) => h.mark)).toBe(false);
      if (v.level >= 2) expect(p.fillBars.length).toBeGreaterThan(0);
      else expect(p.fillBars).toEqual([]);
      const ext = hits.some((h) => h.inst.includes('.') || ['SP', 'CN', 'CB'].includes(h.inst));
      expect(ext, v.name).toBe(v.style === 'ext');
    }
    const fills = vs.filter((v) => v.level === 2 && v.style === 'rock8').map((v) => drumPattern(v));
    expect(fills[0].bars.flat().some((h) => h.inst === 'T1' || h.inst === 'FT')).toBe(true);
  });

  it('the groove of a seed is the same at D0 and D1 (only marks / ghost notes differ)', () => {
    const v0 = variants.find((v) => v.name === 'syn-d0-pop16-kA-s1')!;
    const v1 = variants.find((v) => v.name === 'syn-d1-pop16-kA-s1')!;
    const plain = (p: Pattern) => p.bars.flatMap((bar, b) => bar.map((h) => `${b}:${h.tick}:${h.inst}`)).sort();
    const p1 = drumPattern(v1);
    const p1NoGhost: Pattern = { ...p1, bars: p1.bars.map((bar) => bar.filter((h) => h.mark !== 'g')) };
    expect(plain(drumPattern(v0))).toEqual(plain(p1NoGhost));
  });
});

describe('timing', () => {
  it('swingTick: 2:1 off-beat 8th at 2/3 of the quarter, 3:2 at 0.6; straight unchanged', () => {
    expect(swingTick(8, '8', 2 / 3, 4)).toBeCloseTo(32 / 3, 12);
    expect(swingTick(8, '8', 0.6, 4)).toBeCloseTo(9.6, 12);
    expect(swingTick(16, '8', 2 / 3, 4)).toBe(16);
    expect(swingTick(4, '16', 2 / 3, 4)).toBeCloseTo(16 / 3, 12);
    expect(swingTick(12, 'none', 2 / 3, 4)).toBe(12);
  });

  it('hitTimes: bar head + ticks at the tempo; 6/8 counts eighths', () => {
    const p: Pattern = { style: 'rock8', ts: [4, 4], shuffle: 'none', fillBars: [], bars: [[{ tick: 16, inst: 'SD' }], [{ tick: 0, inst: 'BD' }]] };
    const t = hitTimes(p, 120, 1, 2 / 3, () => 0);
    expect(t.map((h) => h.t)).toEqual([1.5, 3]);
    const p68: Pattern = { ...p, ts: [6, 8], bars: [[{ tick: 8, inst: 'SD' }], [{ tick: 0, inst: 'BD' }]] };
    expect(hitTimes(p68, 120, 0, 2 / 3, () => 0).map((h) => h.t)).toEqual([0.5, 3]);
  });
});

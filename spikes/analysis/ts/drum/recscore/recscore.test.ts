import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSong } from '../../../../../src/lib/parseSong';
import { chartOrder } from '../../../../../src/lib/melodyEditor';
import { melodyTimeSignature } from '../../../../../src/lib/melody';
import { drumParts, readDrumSection } from '../../../../../src/lib/drumPart';
import { buildViewerSections } from '../../../../../src/lib/viewerSections';
import { DRUM_KIT } from '../../../../../src/lib/drumKit';
import {
  TAKE_ROLE, durationSec, grid, songText, totalBars, txtTemplate,
  type TakeDef, type TakeLetter,
} from './builder';

const REC = join(import.meta.dirname, '../../../recordings');

/** Checks one take; returns the set of instruments and features it uses. */
function checkTake(def: TakeDef, bars: [number, number], sec: [number, number]) {
  const text = songText(def);
  const song = parseSong(text);
  expect(song.meta.title).toBe(def.title);
  expect(song.meta.tempo).toBe(def.bpm);
  const ts = melodyTimeSignature(song.meta.time);
  const body = drumParts(song)[0].body;
  let n = 0;
  const insts = new Set<string>();
  let ghost = false;
  for (const s of def.sections) {
    const r = readDrumSection(body, s.label, ts, chartOrder(song));
    if (r.status !== 'ok') throw new Error(`${def.letter} ${s.label}: ${JSON.stringify(r)}`);
    expect(r.shuffle).toBe(s.shuffle);
    const ticks = r.events.reduce((m, e) => m + e.ticks, 0);
    expect(ticks).toBe(s.bars.length * 64); // 4/4: whole = 64
    n += s.bars.length;
    for (const e of r.events) for (const h of e.hits) {
      insts.add(h.inst);
      if (h.ghost === true) ghost = true;
    }
  }
  expect(n).toBe(totalBars(def));
  expect(n).toBeGreaterThanOrEqual(bars[0]);
  expect(n).toBeLessThanOrEqual(bars[1]);
  expect(durationSec(def)).toBeGreaterThanOrEqual(sec[0]);
  expect(durationSec(def)).toBeLessThanOrEqual(sec[1]);
  const v = buildViewerSections(song);
  expect(v.errors).toEqual([]);
  expect(v.sections.length).toBe(def.sections.length);
  expect(txtTemplate(def)).toContain(`bpm: ${def.bpm}`);
  return { text, insts, ghost, shuffle: def.sections.some((s) => s.shuffle !== 'none') };
}

describe('recscore builder', () => {
  it('grid builds rests, chords, effects; rejects bad lengths', () => {
    expect(grid(4, { HH: 'xxxx', SD: '.g.a' })).toBe(':4 HH (HH SD{g}) HH (HH SD{ac})');
    expect(grid(4, { HH: 'x...' })).toBe(':4 HH r r r');
    expect(() => grid(4, { HH: 'xx' })).toThrow();
  });
  it('a tiny take parses and is read ok', () => {
    const def: TakeDef = {
      letter: 'a', title: 't', bpm: 120, time: '4/4', style: 's',
      sections: [{ label: 'A', shuffle: '8', bars: Array(16).fill(grid(8, { HH: 'xxxxxxxx', BD: 'x...x...' })) }],
    };
    const r = checkTake(def, [16, 32], [30, 90]);
    expect(r.shuffle).toBe(true);
  });
});

// Real scores live in the gitignored recordings/ dir; skipped when absent.
const DEFS = join(REC, 'drum-scores', 'defs.ts');
const ALL: TakeDef[] | undefined = existsSync(DEFS)
  ? ((await import(/* @vite-ignore */ DEFS)) as { ALL: TakeDef[] }).ALL
  : undefined;

describe.skipIf(!ALL)('drum recording scores (local only)', () => {
  const infos = new Map<TakeLetter, ReturnType<typeof checkTake>>();
  it('all six parse, 16-32 bars, 30-90 s, viewer ok', () => {
    expect(ALL!.map((d) => d.letter)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    for (const d of ALL!) infos.set(d.letter, checkTake(d, [16, 32], [30, 90]));
    const known = new Set(DRUM_KIT.map((k) => k.id));
    for (const i of infos.values()) for (const x of i.insts) expect(known.has(x as never)).toBe(true);
  });
  it('tempos differ per take; held-out = e, f only', () => {
    expect(new Set(ALL!.map((d) => d.bpm)).size).toBe(6);
    expect(Object.entries(TAKE_ROLE).filter(([, v]) => v.heldOut).map(([k]) => k)).toEqual(['e', 'f']);
  });
  it('every instrument / feature in held-out is also in dev', () => {
    const dev = ALL!.filter((d) => !TAKE_ROLE[d.letter].heldOut).map((d) => infos.get(d.letter)!);
    const devInsts = new Set(dev.flatMap((i) => [...i.insts]));
    for (const d of ALL!.filter((x) => TAKE_ROLE[x.letter].heldOut)) {
      const i = infos.get(d.letter)!;
      for (const x of i.insts) expect(devInsts.has(x)).toBe(true);
      if (i.ghost) expect(dev.some((y) => y.ghost)).toBe(true);
      if (i.shuffle) expect(dev.some((y) => y.shuffle)).toBe(true);
    }
  });
  it.skipIf(!process.env.DRUM_SCORES_WRITE)('writes song texts and .txt templates', () => {
    mkdirSync(join(REC, 'drum-scores'), { recursive: true });
    mkdirSync(join(REC, 'drm-inbox'), { recursive: true });
    for (const d of ALL!) {
      writeFileSync(join(REC, 'drum-scores', `${d.letter}.song.txt`), songText(d));
      writeFileSync(join(REC, 'drm-inbox', `${d.letter}.txt`), txtTemplate(d));
    }
  });
});

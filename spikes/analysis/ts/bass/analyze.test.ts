import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../dsp/analyze';
import { readMeta, readStage } from '../parity/stageFile';
import { analyzeWithBass, applyBass, BASS_STAGES, bassChords } from './analyze';
import { bassConfigHash, resolveBassConfig } from './config';

// Plan section 6 decisions 3-5: off = v1a bit for bit; on = only the bass fields change; truth is never read.
const dir = join(import.meta.dirname, '..', 'parity', 'fixtures', 'full-t116-straight-trim8s');
const y = () => readStage(dir, 'y', readMeta(dir)).data as Float32Array;

describe('analyzeWithBass', () => {
  it.runIf(existsSync(join(dir, 'result.json')))('default config (bass off) = analyze() exactly', () => {
    const a = analyzeWithBass(y(), { timings: false });
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(analyze(y(), { timings: false }).result));
    expect(a.result).not.toHaveProperty('bassAnalyzer');
  }, 120_000);

  it.runIf(existsSync(join(dir, 'result.json')))('bass on: v1a chords kept, bass fields only on marked chords, stages and hash written', () => {
    const cfg = resolveBassConfig({ enabled: true });
    const v1a = analyze(y(), { timings: false }).result;
    const out = analyzeWithBass({ y: y() }, { bass: cfg, commit: 'abc1234' });
    const r = out.result;
    expect(r.bassAnalyzer).toEqual({ config: 'bass-v0', configHash: bassConfigHash(cfg), commit: 'abc1234' });
    expect(out.stats.map((s) => s.name).slice(-2)).toEqual([...BASS_STAGES]);
    expect(Object.keys(r.analyzer.timingsSec ?? {})).toEqual(expect.arrayContaining([...BASS_STAGES, 'total']));
    expect(r.chords.length).toBe(v1a.chords.length);
    expect(r.beats).toEqual(v1a.beats);
    r.chords.forEach((c, i) => {
      const o = v1a.chords[i];
      expect([c.start, c.end, c.root, c.quality, c.confidence]).toEqual([o.start, o.end, o.root, o.quality, o.confidence]);
      if (c.bass === null) {
        expect(c).toEqual(o);
        return;
      }
      expect(c.bass).not.toBe(c.root);
      expect(c.text).toBe(o.text.replace(/(\?)?$/, `/${c.bass}$1`));
      expect(c.bassConfidence).toBeGreaterThanOrEqual(cfg.slash.minConfidence);
      expect(['inversion', 'passing', 'pedal']).toContain(c.bassKind);
      expect(c.bassCandidates).toHaveLength(1);
      expect(c.bassCandidates![0].bass).not.toBe(c.bass);
      expect(c.bassCandidates![0].confidence).toBeGreaterThanOrEqual(0);
      expect(c.bassCandidates![0].confidence).toBeLessThanOrEqual(1);
    });
  }, 120_000);

  it('applyBass writes C/E with its second candidate on a key-C toy (v1a segments C - C - F, bass C E F)', () => {
    const frameSec = 512 / 22050;
    const cols = Math.ceil(6 / frameSec) + 1;
    const semi = new Float32Array(60 * cols);
    const row = (sec: number) => (sec < 2 ? 12 : sec < 4 ? 16 : 17); // C2, E2, F2 (row 0 = C1)
    for (let t = 0; t < cols; t++) semi[row(t * frameSec) * cols + t] = 1;
    const low = { semi, nSemis: 60, cols, midi0: 24, frameSec, tuning: 0 };
    const ch = (start: number, root: string) => ({ start, end: start + 2, root, quality: 'maj', bass: null, text: root, confidence: 0.9 });
    const v1a = { analyzer: {}, beats: Array.from({ length: 12 }, (_, i) => ({ t: i * 0.5, downbeat: i % 4 === 0 })), chords: [ch(0, 'C'), ch(2, 'C'), ch(4, 'F')] } as never;
    const r = applyBass(low, v1a, resolveBassConfig({ enabled: true }));
    expect(r.chords[0]).toBe((v1a as { chords: unknown[] }).chords[0]);
    expect(r.chords[2]).toBe((v1a as { chords: unknown[] }).chords[2]);
    expect(r.chords[1]).toMatchObject({ root: 'C', bass: 'E', text: 'C/E', bassKind: 'inversion' });
    expect(r.chords[1].bassConfidence).toBeGreaterThan(0.9);
    // second reading: a neighbour segment's bass leaking over the boundary frames, far below the first
    expect(r.chords[1].bassCandidates).toHaveLength(1);
    expect(['C', 'F']).toContain(r.chords[1].bassCandidates![0].bass);
    expect(r.chords[1].bassCandidates![0].confidence).toBeLessThan(0.1);
    expect(r.bassAnalyzer?.config).toBe('bass-v0');
  });

  it('refuses the stage that is not built yet (B-4 notes)', () => {
    const low = { semi: new Float32Array(60), nSemis: 60, cols: 1, midi0: 24, frameSec: 0.023, tuning: 0 };
    const r = { beats: [], chords: [] } as never;
    expect(() => applyBass(low, r, resolveBassConfig({ enabled: true, notes: { enabled: true } }))).toThrow(/not built/);
  });

  describe('bassChords with the B-3 split (T10)', () => {
    const frameSec = 512 / 22050;
    const toy = (spans: [number, number, number][], sec: number) => {
      const cols = Math.ceil(sec / frameSec) + 1;
      const semi = new Float32Array(60 * cols);
      for (let t = 0; t < cols; t++) for (const [s, e, row] of spans) if (t * frameSec >= s && t * frameSec < e) semi[row * cols + t] = 1;
      return { semi, nSemis: 60, cols, midi0: 24, frameSec, tuning: 0 };
    };
    const beats = Array.from({ length: 25 }, (_, i) => i * 0.5);
    const ch = (start: number, end: number, root: string) => ({ start, end, root, quality: 'maj', bass: null, text: root });
    const on = resolveBassConfig({ enabled: true, cliche: { split: true } });

    it('one v1a C over a descending line -> C, C/B, C/A#, C/A (passing); off -> the C unchanged', () => {
      const low = toy([[0, 2, 12], [2, 4, 11], [4, 6, 10], [6, 8, 9], [8, 10, 17]], 10); // C2 B1 A#1 A1 | F2
      const v1a = [ch(0, 8, 'C'), ch(8, 10, 'F')];
      expect(bassChords(low, v1a, beats, on).map((c) => [c.start, c.end, c.text, c.bassKind ?? null])).toEqual([
        [0, 2, 'C', null],
        [2, 4, 'C/B', 'passing'],
        [4, 6, 'C/A#', 'passing'],
        [6, 8, 'C/A', 'passing'],
        [8, 10, 'F', null],
      ]);
      const off = bassChords(low, v1a, beats, resolveBassConfig({ enabled: true }));
      expect(off[0]).toBe(v1a[0]);
      expect(off).toHaveLength(2);
    });

    it('a split whose pieces get no mark is undone (the v1a chord object comes back)', () => {
      const low = toy([[0, 1, 12], [1, 2, 14], [2, 4, 17]], 4); // C2 then D2 under C, then F2 under F
      const v1a = [ch(0, 2, 'C'), ch(2, 4, 'F')];
      const out = bassChords(low, v1a, beats, on);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe(v1a[0]);
    });
  });

  it('never reads ground truth: the bass analyzer imports no scoring, truth, render or file code', () => {
    for (const f of ['analyze.ts', 'cliche.ts', 'redecide.ts', 'slash.ts', 'segmentBass.ts']) {
      const src = readFileSync(join(import.meta.dirname, f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.length).toBeGreaterThan(0);
      for (const p of imports) expect(p).not.toMatch(/score|truth|render|segment_eval|heldout|\/cli$|node:/);
    }
  });
});

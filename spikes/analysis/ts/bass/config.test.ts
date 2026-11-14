import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASS_CONFIG_GROUPS, DEFAULT_BASS_CONFIG, bassConfigCanonical, bassConfigHash, enabledBassConfig, resolveBassConfig } from './config';
import { analyze } from '../dsp/analyze';
import { readMeta, readStage } from '../parity/stageFile';

const PINNED = '9c4d53b4e54e'; // bass-v0 after T10 (T9: 254af76bfe61, T6/T8: dfed4fc0704f, T5: 5170bd9d0922, T0: b30ed4697543)
/** Bass ON after G2 (B-3 split + root re-decision ON; docs/audio-spike6-plan.md); T10 004f3b7b38f7, T9 3bea9f3db99d, the T8 baseline (docs/audio-spike6-t8.md) 9b8d16cf12cb. */
const PINNED_ENABLED = 'e5b432a11e3c';

describe('bass config hash', () => {
  it('is 12 hex chars and stable (pinned)', () => {
    expect(bassConfigHash()).toMatch(/^[0-9a-f]{12}$/);
    expect(bassConfigHash()).toBe(PINNED);
    expect(bassConfigHash(enabledBassConfig())).toBe(PINNED_ENABLED);
  });
  it('does not depend on key order', () => {
    const rev = Object.fromEntries(Object.entries(DEFAULT_BASS_CONFIG).reverse()) as typeof DEFAULT_BASS_CONFIG;
    expect(Object.keys(rev)[0]).not.toBe(Object.keys(DEFAULT_BASS_CONFIG)[0]);
    expect(bassConfigCanonical(rev)).toBe(bassConfigCanonical());
  });
  it('resolve applies nested overrides, rejects unknown keys and wrong types', () => {
    const a = resolveBassConfig({ slash: { minConfidence: 0.7 }, enabled: true });
    expect(a.slash.minBeats).toBe(1);
    expect(bassConfigHash(a)).not.toBe(bassConfigHash());
    expect(bassConfigHash(resolveBassConfig({}))).toBe(bassConfigHash());
    expect(() => resolveBassConfig({ nope: 1 })).toThrow(/unknown/);
    expect(() => resolveBassConfig({ slash: { minBeats: '1' } })).toThrow(/expected number/);
    expect(() => resolveBassConfig({ enabled: 1 })).toThrow(/expected boolean/);
    expect(() => resolveBassConfig([])).toThrow();
  });
  it('plan values: every group present, bass stage and every switch OFF by default', () => {
    const c = DEFAULT_BASS_CONFIG;
    expect(Object.keys(c).filter((k) => k !== 'name' && k !== 'enabled')).toEqual([...BASS_CONFIG_GROUPS]);
    expect(c.enabled).toBe(false);
    expect([c.cliche.split, c.cliche.redecideRoot, c.notes.enabled]).toEqual([false, false, false]);
    expect(Object.isFrozen(c) && Object.isFrozen(c.slash)).toBe(true);
  });
});

// Plan section 6 decision 3: with the bass stage off the output is v1a's, bit for bit (chords[].bass stays null).
describe('default path equals v1a (committed parity fixture)', () => {
  const dir = join(import.meta.dirname, '..', 'parity', 'fixtures', 'full-t116-straight-trim8s');
  it.runIf(existsSync(join(dir, 'result.json')))('analyze() output has no bass fields and matches the committed result.json keys', () => {
    const y = readStage(dir, 'y', readMeta(dir)).data;
    const out = JSON.parse(JSON.stringify(analyze(y).result)) as { chords: Record<string, unknown>[]; bassNotes?: unknown };
    const py = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as { chords: Record<string, unknown>[] };
    expect(out.chords.length).toBe(py.chords.length);
    for (const [i, c] of out.chords.entries()) {
      expect(c.bass).toBeNull();
      expect(Object.keys(c).sort()).toEqual(Object.keys(py.chords[i]).sort());
      expect(c).not.toHaveProperty('bassConfidence');
      expect(c).not.toHaveProperty('bassKind');
    }
    expect(out).not.toHaveProperty('bassNotes');
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import { gateSingle, parseArgs, planAll, UsageError, type SynVariant } from './cli';
import { DEFAULT_BASS_CONFIG, enabledBassConfig } from './config';
import type { GuardSources } from './heldout_guard';

const v = (name: string, split: string, timbre: string): SynVariant => ({ name, wav: `${name}.wav`, split, heldOut: split === 'heldOut', timbre, level: 'B0', audioSec: 30 });
const syn = [v('syn-b0-whole-tA-s1', 'tuning', 'A'), v('syn-b1-whole-tB-s4', 'dev', 'B'), v('syn-b0-whole-tC-s6', 'heldOut', 'C')];
const src: GuardSources = { syn, rec: null, ids: { 'bas-01-a': { heldOut: false }, 'bas-05-e': { heldOut: true } } };

describe('bass CLI arguments and config', () => {
  it('parses --all, splits, only, dev look; default split is tuning only', () => {
    expect(parseArgs(['--all']).splits).toEqual(['tuning']);
    const a = parseArgs(['--all', '--split', 'tuning,dev', '--only', 'syn-b0-*', '--dev-look', 'why', '--task', 'T9', '--commit', 'abc']);
    expect(a).toMatchObject({ all: true, splits: ['tuning', 'dev'], only: 'syn-b0-*', devLook: 'why', task: 'T9', commit: 'abc' });
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--only'])).toThrow(/needs a value/);
  });
  it('turns the bass stage on; overrides still apply (and may turn it off)', () => {
    expect(enabledBassConfig().enabled).toBe(true);
    expect(DEFAULT_BASS_CONFIG.enabled).toBe(false);
    expect(enabledBassConfig({ slash: { minConfidence: 0.3 } }).slash).toEqual({ minConfidence: 0.3, minBeats: 1, weakMinConfidence: 0.4 });
    expect(enabledBassConfig({ enabled: false }).enabled).toBe(false);
  });
  it('G2: the B-3 split and the root re-decision are ON in the bass-on config, OFF in the default; cliche overrides keep the rest', () => {
    expect(enabledBassConfig().cliche).toEqual({ split: true, minBeats: 2, redecideRoot: true, redecideRatio: 4 });
    expect(DEFAULT_BASS_CONFIG.cliche).toEqual({ split: false, minBeats: 2, redecideRoot: false, redecideRatio: 4 });
    expect(enabledBassConfig({ cliche: { redecideRoot: false } }).cliche).toEqual({ split: true, minBeats: 2, redecideRoot: false, redecideRatio: 4 });
    expect(() => enabledBassConfig([])).toThrow(/must be an object/);
  });
});

describe('bass CLI held-out guard and dev looks', () => {
  it('--all selects tuning; dev needs --dev-look', () => {
    expect(planAll(syn, { splits: ['tuning'] }).map((x) => x.name)).toEqual(['syn-b0-whole-tA-s1']);
    expect(() => planAll(syn, { splits: ['tuning', 'dev'] })).toThrow(/dev-look/);
    expect(planAll(syn, { splits: ['dev'], devLook: 'T7 run-through' }).map((x) => x.name)).toEqual(['syn-b1-whole-tB-s4']);
  });
  it('--all refuses the held-out split and any --only glob that matches a held-out variant', () => {
    expect(() => planAll(syn, { splits: ['heldOut'] })).toThrow(/refused/);
    expect(() => planAll(syn, { splits: ['tuning', 'heldOut'] })).toThrow(/refused/);
    expect(() => planAll(syn, { splits: ['tuning'], only: 'syn-b0-*' })).toThrow(/held-out/);
    expect(() => planAll(syn, { splits: ['tuning'], only: '*-tC-*' })).toThrow(/held-out/);
    expect(() => planAll(syn, { splits: ['tuning'], only: 'nothing' })).toThrow(/no variant/);
  });
  it('single file: refuses held-out / timbre C / unverifiable; dev synthetic needs --dev-look', () => {
    expect(gateSingle('out/bass/syn-b0-whole-tA-s1.wav', src)).toEqual({ dev: false });
    expect(() => gateSingle('out/bass/syn-b0-whole-tC-s6.wav', src)).toThrow(/timbre C/);
    expect(() => gateSingle('recordings/bas-05-e.wav', src)).toThrow(/held-out recording/);
    expect(() => gateSingle('song.wav', src)).toThrow(/unverifiable/);
    expect(() => gateSingle('syn-b0-whole-tA-s1.wav', { ...src, syn: null })).toThrow(/cannot verify/);
    expect(() => gateSingle('out/bass/syn-b1-whole-tB-s4.wav', src)).toThrow(/dev-look/);
    expect(gateSingle('out/bass/syn-b1-whole-tB-s4.wav', src, 'reason')).toEqual({ dev: true });
    expect(gateSingle('recordings/bas-01-a.wav', src)).toEqual({ dev: false });
  });
});

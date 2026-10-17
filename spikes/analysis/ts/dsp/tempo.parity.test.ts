/**
 * Parity of the tempo-rule events (tempo.event_times) against the Python dumps: from Python's
 * y_harm / onset_env the TS event times equal the float32 dump; the tempo rule then picks the same
 * candidate, and trackBeats with TS events reproduces Python's beat_times. Skips without dumps.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMeta, readStage } from '../parity/stageFile';
import { trackBeats, type BeatDebug } from './beats';
import { tempoEventTimes } from './tempo';

const PARITY = join(import.meta.dirname, '../../out/parity');
const NEEDED = ['y_harm', 'y_perc', 'onset_env', 'tempo_event_times', 'beat_times'];
const variants = existsSync(PARITY)
  ? readdirSync(PARITY).filter((v) => {
      if (!existsSync(join(PARITY, v, 'meta.json'))) return false;
      const m = readMeta(join(PARITY, v));
      return NEEDED.every((s) => s in m.stages);
    })
  : [];

const rows: string[] = [];

describe.skipIf(variants.length === 0)('tempo events parity (Python dumps)', () => {
  it.each(variants)('%s', (v) => {
    const dir = join(PARITY, v);
    const meta = readMeta(dir);
    const sr = (meta.sr as number) ?? 22050;
    const hop = (meta.hop as number) ?? 512;
    const yHarm = readStage(dir, 'y_harm', meta).data;
    const yPerc = readStage(dir, 'y_perc', meta).data;
    const onsetEnv = readStage(dir, 'onset_env', meta).data;
    const py = readStage(dir, 'tempo_event_times', meta).data;
    const pyFinal = readStage(dir, 'beat_times', meta).data;

    const t0 = performance.now();
    const ev = tempoEventTimes({ onsetEnv, yHarm, sr, hop });
    const ms = performance.now() - t0;
    expect(ev.length).toBe(py.length);
    let maxDiff = 0;
    for (let i = 0; i < py.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(ev[i] - py[i]));
      expect(Math.fround(ev[i])).toBe(py[i]);
    }

    const dbg: BeatDebug = {};
    const grid = trackBeats({ onsetEnv, yPerc, sr, hop }, () => ev, dbg);
    const chosenPy = meta.tempoChosen as string | null | undefined;
    if (chosenPy != null) expect(dbg.chosen).toBe(chosenPy);
    expect(Array.from(grid.times, Math.fround)).toEqual(Array.from(pyFinal));

    rows.push(
      `${v.padEnd(46)} events ${ev.length}/${py.length} maxΔ ${maxDiff.toExponential(1)} | chosen ${dbg.chosen}/${chosenPy}` +
        ` | beats ${grid.times.length} exact | ${(ms / 1000).toFixed(1)}s for ${(yHarm.length / sr).toFixed(0)}s`,
    );
  });

  it('summary', () => {
    console.log(['tempo events parity:', ...rows].join('\n'));
  });
});

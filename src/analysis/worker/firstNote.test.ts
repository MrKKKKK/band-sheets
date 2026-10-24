import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HumAnalysisResult } from '../../lib/analysis/hum/types';
import { requantizeAtFirstNote } from './firstNote';

const golden = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../lib/analysis/fixtures/hum.expected.json'),
    'utf8',
  ),
) as { result: HumAnalysisResult };

/** The golden analysis as if it had been run with a useless start (bar 1 at 0 s). */
function placeholderRun(): HumAnalysisResult {
  const r = structuredClone(golden.result);
  r.hum.meta.info = { ...r.hum.meta.info, startSec: 0 };
  return r;
}

describe('requantizeAtFirstNote', () => {
  it('finds bar 1 from the first sung note and its bar position', () => {
    // The golden tune's first note is on beat 2 of bar 1 (tick 16) and bar 1 starts at 0.50 s.
    const out = requantizeAtFirstNote(placeholderRun(), 16);
    const q = out.melody.quantized;
    expect(q.startSec).toBeCloseTo(golden.result.melody.quantized.startSec, 1);
    const shape = (r: HumAnalysisResult) =>
      r.melody.quantized.events.map((e) => [
        e.kind,
        e.startTick,
        e.ticks,
        e.kind === 'note' ? e.midi : null,
      ]);
    expect(shape(out)).toEqual(shape(golden.result));
    expect(out.hum.meta.info.firstNoteTick).toBe(16);
    expect(out.hum.meta.info.startSec).toBeUndefined();
    expect(out.hum.meta.grid.startMode).toBe('firstNote');
  });

  it('puts the first note at bar 1 beat 1 for tick 0', () => {
    const q = requantizeAtFirstNote(placeholderRun(), 0).melody.quantized;
    expect(q.events[0]).toMatchObject({ kind: 'note', startTick: 0 });
  });

  it('leaves a result without notes as it is', () => {
    const r = placeholderRun();
    r.melody.notes = [];
    expect(requantizeAtFirstNote(r, 0)).toBe(r);
  });
});

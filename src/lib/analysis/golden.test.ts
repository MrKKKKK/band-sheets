/**
 * Frozen ("golden") tests: the ported analyzers must give the same results as the research branch's
 * TS analyzers did at `ORIGIN_COMMIT` (docs/audio-integration-plan.md section 2.4).
 *
 * Fixtures (src/lib/analysis/fixtures/, SYNTHETIC audio only, ~485 KB of wav in total):
 *   chords.wav  7 s, 22050 Hz mono 16-bit: the first 7 s of the research variant `etude-full-t140-straight`
 *               (render/cli.ts: alphaTab + sonivox soundfont; piano + drums + melody, 140 BPM, 4/4).
 *   hum.wav     8 s, 11025 Hz mono 16-bit: 8 s of the research variant `syn-h0-saints-s1` (render/hum/cli.ts,
 *               tuning split, not held out) starting 94500 samples (2.142857 s) into the 44.1 kHz render.
 *   *.expected.json  what the research branch's `analyze()` / `analyzeHum()` produced for exactly these samples.
 *               Chords: `analyze(y, { timings: false })`. Hum: `analyzeHum(y, sr, info, { f0Track: true,
 *               sourceKind: 'synthetic' })` with `hum.meta.timings` removed (timings are not reproducible).
 * To regenerate (only when re-porting from the research branch): in a worktree of `research/audio-analysis`
 * render the two variants (`npx tsx render/cli.ts --out OUT --only etude-full-t140-straight`,
 * `npx tsx render/hum/cli.ts --out OUT --only syn-h0-saints-s1`) and run fixtures/gen-golden.ts.txt (copy it to
 * spikes/analysis/_gen-golden.ts there) with `npx tsx _gen-golden.ts GOLD_DIR FIXTURES_DIR`.
 *
 * Comparison: strings, booleans, array lengths and object keys must be equal; numbers within 1e-6.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from './chords/analyze';
import { analyzeHum } from './hum/analyze';
import { melodyRoundTrip } from './hum/toMelody';
import type { HumInput, QuantizedMelody } from './hum/types';

const DIR = join(import.meta.dirname, 'fixtures');

/** 44-byte header, then 16-bit little-endian mono PCM (what fixtures/gen-golden.ts.txt writes). */
function readPcmWav(name: string): { y: Float32Array; sr: number } {
  const b = readFileSync(join(DIR, name));
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = (b.byteLength - 44) / 2;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = v.getInt16(44 + i * 2, true) / 32768;
  return { y, sr: v.getUint32(24, true) };
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), 'utf8'));
}

const TOL = 1e-6;

/** Collects every difference between `actual` and `expected` (path + reason); empty = equal. */
function diff(
  actual: unknown,
  expected: unknown,
  path = '$',
  out: string[] = [],
): string[] {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !(Math.abs(actual - expected) <= TOL)) {
      out.push(`${path}: ${String(actual)} vs ${expected}`);
    }
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      out.push(
        `${path}: length ${Array.isArray(actual) ? actual.length : typeof actual} vs ${expected.length}`,
      );
    } else {
      expected.forEach((e, i) => diff(actual[i], e, `${path}[${i}]`, out));
    }
  } else if (expected !== null && typeof expected === 'object') {
    if (
      actual === null ||
      typeof actual !== 'object' ||
      Array.isArray(actual)
    ) {
      out.push(`${path}: not an object`);
    } else {
      const a = actual as Record<string, unknown>;
      const e = expected as Record<string, unknown>;
      const ka = Object.keys(a).sort();
      const ke = Object.keys(e).sort();
      if (ka.join() !== ke.join())
        out.push(`${path}: keys ${ka.join()} vs ${ke.join()}`);
      else for (const k of ke) diff(a[k], e[k], `${path}.${k}`, out);
    }
  } else if (actual !== expected) {
    out.push(
      `${path}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
    );
  }
  return out;
}

/** What the result would look like in a JSON file (drops undefined, class instances, typed arrays as plain). */
function viaJson(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x));
}

describe('golden: ported analyzers reproduce the research branch', () => {
  it('diff() finds changes (the comparison itself is not vacuous)', () => {
    expect(diff({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(diff({ a: [1, 2 + 1e-5] }, { a: [1, 2] })).toHaveLength(1);
    expect(diff({ a: [1] }, { a: [1, 2] })).toHaveLength(1);
    expect(diff({ a: 'x' }, { a: 'y' })).toHaveLength(1);
    expect(diff({ a: 1 }, { b: 1 })).toHaveLength(1);
  });

  it('chords / beats / sections / key: analyze() equals chords.expected.json', () => {
    const { y, sr } = readPcmWav('chords.wav');
    expect(sr).toBe(22050);
    const { result } = analyze(y, { timings: false });
    const expected = readJson('chords.expected.json') as {
      chords: unknown[];
      beats: unknown[];
    };
    // the fixture is not degenerate
    expect(expected.chords.length).toBeGreaterThanOrEqual(4);
    expect(expected.beats.length).toBeGreaterThanOrEqual(10);
    expect(diff(viaJson(result), expected)).toEqual([]);
  });

  it('hum: analyzeHum() equals hum.expected.json (f0 track, notes, quantized melody)', () => {
    const { y, sr } = readPcmWav('hum.wav');
    expect(sr).toBe(11025);
    const exp = readJson('hum.expected.json') as {
      info: HumInput;
      result: { melody: { notes: unknown[] }; hum: { f0?: { hz: unknown[] } } };
    };
    expect(exp.result.melody.notes.length).toBeGreaterThanOrEqual(6);
    expect(exp.result.hum.f0?.hz.length).toBeGreaterThan(100);
    const r = analyzeHum(y, sr, exp.info, {
      f0Track: true,
      sourceKind: 'synthetic',
    });
    const got = viaJson(r) as { hum: { meta: { timings?: unknown } } };
    delete got.hum.meta.timings;
    expect(diff(got, exp.result)).toEqual([]);
    // the quantized melody still goes through the app's melody model unchanged
    // (splitAtBars -> serializeMelody -> parseMelody)
    const rt = melodyRoundTrip(r.melody.quantized as QuantizedMelody);
    expect(rt.events.length).toBeGreaterThan(0);
    expect(rt.parsed).toBe(true);
    expect(rt.identical).toBe(true);
  });
});

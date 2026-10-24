/**
 * One-off speed / memory measurement of the real analysis path in Chromium (plan sections 6.1 and 7), skipped
 * unless ANALYSIS_PERF=1:
 *   ANALYSIS_PERF=1 npx playwright test e2e/analysis-perf.spec.ts --project chromium
 * Input: the SYNTHETIC golden fixtures looped to 5 minutes (chords: 48 kHz stereo, hum: 44.1 kHz mono, so decode
 * and resample do real work), written under test-results/ (gitignored). Never user recordings.
 * Time = harness run (decode on the page + Worker analysis). Memory = renderer-process VmRSS from /proc, polled
 * every 100 ms (before = just before the run, increase = peak - before), as in spikes 3 and 4.
 * Targets (plan section 6.1): chords <= 40 s / +300 MB, hum <= 10 s / +150 MB.
 */
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Harness,
  HarnessOutcome,
  HarnessRunOptions,
} from '../src/analysis/testing/harness';
import {
  GEN_DIR,
  loopTo,
  readFixtureJson,
  readFixtureWav,
  writeWav16,
} from './support/analysisAudio';

test.skip(!process.env.ANALYSIS_PERF, 'set ANALYSIS_PERF=1 to measure');
test.setTimeout(300_000);

function rendererRssMb(): number {
  let max = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (
        !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(
          '--type=renderer',
        )
      )
        continue;
      const m = /VmRSS:\s+(\d+) kB/.exec(
        readFileSync(`/proc/${pid}/status`, 'utf8'),
      );
      if (m) max = Math.max(max, Number(m[1]) / 1024);
    } catch {
      /* process gone */
    }
  }
  return max;
}

const CASES = [
  {
    kind: 'chords' as const,
    make: () => {
      const { y, sr } = readFixtureWav('chords.wav');
      return writeWav16(
        'chords-5min-48k-stereo.wav',
        loopTo(y, sr, 300, 48000),
        48000,
        2,
      );
    },
    opts: {} as HarnessRunOptions,
    targetSec: 40,
    targetMb: 300,
  },
  {
    kind: 'hum' as const,
    make: () => {
      const { y, sr } = readFixtureWav('hum.wav');
      return writeWav16(
        'hum-5min-44k-mono.wav',
        loopTo(y, sr, 300, 44100),
        44100,
        1,
      );
    },
    opts: {
      info: readFixtureJson<{ info: NonNullable<HarnessRunOptions['info']> }>(
        'hum.expected.json',
      ).info,
    } as HarnessRunOptions,
    targetSec: 10,
    targetMb: 150,
  },
];

const rows: Record<string, unknown>[] = [];

for (const c of CASES) {
  test(`perf: ${c.kind}, 5 min synthetic`, async ({ page }) => {
    const file = c.make();
    await page.goto('/e2e/harness/analysis.html');
    await page.waitForFunction(() => '__analysis' in window);
    await page.setInputFiles('#file', file);
    await page.waitForTimeout(1000); // let the page settle before the baseline
    const before = rendererRssMb();
    let peak = before;
    const timer = setInterval(
      () => (peak = Math.max(peak, rendererRssMb())),
      100,
    );
    const out: HarnessOutcome = await page.evaluate(
      ([k, o]) =>
        (window as unknown as { __analysis: Harness }).__analysis.run(k, {
          ...o,
          summaryOnly: true,
        }),
      [c.kind, c.opts] as const,
    );
    clearInterval(timer);
    peak = Math.max(peak, rendererRssMb());
    expect(out).toMatchObject({ ok: true });
    const row = {
      kind: c.kind,
      seconds: Number((out.ms / 1000).toFixed(2)),
      targetSec: c.targetSec,
      rssBeforeMb: Math.round(before),
      rssPeakMb: Math.round(peak),
      rssIncreaseMb: Math.round(peak - before),
      targetMb: c.targetMb,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    writeFileSync(
      join(GEN_DIR, 'perf.json'),
      JSON.stringify(rows, null, 1) + '\n',
    );
  });
}

/**
 * Drum Worker path (spike 5 T8): one tuning-split synthetic wav through file input -> decodeAudioData -> transfer ->
 * drumWorker -> analyzeDrums + conversion; the page shows hit counts and timings only. Also: a repeated input for the
 * time-per-minute figure (logged, not asserted: T13 judges it), a silent file shows the error code, and every request
 * stays on the page's own origin.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DRUM = join(import.meta.dirname, '../../out/drum');
const NAME = 'syn-d0-rock8-kA-s1'; // tuning split (never held-out)

function silentWav(sec: number, sr = 22050): Buffer {
  const n = sec * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  return b;
}

test.skip(!existsSync(join(DRUM, `${NAME}.wav`)), 'synthetic drum variants not rendered (out/drum is gitignored)');

type Run = { audioSec: number; hitCount: number; gridCount: number; stagesMs: Record<string, number>; analysisMs: number; totalMs: number; configHash: string; roundTrip: { identical: boolean } };
const runs = () => (window as unknown as { __drumBench: { runs: { summary: Run }[] } }).__drumBench.runs;

test('drum Worker analyzes a synthetic wav; repeated input gives time per minute; silent input gives the error code', async ({ page }) => {
  const foreign: string[] = [];
  const origin = 'http://127.0.0.1:5185';
  page.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  await page.goto('/drumBench.html');
  await page.waitForFunction(() => (window as unknown as { __drumBench: { ready: boolean } }).__drumBench.ready);
  const manifest = JSON.parse(readFileSync(join(DRUM, 'manifest.json'), 'utf8')) as { variants: { name: string; bpm: number; startSec: number; heldOut: boolean; hits: number }[] };
  const v = manifest.variants.find((x) => x.name === NAME)!;
  expect(v.heldOut).toBe(false);
  await page.fill('#bpm', String(v.bpm));
  await page.fill('#start', String(v.startSec));
  await page.setInputFiles('#file', join(DRUM, `${NAME}.wav`));
  await page.click('#run');
  await page.waitForFunction(() => (window as unknown as { __drumBench: { runs: unknown[] } }).__drumBench.runs.length === 1, null, { timeout: 60_000 });
  const first = (await page.evaluate(runs))[0].summary;
  expect(first.hitCount).toBeGreaterThan(v.hits * 0.9);
  expect(first.hitCount).toBeLessThan(v.hits * 1.1);
  expect(first.gridCount).toBeGreaterThan(0);
  expect(first.roundTrip.identical).toBe(true);
  expect(Object.keys(first.stagesMs)).toEqual(['validate', 'onset', 'classify', 'quantize']);
  expect(first.configHash).toMatch(/^[0-9a-f]{12}$/);

  await page.fill('#repeat', '6');
  await page.click('#run');
  await page.waitForFunction(() => (window as unknown as { __drumBench: { runs: unknown[] } }).__drumBench.runs.length === 2, null, { timeout: 120_000 });
  const rep = (await page.evaluate(runs))[1].summary;
  expect(rep.audioSec).toBeGreaterThan(first.audioSec * 5.9);
  expect(rep.roundTrip.identical).toBe(true);
  console.log(`TIMING ${rep.audioSec.toFixed(1)} s audio: analysis ${(rep.analysisMs / 1000).toFixed(2)} s = ${((rep.analysisMs / 1000 / rep.audioSec) * 60).toFixed(2)} s per audio minute; stages ${JSON.stringify(rep.stagesMs)}`);

  await page.fill('#repeat', '1');
  await page.setInputFiles('#file', { name: 'silent.wav', mimeType: 'audio/wav', buffer: silentWav(2) });
  await page.click('#run');
  await expect(page.locator('#error')).toContainText('[silent]', { timeout: 30_000 });
  expect(foreign).toEqual([]);
});

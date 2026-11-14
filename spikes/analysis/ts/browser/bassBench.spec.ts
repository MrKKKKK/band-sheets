/**
 * Bass Worker path (spike 6 T7): one tuning-split synthetic bass wav through file input -> decodeAudioData -> transfer ->
 * worker.ts, once without and once with the bass stage. Checks: without it the summary has no bass part and no bass
 * stages (v1a path); with it the chord count is unchanged, the two bass stages ran and some chords got a /X (counts only).
 * Also: a repeated input for the added time per minute (logged, not asserted: T12 judges it), a silent file shows the
 * error code, and every request stays on the page's own origin (no network).
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASS = join(import.meta.dirname, '../../out/bass');
const NAME = 'syn-b1-walking-tA-s1'; // tuning split (never held-out)

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

test.skip(!existsSync(join(BASS, `${NAME}.wav`)), 'synthetic bass variants not rendered (out/bass is gitignored)');

type Summary = { stages: { name: string; ms: number }[]; totalMs: number; memPeak: number; chords: number; resultJsonBytes: number; bass?: { configHash: string; marked: number } };
type Row = { bass: boolean; inputSec: number; summary: Summary; workerHeap?: number };
const runs = () => (window as unknown as { __bassBench: { runs: Row[] } }).__bassBench.runs;
const BASS_STAGES = ['bassLowCqt', 'bass'];

test('chord Worker without / with the bass stage; repeated input gives the added time; silent input gives the error code', async ({ page }) => {
  const foreign: string[] = [];
  const origin = 'http://127.0.0.1:5187';
  page.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  await page.goto('/bassBench.html');
  await page.waitForFunction(() => (window as unknown as { __bassBench: { ready: boolean } }).__bassBench.ready);
  const manifest = JSON.parse(readFileSync(join(BASS, 'manifest.json'), 'utf8')) as { variants: { name: string; split: string; heldOut: boolean }[] };
  const v = manifest.variants.find((x) => x.name === NAME)!;
  expect([v.heldOut, v.split]).toEqual([false, 'tuning']);
  await page.setInputFiles('#file', join(BASS, `${NAME}.wav`));
  await page.click('#run');
  await page.waitForFunction(() => (window as unknown as { __bassBench: { runs: unknown[] } }).__bassBench.runs.length === 2, null, { timeout: 120_000 });
  const [off, on] = await page.evaluate(runs);
  expect([off.bass, on.bass]).toEqual([false, true]);
  expect(off.summary.bass).toBeUndefined();
  expect(off.summary.stages.some((s) => BASS_STAGES.includes(s.name))).toBe(false);
  expect(on.summary.stages.map((s) => s.name).slice(-2)).toEqual(BASS_STAGES);
  expect(on.summary.chords).toBe(off.summary.chords);
  expect(on.summary.bass?.configHash).toMatch(/^[0-9a-f]{12}$/);
  expect(on.summary.bass?.marked).toBeGreaterThan(0);
  expect(on.summary.resultJsonBytes).toBeGreaterThan(off.summary.resultJsonBytes);

  await page.fill('#repeat', '5');
  await page.click('#run');
  await page.waitForFunction(() => (window as unknown as { __bassBench: { runs: unknown[] } }).__bassBench.runs.length === 4, null, { timeout: 240_000 });
  const [roff, ron] = (await page.evaluate(runs)).slice(2);
  const min = ron.inputSec / 60;
  const bassMs = ron.summary.stages.filter((s) => BASS_STAGES.includes(s.name)).reduce((a, s) => a + s.ms, 0);
  const mb = (b: number | undefined) => (b === undefined ? '-' : (b / 2 ** 20).toFixed(1));
  console.log(
    `TIMING ${ron.inputSec.toFixed(1)} s audio: total off ${(roff.summary.totalMs / 1000).toFixed(2)} s, on ${(ron.summary.totalMs / 1000).toFixed(2)} s; ` +
      `bass stages ${(bassMs / 1000).toFixed(2)} s = ${(bassMs / 1000 / min).toFixed(2)} s per audio minute; ` +
      `memPeak off ${mb(roff.summary.memPeak)} MB, on ${mb(ron.summary.memPeak)} MB; worker heap off ${mb(roff.workerHeap)} MB, on ${mb(ron.workerHeap)} MB; ` +
      `JSON off ${roff.summary.resultJsonBytes} B, on ${ron.summary.resultJsonBytes} B`,
  );

  await page.fill('#repeat', '1');
  await page.setInputFiles('#file', { name: 'silent.wav', mimeType: 'audio/wav', buffer: silentWav(2) });
  await page.click('#run');
  await expect(page.locator('#error')).toContainText('[silent]', { timeout: 30_000 });
  expect(foreign).toEqual([]);
});

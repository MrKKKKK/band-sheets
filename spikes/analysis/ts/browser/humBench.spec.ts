/**
 * Humming Worker path (spike 4 T7): one dev synthetic wav (tuning split) through file input -> decodeAudioData ->
 * transfer -> humWorker -> analyzeHum; the page shows a note count and timings only. Also: a silent file shows the
 * spike-3 error code, and every request stays on the page's own origin.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HUM = join(import.meta.dirname, '../../out/hum');
const NAME = 'syn-h0-saints-s1'; // tuning split (never held-out)

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

test.skip(!existsSync(join(HUM, `${NAME}.wav`)), 'synthetic hum variants not rendered (out/hum is gitignored)');

test('humming Worker analyzes a synthetic wav; silent input gives the error code', async ({ page }) => {
  const foreign: string[] = [];
  const origin = 'http://127.0.0.1:5183';
  page.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  await page.goto('/humBench.html');
  await page.waitForFunction(() => (window as unknown as { __humBench: { ready: boolean } }).__humBench.ready);
  const manifest = JSON.parse(readFileSync(join(HUM, 'manifest.json'), 'utf8')) as { variants: { name: string; bpm: number; startSec: number; heldOut: boolean }[] };
  const v = manifest.variants.find((x) => x.name === NAME)!;
  expect(v.heldOut).toBe(false);
  await page.fill('#bpm', String(v.bpm));
  await page.fill('#start', String(v.startSec));
  await page.setInputFiles('#file', join(HUM, `${NAME}.wav`));
  await page.click('#run');
  await page.waitForFunction(() => (window as unknown as { __humBench: { runs: unknown[] } }).__humBench.runs.length === 1, null, { timeout: 60_000 });
  const run = await page.evaluate(() => (window as unknown as { __humBench: { runs: { summary: { noteCount: number; stagesMs: Record<string, number>; configHash: string } }[] } }).__humBench.runs[0].summary);
  expect(run.noteCount).toBeGreaterThan(25);
  expect(run.noteCount).toBeLessThan(45);
  expect(Object.keys(run.stagesMs)).toEqual(['validate', 'resample', 'f0', 'level', 'notes', 'quantize']);
  expect(run.configHash).toMatch(/^[0-9a-f]{12}$/);

  await page.setInputFiles('#file', { name: 'silent.wav', mimeType: 'audio/wav', buffer: silentWav(2) });
  await page.click('#run');
  await expect(page.locator('#error')).toContainText('[silent]', { timeout: 30_000 });
  expect(foreign).toEqual([]);
});

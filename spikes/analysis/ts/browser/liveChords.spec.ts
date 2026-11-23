/**
 * Smoke test of the live chord-check page: with a fake input device playing a synthetic C chord (liveChords.fixture.ts),
 * after calibration the page shows C for the chosen logic; no request leaves the page's origin, no page error. Also logs
 * the measured ms and updates/s per logic at a 1 s window (headless Chromium, no assertion on speed).
 */
import { expect, test } from '@playwright/test';

test('shows C for a synthetic C chord, per logic', async ({ page, baseURL }) => {
  const errors: string[] = [];
  const foreign: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith(baseURL!) && !r.url().startsWith('blob:')) foreign.push(r.url());
  });
  await page.goto('/liveChords.html');
  await expect(page.locator('#variant option[value="s8-cand"]')).toHaveAttribute('disabled', '');
  await page.locator('#variant').selectOption('v1a');
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.locator('#stats')).toContainText('（固定）', { timeout: 40_000 });
  await expect(page.locator('#answer')).toHaveText('C', { timeout: 30_000 });
  await expect(page.locator('#cands tr').first()).toContainText('C');
  await page.screenshot({ path: 'spikes/analysis/out/live/smoke.png' });
  for (const id of ['v1a', 'base', 's7-V1', 's8-D2', 's8-D1']) {
    await page.locator('#variant').selectOption(id);
    await page.waitForTimeout(8000);
    console.log(`${id}: answer=${await page.locator('#answer').textContent()} | ${await page.locator('#stats').textContent()}`);
  }
  expect(errors).toEqual([]);
  expect(foreign).toEqual([]);
});

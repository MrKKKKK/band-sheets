/**
 * T13 smoke: the page runs a measurement end to end in headless Chromium with the fake mic (which plays
 * its own beeps, not our clicks, so only "it runs and shows numbers or 拾えず" is checked). Also: no
 * request leaves the page's origin, and no page error.
 */
import { expect, test } from '@playwright/test';

test('measures twice with the fake mic and builds the copy text', async ({ page, baseURL }) => {
  const errors: string[] = [];
  const foreign: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith(baseURL!) && !r.url().startsWith('blob:')) foreign.push(r.url());
  });
  await page.goto('/micCheck.html');
  await page.getByRole('button', { name: 'マイクを使う' }).click();
  await expect(page.locator('#status')).toContainText('準備ができました', { timeout: 15_000 });
  await expect(page.locator('#env')).toContainText('echoCancellation=');
  for (let n = 1; n <= 2; n++) {
    await page.getByRole('button', { name: '計測する' }).click();
    await expect(page.locator('#status')).toContainText(`計測 ${n}`, { timeout: 20_000 });
  }
  await expect(page.locator('#runs tr')).toHaveCount(2);
  await expect(page.locator('#last')).toContainText(/クリックごとのずれ \(ms\): ((-?\d+\.\d\d|拾えず)(, )?){8}/);
  await page.getByRole('button', { name: '結果をコピー' }).click();
  await expect(page.locator('#copyOut')).toHaveValue(/計測\t方法/);
  console.log(await page.locator('#last').textContent());
  expect(errors).toEqual([]);
  expect(foreign).toEqual([]);
});

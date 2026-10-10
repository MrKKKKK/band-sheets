import { expect, test, type Locator, type Page } from '@playwright/test';
import { freshStart } from './support/app';

// Regression: with the page scrolled, entering a note (piano key, drum pad
// or keyboard) must keep the window's scroll position. alphaTab's default
// ScrollMode.Continuous used to smooth-scroll html/body to its beat cursor
// after every PartScore re-render, dragging the page to the preview.

// Short enough that the sample song's editor needs a scrollbar.
test.use({ viewport: { width: 1280, height: 600 } });

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

async function openSampleTab(page: Page, tab: 'メロディ' | 'ドラム') {
  await freshStart(page);
  await page
    .getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' })
    .click();
  await page.getByRole('tab', { name: tab }).click();
  const panel = page.getByRole('tabpanel', { name: tab });
  // The preview has rendered once before we start measuring.
  await expect(panel.locator('[data-state="rendered"]')).toHaveCount(1, {
    timeout: 10000,
  });
  return panel;
}

/**
 * Scrolls the window so `el` sits at the viewport's top or bottom edge
 * (still visible), somewhere strictly between the top and the bottom of the
 * page — so a jump either way would show.
 */
async function scrollTo(
  page: Page,
  el: Locator,
  block: 'start' | 'end',
): Promise<number> {
  await el.evaluate((e, b) => e.scrollIntoView({ block: b }), block);
  const y = await scrollY(page);
  const max = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(y).toBeGreaterThan(0);
  expect(y).toBeLessThan(max - 100);
  return y;
}

/**
 * The preview re-renders after a 400 ms debounce and the old scroll was a
 * smooth scroll started right after that render, so give it ample time.
 */
async function expectScrollKept(page: Page, panel: Locator, before: number) {
  await page.waitForTimeout(1500);
  await expect(panel.locator('[data-state="rendered"]')).toHaveCount(1);
  expect(await scrollY(page)).toBe(before);
}

test('melody: a piano key keeps the scroll position', async ({ page }) => {
  const panel = await openSampleTab(page, 'メロディ');
  const key = panel.getByRole('button', { name: 'ド4', exact: true });
  const before = await scrollTo(page, key, 'end');
  const notes = await panel.locator('[data-testid^="note-"]').count();

  // Lower half of the white key: ド♯4 covers its upper part.
  await key.click({ position: { x: 20, y: 140 } });
  await expect(panel.locator('[data-testid^="note-"]')).toHaveCount(notes + 1);
  await expectScrollKept(page, panel, before);
});

test('melody: keyboard input keeps the scroll position', async ({ page }) => {
  const panel = await openSampleTab(page, 'メロディ');
  const staff = panel.getByRole('application');
  await staff.focus();
  const before = await scrollTo(
    page,
    panel.getByRole('button', { name: 'ド4', exact: true }),
    'end',
  );
  const notes = await panel.locator('[data-testid^="note-"]').count();

  await staff.press('a');
  await expect(panel.locator('[data-testid^="note-"]')).toHaveCount(notes + 1);
  await expectScrollKept(page, panel, before);
});

test('drums: a drum pad keeps the scroll position', async ({ page }) => {
  const panel = await openSampleTab(page, 'ドラム');
  const pad = panel
    .getByRole('group', { name: 'ドラムパッド' })
    .getByRole('button')
    .first();
  const before = await scrollTo(page, pad, 'start');
  const heads = await panel.locator('[data-testid^="head-"]').count();

  await pad.click();
  await expect(panel.locator('[data-testid^="head-"]')).toHaveCount(heads + 1);
  await expectScrollKept(page, panel, before);
});

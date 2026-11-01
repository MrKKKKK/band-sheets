/**
 * T4-3 in the text editor: the 「? 書き方」 help and the full-width warning with 「半角に直す」.
 *
 * `SHOTS=1 npx playwright test e2e/dash-help.spec.ts` also writes screenshots to out/import/.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  draftText,
  openNewSong,
  setSongText,
  songTextarea,
} from './support/app';

const FULL = '｜[C]ーーーーーーーー｜[G]ーーーーーーーー｜';
const HALF = '|[C]--------|[G]--------|';

test('text editor: help popover, full-width warning and one-line fix', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const songId = await openNewSong(page);
  const text = `{title: t}\n{time: 4/4}\n\n{start_of_verse: A}\n${HALF}\n${FULL}\n[C]ひかるー[G]ほしー\n{end_of_verse}\n`;
  await setSongText(page, text);

  const help = page.getByRole('button', { name: '? 書き方' });
  await help.click();
  const dialog = page.getByRole('dialog', { name: 'コードだけの行の書き方' });
  await expect(dialog).toBeVisible();
  if (process.env.SHOTS)
    await page.screenshot({
      path: join(import.meta.dirname, '../out/import/editor-help.png'),
    });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(help).toBeFocused();

  const warning = page.getByTestId('fullwidth-warning-0-1');
  await expect(warning).toContainText('全角の記号があります（｜ ー －）。');
  await expect(page.getByTestId('fullwidth-warning-0-2')).toHaveCount(0);
  if (process.env.SHOTS)
    await page.screenshot({
      path: join(import.meta.dirname, '../out/import/editor-fullwidth.png'),
    });
  await warning.getByRole('button', { name: '半角に直す' }).click();
  await expect(warning).toHaveCount(0);
  const fixed = text.replace(FULL, HALF);
  await expect(songTextarea(page)).toHaveValue(fixed);
  await expect.poll(() => draftText(page, songId)).toBe(fixed);
});

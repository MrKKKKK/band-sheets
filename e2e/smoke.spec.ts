import { expect, test } from '@playwright/test';
import { openNewSong } from './support/app';

test('app loads', async ({ page }) => {
  await page.goto('/');
  // No songs and not signed in: the sign-in screen.
  await expect(
    page.getByRole('button', { name: 'ログインせずに編集を始める →' }),
  ).toBeVisible();
  await openNewSong(page);
});

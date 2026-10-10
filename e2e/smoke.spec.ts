import { expect, test } from '@playwright/test';
import { freshStart, openNewSong, readDraft, songIdOf } from './support/app';

test('app loads', async ({ page }) => {
  await page.goto('/');
  // No songs and not signed in: the sign-in screen.
  await expect(
    page.getByRole('button', { name: 'ログインせずに編集を始める →' }),
  ).toBeVisible();
  await openNewSong(page);
});

test('sample song: added from the sign-in screen, every section editable in the melody and drum editors', async ({
  page,
}) => {
  await freshStart(page);
  await page
    .getByRole('button', { name: 'サンプル曲を追加（聖者の行進） →' })
    .click();
  await expect(page).toHaveURL(/#\/edit\//);
  await expect(
    page.getByRole('heading', { level: 1, name: '聖者の行進' }),
  ).toBeVisible();
  const songId = songIdOf(page);
  expect((await readDraft(page, songId))?.text).toContain(
    '{title: 聖者の行進}',
  );

  for (const [tab, kind] of [
    ['メロディ', 'メロディ'],
    ['ドラム', 'ドラム'],
  ] as const) {
    await page.getByRole('tab', { name: tab }).click();
    const panel = page.getByRole('tabpanel', { name: tab });
    for (const label of ['A', 'B']) {
      await panel
        .getByRole('group', { name: 'セクション' })
        .getByRole('button', { name: label, exact: true })
        .click();
      // Editable: an input staff (role application), no read-only notice.
      await expect(
        panel.getByRole('application', {
          name: `セクション ${label} の${kind}`,
        }),
      ).toBeVisible();
      await expect(
        panel.getByText('このセクションはアプリでは編集できません'),
      ).toHaveCount(0);
    }
  }
});

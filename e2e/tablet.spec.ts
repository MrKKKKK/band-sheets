import { expect, test } from '@playwright/test';
import { freshStart, songText } from './support/app';
import { installFakeDrive } from './support/fakeDrive';

test('tablet: sign in → list → open for viewing only (no draft is created)', async ({
  page,
}) => {
  const drive = await installFakeDrive(page);
  drive.seed({
    name: '曲A.bandsheet',
    text: songText('曲A', 'ひかるよ'),
    songId: 'song-a',
    device: 'Windows PC',
  });
  drive.seed({
    name: '曲B.bandsheet',
    text: songText('曲B'),
    songId: 'song-b',
  });
  await freshStart(page);
  await page.getByRole('button', { name: 'Google でログイン' }).tap();

  await expect(page.getByTestId('tablet-song-list')).toBeVisible();
  await expect(page.getByTestId('song-row-song-a')).toBeVisible();
  await expect(page.getByTestId('song-row-song-b')).toBeVisible();
  await page.screenshot({ path: 'docs/m7-tablet-list.png' });

  await page.getByTestId('song-row-song-a').tap();
  await expect(page).toHaveURL(/#\/view\/song-a$/);
  await expect(page.getByTestId('viewer')).toHaveAttribute(
    'data-ready',
    'true',
  );
  // Viewing never writes a draft, and there is no way into the editor.
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k.startsWith('band-sheets:draft:'))).toEqual([]);
  await expect(page.getByRole('button', { name: '閲覧モード' })).toHaveCount(0);

  await page.getByRole('button', { name: '‹ 曲の一覧' }).first().tap();
  await expect(page.getByTestId('tablet-song-list')).toBeVisible();
  const after = await page.evaluate(() => Object.keys(localStorage));
  expect(after.filter((k) => k.startsWith('band-sheets:draft:'))).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { openNewSong, readDraft } from './support/app';

const chordTextarea = (page: Page) => page.getByLabel('ChordPro テキスト');

test('editor A → B → A round trip, persisted as a draft', async ({ page }) => {
  const songId = await openNewSong(page);

  // New song: editor A, step 1.
  await expect(
    page.getByRole('heading', { level: 1, name: '無題の曲' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'かんたん入力' }),
  ).toHaveAttribute('aria-pressed', 'true');

  // Key C → diatonic chips in the chord popover.
  await page.getByRole('button', { name: '曲情報を設定' }).click();
  const info = page.getByRole('dialog', { name: '曲情報' });
  await info.getByLabel('キー').fill('C');
  await info.getByRole('button', { name: '適用' }).click();

  await page
    .getByLabel('歌詞を貼り付け')
    .fill('きらきらひかる\nおそらのほしよ');
  await page.getByRole('button', { name: '反映' }).click();

  // Step 2: put F on 「ひ」 (line 0 of section 0, 5th character).
  const hi = page.getByTestId('char-0-0-4');
  await expect(hi).toHaveText('ひ');
  await hi.click();
  const popover = page.getByRole('dialog', { name: 'コードを置く' });
  await popover.getByRole('button', { name: 'F', exact: true }).click();
  await expect(popover).toBeHidden();
  await expect(page.getByTestId('chord-0-0-1')).toHaveText('F');

  // Editor B shows the same text.
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  const textarea = chordTextarea(page);
  await expect(textarea).toHaveValue(/きらきら\[F\]ひかる/);

  // Type [G] before 「よ」 at the caret.
  await textarea.evaluate((el: HTMLTextAreaElement) => {
    const i = el.value.indexOf('よ\n');
    el.focus();
    el.setSelectionRange(i, i);
  });
  await page.keyboard.type('[G]');
  await expect(textarea).toHaveValue(/おそらのほし\[G\]よ/);

  // Back in editor A, G sits above 「よ」.
  await page.getByRole('button', { name: 'かんたん入力' }).click();
  const g = page.getByTestId('chord-0-1-1');
  await expect(g).toHaveText('G');
  const yo = page.getByTestId('char-0-1-6');
  await expect(yo).toHaveText('よ');
  const gBox = (await g.boundingBox())!;
  const yoBox = (await yo.boundingBox())!;
  expect(Math.abs(gBox.x - yoBox.x)).toBeLessThan(4);
  expect(gBox.y).toBeLessThan(yoBox.y);

  // Autosaved draft survives a reload.
  await expect
    .poll(async () => (await readDraft(page, songId))?.text ?? '')
    .toContain('おそらのほし[G]よ');
  await page.reload();
  await expect(page.getByTestId('chord-0-0-1')).toHaveText('F');
  await expect(page.getByTestId('chord-0-1-1')).toHaveText('G');
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  await expect(chordTextarea(page)).toHaveValue(
    '{title: 無題の曲}\n{key: C}\n\n{start_of_verse: A}\nきらきら[F]ひかる\nおそらのほし[G]よ\n{end_of_verse}\n',
  );
});

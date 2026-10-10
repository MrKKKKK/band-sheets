import { expect, test, type Page } from '@playwright/test';
import { openNewSong, readDraft } from './support/app';

const chordTextarea = (page: Page) => page.getByLabel('ChordPro テキスト');

test('drums: type an 8-beat with keys, insert and fill a triplet, shuffle, write text, persist across reload', async ({
  page,
}) => {
  const songId = await openNewSong(page);

  // コード譜 / かんたん入力: create section A so the drum tab has somewhere
  // to write (otherwise it shows 「コード譜でセクションを作ってください」).
  await page.getByLabel('歌詞を貼り付け').fill('どんたんどんたん');
  await page.getByRole('button', { name: '反映' }).click();

  // ドラム タブ.
  await page.getByRole('tab', { name: 'ドラム' }).click();
  const staff = page.getByRole('application', {
    name: 'セクション A のドラム',
  });
  await expect(staff).toBeVisible();
  await staff.focus();

  // 8ビート: H = ハイハット(KeyH), J = バスドラム(KeyJ), F = スネア(KeyF).
  // Shift+楽器 adds the instrument to the beat just before the cursor, so
  // typing H then Shift+J/F right after builds the usual 8-beat pattern of
  // eighth-note hi-hats with kick/snare layered on top of some of them.
  await staff.press('h'); // beat 0: HH
  await staff.press('Shift+J'); // beat 0: + BD → (HH BD)
  await staff.press('h'); // beat 1: HH
  await staff.press('h'); // beat 2: HH
  await staff.press('Shift+F'); // beat 2: + SD → (HH SD), simultaneous hit
  await staff.press('h'); // beat 3: HH
  await staff.press('h'); // beat 4: HH
  await staff.press('Shift+J'); // beat 4: + BD → (HH BD)
  await staff.press('h'); // beat 5: HH
  await staff.press('h'); // beat 6: HH
  await staff.press('Shift+F'); // beat 6: + SD → (HH SD), simultaneous hit
  await staff.press('h'); // beat 7: HH — one full 4/4 bar of eighth notes

  // Shift+F really did add a simultaneous hit (not replace the HH).
  await expect(page.getByTestId('head-6-HH')).toBeVisible();
  await expect(page.getByTestId('head-6-SD')).toBeVisible();
  await expect(page.getByTestId('head-0-HH')).toBeVisible();
  await expect(page.getByTestId('head-0-BD')).toBeVisible();
  await expect(page.getByTestId('beat-7')).toBeVisible();

  // 連符ボタンで3連符を挿入（カーソルは次の小節の頭、休符3つ）して埋める。
  await page.getByRole('button', { name: '連符', exact: true }).click();
  await page.getByRole('button', { name: '3連符' }).click();
  await staff.press('f'); // triplet slot 1 → SD
  await staff.press('j'); // triplet slot 2 → BD
  await staff.press('h'); // triplet slot 3 → HH
  await expect(page.getByTestId('tuplet-8')).toBeVisible();

  // シャッフル 8分.
  await page.getByRole('button', { name: '8分', exact: true }).click();

  // コード譜 / テキスト入力: the drum part is written as alphaTex text.
  await page.getByRole('tab', { name: 'コード譜' }).click();
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  const textarea = chordTextarea(page);
  await expect(textarea).toHaveValue(/\\tf triplet8th/);
  await expect(textarea).toHaveValue(/\{tu 3\}/);
  await expect(textarea).toHaveValue(
    /\(HH BD\) HH \(HH SD\) HH \(HH BD\) HH \(HH SD\) HH/,
  );

  // Autosaved draft survives a reload.
  await expect
    .poll(async () => (await readDraft(page, songId))?.text ?? '')
    .toMatch(/\\tf triplet8th/);
  await page.reload();

  await page.getByRole('button', { name: 'テキスト入力' }).click();
  await expect(chordTextarea(page)).toHaveValue(/\\tf triplet8th/);
  await expect(chordTextarea(page)).toHaveValue(/\{tu 3\}/);

  await page.getByRole('tab', { name: 'ドラム' }).click();
  await expect(
    page.getByRole('application', { name: 'セクション A のドラム' }),
  ).toBeVisible();
  await expect(page.getByTestId('beat-7')).toBeVisible();
  await expect(page.getByTestId('tuplet-8')).toBeVisible();
});

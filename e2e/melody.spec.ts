import { expect, test, type Page } from '@playwright/test';
import { openNewSong, readDraft } from './support/app';

const chordTextarea = (page: Page) => page.getByLabel('ChordPro テキスト');

test('melody: type notes, import lyrics from the chart, persist across reload', async ({
  page,
}) => {
  const songId = await openNewSong(page);

  // Key C (コード譜 / 曲情報), same as editor.spec.ts.
  await page.getByRole('button', { name: '曲情報を設定' }).click();
  const info = page.getByRole('dialog', { name: '曲情報' });
  await info.getByLabel('キー').fill('C');
  await info.getByRole('button', { name: '適用' }).click();

  // コード譜 / かんたん入力: paste lyrics and 反映 → section A.
  await page
    .getByLabel('歌詞を貼り付け')
    .fill('きらきらひかる\nおそらのほしよ');
  await page.getByRole('button', { name: '反映' }).click();

  // メロディ タブ.
  await page.getByRole('tab', { name: 'メロディ' }).click();
  const staff = page.getByRole('application', {
    name: 'セクション A のメロディ',
  });
  await expect(staff).toBeVisible();
  // Focus programmatically rather than clicking the staff: a click inside
  // the pitch area places a note at that point (MelodyStaff's onClick),
  // which would add an extra, unintended note before the scripted ones.
  await staff.focus();

  // C C G G A A, then a half-note G (Digit2 = half, per DurationBar/
  // melodyInput.ts's DURATION_CODES), then quarter F F.
  for (const key of ['a', 'a', 'g', 'g', 'h', 'h']) {
    await staff.press(key);
  }
  await staff.press('2');
  await staff.press('g');
  await staff.press('4');
  await staff.press('f');
  await staff.press('f');

  // 9 notes now on the staff.
  for (let i = 0; i < 9; i++) {
    await expect(page.getByTestId(`note-${i}-0`)).toBeVisible();
  }

  // M2 regression: the alphaTab preview (mounted while the tab was hidden)
  // has drawn the melody part shortly after the tab opened.
  const preview = page.getByRole('region', { name: '仕上がりの確認' });
  // alphaTab lazy-loads: it draws a partial only once it's in the viewport.
  // (This used to pass only because alphaTab's own auto-scroll dragged the
  // page down to the preview — the bug editor-scroll.spec.ts guards.)
  const score = preview.locator('[data-state]');
  await expect(score).toHaveAttribute('data-state', 'rendered', {
    timeout: 5000,
  });
  await score.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await expect(preview.locator('svg').first()).toBeVisible({ timeout: 5000 });

  // コード譜から歌詞を取り込む: the chart's syllables (き ら き ら ひ か る
  // お そ ら の ほ し よ) land on the notes in order; only the first 9 fit.
  await page
    .getByRole('button', { name: 'コード譜から歌詞を取り込む' })
    .click();
  const lyricsAtNotes = ['き', 'ら', 'き', 'ら', 'ひ', 'か', 'る', 'お', 'そ'];
  for (const [i, lyric] of lyricsAtNotes.entries()) {
    await expect(page.getByTestId(`lyric-${i}`)).toHaveText(lyric);
  }

  // Keyboard only: select 「る」 (Enter = the note before the cursor) and
  // のばす (N): the next note becomes its melisma, 「お」 moves one right.
  await staff.focus();
  await staff.press('ArrowLeft');
  await staff.press('ArrowLeft');
  await staff.press('Enter');
  await expect(page.getByTestId('selection')).toBeVisible();
  await staff.press('n');
  await expect(page.getByTestId('lyric-6')).toHaveText('る');
  await expect(page.getByTestId('lyric-7')).toHaveCount(0);
  await expect(page.getByTestId('lyric-8')).toHaveText('お');

  // コード譜 / テキスト入力: the melody part is written as alphaTex text.
  await page.getByRole('tab', { name: 'コード譜' }).click();
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  const textarea = chordTextarea(page);
  await expect(textarea).toHaveValue(/\\section "A"/);
  await expect(textarea).toHaveValue(/lyrics "き"/);
  await expect(textarea).toHaveValue(/{start_of_part: Vocal}/);

  // Autosaved draft survives a reload.
  await expect
    .poll(async () => (await readDraft(page, songId))?.text ?? '')
    .toMatch(/lyrics "き"/);
  await page.reload();

  await page.getByRole('tab', { name: 'メロディ' }).click();
  await expect(page.getByTestId('lyric-0')).toHaveText('き');
  await expect(page.getByTestId('lyric-6')).toHaveText('る');
});

test('melody: insert a triplet and fill it, writing {tu 3} to the text', async ({
  page,
}) => {
  await openNewSong(page);

  // コード譜 / かんたん入力: create section A so the melody tab has
  // somewhere to write.
  await page.getByLabel('歌詞を貼り付け').fill('どれみふぁそ');
  await page.getByRole('button', { name: '反映' }).click();

  // メロディ タブ.
  await page.getByRole('tab', { name: 'メロディ' }).click();
  const staff = page.getByRole('application', {
    name: 'セクション A のメロディ',
  });
  await expect(staff).toBeVisible();
  await staff.focus();

  // 連符ボタンで3連符を挿入（カーソルは連符の頭、休符3つ）して埋める。
  await page.getByRole('button', { name: '連符', exact: true }).click();
  await page.getByRole('button', { name: '3連符' }).click();
  await staff.press('a');
  await staff.press('a');
  await staff.press('a');

  // コード譜 / テキスト入力: the melody part is written as alphaTex text.
  await page.getByRole('tab', { name: 'コード譜' }).click();
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  await expect(chordTextarea(page)).toHaveValue(/\{tu 3\}/);
});

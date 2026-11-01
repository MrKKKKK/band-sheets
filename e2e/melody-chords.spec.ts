import { expect, test, type Page } from '@playwright/test';
import { freshStart } from './support/app';

/**
 * Issue #6: copy the chord chart's chords onto the melody, then edit them
 * per note. Section A of the sample song (聖者の行進) has 8 chart chords,
 * all on syllables the melody carries; events of A start
 * r Oh when the saints(4) r go march- ing in r Oh when the saints go
 * march- ing in(18) …
 */
async function openSampleMelody(page: Page) {
  await freshStart(page);
  await page
    .getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' })
    .click();
  await expect(page).toHaveURL(/#\/edit\//);
  await page.getByRole('tab', { name: 'メロディ' }).click();
  const staff = page.getByRole('application', {
    name: 'セクション A のメロディ',
  });
  await expect(staff).toBeVisible();
  return staff;
}

/** The melody tab's one live region (the drum tab has its own). */
const melodyLive = (page: Page) =>
  page.getByRole('tabpanel', { name: 'メロディ' }).getByTestId('staff-live');

const chordsPanel = (page: Page) =>
  page.getByRole('region', { name: 'コード', exact: true });

test('melody chords: copy from the chart, shown on the staff and in the preview', async ({
  page,
}) => {
  await openSampleMelody(page);
  const panel = chordsPanel(page);
  await expect(panel.getByText('コードが付いた音符 0 / 34')).toBeVisible();

  await panel.getByRole('button', { name: 'コード譜からコードを写す' }).click();
  await expect(panel.getByTestId('chord-copy-result')).toHaveText(
    /コードを 8 個、音符に写しました/,
  );
  // Announced through the editor's one live region.
  await expect(melodyLive(page)).toHaveText(/コードを 8 個、音符に写しました/);
  await expect(page.getByTestId('chord-4')).toHaveText('C');
  await expect(page.getByTestId('chord-18')).toHaveText('G7');
  await expect(panel.getByText('コードが付いた音符 8 / 34')).toBeVisible();
  await expect(panel.getByRole('listitem').first()).toHaveText('C ×4');

  // The alphaTab preview draws the chord names too.
  const preview = page.getByRole('region', { name: '仕上がりの確認' });
  // The preview re-renders after the copy, and alphaTab lazy-loads: it only
  // draws once the preview is in the viewport. The re-render collapses the
  // preview's height and can leave it below the fold with nothing drawn, and
  // `data-state="rendered"` can't tell (it's also true for the render before
  // the copy). So wait for the chord text itself, scrolling the preview back
  // into view on every attempt.
  const score = preview.locator('[data-state]');
  await expect(async () => {
    await score.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await expect(
      preview.locator('svg text', { hasText: /^G7$/ }).first(),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
});

test('melody chords: confirm when chords exist, edit / delete per note, text keeps ch', async ({
  page,
}) => {
  const staff = await openSampleMelody(page);
  const panel = chordsPanel(page);
  const copyButton = panel.getByRole('button', {
    name: 'コード譜からコードを写す',
  });
  await copyButton.click();
  await expect(page.getByTestId('chord-4')).toHaveText('C');

  // Change the chord of 「saints」 by clicking its name: ChordPopover.
  await page.getByTestId('chord-4').click();
  const change = page.getByRole('dialog', { name: 'コードを変更' });
  await expect(change).toBeVisible();
  await change.getByLabel('コード').fill('Cmaj7');
  await change.getByLabel('コード').press('Enter');
  await expect(change).toHaveCount(0);
  await expect(page.getByTestId('chord-4')).toHaveText('Cmaj7');
  await expect(staff).toBeFocused();
  await expect(melodyLive(page)).toHaveText(/5音目のコードを Cmaj7 にしました/);

  // Keyboard: Shift+Backspace deletes the selected note's chord, Shift+C
  // opens the popover to place one again.
  await staff.press('Shift+Backspace');
  await expect(page.getByTestId('chord-4')).toHaveCount(0);
  await expect(page.getByTestId('chord-slot')).toBeVisible();
  await staff.press('Shift+C');
  const place = page.getByRole('dialog', { name: 'コードを置く' });
  await expect(place).toBeVisible();
  await place.getByLabel('コード').fill('F');
  await place.getByRole('button', { name: '置く' }).click();
  await expect(page.getByTestId('chord-4')).toHaveText('F');

  // A chordless note: the dotted ＋ box opens 「コードを置く」, Esc closes.
  await staff.press('ArrowLeft'); // 「the」 (event 3)
  await expect(page.getByTestId('chord-slot')).toBeVisible();
  await page.getByTestId('chord-slot').click();
  await expect(
    page.getByRole('dialog', { name: 'コードを置く' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'コードを置く' })).toHaveCount(
    0,
  );

  // Copy again: chords exist → choose. 「空いている音符だけ」 keeps F.
  await copyButton.click();
  const ask = page.getByRole('dialog', { name: 'コードを写す方法' });
  await expect(ask).toContainText('すでにコードが 8 個付いています');
  await ask.getByRole('button', { name: '空いている音符だけに写す' }).click();
  await expect(page.getByTestId('chord-4')).toHaveText('F');
  await expect(panel.getByTestId('chord-copy-result')).toContainText(
    'コードが付いていた音符 8 個はそのままにしました',
  );

  // 「すべて上書きする」 puts the chart's C back; キャンセル changes nothing.
  await copyButton.click();
  await ask.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.getByTestId('chord-4')).toHaveText('F');
  await copyButton.click();
  await ask.getByRole('button', { name: 'すべて上書きする' }).click();
  await expect(page.getByTestId('chord-4')).toHaveText('C');

  // Written as per-note `ch` in the part; the chart is untouched.
  await page.getByRole('tab', { name: 'コード譜' }).click();
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  const text = page.getByLabel('ChordPro テキスト');
  await expect(text).toHaveValue(/G4\{lyrics "saints" ch "C"\}/);
  await expect(text).toHaveValue(/Oh when the \[C\]saints go march-ing in/);

  // Clear all (with a confirm).
  await page.getByRole('tab', { name: 'メロディ' }).click();
  await panel
    .getByRole('button', { name: 'このセクションのコードをすべて消す' })
    .click();
  await page
    .getByRole('dialog', { name: 'コードをすべて消す確認' })
    .getByRole('button', { name: 'すべて消す' })
    .click();
  await expect(page.getByTestId('chord-4')).toHaveCount(0);
  await expect(panel.getByText('まだコードがありません')).toBeVisible();
});

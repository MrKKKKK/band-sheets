/**
 * 「鼻歌から下書き」 end to end on the dev server with the REAL hum Worker (docs/audio-integration-plan.md sections 4,
 * 5, 7): the sample song's melody screen → S2 → analyse the SYNTHETIC hum fixture (src/lib/analysis/fixtures/
 * hum.wav, rendered from the sample tune; never user recordings) → S4 → replace a section (with the confirmation)
 * → the melody editor shows the notes; cancel. Nothing may be requested off-origin.
 *
 * `SHOTS=1 npx playwright test e2e/hum-import.spec.ts` also writes 1280×800 screenshots to out/hum/.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { IMPORT_ERROR_MESSAGES } from '../src/lib/import/importErrors';
import {
  FIXTURES,
  loopTo,
  offOriginRequests,
  readFixtureWav,
  writeWav16,
} from './support/analysisAudio';
import { draftText, freshStart, songIdOf } from './support/app';

const SHOT_DIR = join(import.meta.dirname, '../out/hum');
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}

/** The sample song (聖者の行進: ♩=116, 4/4, like the fixture) on the melody tab, then S2. */
async function openHum(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshStart(page);
  await page
    .getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' })
    .click();
  await expect(page).toHaveURL(/#\/edit\//);
  await page.getByRole('tab', { name: 'メロディ' }).click();
  const offOrigin = offOriginRequests(
    page,
    new URL(test.info().project.use.baseURL!).origin,
  );
  await shot(page, 's2-0-entry');
  await page.getByRole('button', { name: '鼻歌から下書き' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: '鼻歌から下書きを作る' }),
  ).toBeFocused();
  return offOrigin;
}

const fileInput = (page: Page) => page.getByTestId('audio-file-input');

test('happy path: analyse the synthetic hum, check it, replace section B, the editor shows it', async ({
  page,
}) => {
  const offOrigin = await openHum(page);
  const songId = songIdOf(page);
  await expect(page.getByTestId('hum-tempo')).toHaveValue('116');
  await shot(page, 's2-a-idle');
  await page.getByRole('combobox', { name: 'セクション' }).selectOption('B');
  // the fixture's singing starts on beat 2 of bar 1
  await page.getByRole('combobox', { name: '歌い始めの拍' }).selectOption('2');
  await fileInput(page).setInputFiles(join(FIXTURES, 'hum.wav'));
  await expect(page.getByTestId('picked-file')).toContainText('hum.wav');
  await page.getByRole('button', { name: '解析する' }).click();

  const h1 = page.getByRole('heading', {
    level: 1,
    name: '鼻歌の下書きを確かめる',
  });
  await expect(h1).toBeVisible({ timeout: 60_000 });
  await expect(h1).toBeFocused();
  await expect(page.getByTestId('hum-summary')).toContainText('B ・ 4 小節');
  await expect(page.getByTestId('hum-start')).toHaveText('1 小節目の 2 拍目');
  // the editor stays mounted (hidden) under S4: look inside S4's score
  const score = page.getByRole('region', { name: '下書きの譜面' });
  await expect(score.getByTestId('lyric-1')).toHaveText(/^(レ♯|ミ♭)\??$/);
  await shot(page, 's4-a-default');
  await score.scrollIntoViewIfNeeded();
  await shot(page, 's4-a-score');

  // a note's candidates (the first note), shown with the name mode
  await page.getByRole('application').focus();
  await page.keyboard.press('ArrowRight');
  await expect(score.getByTestId('candidate-panel')).toContainText(
    '1 小節目の 1 つ目の音',
  );
  await shot(page, 's4-b-candidates');
  await page.getByRole('button', { name: 'C D E' }).click();
  await expect(score.getByTestId('lyric-1')).toHaveText(/^(D♯|E♭)\??$/);
  await page.keyboard.press('Escape');

  // playback (recording + draft tone) moves the cursor
  await page.getByRole('button', { name: '▶ 再生' }).click();
  await expect(score.getByTestId('cursor')).toHaveCount(1, {
    timeout: 5_000,
  });
  await page.getByRole('button', { name: '❚❚ 止める' }).click();

  // the section has notes: confirm, cancel keeps S4, then replace
  const insert = page.getByRole('button', {
    name: 'このセクションに下書きを入れる',
  });
  await insert.click();
  const dialog = page.getByRole('dialog', { name: 'Bの音符を置き換えますか' });
  await expect(
    dialog.getByRole('button', { name: 'キャンセル' }),
  ).toBeFocused();
  await shot(page, 's4-c-confirm');
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(h1).toBeVisible();
  await insert.click();
  await dialog.getByRole('button', { name: '置き換えて入れる' }).click();

  // back in the melody editor, on section B, with the draft's notes (no draft mark in the text)
  const staff = page.getByRole('application', {
    name: 'セクション B のメロディ',
  });
  await expect(staff).toBeFocused();
  await expect(page.getByTestId('note-1-0')).toBeVisible();
  await shot(page, 'editor-after-insert');
  expect(songIdOf(page)).toBe(songId);
  // the autosaved draft (debounced) has section B rewritten, with no draft mark in the text
  const sectionB = async () =>
    (await draftText(page, songId))
      .split('\\section "B"')[1]
      ?.split('{end_of_part}')[0] ?? '';
  await expect.poll(sectionB).toMatch(/:4 r (D#4|Eb4) G4 (G#4|Ab4) \|/);
  const text = await draftText(page, songId);
  expect(text).not.toMatch(/下書き/);
  expect(offOrigin).toEqual([]);
});

test('cancel: stops the analysis, neutral notice, back to the editor', async ({
  page,
}) => {
  const offOrigin = await openHum(page);
  const { y, sr } = readFixtureWav('hum.wav');
  await fileInput(page).setInputFiles(
    writeWav16('hum-300s.wav', loopTo(y, sr, 300), sr),
  );
  await page.getByRole('button', { name: '解析する' }).click();
  await expect(
    page.getByRole('heading', { name: '解析しています' }),
  ).toBeFocused();
  await expect(page.getByTestId('import-step-count')).toHaveText('2 / 3 段階', {
    timeout: 30_000,
  });
  await shot(page, 's2-b-analyzing');
  await page.getByRole('button', { name: '中止' }).click();
  const notice = page.getByTestId('import-notice');
  await expect(notice).toHaveAttribute('data-severity', 'notice');
  await expect(notice).toContainText(IMPORT_ERROR_MESSAGES.cancelled);
  await expect(page.getByRole('button', { name: '解析する' })).toBeEnabled();
  await page.getByRole('button', { name: 'やめて戻る' }).last().click();
  await expect(
    page.getByRole('application', { name: 'セクション A のメロディ' }),
  ).toBeVisible();
  expect(offOrigin).toEqual([]);
});

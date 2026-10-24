/**
 * 「録音から新しい曲」 end to end on the dev server with the REAL analysis Worker (docs/audio-integration-plan.md
 * sections 4, 5, 7): list → S1 → analyse a SYNTHETIC fixture (src/lib/analysis/fixtures/, never user recordings)
 * → S3 → new device-only song in the editor; cancel; an unreadable file. Nothing may be requested off-origin
 * from the import screen on.
 *
 * `SHOTS=1 npx playwright test e2e/import.spec.ts` also writes screenshots of the S1 / S3 states to out/import/.
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
import { freshStart, songIdOf, draftText } from './support/app';

const SHOT_DIR = join(import.meta.dirname, '../out/import');
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.screenshot({
    path: join(SHOT_DIR, `${name}.png`),
    fullPage: true,
  });
}

/** The PC list (via the sample song, so no sign-in), then the import screen. Returns the off-origin log. */
async function openImport(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await freshStart(page);
  await page
    .getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' })
    .click();
  await expect(page).toHaveURL(/#\/edit\//);
  await page.getByRole('button', { name: '‹ 曲の一覧' }).click();
  // the sample is a device-only song: leave it unsaved
  await page.getByRole('button', { name: '保存せずに戻る' }).click();
  const offOrigin = offOriginRequests(
    page,
    new URL(test.info().project.use.baseURL!).origin,
  );
  await shot(page, 's0-list');
  await page.getByRole('button', { name: '録音から新しい曲' }).click();
  await expect(page).toHaveURL(/#\/import$/);
  await expect(
    page.getByRole('heading', { level: 1, name: '録音から新しい曲' }),
  ).toBeFocused();
  return offOrigin;
}

const fileInput = (page: Page) => page.getByTestId('audio-file-input');

test('happy path: analyse a synthetic WAV, review, create, the editor shows the dash chart', async ({
  page,
}) => {
  const offOrigin = await openImport(page);
  await shot(page, 's1a-idle');
  await fileInput(page).setInputFiles(join(FIXTURES, 'chords.wav'));
  await expect(page.getByTestId('picked-file')).toContainText('chords.wav');
  await expect(page.getByTestId('picked-file')).toContainText('長さ 0:07');
  await shot(page, 's1b-file');
  await page.getByRole('button', { name: '解析を始める' }).click();

  const h1 = page.getByRole('heading', {
    level: 1,
    name: 'コード譜の下書きを確かめる',
  });
  await expect(h1).toBeVisible({ timeout: 60_000 });
  await expect(h1).toBeFocused();
  await expect(page.getByTestId('chart-summary')).toContainText('小節');
  await shot(page, 's3-default');

  // the review screen has no 「? 書き方」 (G2: lyrics / dash text can't be edited here)
  await expect(page.getByRole('button', { name: '? 書き方' })).toHaveCount(0);

  // playback from a local object URL: the current bar is highlighted
  await page.getByRole('button', { name: '録音を再生' }).click();
  await expect(page.locator('[data-current]')).toHaveCount(1);
  await shot(page, 's3-playing');
  await page.getByRole('button', { name: '録音を止める' }).click();

  // a chord's candidates
  await page.locator('[data-chord]').first().click();
  await expect(page.getByTestId('candidate-panel')).toContainText(
    '正解の確率ではありません',
  );
  await shot(page, 's3-candidates');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('candidate-panel')).toHaveCount(0);

  await page.getByRole('button', { name: 'この内容で曲を作る' }).click();
  await expect(page).toHaveURL(/#\/edit\//);
  await expect(
    page.getByRole('heading', { level: 1, name: 'chords（下書き）' }),
  ).toBeVisible();
  const text = await draftText(page, songIdOf(page));
  expect(text).toMatch(
    /^\{comment: 自動解析の下書き \d{4}-\d{2}-\d{2} コード adec583eb3c6\}$/m,
  );
  expect(text).toMatch(/^\|\[[^\]]+\]-+/m);
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  await expect(page.getByLabel('ChordPro テキスト')).toHaveValue(/\|\[/);
  await shot(page, 'editor-after-create');
  expect(offOrigin).toEqual([]);
});

test('cancel: stops the analysis, neutral notice, can run again', async ({
  page,
}) => {
  const offOrigin = await openImport(page);
  const { y, sr } = readFixtureWav('chords.wav');
  await fileInput(page).setInputFiles(
    writeWav16('chords-60s.wav', loopTo(y, sr, 60), sr),
  );
  await page.getByRole('button', { name: '解析を始める' }).click();
  await expect(
    page.getByRole('heading', { name: '解析しています' }),
  ).toBeFocused();
  await expect(page.getByTestId('import-step-count')).toHaveText(
    /^[2-5] \/ 6 段階$/,
    { timeout: 30_000 },
  );
  await shot(page, 's1c-analyzing');
  await page.getByRole('button', { name: '中止' }).click();
  const notice = page.getByTestId('import-notice');
  await expect(notice).toHaveAttribute('data-severity', 'notice');
  await expect(notice).toContainText(IMPORT_ERROR_MESSAGES.cancelled);
  await expect(
    page.getByRole('button', { name: 'もう一度解析する' }),
  ).toBeVisible();
  await shot(page, 's1d-cancelled');
  expect(offOrigin).toEqual([]);
});

test('an unreadable file shows the Japanese error above the picker', async ({
  page,
}) => {
  const offOrigin = await openImport(page);
  await fileInput(page).setInputFiles({
    name: 'notes.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from('this is not audio'),
  });
  await expect(page.getByTestId('picked-file')).toContainText('notes.mp3');
  await page.getByRole('button', { name: '解析を始める' }).click();
  const notice = page.getByTestId('import-notice');
  await expect(notice).toHaveAttribute('data-severity', 'error');
  await expect(notice).toContainText(IMPORT_ERROR_MESSAGES['decode-failed']);
  await expect(notice).toBeFocused();
  await shot(page, 's1d-error');
  expect(offOrigin).toEqual([]);
});

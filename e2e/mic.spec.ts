/**
 * 「鼻歌から下書き」 → 「マイクで録る」 end to end (docs/mic-recording-plan.md T6b), project `mic`: Chromium's fake
 * microphone plays a generated wav (e2e/support/micFakeAudio.ts) and its permission prompt is auto-allowed.
 * Only the FLOW is checked (permission, meter, latency dialog, count-in, recording, take, wav download, draft,
 * insert, switching, closing the mic): the fake device's timing is not real, so no latency / alignment is asserted.
 */
import { expect, test, type Page } from '@playwright/test';
import { offOriginRequests } from './support/analysisAudio';
import { draftText, freshStart, songIdOf } from './support/app';

declare global {
  interface Window {
    __micTracks: MediaStreamTrack[];
  }
}

/** Remembers every audio track getUserMedia hands out, to check they end when the screen is left. */
async function trackMicTracks(page: Page) {
  await page.addInitScript(() => {
    window.__micTracks = [];
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const s = await orig(c);
      window.__micTracks.push(...s.getAudioTracks());
      return s;
    };
  });
}
const liveTracks = (page: Page) =>
  page.evaluate(
    () => window.__micTracks.filter((t) => t.readyState === 'live').length,
  );

async function openMic(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await trackMicTracks(page);
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
  await page.getByRole('button', { name: '鼻歌から下書き' }).click();
  await page.getByRole('button', { name: 'マイクで録る' }).click();
  const panel = page.getByTestId('mic-panel');
  await expect(panel).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });
  return { offOrigin, panel };
}

async function record(page: Page) {
  const panel = page.getByTestId('mic-panel');
  await page.getByRole('button', { name: '● 録音' }).click();
  await expect(panel).toHaveAttribute('data-phase', 'countIn');
  await expect(panel).toHaveAttribute('data-phase', 'recording', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('bar')).toContainText('小節目');
  await expect(page.getByTestId('elapsed')).not.toHaveText('0:00', {
    timeout: 10_000,
  });
  // let a few seconds go by so the take is not "too short"
  await expect(page.getByTestId('elapsed')).toHaveText(/^0:0[3-9]|^0:[1-5]/, {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: '■ 止める' }).click();
  await expect(panel).toHaveAttribute('data-phase', 'take', {
    timeout: 20_000,
  });
}

test('mic: meter, latency dialog, record, take, wav download, switch, draft, insert, mic closes', async ({
  page,
}) => {
  // ~15 s normally, but its own waits (recording, analysis up to 60 s) need more than the default 30 s test timeout
  // on a loaded machine
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const { offOrigin, panel } = await openMic(page);
  const songId = songIdOf(page);
  const before = await draftText(page, songId);

  // permission was auto-allowed: the mic is named, the meter moves
  await expect(panel.getByRole('combobox', { name: 'マイク' })).toBeVisible();
  const meter = panel.getByRole('meter', { name: '音の大きさ' });
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  expect(await liveTracks(page)).toBe(1);

  // 「遅れを測る」: the fake mic does not hear the clicks, so either end is fine, but it must END without errors
  await expect(page.getByTestId('latency-value')).toHaveText(
    'まだ測っていません',
  );
  await page.getByRole('button', { name: '遅れを測る' }).click();
  await expect(
    page.getByRole('dialog', { name: '入力の遅れを測ります' }),
  ).toBeVisible();
  const result = page.getByTestId('measure-result');
  const failed = page.getByTestId('measure-failed');
  await expect(result.or(failed)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(panel).toHaveAttribute('data-phase', 'ready');

  // record → take
  await record(page);
  await expect(page.getByTestId('take-info')).toContainText('長さ');
  await expect(page.getByRole('img', { name: '録音の波形' })).toBeVisible();
  await expect(page.getByRole('button', { name: '▶ 聞く' })).toBeEnabled();
  await expect(page.getByLabel('クリックも一緒に聞く')).toBeVisible();

  // 録音を保存（wav） in M7
  const dl1 = page.waitForEvent('download');
  await page.getByRole('button', { name: '録音を保存（wav）' }).click();
  expect((await dl1).suggestedFilename()).toMatch(/\.wav$/);

  // 「ファイルを選ぶ」 and back keeps the take
  await page
    .getByRole('button', { name: 'ファイルを選ぶ', exact: true })
    .click();
  await expect(page.getByTestId('audio-file-input')).toBeAttached();
  await page.getByRole('button', { name: 'マイクで録る', exact: true }).click();
  await expect(page.getByTestId('mic-panel')).toHaveAttribute(
    'data-phase',
    'take',
  );

  // 下書きを作る → S4
  await page.getByRole('button', { name: '下書きを作る' }).click();
  const h1 = page.getByRole('heading', {
    level: 1,
    name: '鼻歌の下書きを確かめる',
  });
  await expect(h1).toBeVisible({ timeout: 60_000 });
  // S4's own 録音を保存（wav）
  const dl2 = page.waitForEvent('download');
  await page.getByRole('button', { name: '録音を保存（wav）' }).click();
  expect((await dl2).suggestedFilename()).toMatch(/\.wav$/);

  // the mic is closed once the take is made / S4 shown
  await expect.poll(() => liveTracks(page)).toBe(0);

  // insert into the target section (confirm if it has notes)
  await page
    .getByRole('button', { name: 'このセクションに下書きを入れる' })
    .click();
  const confirm = page.getByRole('button', { name: '置き換えて入れる' });
  if (await confirm.isVisible()) await confirm.click();
  await expect(page.getByRole('application').first()).toBeVisible();
  await expect.poll(() => draftText(page, songId)).not.toBe(before);

  expect(await liveTracks(page)).toBe(0);
  expect(errors).toEqual([]);
  expect(offOrigin).toEqual([]);
});

test('mic: leaving the screen closes the mic', async ({ page }) => {
  await openMic(page);
  expect(await liveTracks(page)).toBe(1);
  await page.getByRole('button', { name: 'やめて戻る' }).last().click();
  await expect(
    page.getByRole('application', { name: 'セクション A のメロディ' }),
  ).toBeVisible();
  await expect.poll(() => liveTracks(page)).toBe(0);
});

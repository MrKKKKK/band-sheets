import { expect, test, type Page } from '@playwright/test';
import { openNewSong, readDraft, seedDraftAndOpen } from './support/app';

const SONG_ID = 'e2e-viewer';
const viewerKey = (id: string) => `band-sheets:viewer:${id}`;

// Chart A B A C + Vocal / Bass / Drums (same shape as the viewer fixtures).
const SONG = `{title: 閲覧のサンプル}
{key: G}
{tempo: 120}
{time: 4/4}

{start_of_verse: A}
[G]あさの[Em]ひかり[C]まどを[D]あけて
[G]かぜが[Em]そっと[C]ほおに[D]ふれる
{end_of_verse}

{start_of_chorus: B}
[C]うたを[D]うたおう[G]いま[Em]ここで
[C]こえを[D]あわせて[G]どこ[G7]までも
{end_of_chorus}

{start_of_verse: A}
[G]ゆうべの[Em]そらに[C]ほしが[D]ひとつ
[G]あすへ[Em]つづく[C]みちを[D]てらす
{end_of_verse}

{start_of_bridge: C}
[Am]しずかに[D]おわる
{end_of_bridge}

{start_of_part: Vocal}
\\section "A"
:4 B4 B4 A4 G4 | E4.2 E4.4 G4 | :4 C5 C5 B4 A4 | A4.1 |
\\section "B"
:4 E5 E5 D5 B4 | B4.2 r.2 | :4 E5 E5 D5 B4 | G4.1 |
\\section "C"
:4 C5 C5 B4 A4 | A4.1 |
{end_of_part}

{start_of_part: Bass}
\\clef bass
\\section "A"
:2 G2 G2 | E2 E2 | C3 C3 | D3 D3 |
\\section "B"
:2 C3 D3 | G2 E2 | C3 D3 | G2 G2 |
\\section "C"
:2 A2 A2 | D3 D3 |
{end_of_part}

{start_of_part: Drums}
\\instrument percussion
\\section "A"
:8 (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH :16 SD SD SD SD SD SD (SD BD) (SD BD) |
\\section "B"
\\tf triplet8th
:8 (RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
(RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
(RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
(RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
\\section "C"
\\tf none
:4 (CR BD) HH (HH SD) HH | (CR BD) r r r |
{end_of_part}
`;

async function seed(page: Page) {
  await seedDraftAndOpen(page, SONG_ID, SONG);
}

async function openViewer(page: Page) {
  await page.getByRole('button', { name: '閲覧モード' }).click();
  await expect(page.getByTestId('viewer')).toHaveAttribute(
    'data-ready',
    'true',
  );
}

const pageCount = (page: Page) => page.getByTestId('page-count');
const viewport = (page: Page) => page.getByTestId('viewer-viewport');
const scrollTop = (page: Page) =>
  viewport(page).evaluate((el) => (el as HTMLElement).scrollTop);

/** Settings drawer (the toolbar hides some controls below 1400px). */
async function openDrawer(page: Page) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  return page.getByRole('dialog');
}

test('viewer: typed song, page flip by tap and keys, layouts, zoom, persistence, back', async ({
  page,
}) => {
  const songId = await openNewSong(page);

  // Type the song through テキスト入力.
  await page.getByRole('button', { name: 'テキスト入力' }).tap();
  await page.getByLabel('ChordPro テキスト').fill(SONG);
  await expect(page.getByLabel('ChordPro テキスト')).toHaveValue(
    /閲覧のサンプル/,
  );
  await openViewer(page);
  expect(new URL(page.url()).hash).toBe(`#/view/${songId}`);

  // Page flip: tap the right zone, then PageDown / PageUp (pedal keys).
  await expect(pageCount(page)).toHaveText(/^1 \/ \d+$/);
  const total = Number((await pageCount(page).innerText()).split('/')[1]);
  expect(total).toBeGreaterThan(1);
  await page.getByTestId('tap-next').tap();
  await expect(pageCount(page)).toHaveText(`2 / ${total}`);
  await page.keyboard.press('PageUp');
  await expect(pageCount(page)).toHaveText(`1 / ${total}`);
  await page.keyboard.press('PageDown');
  await expect(pageCount(page)).toHaveText(`2 / ${total}`);
  await page.getByTestId('tap-prev').tap();
  await expect(pageCount(page)).toHaveText(`1 / ${total}`);

  await page.screenshot({ path: 'docs/m6-app-part.png' });

  // Score layout; hide a part through the 「パート ▾」 popover.
  await page.getByRole('button', { name: 'スコア', exact: true }).tap();
  await expect(page.getByTestId('viewer')).toHaveAttribute(
    'data-ready',
    'true',
  );
  // The live region follows the new layout's page count.
  const scoreTotal = (await pageCount(page).textContent())!
    .split('/')[1]
    .trim();
  await expect(page.getByTestId('viewer-live')).toContainText(
    `/ ${scoreTotal} ページ`,
  );
  await page.getByRole('button', { name: /^パート/ }).tap();
  await page
    .getByRole('dialog', { name: '表示するパート' })
    .getByRole('button', { name: 'Bass' })
    .tap();
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate((k) => localStorage.getItem(k), viewerKey(songId)),
  ).toContain('Bass');
  await page.screenshot({ path: 'docs/m6-app-score.png' });

  // Zoom keeps the reading position: go to page 2, A＋, the same section
  // stays at the top of the viewport (within a screen).
  await page.getByTestId('tap-next').tap();
  await expect(pageCount(page)).toHaveText(/^2 \/ \d+$/);
  const dlg = await openDrawer(page);
  const before = await dlg.getByTestId('size-px').innerText();
  await dlg.getByRole('button', { name: '文字を大きく' }).tap();
  await expect(dlg.getByTestId('size-px')).not.toHaveText(before);
  const after = await dlg.getByTestId('size-px').innerText();
  await dlg.getByRole('button', { name: '閉じる' }).tap();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('viewer')).toHaveAttribute(
    'data-ready',
    'true',
  );
  expect(Number.parseInt(after)).toBeGreaterThan(Number.parseInt(before));
  // Not thrown back to the very start.
  await expect(pageCount(page)).not.toHaveText(/^1 \/ /);

  // Settings persist across a reload (draft too).
  const stored = await page.evaluate(
    (k) => localStorage.getItem(k),
    viewerKey(songId),
  );
  expect(stored).toContain('score');
  await page.reload();
  await expect(page.getByTestId('viewer')).toHaveAttribute(
    'data-ready',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'スコア', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const dlg2 = await openDrawer(page);
  await expect(dlg2.getByTestId('size-px')).toHaveText(after);
  await dlg2.getByRole('button', { name: '閉じる' }).tap();

  // Opened by URL (not from the editor): the back button leads to the list.
  // The draft is untouched; go to the editor by URL.
  await expect(
    page.getByRole('button', { name: '‹ 曲の一覧' }).first(),
  ).toBeVisible();
  await page.evaluate((id) => {
    window.location.hash = `#/edit/${id}`;
  }, songId);
  await expect(page.getByRole('button', { name: '閲覧モード' })).toBeVisible();
  expect((await readDraft(page, songId))?.text).toBe(SONG);

  // Back to the editor with the button (entered from the editor this time).
  await page.getByRole('button', { name: '閲覧モード' }).tap();
  await expect(page.getByTestId('viewer')).toBeVisible();
  await page.getByRole('button', { name: '編集に戻る' }).tap();
  await expect(page.getByRole('button', { name: '閲覧モード' })).toBeVisible();
  expect((await readDraft(page, songId))?.text).toBe(SONG);

  // ... and with the browser's back button.
  await page.getByRole('button', { name: '閲覧モード' }).tap();
  await expect(page.getByTestId('viewer')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: '閲覧モード' })).toBeVisible();
  await expect(page.getByTestId('viewer')).toHaveCount(0);
  expect((await readDraft(page, songId))?.text).toBe(SONG);
});

test('viewer: play mode enter / exit', async ({ page }) => {
  await seed(page);
  await openViewer(page);
  await page.getByRole('button', { name: '演奏モード' }).tap();
  const viewer = page.getByTestId('viewer');
  await expect(viewer).toHaveAttribute('data-play-mode', 'true');
  await expect(page.getByRole('banner', { name: '閲覧の操作' })).toHaveCount(0);
  await page.screenshot({ path: 'docs/m6-app-play-mode.png' });

  // Pedal key still turns pages; the top edge brings the bar back.
  await page.keyboard.press('PageDown');
  await page.getByRole('button', { name: '操作バーを表示' }).tap();
  await expect(page.getByTestId('play-mode-bar')).toBeVisible();
  await page.getByRole('button', { name: '演奏モードを終了' }).tap();
  await expect(viewer).not.toHaveAttribute('data-play-mode', 'true');

  // Esc also leaves play mode.
  await page.getByRole('button', { name: '演奏モード' }).tap();
  await expect(viewer).toHaveAttribute('data-play-mode', 'true');
  await page.keyboard.press('Escape');
  await expect(viewer).not.toHaveAttribute('data-play-mode', 'true');
});

test('viewer: auto scroll start / pause / speed', async ({ page }) => {
  await page.clock.install();
  await seed(page);
  await openViewer(page);
  const dlg = await openDrawer(page);
  await dlg.getByRole('button', { name: /自動スクロール/ }).tap();
  await dlg.getByRole('button', { name: '閉じる' }).tap();
  await expect(page.getByTestId('viewer')).toHaveAttribute('data-nav', 'auto');

  const bar = page.getByTestId('auto-scroll-bar');
  const countIn = bar.getByRole('switch');
  if ((await countIn.getAttribute('aria-checked')) === 'true') {
    await countIn.tap();
  }
  await expect(page.getByTestId('auto-scroll-speed')).toHaveText('100%');

  await bar.getByRole('button', { name: '再生' }).tap();
  await expect(bar).toHaveAttribute('data-playing', 'true');
  await page.clock.runFor(4000);
  const s1 = await scrollTop(page);
  expect(s1).toBeGreaterThan(0);
  await page.screenshot({ path: 'docs/m6-app-auto.png' });

  // Pause: the position holds.
  await bar.getByRole('button', { name: '一時停止' }).tap();
  const paused = await scrollTop(page);
  expect(paused).toBeGreaterThanOrEqual(s1);
  await page.clock.runFor(3000);
  expect(await scrollTop(page)).toBe(paused);

  // Faster speed covers more ground in the same time.
  const t0 = await scrollTop(page);
  await bar.getByRole('button', { name: '再生' }).tap();
  await page.clock.runFor(1500);
  const slow = (await scrollTop(page)) - t0;
  await bar.getByRole('button', { name: '一時停止' }).tap();
  await bar.getByRole('button', { name: '速度を上げる' }).tap();
  await bar.getByRole('button', { name: '速度を上げる' }).tap();
  await expect(page.getByTestId('auto-scroll-speed')).not.toHaveText('100%');
  const t1 = await scrollTop(page);
  await bar.getByRole('button', { name: '再生' }).tap();
  await page.clock.runFor(1500);
  const fast = (await scrollTop(page)) - t1;
  expect(slow).toBeGreaterThan(0);
  expect(fast).toBeGreaterThan(slow);
});

test('viewer: count-in holds the scroll', async ({ page }) => {
  await page.clock.install();
  await seed(page);
  await openViewer(page);
  const dlg = await openDrawer(page);
  await dlg.getByRole('button', { name: /自動スクロール/ }).tap();
  await dlg.getByRole('button', { name: '閉じる' }).tap();
  const bar = page.getByTestId('auto-scroll-bar');
  const countIn = bar.getByRole('switch');
  if ((await countIn.getAttribute('aria-checked')) !== 'true') {
    await countIn.tap();
  }
  await bar.getByRole('button', { name: '再生' }).tap();
  await expect(page.getByTestId('viewer')).toHaveAttribute(
    'data-play-state',
    'countIn',
  );
  await page.clock.runFor(200);
  expect(await scrollTop(page)).toBe(0);
  await page.clock.runFor(3000);
  await expect(page.getByTestId('viewer')).toHaveAttribute(
    'data-play-state',
    'playing',
  );
});

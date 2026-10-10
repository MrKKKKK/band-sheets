import { expect, test, type Page } from '@playwright/test';
import {
  freshStart,
  readDraft,
  setSongText,
  signIn,
  songIdOf,
  songText,
  songTextarea,
} from './support/app';
import { installFakeDrive, type FakeDrive } from './support/fakeDrive';

const saveStatus = (page: Page) => page.getByTestId('save-status');
const row = (page: Page, songId: string) =>
  page.getByTestId(`song-row-${songId}`);

/** Signed in, empty list. */
async function startSignedIn(page: Page): Promise<FakeDrive> {
  const drive = await installFakeDrive(page);
  await freshStart(page);
  await signIn(page);
  await expect(page.getByTestId('song-list-empty')).toBeVisible();
  return drive;
}

/** From the empty list: new song with `text`, saved to the fake Drive. */
async function newSavedSong(
  page: Page,
  drive: FakeDrive,
  text: string,
): Promise<string> {
  await page.getByRole('button', { name: '新しい曲', exact: true }).click();
  await expect(page).toHaveURL(/#\/edit\//);
  await setSongText(page, text);
  await page.keyboard.press('Control+s');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  expect(drive.songs()).toHaveLength(1);
  return songIdOf(page);
}

/** Types more text at the end and waits for the dirty state. */
async function editMore(page: Page, text: string): Promise<void> {
  await songTextarea(page).fill(text);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'dirty');
}

test('sign in → empty list → new song → Ctrl+S saves → reload shows it synced', async ({
  page,
}) => {
  const drive = await startSignedIn(page);
  await page.screenshot({ path: 'docs/m7-list-empty.png' });

  await page.getByRole('button', { name: '新しい曲', exact: true }).click();
  await expect(page).toHaveURL(/#\/edit\//);
  const songId = songIdOf(page);

  await setSongText(page, songText('きらきら星'));
  // Never saved to Drive yet: "この端末だけに保存".
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'local');
  await page.screenshot({
    path: 'docs/m7-editor-local.png',
    clip: { x: 0, y: 0, width: 1280, height: 90 },
  });

  await page.keyboard.press('Control+s');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  await page.screenshot({
    path: 'docs/m7-editor-saved.png',
    clip: { x: 0, y: 0, width: 1280, height: 90 },
  });

  // Edited after saving: unsaved changes.
  await editMore(page, songText('きらきら星', 'ひかるよ'));
  await page.screenshot({
    path: 'docs/m7-editor-dirty.png',
    clip: { x: 0, y: 0, width: 1280, height: 90 },
  });
  await page.keyboard.press('Control+s');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');

  const [file] = drive.songs();
  expect(file.name).toBe('きらきら星.bandsheet');
  expect(file.text).toContain('{title: きらきら星}');
  expect(file.appProperties.songId).toBe(songId);

  await page.reload();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  await expect(songTextarea(page)).toHaveValue(/きらきら星/);

  await page.getByRole('button', { name: '‹ 曲の一覧' }).click();
  await expect(row(page, songId)).toHaveAttribute('data-status', 'synced');
  await expect(row(page, songId)).toContainText('きらきら星');
  await page.screenshot({ path: 'docs/m7-list.png' });

  // A fresh reload of the list keeps it (cache + Drive).
  await page.reload();
  await expect(row(page, songId)).toHaveAttribute('data-status', 'synced');
});

test('failed save → failed state → retry succeeds', async ({ page }) => {
  const drive = await startSignedIn(page);
  await newSavedSong(page, drive, songText('テスト曲'));

  await editMore(page, songText('テスト曲', 'かきくけこ'));
  drive.offline = true;
  await page.keyboard.press('Control+s');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'failed');
  await page.screenshot({
    path: 'docs/m7-editor-failed.png',
    clip: { x: 0, y: 0, width: 1280, height: 90 },
  });
  expect(drive.songs()[0].text).toContain('あいうえお');

  drive.offline = false;
  await saveStatus(page).getByRole('button').click();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  expect(drive.songs()[0].text).toContain('かきくけこ');
});

/** A saved song, edited again, then changed on Drive by "another device". */
async function conflictSetup(page: Page) {
  const drive = await startSignedIn(page);
  const songId = await newSavedSong(page, drive, songText('衝突曲'));
  const fileId = drive.songs()[0].id;
  drive.externalEdit(fileId, songText('衝突曲', 'iPadで直した'));
  await editMore(page, songText('衝突曲', 'PCで直した'));
  await page.keyboard.press('Control+s');
  const dialog = page.getByRole('dialog', {
    name: 'Drive の方が新しくなっています',
  });
  await expect(dialog).toBeVisible();
  return { drive, songId, fileId, dialog };
}

test('conflict: overwrite', async ({ page }) => {
  const { drive, dialog } = await conflictSetup(page);
  await page.screenshot({ path: 'docs/m7-conflict.png' });
  await dialog.getByRole('radio', { name: /^上書きする/ }).check();
  await dialog.getByRole('button', { name: '上書きして保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  expect(drive.songs()).toHaveLength(1);
  expect(drive.songs()[0].text).toContain('PCで直した');
  await expect(songTextarea(page)).toHaveValue(/PCで直した/);
});

test('conflict: reload Drive and keep my changes as another song', async ({
  page,
}) => {
  const { drive, dialog } = await conflictSetup(page);
  // The default choice.
  await dialog.getByRole('button', { name: '読み直す', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  await expect(songTextarea(page)).toHaveValue(/iPadで直した/);
  const files = drive.songs();
  expect(files).toHaveLength(2);
  expect(files.some((f) => f.text.includes('PCで直した'))).toBe(true);
  expect(files.some((f) => f.text.includes('iPadで直した'))).toBe(true);
});

test('conflict: reload Drive and discard my changes', async ({ page }) => {
  const { drive, songId, dialog } = await conflictSetup(page);
  await dialog.getByRole('radio', { name: /手元の変更は捨てる/ }).check();
  await dialog.getByRole('button', { name: '読み直して破棄' }).click();
  await expect(dialog).toBeHidden();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  await expect(songTextarea(page)).toHaveValue(/iPadで直した/);
  expect(drive.songs()).toHaveLength(1);
  expect(drive.songs()[0].text).toContain('iPadで直した');
  expect(await readDraft(page, songId)).toBeNull();
});

test('conflict: cancel keeps the local change and the draft', async ({
  page,
}) => {
  const { drive, songId, dialog } = await conflictSetup(page);
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(dialog).toBeHidden();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'dirty');
  expect(drive.songs()[0].text).toContain('iPadで直した');
  // The draft is written by the 500 ms autosave.
  await expect
    .poll(async () => (await readDraft(page, songId))?.text)
    .toContain('PCで直した');
});

/** A saved song with a newer local draft; back on the list. */
async function draftOnList(page: Page) {
  const drive = await startSignedIn(page);
  const songId = await newSavedSong(page, drive, songText('下書き曲'));
  await editMore(page, songText('下書き曲', 'PCの下書き'));
  await expect
    .poll(async () => (await readDraft(page, songId))?.text ?? '')
    .toContain('PCの下書き');
  await page.getByRole('button', { name: '‹ 曲の一覧' }).click();
  await page.getByRole('button', { name: '保存せずに戻る' }).click();
  await expect(row(page, songId)).toHaveAttribute('data-status', 'dirty');
  return { drive, songId };
}

test('open with a newer local draft (B): resume the draft', async ({
  page,
}) => {
  const { songId } = await draftOnList(page);
  await page.getByRole('button', { name: '下書き曲を開く' }).click();
  const dialog = page.getByRole('dialog', {
    name: '保存していない下書きが残っています',
  });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: 'docs/m7-open-draft.png' });
  await dialog.getByRole('button', { name: '下書きから続ける' }).click();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'dirty');
  await expect(songTextarea(page)).toHaveValue(/PCの下書き/);
  expect((await readDraft(page, songId))?.text).toContain('PCの下書き');
});

test('open with a newer local draft (B): open Drive, draft discarded', async ({
  page,
}) => {
  const { songId } = await draftOnList(page);
  await page.getByRole('button', { name: '下書き曲を開く' }).click();
  await page
    .getByRole('dialog', { name: '保存していない下書きが残っています' })
    .getByRole('button', { name: 'Drive の版を開く（下書きは破棄）' })
    .click();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  await expect(songTextarea(page)).toHaveValue(/あいうえお/);
  expect(await readDraft(page, songId)).toBeNull();
});

test('open when Drive moved on after my draft (C): open Drive / keep a copy', async ({
  page,
}) => {
  const { drive } = await draftOnList(page);
  drive.externalEdit(drive.songs()[0].id, songText('下書き曲', 'iPadの版'));
  await page.getByRole('button', { name: '下書き曲を開く' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Drive の版が新しくなっています',
  });
  await expect(dialog).toBeVisible();
  // R1: keeping the draft is the default (focused) choice.
  const keep = dialog.getByRole('button', { name: '下書きも別の曲として残す' });
  await expect(keep).toBeFocused();
  await expect(
    dialog.getByRole('button', { name: 'Drive の版を開く（下書きは破棄）' }),
  ).toBeVisible();
  await keep.click();
  await expect(songTextarea(page)).toHaveValue(/iPadの版/);
  const files = drive.songs();
  expect(files).toHaveLength(2);
  expect(files.some((f) => f.text.includes('PCの下書き'))).toBe(true);
});

test('rename, duplicate and delete from the list', async ({ page }) => {
  const drive = await installFakeDrive(page);
  drive.seed({
    name: '曲A.bandsheet',
    text: songText('曲A'),
    songId: 'song-a',
  });
  drive.seed({
    name: '曲B.bandsheet',
    text: songText('曲B'),
    songId: 'song-b',
  });
  await freshStart(page);
  await signIn(page);
  await expect(row(page, 'song-a')).toHaveAttribute('data-status', 'synced');
  await expect(row(page, 'song-b')).toBeVisible();

  // Rename.
  await page.getByRole('button', { name: '曲Aのその他の操作' }).click();
  await page.getByRole('button', { name: '名前を変える' }).click();
  const rename = page.getByRole('dialog', { name: '曲名を変える' });
  await rename.getByLabel('曲名').fill('曲A改');
  await rename.getByRole('button', { name: '変更する' }).click();
  await expect(row(page, 'song-a')).toContainText('曲A改');
  expect(drive.file('fake2')?.name).toBe('曲A改.bandsheet');

  // Duplicate.
  await page.getByRole('button', { name: '曲Bのその他の操作' }).click();
  await page.getByRole('button', { name: '複製する' }).click();
  await expect(page.getByTestId('song-count')).toHaveText(/^3 曲/);
  await expect(page.getByText('曲B のコピー')).toBeVisible();
  expect(drive.songs()).toHaveLength(3);

  // Delete (to the Drive trash).
  await page.getByRole('button', { name: '曲Bのその他の操作' }).click();
  await page.getByRole('button', { name: '削除する…' }).click();
  await page
    .getByRole('dialog', { name: '「曲B」を削除しますか？' })
    .getByRole('button', { name: '削除する', exact: true })
    .click();
  await expect(row(page, 'song-b')).toHaveCount(0);
  expect(drive.trashed()).toHaveLength(1);
  expect(drive.songs()).toHaveLength(2);
});

test('offline: the cached list is shown; sign out clears it', async ({
  page,
}) => {
  const drive = await startSignedIn(page);
  const songId = await newSavedSong(page, drive, songText('キャッシュ曲'));
  await page.getByRole('button', { name: '‹ 曲の一覧' }).click();
  await expect(row(page, songId)).toBeVisible();

  drive.offline = true;
  await page.reload();
  await expect(row(page, songId)).toContainText('キャッシュ曲');

  drive.offline = false;
  await page.getByRole('button', { name: 'ログイン中' }).click();
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(
    page.getByRole('button', { name: 'ログインせずに編集を始める →' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('band-sheets:auth')),
  ).toBeNull();
});

test('expired sign-in at startup: 「前回読み込んだ版です」, 未確認, reconnect opens the newer version (R2)', async ({
  page,
}) => {
  const drive = await startSignedIn(page);
  const songId = await newSavedSong(page, drive, songText('期限切れ曲'));
  // Another device saves; this device's token runs out (next morning).
  drive.externalEdit(drive.songs()[0].id, songText('期限切れ曲', 'iPadの版'));
  await page.evaluate(() => {
    const raw = localStorage.getItem('band-sheets:auth');
    const a = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    localStorage.setItem(
      'band-sheets:auth',
      JSON.stringify({ ...a, expiresAt: Date.now() - 60_000 }),
    );
  });
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#/edit/${songId}`));
  const notice = page.getByTestId('stale-notice');
  await expect(notice).toContainText('前回読み込んだ版です');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'unconfirmed');
  await page.screenshot({ path: 'docs/m7-editor-unconfirmed.png' });
  const before = await drive.gisCalls(page);
  await notice.getByRole('button', { name: 'Drive に再接続' }).click();
  await expect(notice).toBeHidden();
  expect(await drive.gisCalls(page)).toBe(before + 1);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  await expect(songTextarea(page)).toHaveValue(/iPadの版/);
});

test('expired + body never downloaded: the editor offers reconnect and opens (R18)', async ({
  page,
}) => {
  const drive = await startSignedIn(page);
  const songId = await newSavedSong(page, drive, songText('未読込曲'));
  // The list knows the song, but this device never kept its body.
  await page.getByRole('button', { name: '‹ 曲の一覧' }).click();
  await expect(row(page, songId)).toBeVisible();
  await page.evaluate((id) => {
    localStorage.removeItem(`band-sheets:base:${id}`);
    localStorage.removeItem(`band-sheets:draft:${id}`);
    const raw = localStorage.getItem('band-sheets:auth');
    const a = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    localStorage.setItem(
      'band-sheets:auth',
      JSON.stringify({ ...a, expiresAt: Date.now() - 60_000 }),
    );
  }, songId);
  await page.reload();
  await page.goto(`/#/edit/${songId}`);
  const notice = page.getByTestId('stale-notice');
  await expect(notice).toContainText('Drive に再接続すると開けます');
  await notice.getByRole('button', { name: 'Drive に再接続' }).click();
  await expect(notice).toBeHidden();
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  await expect(songTextarea(page)).toHaveValue(/未読込曲/);
});

test('the Drive file is gone: asks before saving a new file (R14)', async ({
  page,
}) => {
  const drive = await startSignedIn(page);
  await newSavedSong(page, drive, songText('消えた曲'));
  const oldId = drive.songs()[0].id;
  drive.externalTrash(oldId);
  await editMore(page, songText('消えた曲', '書き足し'));
  await page.keyboard.press('Control+s');
  const dialog = page.getByRole('dialog', {
    name: 'Drive にこの曲のファイルが見つかりません',
  });
  await expect(dialog).toContainText('アプリの許可が外れた可能性');
  expect(drive.songs()).toHaveLength(0);
  // Cancel: nothing written, still unsaved.
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'dirty');
  expect(drive.songs()).toHaveLength(0);
  // Again, and confirm.
  await page.keyboard.press('Control+s');
  await page
    .getByRole('dialog', { name: 'Drive にこの曲のファイルが見つかりません' })
    .getByRole('button', { name: '新しく保存する' })
    .click();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  const files = drive.songs();
  expect(files).toHaveLength(1);
  expect(files[0].id).not.toBe(oldId);
  expect(files[0].text).toContain('書き足し');
});

test('an unknown song URL explains instead of opening an empty song (R6)', async ({
  page,
}) => {
  const drive = await startSignedIn(page);
  await page.goto('/#/edit/no-such-song');
  await expect(page.getByTestId('unknown-song')).toContainText(
    'この曲は見つかりません',
  );
  await page.getByRole('button', { name: '‹ 曲の一覧' }).click();
  await expect(page.getByTestId('song-list-empty')).toBeVisible();
  expect(drive.songs()).toHaveLength(0);
});

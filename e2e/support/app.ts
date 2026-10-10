import { expect, type Page } from '@playwright/test';

export const draftKey = (songId: string) => `band-sheets:draft:${songId}`;

/** The song id in `#/edit/<id>` or `#/view/<id>`. */
export function songIdOf(page: Page): string {
  const m = /#\/(?:edit|view)\/([^/?#]+)/.exec(page.url());
  if (!m) throw new Error(`not on a song route: ${page.url()}`);
  return decodeURIComponent(m[1]);
}

/** Opens the app with empty storage (the sign-in screen or list shows). */
export async function freshStart(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

/** Fresh storage, then a new song via `#/new` (→ `#/edit/<id>`). Returns the id. */
export async function openNewSong(page: Page): Promise<string> {
  await freshStart(page);
  await page.evaluate(() => {
    window.location.hash = '#/new';
  });
  await expect(page).toHaveURL(/#\/edit\//);
  await expect(
    page.getByRole('heading', { level: 1, name: '無題の曲' }),
  ).toBeVisible();
  return songIdOf(page);
}

export interface DraftJson {
  v: number;
  text: string;
  baseVersion: string | null;
  savedAt: string;
}

export async function readDraft(
  page: Page,
  songId: string,
): Promise<DraftJson | null> {
  const raw = await page.evaluate(
    (k) => localStorage.getItem(k),
    draftKey(songId),
  );
  return raw === null ? null : (JSON.parse(raw) as DraftJson);
}

/** Waits for the autosave (500 ms debounce) and returns the draft's text. */
export async function draftText(page: Page, songId: string): Promise<string> {
  await expect
    .poll(async () => (await readDraft(page, songId))?.text ?? '')
    .not.toBe('');
  return (await readDraft(page, songId))!.text;
}

/** Writes a JSON draft, then opens `#/edit/<id>` (a reload makes the app read it). */
export async function seedDraftAndOpen(
  page: Page,
  songId: string,
  text: string,
  route: 'edit' | 'view' = 'edit',
): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    ([key, value]) => {
      localStorage.clear();
      localStorage.setItem(key, value);
    },
    [
      draftKey(songId),
      JSON.stringify({
        v: 1,
        text,
        baseVersion: null,
        savedAt: new Date().toISOString(),
      }),
    ],
  );
  await page.goto(`/#/${route}/${encodeURIComponent(songId)}`);
  await page.reload();
}

/** A minimal valid song document. */
export function songText(title: string, lyric = 'あいうえお'): string {
  return `{title: ${title}}\n\n{start_of_verse: A}\n${lyric}\n{end_of_verse}\n`;
}

/** Replaces the whole text via editor B (テキスト入力). */
export async function setSongText(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  await page.getByLabel('ChordPro テキスト').fill(text);
}

export const songTextarea = (page: Page) =>
  page.getByLabel('ChordPro テキスト');

/** Clicks 「Google でログイン」 (the GIS stub answers at once). */
export async function signIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Google でログイン' }).click();
}
